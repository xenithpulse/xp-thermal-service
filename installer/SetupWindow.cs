// SetupWindow.cs - the one window setup and uninstall show.
//
// Borderless, in the XenithPulse palette: the brand panel on the left (the
// emerald pulse, the product name, the XENITHPULSE wordmark), and on the
// right one page at a time. Install is a single click: Welcome -> Progress ->
// Done. Updates started from the dashboard (--update) skip the click.
//
// Everything is drawn at the window's DPI, and redrawn when it moves to a
// screen with another, so it is sharp at 100%, 150% or 200%.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

enum Page { Welcome, Progress, Done, Error, Confirm, Removed }

sealed class SetupWindow : Form
{
    // Layout, in pixels at 100% scale.
    const float W = 660, H = 400, SIDE = 236, PAD = 36;
    const float X0 = SIDE + PAD, CW = W - SIDE - 2 * PAD;

    readonly Session session;
    Page page;
    float scale = 1f;
    bool roundedByWindows;

    readonly FlatButton primary = new FlatButton();
    readonly FlatButton secondary = new FlatButton();
    readonly FlatCheck check = new FlatCheck();
    readonly CloseGlyph close = new CloseGlyph();
    // What the page wants shown. Control.Visible reads false until the window
    // itself is visible, so layout cannot go by it.
    bool showPrimary, showSecondary;

    Font fTitle, fSub, fBody, fFact, fSmall, fButton, fBrandName, fBrandTag;
    Bitmap side;

    readonly System.Windows.Forms.Timer animation = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer fade = new System.Windows.Forms.Timer();
    int closeAt;

    // Progress: the worker reports phases; the bar eases through each one.
    float shown, phaseFrom, phaseTo;
    int phaseAt, startedAt, finishedAt;
    string step = "";
    bool working, workDone;
    string error;

    /// <summary>0 done, 1 failed, 2 cancelled.</summary>
    public int ExitCode = 2;

    public SetupWindow(Session session)
    {
        this.session = session;
        Text = session.Uninstall ? "Uninstall Thermal Bridge" : "Thermal Bridge Setup";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        MaximizeBox = false;
        MinimizeBox = true;
        BackColor = Brand.Surface;
        KeyPreview = true;
        Opacity = 0;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch (Exception) { }

        primary.Kind = ButtonKind.Primary;
        secondary.Kind = ButtonKind.Secondary;
        primary.Click += delegate { OnPrimary(); };
        secondary.Click += delegate { OnSecondary(); };
        close.Click += delegate { OnSecondary(); };
        check.TabIndex = 0;
        secondary.TabIndex = 1;
        primary.TabIndex = 2;
        Controls.Add(primary);
        Controls.Add(secondary);
        Controls.Add(check);
        Controls.Add(close);

        animation.Interval = 15;
        animation.Tick += delegate { Animate(); };
        fade.Interval = 15;
        fade.Tick += delegate { FadeIn(); };

        ApplyScale(1f);
        ShowPage(session.Uninstall ? Page.Confirm : Page.Welcome);
    }

    float S(float v) { return v * scale; }

    // ── Window chrome ─────────────────────────────────────────────────────────

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ClassStyle |= 0x20000;       // CS_DROPSHADOW
            cp.Style |= 0x20000 | 0x80000;  // WS_MINIMIZEBOX | WS_SYSMENU: taskbar click and menu work
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Windows 11: rounded corners and a hairline border drawn by the compositor.
        int round = 2; // DWMWCP_ROUND
        roundedByWindows = DwmSetWindowAttribute(Handle, 33, ref round, 4) == 0;
        int border = ColorTranslator.ToWin32(Brand.LineStrong);
        DwmSetWindowAttribute(Handle, 34, ref border, 4);

        ApplyScale(WindowDpi() / 96f);
        Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(area.X + (area.Width - Width) / 2, area.Y + (area.Height - Height) / 2);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Activate();
        fade.Start();
        if (session.Update) StartWork();
    }

    void FadeIn()
    {
        double next = Opacity + 0.09;
        if (next >= 1)
        {
            Opacity = 1;
            fade.Stop();
        }
        else
        {
            Opacity = next;
        }
    }

    protected override void WndProc(ref Message m)
    {
        const int WM_NCHITTEST = 0x84, HTCLIENT = 1, HTCAPTION = 2, WM_DPICHANGED = 0x02E0;
        if (m.Msg == WM_DPICHANGED)
        {
            int dpi = (int)((long)m.WParam & 0xFFFF);
            RECT suggested = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
            ApplyScale(dpi / 96f);
            Bounds = new Rectangle(suggested.Left, suggested.Top, suggested.Right - suggested.Left, suggested.Bottom - suggested.Top);
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
        // Anywhere that is not a control drags the window.
        if (m.Msg == WM_NCHITTEST && (int)m.Result == HTCLIENT) m.Result = (IntPtr)HTCAPTION;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Files are being swapped: closing now could leave half an install.
        if (working && e.CloseReason != CloseReason.WindowsShutDown) e.Cancel = true;
        base.OnFormClosing(e);
    }

    int WindowDpi()
    {
        try
        {
            if (IsHandleCreated) return (int)GetDpiForWindow(Handle);
        }
        catch (EntryPointNotFoundException)
        {
        }
        using (Graphics g = CreateGraphics()) return (int)g.DpiX;
    }

    // ── Scale and layout ──────────────────────────────────────────────────────

    internal void ApplyScale(float value)
    {
        scale = value;
        DisposeFonts();
        fTitle = Brand.Display(S(23));
        fSub = Brand.Text(S(12.5f));
        fBody = Brand.Text(S(13.5f));
        fFact = Brand.Text(S(12.5f));
        fSmall = Brand.Text(S(11.5f));
        fButton = Brand.TextStrong(S(13));
        fBrandName = Brand.Display(S(22));
        fBrandTag = Brand.TextStrong(S(9.5f));
        if (side != null) { side.Dispose(); side = null; }

        foreach (Control c in new Control[] { primary, secondary, check, close })
            ((BrandControl)c).UiScale = scale;
        primary.Font = fButton;
        secondary.Font = fButton;
        check.Font = fBody;

        ClientSize = new Size((int)Math.Round(S(W)), (int)Math.Round(S(H)));
        LayoutControls();
        Invalidate(true);
    }

    void DisposeFonts()
    {
        foreach (Font f in new Font[] { fTitle, fSub, fBody, fFact, fSmall, fButton, fBrandName, fBrandTag })
            if (f != null) f.Dispose();
    }

    void LayoutControls()
    {
        close.Bounds = R(W - 42, 10, 32, 28);

        float inset = primary.Inset / scale;
        float rowY = H - 30 - 34 - inset;
        float right = W - PAD + inset;
        if (showPrimary)
        {
            float w = ButtonWidth(primary);
            primary.Bounds = R(right - w, rowY, w, 34 + 2 * inset);
            right -= w - 2 * inset + 10;
        }
        if (showSecondary)
        {
            float w = ButtonWidth(secondary);
            secondary.Bounds = R(right - w, rowY, w, 34 + 2 * inset);
        }

        float checkY = page == Page.Confirm ? 240 : 246;
        check.Bounds = R(X0 - 1, checkY, Math.Min(CW + 2, check.PreferredWidth / scale), 28);
    }

    float ButtonWidth(FlatButton b)
    {
        float text = TextRenderer.MeasureText(b.Text, fButton).Width / scale;
        return Math.Max(104, text + 44) + 2 * (b.Inset / scale);
    }

    Rectangle R(float x, float y, float w, float h)
    {
        int left = (int)Math.Round(S(x)), top = (int)Math.Round(S(y));
        return new Rectangle(left, top, (int)Math.Round(S(x + w)) - left, (int)Math.Round(S(y + h)) - top);
    }

    // ── Pages ─────────────────────────────────────────────────────────────────

    enum Kind { Fresh, Upgrade, Reinstall, Downgrade }

    Kind InstallKind
    {
        get
        {
            if (session.InstalledVersion == null) return Kind.Fresh;
            int c = Engine.CompareVersions(session.Version, session.InstalledVersion);
            return c > 0 || session.InstalledVersion == "unknown" ? Kind.Upgrade : c == 0 ? Kind.Reinstall : Kind.Downgrade;
        }
    }

    internal void ShowPage(Page next)
    {
        page = next;
        showPrimary = true;
        showSecondary = false;
        primary.Enabled = true;
        primary.Kind = ButtonKind.Primary;
        check.Visible = false;
        close.Visible = next != Page.Progress;
        CancelButton = null;

        switch (next)
        {
            case Page.Welcome:
                {
                    Kind k = InstallKind;
                    primary.Text = k == Kind.Fresh ? "Install" : k == Kind.Upgrade ? "Update" : k == Kind.Reinstall ? "Reinstall" : "Install anyway";
                    secondary.Text = "Cancel";
                    showSecondary = true;
                    CancelButton = secondary;
                    break;
                }
            case Page.Progress:
                showPrimary = false;
                break;
            case Page.Done:
                if (session.Update)
                {
                    primary.Text = "Close";
                }
                else
                {
                    primary.Text = "Finish";
                    check.Text = InstallKind == Kind.Fresh ? "Open Thermal Bridge now" : "Start Thermal Bridge now";
                    check.Checked = true;
                    check.Visible = true;
                }
                CancelButton = primary;
                break;
            case Page.Error:
                primary.Text = "Try again";
                secondary.Text = "Close";
                showSecondary = true;
                CancelButton = secondary;
                break;
            case Page.Confirm:
                primary.Text = "Uninstall";
                primary.Kind = ButtonKind.Danger;
                secondary.Text = "Cancel";
                showSecondary = true;
                check.Text = "Also delete printer settings and print history";
                check.Checked = false;
                check.Visible = true;
                CancelButton = secondary;
                break;
            case Page.Removed:
                primary.Text = "Close";
                CancelButton = primary;
                break;
        }

        primary.Visible = showPrimary;
        secondary.Visible = showSecondary;
        AcceptButton = showPrimary ? primary : null;
        LayoutControls();
        if (showPrimary && IsHandleCreated) primary.Focus();
        Invalidate();
    }

    void OnPrimary()
    {
        switch (page)
        {
            case Page.Welcome:
            case Page.Error:
            case Page.Confirm:
                if (page == Page.Confirm) session.DeleteData = check.Checked;
                StartWork();
                break;
            case Page.Done:
                if (!session.Update && check.Checked) LaunchApp(false);
                ExitCode = 0;
                Close();
                break;
            case Page.Removed:
                ExitCode = 0;
                Close();
                break;
        }
    }

    void OnSecondary()
    {
        if (working) return;
        if (page == Page.Done || page == Page.Removed)
        {
            OnPrimary();
            return;
        }
        ExitCode = page == Page.Error ? 1 : 2;
        Close();
    }

    void LaunchApp(bool background)
    {
        try
        {
            Engine.Launch(background);
        }
        catch (Exception e)
        {
            Log.Write("Could not start Thermal Bridge: " + e.Message);
        }
    }

    // ── Work ──────────────────────────────────────────────────────────────────

    void StartWork()
    {
        working = true;
        workDone = false;
        error = null;
        shown = 0;
        phaseFrom = 0;
        phaseTo = 0.1f;
        step = "Getting ready…";
        startedAt = phaseAt = Environment.TickCount;
        ShowPage(Page.Progress);
        animation.Start();

        Thread worker = new Thread(Work);
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.STA); // the Start Menu shortcut is a COM object
        worker.Start();
    }

    void Work()
    {
        string failure = null;
        try
        {
            if (session.Uninstall) Engine.Uninstall(session.DeleteData, Report);
            else Engine.Install(Report);
        }
        catch (SetupException e)
        {
            Log.Write("Failed: " + e);
            failure = e.Message;
        }
        catch (Exception e)
        {
            Log.Write("Failed: " + e);
            failure = "Something unexpected went wrong: " + e.Message;
        }

        if (failure == null && session.Uninstall && session.Removed != null) session.Removed();
        Post(delegate { WorkFinished(failure); });
    }

    /// <summary>Run on the UI thread, unless the window is already gone (Windows shutting down).</summary>
    void Post(MethodInvoker action)
    {
        try
        {
            if (IsHandleCreated && !IsDisposed) BeginInvoke(action);
        }
        catch (InvalidOperationException)
        {
        }
    }

    void Report(float from, float to, string text)
    {
        Post(delegate
        {
            phaseFrom = Math.Max(from, shown);
            phaseTo = to;
            phaseAt = Environment.TickCount;
            step = text;
            Invalidate(R(X0, 170, CW, 60));
        });
    }

    void WorkFinished(string failure)
    {
        working = false;
        if (failure == null)
        {
            workDone = true;
            finishedAt = Environment.TickCount;
            return; // Animate() finishes the bar, then shows Done.
        }
        animation.Stop();
        error = failure;
        ShowPage(Page.Error);
    }

    void Animate()
    {
        int now = Environment.TickCount;
        if (page == Page.Progress)
        {
            float target;
            if (workDone)
            {
                target = 1f;
            }
            else
            {
                // Ease towards the end of the current phase without ever reaching
                // it, so a long step still looks alive and the next one takes over.
                float t = (now - phaseAt) / 1000f;
                target = phaseFrom + (phaseTo - phaseFrom) * 0.96f * (1f - (float)Math.Exp(-t / 1.2f));
            }
            shown += (Math.Max(target, shown) - shown) * (workDone ? 0.2f : 0.12f);

            // A finished install still shows a moment of progress, so the page never flickers past.
            if (workDone && shown > 0.995f && now - startedAt > 900 && now - finishedAt > 250)
            {
                shown = 1f;
                ShowPage(session.Uninstall ? Page.Removed : Page.Done);
                if (!session.Uninstall)
                {
                    ExitCode = 0;
                    if (session.Update)
                    {
                        LaunchApp(true);
                        closeAt = now + 6000;
                        return; // keep ticking for the auto-close
                    }
                }
                else
                {
                    ExitCode = 0;
                }
                animation.Stop();
                return;
            }
            Invalidate(R(X0, 170, CW, 60));
        }
        else if (closeAt != 0 && now - closeAt >= 0)
        {
            animation.Stop();
            Close();
        }
    }

    // ── Painting ──────────────────────────────────────────────────────────────

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        if (side == null) side = RenderSide();
        g.DrawImageUnscaled(side, 0, 0);
        using (Pen line = new Pen(Brand.Line, Math.Max(1f, S(1))))
            g.DrawLine(line, S(SIDE) - 0.5f, 0, S(SIDE) - 0.5f, Height);
        if (!roundedByWindows)
            using (Pen border = new Pen(Brand.LineStrong))
                g.DrawRectangle(border, 0, 0, Width - 1, Height - 1);

        PaintPage(g);
    }

    /// <summary>The brand panel: drawn once per scale and kept.</summary>
    Bitmap RenderSide()
    {
        int w = (int)Math.Round(S(SIDE)), h = (int)Math.Round(S(H));
        Bitmap bmp = new Bitmap(Math.Max(1, w), Math.Max(1, h));
        using (Graphics g = Graphics.FromImage(bmp))
        {
            Brand.Quality(g);
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            using (LinearGradientBrush ground = new LinearGradientBrush(new Rectangle(0, 0, w, h), Brand.PanelTop, Brand.PanelBottom, 90f))
                g.FillRectangle(ground, 0, 0, w, h);

            // A faint emerald light behind the mark.
            float cx = w / 2f, cy = S(122);
            Brand.DrawHalo(g, new RectangleF(cx - S(170), cy - S(130), S(340), S(260)), Brand.Emerald, 0.16f);

            Brand.DrawPulse(g, cx, cy, S(134), S(7.5f));
            Brand.DrawTracked(g, "Thermal Bridge", fBrandName, Brand.Chalk, cx, S(184), 0);
            using (Pen hair = new Pen(Brand.WithAlpha(Brand.Emerald, 90), Math.Max(1f, S(1))))
                g.DrawLine(hair, cx - S(44), S(225), cx + S(44), S(225));
            Brand.DrawTracked(g, "RECEIPT PRINTING", fBrandTag, Brand.Muted, cx, S(238), S(2.4f));
            Brand.DrawWordmark(g, cx, h - S(34), S(9.5f), Brand.WithAlpha(Brand.Chalk, 150));
        }
        return bmp;
    }

    void PaintPage(Graphics g)
    {
        Brand.Quality(g);
        string user = session.UserName;
        string v = session.Version;
        string installed = session.InstalledVersion;

        switch (page)
        {
            case Page.Welcome:
                {
                    DrawIcon(g);
                    Kind k = InstallKind;
                    if (k == Kind.Fresh)
                    {
                        Title(g, "Install Thermal Bridge");
                        Sub(g, "Version " + v + "  ·  by XenithPulse");
                        Body(g, "Prints receipts from your web POS straight to your receipt printer. No print dialog, no extra clicks.", 44);
                        Facts(g, "Installs for " + user + " only, no administrator rights",
                            "Runs quietly in the system tray",
                            "Starts with Windows, so printing survives a restart");
                    }
                    else
                    {
                        if (k == Kind.Upgrade)
                        {
                            Title(g, "Update Thermal Bridge");
                            Sub(g, installed == "unknown" ? "Update to version " + v : "Version " + installed + "  →  " + v);
                            Body(g, "A newer Thermal Bridge is ready to install. Printing pauses for a few seconds while it updates.", 44);
                        }
                        else if (k == Kind.Reinstall)
                        {
                            Title(g, "Reinstall Thermal Bridge");
                            Sub(g, "Version " + v + " is already installed");
                            Body(g, "Reinstalling repairs the program files. Printing pauses for a few seconds.", 44);
                        }
                        else
                        {
                            Title(g, "Install an earlier version");
                            Sub(g, "Version " + installed + " is installed  ·  this is " + v);
                            Body(g, "This replaces the installed Thermal Bridge with an earlier version.", 44);
                        }
                        Facts(g, "Your printers and settings are kept",
                            "Websites you allowed can still print",
                            "Installs for " + user + " only, no administrator rights");
                    }
                    break;
                }
            case Page.Progress:
                DrawIcon(g);
                Title(g, session.Uninstall ? "Removing Thermal Bridge" :
                    InstallKind == Kind.Fresh ? "Installing Thermal Bridge" : "Updating Thermal Bridge");
                Sub(g, session.Uninstall ? "Version " + (installed ?? v) : "Version " + v);
                DrawProgress(g);
                break;
            case Page.Done:
                Badge(g, false);
                Title(g, InstallKind == Kind.Fresh && !session.Update ? "Thermal Bridge is ready" : "Thermal Bridge is up to date");
                Sub(g, session.Update ? "Version " + v + " is running" : "Version " + v);
                if (session.Update)
                    Body(g, "Your printers and settings were kept. This window closes by itself.", 44);
                else if (InstallKind == Kind.Fresh)
                    Body(g, "It runs in the system tray, next to the clock, and starts with Windows. Web apps on this PC can now print through it.", 64);
                else
                    Body(g, "Your printers and settings were kept. Thermal Bridge runs in the system tray, next to the clock.", 64);
                break;
            case Page.Error:
                Badge(g, true);
                Title(g, session.Uninstall ? "Thermal Bridge was not removed" : "Setup could not finish");
                Sub(g, "Nothing you set up was lost");
                Body(g, error ?? "", 62);
                TextRenderer.DrawText(g, "Details: " + Log.FilePath, fSmall, R(X0, 248, CW, 18), Brand.Muted, Brand.Surface,
                    TextFormatFlags.SingleLine | TextFormatFlags.PathEllipsis | TextFormatFlags.NoPadding);
                break;
            case Page.Confirm:
                DrawIcon(g);
                Title(g, "Uninstall Thermal Bridge");
                Sub(g, installed != null ? "Version " + installed + "  ·  by XenithPulse" : "Not fully installed  ·  leftovers will be cleaned up");
                Body(g, "Removes Thermal Bridge from this computer. Web apps on this PC will no longer be able to print through it.", 44);
                break;
            case Page.Removed:
                Badge(g, false);
                Title(g, "Thermal Bridge was removed");
                Sub(g, "Uninstalled for " + user);
                Body(g, session.DeleteData
                    ? "Your printer settings and print history were deleted too."
                    : "Your printer settings and print history were kept, so installing again picks up where you left off.", 64);
                break;
        }

        // Footer, level with the buttons.
        TextRenderer.DrawText(g, "© XenithPulse", fSmall, R(X0, H - 30 - 34, 150, 34), Brand.Muted, Brand.Surface,
            TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
    }

    void DrawIcon(Graphics g)
    {
        Image icon = Brand.AppIcon;
        if (icon != null) g.DrawImage(icon, R(X0 - 2, 40, 52, 52));
    }

    /// <summary>A round badge in the icon's place: a tick for done, "!" for a failure.</summary>
    void Badge(Graphics g, bool failed)
    {
        Color c = failed ? Brand.Danger : Brand.Emerald;
        RectangleF r = R(X0, 42, 48, 48);
        using (SolidBrush fill = new SolidBrush(Brand.WithAlpha(c, 34))) g.FillEllipse(fill, r);
        using (Pen ring = new Pen(Brand.WithAlpha(c, 150), Math.Max(1f, S(1.5f)))) g.DrawEllipse(ring, RectangleF.Inflate(r, -S(0.75f), -S(0.75f)));
        if (failed)
        {
            using (Pen bar = new Pen(c, S(3.4f)))
            {
                bar.StartCap = LineCap.Round;
                bar.EndCap = LineCap.Round;
                g.DrawLine(bar, r.X + r.Width / 2, r.Y + S(13), r.X + r.Width / 2, r.Y + S(28));
            }
            using (SolidBrush dot = new SolidBrush(c)) g.FillEllipse(dot, r.X + r.Width / 2 - S(2.2f), r.Y + S(33), S(4.4f), S(4.4f));
        }
        else
        {
            Brand.DrawTick(g, RectangleF.Inflate(r, -S(9), -S(9)), c, S(3.4f));
        }
    }

    void Title(Graphics g, string text)
    {
        TextRenderer.DrawText(g, text, fTitle, R(X0, 108, CW, 32), Brand.Chalk, Brand.Surface,
            TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
    }

    void Sub(Graphics g, string text)
    {
        TextRenderer.DrawText(g, text, fSub, R(X0, 142, CW, 20), Brand.Muted, Brand.Surface,
            TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
    }

    void Body(Graphics g, string text, float height)
    {
        TextRenderer.DrawText(g, text, fBody, R(X0, 176, CW, height), Brand.Body, Brand.Surface,
            TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
    }

    void Facts(Graphics g, params string[] facts)
    {
        float y = 232;
        foreach (string fact in facts)
        {
            RectangleF tick = R(X0, y + 3, 14, 14);
            using (SolidBrush dot = new SolidBrush(Brand.WithAlpha(Brand.Emerald, 30))) g.FillEllipse(dot, tick);
            Brand.DrawTick(g, RectangleF.Inflate(tick, -S(2.5f), -S(2.5f)), Brand.Emerald, Math.Max(1.2f, S(1.6f)));
            TextRenderer.DrawText(g, fact, fFact, R(X0 + 24, y, CW - 24, 20), Brand.Body, Brand.Surface,
                TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
            y += 24;
        }
    }

    void DrawProgress(Graphics g)
    {
        using (SolidBrush clear = new SolidBrush(Brand.Surface)) g.FillRectangle(clear, R(X0, 170, CW, 60));

        TextRenderer.DrawText(g, step, fBody, R(X0, 184, CW - 50, 20), Brand.Body, Brand.Surface,
            TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
        TextRenderer.DrawText(g, ((int)Math.Round(shown * 100)) + "%", fSub, R(X0 + CW - 50, 184, 50, 20), Brand.Muted, Brand.Surface,
            TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.Right | TextFormatFlags.NoPadding);

        RectangleF track = new RectangleF(S(X0), S(214), S(CW), S(6));
        using (GraphicsPath path = Brand.Rounded(track, S(3)))
        using (SolidBrush brush = new SolidBrush(Brand.Raised))
            g.FillPath(brush, path);

        float w = track.Width * Math.Max(0f, Math.Min(1f, shown));
        if (w < S(6)) w = S(6);
        RectangleF fill = new RectangleF(track.X, track.Y, w, track.Height);
        using (GraphicsPath path = Brand.Rounded(fill, S(3)))
        {
            using (SolidBrush brush = new SolidBrush(Brand.Emerald)) g.FillPath(brush, path);

            // A soft highlight sweeping along the filled part, so the bar reads as alive.
            float band = S(90);
            float period = 1500f;
            float t = (Environment.TickCount % (int)period) / period;
            float x = track.X - band + (w + band) * t;
            RectangleF sheen = new RectangleF(x, track.Y, band, track.Height);
            using (LinearGradientBrush light = new LinearGradientBrush(new RectangleF(x - 1, track.Y, band + 2, track.Height),
                Color.Transparent, Color.Transparent, 0f))
            {
                ColorBlend blend = new ColorBlend();
                blend.Positions = new float[] { 0f, 0.5f, 1f };
                blend.Colors = new Color[] { Brand.WithAlpha(Color.White, 0), Brand.WithAlpha(Color.White, 110), Brand.WithAlpha(Color.White, 0) };
                light.InterpolationColors = blend;
                Region old = g.Clip;
                g.SetClip(path, CombineMode.Intersect);
                g.FillRectangle(light, sheen);
                g.Clip = old;
            }
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            animation.Dispose();
            fade.Dispose();
            DisposeFonts();
            if (side != null) side.Dispose();
        }
        base.Dispose(disposing);
    }

    // ── Previews ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Put the window in a given state without doing anything, so each page can
    /// be rendered to an image for review. Setup itself never calls this.
    /// </summary>
    internal void Preview(Page p, float progress, string stepText, string errorText)
    {
        if (p == Page.Progress)
        {
            page = Page.Progress;
            ShowPage(Page.Progress);
            shown = progress;
            step = stepText;
        }
        else
        {
            error = errorText;
            ShowPage(p);
        }
    }

    // ── Win32 ─────────────────────────────────────────────────────────────────

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr hwnd);
}
