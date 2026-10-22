// Controls.cs - the three controls the setup window uses: a button, a
// checkbox and the close glyph. Painted by hand in the brand palette, but
// still real controls: they take focus, show a focus ring only when the
// keyboard is in use, and answer Space, Enter and Esc like the system ones.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

enum ButtonKind { Primary, Secondary, Danger }

/// <summary>Base for the hand-painted controls: hover and press tracking, and the scale.</summary>
abstract class BrandControl : Control
{
    protected bool hover;
    protected bool pressed;
    float scale = 1f;

    protected BrandControl()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.StandardClick, true);
        SetStyle(ControlStyles.StandardDoubleClick, false);
        BackColor = Brand.Surface;
        Cursor = Cursors.Hand;
        TabStop = true;
    }

    public float UiScale
    {
        get { return scale; }
        set { scale = value; Invalidate(); }
    }

    protected float S(float v) { return v * scale; }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) { pressed = true; Invalidate(); }
        base.OnMouseDown(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        pressed = false;
        Invalidate();
        base.OnMouseUp(e);
    }

    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Space) { pressed = true; Invalidate(); e.Handled = true; }
        base.OnKeyDown(e);
    }

    protected override void OnKeyUp(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Space && pressed)
        {
            pressed = false;
            Invalidate();
            OnClick(EventArgs.Empty);
            e.Handled = true;
        }
        base.OnKeyUp(e);
    }

    protected bool ShowRing
    {
        get { return Focused && ShowFocusCues; }
    }
}

/// <summary>A rounded button. Implements IButtonControl, so Enter and Esc reach it through the form.</summary>
sealed class FlatButton : BrandControl, IButtonControl
{
    ButtonKind kind;
    DialogResult result;

    public ButtonKind Kind
    {
        get { return kind; }
        set { kind = value; Invalidate(); }
    }

    public DialogResult DialogResult
    {
        get { return result; }
        set { result = value; }
    }

    public void NotifyDefault(bool value) { Invalidate(); }

    public void PerformClick()
    {
        if (Enabled && Visible) OnClick(EventArgs.Empty);
    }

    /// <summary>The ring around a focused button is drawn inside the control's bounds.</summary>
    public float Inset
    {
        get { return S(3); }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        Brand.Quality(g);

        RectangleF r = new RectangleF(Inset, Inset, Width - 2 * Inset - 1, Height - 2 * Inset - 1);
        Color fill, text;
        Color border = Color.Empty;
        switch (kind)
        {
            case ButtonKind.Primary:
                fill = pressed ? Brand.EmeraldPressed : hover ? Brand.EmeraldHover : Brand.Emerald;
                text = Brand.Ink;
                break;
            case ButtonKind.Danger:
                fill = pressed ? Brand.DangerPressed : hover ? Brand.DangerHover : Brand.Danger;
                text = Color.White;
                break;
            default:
                fill = pressed ? Brand.Raised : hover ? Brand.RaisedHover : Brand.Surface;
                text = Brand.Chalk;
                border = hover ? Brand.LineStrong : Brand.Line;
                break;
        }
        if (!Enabled)
        {
            fill = Brand.Raised;
            text = Brand.Muted;
        }

        using (GraphicsPath path = Brand.Rounded(r, S(8)))
        {
            using (SolidBrush brush = new SolidBrush(fill)) g.FillPath(brush, path);
            if (border != Color.Empty)
                using (Pen pen = new Pen(border, Math.Max(1f, S(1)))) g.DrawPath(pen, path);
        }

        if (ShowRing)
        {
            RectangleF ring = RectangleF.Inflate(r, S(2), S(2));
            using (GraphicsPath path = Brand.Rounded(ring, S(10)))
            using (Pen pen = new Pen(Brand.WithAlpha(Brand.Emerald, 200), Math.Max(1f, S(1.5f))))
                g.DrawPath(pen, path);
        }

        // ClearType needs to know what it is drawing on.
        TextRenderer.DrawText(g, Text, Font, Rectangle.Round(r), text, fill,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
    }
}

/// <summary>A checkbox with its label, both clickable.</summary>
sealed class FlatCheck : BrandControl
{
    bool isChecked;
    public event EventHandler CheckedChanged;

    public bool Checked
    {
        get { return isChecked; }
        set
        {
            if (isChecked == value) return;
            isChecked = value;
            Invalidate();
            if (CheckedChanged != null) CheckedChanged(this, EventArgs.Empty);
        }
    }

    protected override void OnClick(EventArgs e)
    {
        Checked = !Checked;
        base.OnClick(e);
    }

    /// <summary>Width needed for the box and the label on one line.</summary>
    public int PreferredWidth
    {
        get { return (int)Math.Ceiling(S(18) + S(10) + TextRenderer.MeasureText(Text, Font).Width + S(6)); }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        Brand.Quality(g);

        float size = S(18);
        RectangleF box = new RectangleF(S(1), (Height - size) / 2f, size, size);
        using (GraphicsPath path = Brand.Rounded(box, S(5)))
        {
            if (isChecked)
            {
                Color fill = pressed ? Brand.EmeraldPressed : hover ? Brand.EmeraldHover : Brand.Emerald;
                using (SolidBrush brush = new SolidBrush(fill)) g.FillPath(brush, path);
                Brand.DrawTick(g, box, Brand.Ink, Math.Max(1.5f, S(2)));
            }
            else
            {
                using (SolidBrush brush = new SolidBrush(hover ? Brand.Raised : Brand.Surface)) g.FillPath(brush, path);
                using (Pen pen = new Pen(hover ? Brand.Muted : Brand.LineStrong, Math.Max(1f, S(1.5f)))) g.DrawPath(pen, path);
            }
        }

        if (ShowRing)
        {
            using (GraphicsPath ring = Brand.Rounded(RectangleF.Inflate(box, S(2.5f), S(2.5f)), S(7)))
            using (Pen pen = new Pen(Brand.WithAlpha(Brand.Emerald, 200), Math.Max(1f, S(1.5f))))
                g.DrawPath(pen, ring);
        }

        Rectangle label = new Rectangle((int)(box.Right + S(10)), 0, Width - (int)(box.Right + S(10)), Height);
        TextRenderer.DrawText(g, Text, Font, label, isChecked || hover ? Brand.Chalk : Brand.Body, BackColor,
            TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
    }
}

/// <summary>The window's own close button, top right.</summary>
sealed class CloseGlyph : BrandControl
{
    public CloseGlyph()
    {
        TabStop = false;
        Cursor = Cursors.Default;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        Brand.Quality(g);

        if (hover || pressed)
        {
            using (GraphicsPath path = Brand.Rounded(new RectangleF(0, 0, Width - 1, Height - 1), S(6)))
            using (SolidBrush brush = new SolidBrush(pressed ? Brand.Raised : Brand.RaisedHover))
                g.FillPath(brush, path);
        }

        float half = S(5);
        float cx = Width / 2f, cy = Height / 2f;
        using (Pen pen = new Pen(hover ? Brand.Chalk : Brand.Muted, Math.Max(1.2f, S(1.4f))))
        {
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            g.DrawLine(pen, cx - half, cy - half, cx + half, cy + half);
            g.DrawLine(pen, cx - half, cy + half, cx + half, cy - half);
        }
    }
}
