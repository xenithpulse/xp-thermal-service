// ThermalBridgeTray.exe - the system tray icon for Thermal Bridge.
//
// A dumb view: it draws the icon and menu, prints the item the user clicked
// to stdout, and applies whatever state arrives on stdin (one tab-separated
// message per line; see src/app/tray.ts). When stdin closes - Thermal Bridge
// quit or crashed - it removes the icon and exits, so it can never outlive
// the app it belongs to.
//
// Built by scripts/build-exe.mjs with the C# compiler that ships with the
// .NET Framework on every Windows 10 and 11 machine.

using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class TrayHost
{
    static NotifyIcon icon;
    static ToolStripMenuItem header;
    static ToolStripMenuItem printers;
    static ToolStripMenuItem startup;
    static StreamWriter output;
    static Control ui;

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;

        // A window handle to marshal stdin messages onto the UI thread.
        ui = new Control();
        ui.CreateControl();

        var menu = new ContextMenuStrip();
        header = new ToolStripMenuItem("Thermal Bridge") { Enabled = false };
        menu.Items.Add(header);
        menu.Items.Add(new ToolStripSeparator());
        var open = Item("Open dashboard", "open");
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add(open);
        menu.Items.Add(Item("Print test page", "test"));
        printers = new ToolStripMenuItem("Printers");
        printers.DropDownItems.Add(new ToolStripMenuItem("No printers yet") { Enabled = false });
        menu.Items.Add(printers);
        menu.Items.Add(new ToolStripSeparator());
        startup = Item("Start with Windows", "startup");
        menu.Items.Add(startup);
        menu.Items.Add(Item("Open logs folder", "logs"));
        menu.Items.Add(Item("Check for updates", "updates"));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item("Quit", "quit"));

        icon = new NotifyIcon();
        icon.Icon = LoadIcon(args.Length > 0 ? args[0] : null);
        icon.Text = "Thermal Bridge";
        icon.ContextMenuStrip = menu;
        icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Send("open"); };
        icon.BalloonTipClicked += (s, e) => Send("open");
        icon.Visible = true;

        new Thread(ReadLoop) { IsBackground = true }.Start();
        Application.Run();

        icon.Visible = false;
        icon.Dispose();
    }

    static ToolStripMenuItem Item(string text, string command)
    {
        var item = new ToolStripMenuItem(text);
        item.Click += (s, e) => Send(command);
        return item;
    }

    static Icon LoadIcon(string path)
    {
        try
        {
            if (path != null && File.Exists(path)) return new Icon(path, SystemInformation.SmallIconSize);
        }
        catch { }
        return SystemIcons.Application;
    }

    static void Send(string command)
    {
        try { output.WriteLine(command); }
        catch { Application.ExitThread(); }
    }

    static void ReadLoop()
    {
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = input.ReadLine()) != null)
        {
            var message = line;
            ui.BeginInvoke((MethodInvoker)(() => Apply(message)));
        }
        ui.BeginInvoke((MethodInvoker)(() => Application.ExitThread()));
    }

    static void Apply(string line)
    {
        var f = line.Split('\t');
        switch (f[0])
        {
            case "header":
                if (f.Length > 1) header.Text = f[1];
                break;
            case "tooltip":
                // NotifyIcon refuses text longer than 63 characters.
                if (f.Length > 1) icon.Text = f[1].Length > 63 ? f[1].Substring(0, 63) : f[1];
                break;
            case "startup":
                startup.Checked = f.Length > 1 && f[1] == "1";
                break;
            case "printers":
                printers.DropDownItems.Clear();
                for (int i = 1; i < f.Length; i++)
                {
                    int bar = f[i].LastIndexOf('|');
                    if (bar < 0) continue;
                    bool online = f[i].Substring(bar + 1) == "1";
                    var item = new ToolStripMenuItem(f[i].Substring(0, bar) + (online ? "  -  online" : "  -  offline"));
                    item.Click += (s, e) => Send("printers");
                    printers.DropDownItems.Add(item);
                }
                if (printers.DropDownItems.Count == 0)
                    printers.DropDownItems.Add(new ToolStripMenuItem("No printers yet") { Enabled = false });
                break;
            case "notify":
                if (f.Length > 2) icon.ShowBalloonTip(5000, f[1], f[2], ToolTipIcon.Info);
                break;
            case "exit":
                Application.ExitThread();
                break;
        }
    }
}
