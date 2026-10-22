// ThermalBridge-Setup.exe and Uninstall.exe - the Thermal Bridge installer.
//
// One program, built twice by scripts/build-exe.mjs: with ThermalBridge.exe
// packed inside it is the setup; without, it is the uninstaller that setup
// leaves in the program folder. Per-user, never elevated.
//
//   ThermalBridge-Setup.exe                 install, with the window
//   ThermalBridge-Setup.exe /S              install silently, then start Thermal Bridge in the background
//   ThermalBridge-Setup.exe /S /NOLAUNCH    install silently, start nothing
//   ThermalBridge-Setup.exe --update        what the dashboard runs: install straight away, then restart the app
//   Uninstall.exe [/S]                      uninstall (silent keeps settings and print history)
//   ThermalBridge-Setup.exe /uninstall      the same, from the setup file
//
// /SILENT and /VERYSILENT mean /S; /SUPPRESSMSGBOXES and /NORESTART are
// accepted and ignored, so existing deployment scripts keep working.
//
// Exit codes: 0 done, 1 failed, 2 cancelled.
//
// Built with the C# compiler that ships with the .NET Framework on every
// Windows 10 and 11 machine (C# 5).

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

/// <summary>What this run is doing, shared by the window and the silent path.</summary>
sealed class Session
{
    public bool Uninstall;
    public bool Update;
    public bool Silent;
    public bool NoLaunch;
    public bool DeleteData;
    public string Version = BuildInfo.Version;
    public string InstalledVersion;
    public string UserName = Environment.UserName;
    /// <summary>Called on the worker thread once an uninstall has succeeded.</summary>
    public Action Removed;
}

sealed class Options
{
    public bool Silent, NoLaunch, Update, Uninstall;
    public int ParentPid;

    public static Options Parse(string[] args)
    {
        Options o = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i].Trim().TrimStart('/', '-').ToLowerInvariant();
            switch (a)
            {
                case "s":
                case "silent":
                case "verysilent":
                    o.Silent = true;
                    break;
                case "nolaunch":
                case "no-launch":
                    o.NoLaunch = true;
                    break;
                case "update":
                    o.Update = true;
                    break;
                case "uninstall":
                    o.Uninstall = true;
                    break;
                case "phase2":
                    if (i + 1 < args.Length) int.TryParse(args[++i], out o.ParentPid);
                    break;
                default:
                    // /SUPPRESSMSGBOXES, /NORESTART and anything else: nothing to do.
                    break;
            }
        }
        return o;
    }
}

static class Program
{
    const string MutexName = @"Local\XenithPulse.ThermalBridge.Setup";

    [STAThread]
    static int Main(string[] args)
    {
        Options options = Options.Parse(args);
        bool uninstall = options.Uninstall || !Payload.Present;
        string self = Application.ExecutablePath;
        Log.Write((uninstall ? "Uninstall " : "Setup ") + BuildInfo.Version + " started: " + string.Join(" ", args));

        // Uninstall.exe cannot delete itself, or the folder it runs from. So the
        // copy in the program folder hands over to a copy in %TEMP%, and waits.
        if (uninstall && options.ParentPid == 0 && Engine.IsInInstallDir(self))
            return HandOverToTempCopy(self, args);

        try
        {
            bool created;
            using (Mutex mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    Log.Write("Another setup is already running");
                    if (!options.Silent) BringOtherWindowForward();
                    return 1;
                }

                Session session = new Session();
                session.Uninstall = uninstall;
                session.Update = options.Update && !uninstall;
                session.Silent = options.Silent;
                session.NoLaunch = options.NoLaunch;
                session.InstalledVersion = Engine.InstalledVersion();
                if (uninstall && options.ParentPid != 0) session.Removed = SignalParent(options.ParentPid);

                int code = options.Silent ? RunSilent(session) : RunWindow(session);
                if (uninstall && code == 0) Engine.FinishUninstall(options.ParentPid);
                Log.Write("Finished with exit code " + code);
                return code;
            }
        }
        finally
        {
            if (options.ParentPid != 0) DeleteSelfLater(self);
        }
    }

    static int RunWindow(Session session)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (SetupWindow window = new SetupWindow(session))
        {
            Application.Run(window);
            return window.ExitCode;
        }
    }

    static int RunSilent(Session session)
    {
        try
        {
            if (session.Uninstall)
            {
                Engine.Uninstall(false, null);
                if (session.Removed != null) session.Removed();
            }
            else
            {
                Engine.Install(null);
                if (!session.NoLaunch) Engine.Launch(true);
            }
            return 0;
        }
        catch (Exception e)
        {
            Log.Write("Failed: " + e);
            return 1;
        }
    }

    // ── Uninstalling from the program folder ──────────────────────────────────

    static string DoneEventName(int parentPid)
    {
        return @"Local\XenithPulse.ThermalBridge.Uninstalled." + parentPid;
    }

    /// <summary>
    /// Run the uninstall from a copy in %TEMP% and wait for it, so whoever
    /// started Uninstall.exe (Apps &amp; Features, a script waiting on /S) sees
    /// it finish. The copy signals once the app is removed; this process then
    /// exits so the copy can delete Uninstall.exe and the folder.
    /// </summary>
    static int HandOverToTempCopy(string self, string[] args)
    {
        string temp = Path.Combine(Path.GetTempPath(), "ThermalBridge-Uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
        int pid = Process.GetCurrentProcess().Id;
        try
        {
            File.Copy(self, temp, true);
            using (EventWaitHandle done = new EventWaitHandle(false, EventResetMode.ManualReset, DoneEventName(pid)))
            {
                ProcessStartInfo start = new ProcessStartInfo(temp, Quote(args) + " --phase2 " + pid);
                start.UseShellExecute = false;
                using (Process child = Process.Start(start))
                using (ProcessWait exited = new ProcessWait(child))
                {
                    if (WaitHandle.WaitAny(new WaitHandle[] { done, exited }) == 0) return 0;
                    child.WaitForExit();
                    return child.ExitCode;
                }
            }
        }
        catch (Exception e)
        {
            Log.Write("Could not start the uninstaller from " + temp + ": " + e);
            if (Options.Parse(args).Silent) return 1;
            MessageBox.Show("Thermal Bridge could not be uninstalled: " + e.Message, "Uninstall Thermal Bridge",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static Action SignalParent(int parentPid)
    {
        return delegate
        {
            try
            {
                EventWaitHandle done;
                if (EventWaitHandle.TryOpenExisting(DoneEventName(parentPid), out done))
                    using (done) done.Set();
            }
            catch (Exception e)
            {
                Log.Write("Could not signal the waiting uninstaller: " + e.Message);
            }
        };
    }

    /// <summary>The temporary copy cannot delete itself while running; cmd does it a moment later.</summary>
    static void DeleteSelfLater(string self)
    {
        try
        {
            ProcessStartInfo start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/d /c ping -n 3 127.0.0.1 >nul & del /f /q \"" + self + "\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(start).Dispose();
        }
        catch (Exception)
        {
            // %TEMP% is cleaned by Windows eventually.
        }
    }

    static string Quote(string[] args)
    {
        StringBuilder line = new StringBuilder();
        foreach (string a in args)
        {
            if (line.Length > 0) line.Append(' ');
            line.Append(a.IndexOf(' ') >= 0 ? "\"" + a + "\"" : a);
        }
        return line.ToString();
    }

    static void BringOtherWindowForward()
    {
        foreach (string title in new[] { "Thermal Bridge Setup", "Uninstall Thermal Bridge" })
        {
            IntPtr hwnd = FindWindow(null, title);
            if (hwnd != IntPtr.Zero)
            {
                ShowWindow(hwnd, 9); // SW_RESTORE
                SetForegroundWindow(hwnd);
                return;
            }
        }
    }

    sealed class ProcessWait : WaitHandle
    {
        public ProcessWait(Process process)
        {
            SafeWaitHandle = new SafeWaitHandle(process.Handle, false);
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern IntPtr FindWindow(string className, string windowName);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int command);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hwnd);
}
