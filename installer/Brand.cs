// Brand.cs - the XenithPulse look, drawn in code so it stays sharp at any
// display scale: the palette, the emerald pulse mark with its glow, the
// XENITHPULSE wordmark, the type, and a few shapes the window is built from.
//
// The values are the brand kit's (XP-POS-DESK ad_screens/brand/colors.json,
// and the palette Pulsar POS's installer artwork is generated from). The
// pulse and the wordmark are the kit's own vector geometry, not redrawings.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

static class Brand
{
    // â”€â”€ Palette â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    public static readonly Color Ink = Hex(0x090E0C);
    public static readonly Color PanelTop = Hex(0x060A09);
    public static readonly Color PanelBottom = Hex(0x0C1411);
    public static readonly Color Surface = Hex(0x0B110F);
    public static readonly Color Raised = Hex(0x15201C);
    public static readonly Color RaisedHover = Hex(0x1C2925);
    public static readonly Color Line = Hex(0x1C2723);
    public static readonly Color LineStrong = Hex(0x2C3A35);
    public static readonly Color Emerald = Hex(0x34D399);
    public static readonly Color EmeraldHover = Hex(0x5BDEAE);
    public static readonly Color EmeraldPressed = Hex(0x23B07F);
    public static readonly Color Chalk = Hex(0xE9F0ED);
    public static readonly Color Body = Hex(0xAEBBB6);
    public static readonly Color Muted = Hex(0x7A8A84);
    public static readonly Color Danger = Hex(0xEF5A5E);
    public static readonly Color DangerHover = Hex(0xF57478);
    public static readonly Color DangerPressed = Hex(0xD9474B);

    static Color Hex(int rgb)
    {
        return Color.FromArgb(255, (rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
    }

    public static Color WithAlpha(Color c, int alpha)
    {
        return Color.FromArgb(Math.Max(0, Math.Min(255, alpha)), c.R, c.G, c.B);
    }

    // â”€â”€ Type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Segoe UI Variable on Windows 11, Segoe UI on Windows 10. GDI lists the
    // variable font's weights as separate (truncated) family names.
    static readonly string DisplayFamily = FirstInstalled("Segoe UI Variable Display Semib", "Segoe UI Semibold");
    static readonly string TextFamily = FirstInstalled("Segoe UI Variable Text", "Segoe UI");
    static readonly string TextStrongFamily = FirstInstalled("Segoe UI Variable Text Semibold", "Segoe UI Semibold");

    static string FirstInstalled(params string[] names)
    {
        using (InstalledFontCollection fonts = new InstalledFontCollection())
        {
            foreach (string name in names)
                foreach (FontFamily family in fonts.Families)
                    if (string.Equals(family.Name, name, StringComparison.OrdinalIgnoreCase)) return family.Name;
        }
        return SystemFonts.MessageBoxFont.FontFamily.Name;
    }

    public static Font Display(float px) { return new Font(DisplayFamily, px, FontStyle.Regular, GraphicsUnit.Pixel); }
    public static Font Text(float px) { return new Font(TextFamily, px, FontStyle.Regular, GraphicsUnit.Pixel); }
    public static Font TextStrong(float px) { return new Font(TextStrongFamily, px, FontStyle.Regular, GraphicsUnit.Pixel); }

    // â”€â”€ The app icon (assets/icon.png, embedded) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    static Image icon;

    public static Image AppIcon
    {
        get
        {
            if (icon == null)
            {
                using (Stream s = typeof(Brand).Assembly.GetManifestResourceStream("icon.png"))
                    icon = s == null ? null : new Bitmap(Image.FromStream(s));
            }
            return icon;
        }
    }

    public static void Quality(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.CompositingQuality = CompositingQuality.HighQuality;
    }

    // â”€â”€ The pulse mark â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // xenithpulse_pulse.svg: one polyline in a 1024 box, round caps and joins.
    static readonly PointF[] PulsePoints =
    {
        new PointF(163.84f, 521.01f), new PointF(344.88f, 521.01f), new PointF(449.33f, 286.72f),
        new PointF(588.60f, 737.28f), new PointF(686.08f, 521.01f), new PointF(860.16f, 521.01f)
    };
    const float PulseLeft = 163.84f, PulseTop = 286.72f, PulseWidth = 696.32f, PulseHeight = 450.56f;

    /// <summary>The pulse, centred on (cx, cy), `width` wide, with a soft emerald glow.</summary>
    public static void DrawPulse(Graphics g, float cx, float cy, float width, float stroke)
    {
        float k = width / PulseWidth;
        PointF[] pts = new PointF[PulsePoints.Length];
        for (int i = 0; i < pts.Length; i++)
        {
            pts[i] = new PointF(
                cx + (PulsePoints[i].X - PulseLeft - PulseWidth / 2f) * k,
                cy + (PulsePoints[i].Y - PulseTop - PulseHeight / 2f) * k);
        }

        // The glow: the line drawn at a quarter size, blurred, and scaled back
        // up. Stacking ever-wider strokes (as the kit's SVG does) leaves visible
        // contour lines at screen resolution; a blur falls off without bands.
        const float down = 4f;
        float reach = stroke * 5f;
        RectangleF area = new RectangleF(cx - width / 2f - reach, cy - PulseHeight * k / 2f - reach,
            width + 2 * reach, PulseHeight * k + 2 * reach);
        int bw = (int)Math.Ceiling(area.Width / down), bh = (int)Math.Ceiling(area.Height / down);
        using (Bitmap glow = new Bitmap(bw, bh, PixelFormat.Format32bppArgb))
        {
            using (Graphics gg = Graphics.FromImage(glow))
            {
                gg.SmoothingMode = SmoothingMode.AntiAlias;
                gg.ScaleTransform(1f / down, 1f / down);
                gg.TranslateTransform(-area.X, -area.Y);
                using (Pen pen = RoundPen(Color.White, stroke * 1.8f)) gg.DrawLines(pen, pts);
            }
            Glow(glow, Emerald, Math.Max(1, (int)Math.Round(stroke * 1.3f / down)), 1.1f);
            DrawSmooth(g, glow, area);
        }
        using (Pen pen = RoundPen(Emerald, stroke)) g.DrawLines(pen, pts);
    }

    /// <summary>
    /// A soft elliptical light, transparent at its edge. Computed at full size
    /// and dithered: a light this faint has only a few dozen distinct shades,
    /// which otherwise show as rings.
    /// </summary>
    public static void DrawHalo(Graphics g, RectangleF area, Color color, float peak)
    {
        int bw = Math.Max(1, (int)Math.Ceiling(area.Width)), bh = Math.Max(1, (int)Math.Ceiling(area.Height));
        using (Bitmap halo = new Bitmap(bw, bh, PixelFormat.Format32bppArgb))
        {
            BitmapData data = halo.LockBits(new Rectangle(0, 0, bw, bh), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            int[] px = new int[bw * bh];
            Random noise = new Random(7);
            for (int y = 0; y < bh; y++)
            {
                for (int x = 0; x < bw; x++)
                {
                    float dx = (x + 0.5f) / bw * 2f - 1f, dy = (y + 0.5f) / bh * 2f - 1f;
                    float d2 = dx * dx + dy * dy;
                    float a = d2 >= 1f ? 0f : (float)Math.Exp(-d2 * 3.2f) * (1f - d2);
                    float level = a * peak * 255f + (float)noise.NextDouble() - 0.5f;
                    px[y * bw + x] = (Clamp(level) << 24) | (color.R << 16) | (color.G << 8) | color.B;
                }
            }
            Marshal.Copy(px, 0, data.Scan0, px.Length);
            halo.UnlockBits(data);
            g.DrawImageUnscaled(halo, (int)Math.Round(area.X), (int)Math.Round(area.Y));
        }
    }

    static void DrawSmooth(Graphics g, Image image, RectangleF area)
    {
        InterpolationMode before = g.InterpolationMode;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        using (ImageAttributes attributes = new ImageAttributes())
        {
            attributes.SetWrapMode(WrapMode.TileFlipXY); // no dark seams at the image's edges
            g.DrawImage(image, new[] { area.Location, new PointF(area.Right, area.Top), new PointF(area.Left, area.Bottom) },
                new RectangleF(0, 0, image.Width, image.Height), GraphicsUnit.Pixel, attributes);
        }
        g.InterpolationMode = before;
    }

    /// <summary>Blur a white-on-transparent bitmap's coverage and recolour it.</summary>
    static void Glow(Bitmap bmp, Color color, int radius, float strength)
    {
        int w = bmp.Width, h = bmp.Height;
        Rectangle all = new Rectangle(0, 0, w, h);
        BitmapData data = bmp.LockBits(all, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        int[] px = new int[w * h];
        Marshal.Copy(data.Scan0, px, 0, px.Length);

        float[] a = new float[w * h], tmp = new float[w * h];
        for (int i = 0; i < px.Length; i++) a[i] = ((px[i] >> 24) & 0xFF) / 255f;
        // Three box blurs approximate a Gaussian.
        for (int pass = 0; pass < 3; pass++)
        {
            BoxBlur(a, tmp, w, h, radius, true);
            BoxBlur(tmp, a, w, h, radius, false);
        }
        for (int i = 0; i < px.Length; i++)
            px[i] = (Clamp(a[i] * strength * 255f) << 24) | (color.R << 16) | (color.G << 8) | color.B;

        Marshal.Copy(px, 0, data.Scan0, px.Length);
        bmp.UnlockBits(data);
    }

    static void BoxBlur(float[] src, float[] dst, int w, int h, int r, bool horizontal)
    {
        int lines = horizontal ? h : w, len = horizontal ? w : h;
        for (int line = 0; line < lines; line++)
        {
            float sum = 0;
            for (int i = -r; i < len + r; i++)
            {
                int add = i + r;
                if (add >= 0 && add < len) sum += src[Index(line, add, w, horizontal)];
                int drop = i - r - 1;
                if (drop >= 0 && drop < len) sum -= src[Index(line, drop, w, horizontal)];
                if (i >= 0 && i < len) dst[Index(line, i, w, horizontal)] = sum / (2 * r + 1);
            }
        }
    }

    static int Index(int line, int pos, int w, bool horizontal)
    {
        return horizontal ? line * w + pos : pos * w + line;
    }

    static int Clamp(float v)
    {
        return v <= 0 ? 0 : v >= 255 ? 255 : (int)(v + 0.5f);
    }

    static Pen RoundPen(Color color, float width)
    {
        Pen pen = new Pen(color, width);
        pen.StartCap = LineCap.Round;
        pen.EndCap = LineCap.Round;
        pen.LineJoin = LineJoin.Round;
        return pen;
    }

    // â”€â”€ The wordmark â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // xenithpulse_wordmark.svg, verbatim. Glyph box: x 1.11 to 1986.67, y -155.56 to 0.
    const string WordmarkSvg =
        "M196.67 0L151.11 0L98.67-56.22L46 0L1.11 0L76.67-78.44L3.33-155.56L47.78-155.56L99.78-101.33L152.22-155.56L194.44-155.56L120.67-79.33L196.67 0Z" +
        "M211.11-155.56L373.33-155.56L373.33-124.44L244.44-124.44L244.44-93.33L368.89-93.33L368.89-62.22L244.44-62.22L244.44-31.11L373.33-31.11L373.33 0L211.11 0L211.11-155.56Z" +
        "M394.44-155.56L436.67-155.56L538.89-38.89L538.89-155.56L572.22-155.56L572.22 0L530 0L427.78-116.67L427.78 0L394.44 0L394.44-155.56Z" +
        "M598.89-155.56L632.22-155.56L632.22 0L598.89 0L598.89-155.56Z" +
        "M651.11-124.44L651.11-155.56L833.33-155.56L833.33-124.44L758.89-124.44L758.89 0L725.56 0L725.56-124.44L651.11-124.44Z" +
        "M885.56 0L852.22 0L852.22-155.56L885.56-155.56L885.56-93.33L996.67-93.33L996.67-155.56L1030-155.56L1030 0L996.67 0L996.67-62.22L885.56-62.22L885.56 0Z" +
        "M1090 0L1056.67 0L1056.67-155.56L1185.56-155.56Q1230-155.56 1230-111.11L1230-111.11L1230-91.11Q1230-46.67 1185.56-46.67L1185.56-46.67L1090-46.67L1090 0Z" +
        "M1090-77.78L1183.33-77.78Q1189.78-77.78 1193.22-81.22Q1196.67-84.67 1196.67-91.11L1196.67-91.11L1196.67-111.11Q1196.67-117.56 1193.22-121Q1189.78-124.44 1183.33-124.44L1183.33-124.44L1090-124.44L1090-77.78Z" +
        "M1250.00-155.56L1283.33-155.56L1283.33-44.44Q1283.33-38 1286.78-34.56Q1290.22-31.11 1296.67-31.11L1296.67-31.11L1385.56-31.11Q1392.00-31.11 1395.44-34.56Q1398.89-38 1398.89-44.44L1398.89-44.44L1398.89-155.56L1432.22-155.56L1432.22-44.44Q1432.22 0 1387.78 0L1387.78 0L1294.44 0Q1250.00 0 1250.00-44.44L1250.00-44.44L1250.00-155.56Z" +
        "M1458.89-155.56L1492.22-155.56L1492.22-31.11L1610.00-31.11L1610.00 0L1458.89 0L1458.89-155.56Z" +
        "M1666.67 0Q1622.22 0 1622.22-44.44L1622.22-44.44L1622.22-48.89L1655.56-48.89L1655.56-43.33Q1655.56-36.89 1659-33.44Q1662.44-30 1668.89-30L1668.89-30L1755.56-30Q1762-30 1765.44-33.44Q1768.89-36.89 1768.89-43.33L1768.89-43.33L1768.89-49.56Q1768.89-56 1765.44-59.44Q1762-62.89 1755.56-62.89L1755.56-62.89L1666.67-62.89Q1622.22-62.89 1622.22-106.67L1622.22-106.67L1622.22-111.11Q1622.22-155.56 1666.67-155.56L1666.67-155.56L1755.56-155.56Q1800-155.56 1800-111.11L1800-111.11L1800-106.67L1766.67-106.67L1766.67-112.22Q1766.67-118.67 1763.22-122.11Q1759.78-125.56 1753.33-125.56L1753.33-125.56L1668.89-125.56Q1662.44-125.56 1659-122.11Q1655.56-118.67 1655.56-112.22L1655.56-112.22L1655.56-106.67Q1655.56-92.89 1668.89-92.89L1668.89-92.89L1757.78-92.89Q1802.22-92.89 1802.22-48.89L1802.22-48.89L1802.22-44.44Q1802.22 0 1757.78 0L1757.78 0L1666.67 0Z" +
        "M1824.44-155.56L1986.67-155.56L1986.67-124.44L1857.78-124.44L1857.78-93.33L1982.22-93.33L1982.22-62.22L1857.78-62.22L1857.78-31.11L1986.67-31.11L1986.67 0L1824.44 0L1824.44-155.56Z";
    const float WordmarkLeft = 1.11f, WordmarkWidth = 1985.56f, WordmarkHeight = 155.56f;
    static GraphicsPath wordmark;

    /// <summary>XENITHPULSE, centred on cx, sitting on `baseline`, cap height `height`.</summary>
    public static void DrawWordmark(Graphics g, float cx, float baseline, float height, Color color)
    {
        if (wordmark == null) wordmark = ParseSvgPath(WordmarkSvg);
        float k = height / WordmarkHeight;
        using (GraphicsPath path = (GraphicsPath)wordmark.Clone())
        using (Matrix m = new Matrix())
        using (SolidBrush brush = new SolidBrush(color))
        {
            m.Translate(cx - (WordmarkLeft + WordmarkWidth / 2f) * k, baseline);
            m.Scale(k, k);
            path.Transform(m);
            g.FillPath(brush, path);
        }
    }

    public static float WordmarkWidthAt(float height)
    {
        return WordmarkWidth * height / WordmarkHeight;
    }

    /// <summary>Absolute M, L, Q and Z: all the kit's wordmark uses.</summary>
    static GraphicsPath ParseSvgPath(string d)
    {
        GraphicsPath path = new GraphicsPath(FillMode.Alternate);
        List<string> tokens = Tokenize(d);
        PointF current = PointF.Empty;
        int i = 0;
        char command = 'M';
        while (i < tokens.Count)
        {
            if (char.IsLetter(tokens[i][0])) command = tokens[i++][0];
            switch (command)
            {
                case 'M':
                    path.StartFigure();
                    current = new PointF(Num(tokens[i]), Num(tokens[i + 1]));
                    i += 2;
                    command = 'L';
                    break;
                case 'L':
                    {
                        PointF next = new PointF(Num(tokens[i]), Num(tokens[i + 1]));
                        path.AddLine(current, next);
                        current = next;
                        i += 2;
                        break;
                    }
                case 'Q':
                    {
                        PointF c = new PointF(Num(tokens[i]), Num(tokens[i + 1]));
                        PointF end = new PointF(Num(tokens[i + 2]), Num(tokens[i + 3]));
                        // A quadratic is a cubic with both controls two thirds of the way to its one.
                        PointF c1 = new PointF(current.X + 2f / 3f * (c.X - current.X), current.Y + 2f / 3f * (c.Y - current.Y));
                        PointF c2 = new PointF(end.X + 2f / 3f * (c.X - end.X), end.Y + 2f / 3f * (c.Y - end.Y));
                        path.AddBezier(current, c1, c2, end);
                        current = end;
                        i += 4;
                        break;
                    }
                case 'Z':
                    path.CloseFigure();
                    break;
                default:
                    throw new FormatException("Unsupported path command " + command);
            }
        }
        return path;
    }

    static List<string> Tokenize(string d)
    {
        List<string> tokens = new List<string>();
        int i = 0;
        while (i < d.Length)
        {
            char c = d[i];
            if (char.IsLetter(c)) { tokens.Add(c.ToString()); i++; continue; }
            if (c == ' ' || c == ',') { i++; continue; }
            int start = i++;
            while (i < d.Length && (char.IsDigit(d[i]) || d[i] == '.')) i++;
            tokens.Add(d.Substring(start, i - start));
        }
        return tokens;
    }

    static float Num(string s)
    {
        return float.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    // â”€â”€ Shapes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    public static GraphicsPath Rounded(RectangleF r, float radius)
    {
        GraphicsPath p = new GraphicsPath();
        float d = Math.Min(radius * 2f, Math.Min(r.Width, r.Height));
        if (d <= 0.5f)
        {
            p.AddRectangle(r);
            return p;
        }
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    /// <summary>A tick inside `box`, as on a checkbox or a "done" badge.</summary>
    public static void DrawTick(Graphics g, RectangleF box, Color color, float stroke)
    {
        PointF[] tick =
        {
            new PointF(box.X + box.Width * 0.22f, box.Y + box.Height * 0.53f),
            new PointF(box.X + box.Width * 0.42f, box.Y + box.Height * 0.72f),
            new PointF(box.X + box.Width * 0.78f, box.Y + box.Height * 0.32f)
        };
        using (Pen pen = RoundPen(color, stroke)) g.DrawLines(pen, tick);
    }

    /// <summary>Text drawn as a vector path, with optional letter spacing (GDI+ has none).</summary>
    public static void DrawTracked(Graphics g, string text, Font font, Color color, float cx, float top, float tracking)
    {
        using (StringFormat format = (StringFormat)StringFormat.GenericTypographic.Clone())
        using (GraphicsPath path = new GraphicsPath())
        using (SolidBrush brush = new SolidBrush(color))
        {
            format.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces;
            float emPx = font.Size;
            float x = 0;
            foreach (char ch in text)
            {
                string s = ch.ToString();
                path.AddString(s, font.FontFamily, (int)font.Style, emPx, new PointF(x, 0), format);
                x += g.MeasureString(s, font, PointF.Empty, format).Width + tracking;
            }
            x -= tracking;
            using (Matrix m = new Matrix())
            {
                m.Translate(cx - x / 2f, top);
                path.Transform(m);
            }
            g.FillPath(brush, path);
        }
    }
}
