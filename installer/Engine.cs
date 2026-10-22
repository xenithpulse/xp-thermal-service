// Engine.cs - what installing and uninstalling actually do. No UI here: the
// window (SetupWindow.cs) and the silent path (Setup.cs) both call in, and
// get progress back through a Report callback.
//
// Install, for the current Windows user only, with no admin rights:
//   %LOCALAPPDATA%\Programs\ThermalBridge\ThermalBridge.exe   the app
//   %LOCALAPPDATA%\Programs\ThermalBridge\Uninstall.exe       this program, without the payload
//   Start Menu\Programs\Thermal Bridge.lnk
//   HKCU\...\Uninstall\ThermalBridge                          Apps & Features entry
//
// The app keeps its settings and print history in %LOCALAPPDATA%\ThermalBridge.
// Installing never touches that folder; uninstalling deletes it only when
// asked to.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

delegate void Report(float from, float to, string step);

/// <summary>A failure with a message meant for the person installing.</summary>
sealed class SetupException : Exception
{
    public SetupException(string message) : base(message) { }
    public SetupException(string message, Exception inner) : base(message, inner) { }
}

static class Engine
{
    public const string HomepageUrl = "https://xenithpulse.com/products/thermal-bridge";
    public const string SupportUrl = "https://github.com/xenithpulse/xp-thermal-service/issues";
    public const string ReleasesUrl = "https://github.com/xenithpulse/xp-thermal-service/releases";

    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ThermalBridge";
    // Thermal Bridge 3.0.1's first installer registered itself under this key,
    // with its own uninstaller files (unins000.exe/.dat) beside the app.
    // Installing replaces both with ours, so Apps & Features lists one entry.
    const string PreviousUninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{B6E0F7A2-3C1D-4E8B-9A57-2D4C6E8F1B30}_is1";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunValue = "ThermalBridge";

    public static readonly string LocalAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    public static readonly string InstallDir = Path.Combine(LocalAppData, "Programs", "ThermalBridge");
    public static readonly string AppExe = Path.Combine(InstallDir, "ThermalBridge.exe");
    public static readonly string UninstallExe = Path.Combine(InstallDir, "Uninstall.exe");
    public static readonly string DataDir = Path.Combine(LocalAppData, "ThermalBridge");
    public static readonly string Shortcut = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Thermal Bridge.lnk");

    // ── Detection ─────────────────────────────────────────────────────────────

    /// <summary>The installed version, or null when the app is not installed.</summary>
    public static string InstalledVersion()
    {
        if (!File.Exists(AppExe)) return null;
        string version = ReadString(UninstallKey, "DisplayVersion") ?? ReadString(PreviousUninstallKey, "DisplayVersion");
        if (version == null)
        {
            try { version = FileVersionInfo.GetVersionInfo(AppExe).ProductVersion; }
            catch (Exception) { version = null; }
        }
        return string.IsNullOrEmpty(version) ? "unknown" : version.Trim();
    }

    /// <summary>Compare two "major.minor.patch" versions; prerelease tags are ignored.</summary>
    public static int CompareVersions(string a, string b)
    {
        Version va = ParseVersion(a), vb = ParseVersion(b);
        if (va == null || vb == null) return 0;
        return va.CompareTo(vb);
    }

    static Version ParseVersion(string value)
    {
        if (value == null) return null;
        int dash = value.IndexOf('-');
        Version v;
        return Version.TryParse(dash >= 0 ? value.Substring(0, dash) : value, out v) ? v : null;
    }

    public static bool IsInInstallDir(string file)
    {
        return SamePath(Path.GetDirectoryName(file), InstallDir);
    }

    static bool SamePath(string a, string b)
    {
        return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }

    // ── Install ───────────────────────────────────────────────────────────────

    public static void Install(Report report)
    {
        Log.Write("Installing " + BuildInfo.Version + " into " + InstallDir);

        Step(report, 0f, 0.14f, "Closing Thermal Bridge…");
        QuitRunningCopy();

        Step(report, 0.14f, 0.8f, "Installing Thermal Bridge…");
        byte[] app = Payload.Extract();
        Directory.CreateDirectory(InstallDir);
        RemoveLeftovers();
        WriteFile(AppExe, app);
        WriteFile(UninstallExe, Payload.Uninstaller());

        Step(report, 0.8f, 0.92f, "Creating shortcuts…");
        RemovePreviousInstaller();
        CreateShortcut();

        Step(report, 0.92f, 1f, "Finishing…");
        WriteUninstallEntry(app.Length);
        Log.Write("Installed");
    }

    /// <summary>Start the installed app. With no flags it opens the dashboard.</summary>
    public static void Launch(bool background)
    {
        ProcessStartInfo start = new ProcessStartInfo(AppExe);
        start.UseShellExecute = false;
        start.WorkingDirectory = InstallDir;
        if (background) start.Arguments = "--background";
        Process.Start(start);
        Log.Write("Started Thermal Bridge" + (background ? " in the background" : ""));
    }

    static void Step(Report report, float from, float to, string step)
    {
        if (report != null) report(from, to, step);
    }

    /// <summary>
    /// Ask a running copy to finish its receipts and exit, so its files can be
    /// replaced. It answers on a named pipe (src/app/instance.ts) and waits up
    /// to 30 seconds for jobs in flight. Anything still running from the
    /// install folder after that is stopped.
    /// </summary>
    static void QuitRunningCopy()
    {
        if (File.Exists(AppExe))
        {
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(AppExe, "--quit");
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WorkingDirectory = InstallDir;
                using (Process quit = Process.Start(start))
                {
                    if (!quit.WaitForExit(45000))
                    {
                        Log.Write("--quit did not return in 45 s");
                        try { quit.Kill(); } catch (Exception) { }
                    }
                }
            }
            catch (Exception e)
            {
                Log.Write("Could not ask Thermal Bridge to quit: " + e.Message);
            }
        }

        DateTime deadline = DateTime.UtcNow.AddSeconds(8);
        while (true)
        {
            Process[] running = RunningFromInstallDir();
            if (running.Length == 0) return;
            if (DateTime.UtcNow > deadline)
            {
                foreach (Process p in running)
                {
                    Log.Write("Stopping process " + p.Id + " (still running after the quit request)");
                    try { p.Kill(); p.WaitForExit(5000); } catch (Exception) { }
                }
                return;
            }
            foreach (Process p in running) p.Dispose();
            Thread.Sleep(250);
        }
    }

    static Process[] RunningFromInstallDir()
    {
        var found = new System.Collections.Generic.List<Process>();
        foreach (Process p in Process.GetProcessesByName("ThermalBridge"))
        {
            try
            {
                if (IsInInstallDir(p.MainModule.FileName)) { found.Add(p); continue; }
            }
            catch (Exception)
            {
                // Another user's process, or one that just exited.
            }
            p.Dispose();
        }
        return found.ToArray();
    }

    /// <summary>
    /// Write next to the target, then swap it in. A running exe cannot be
    /// overwritten or deleted, but it can be renamed, so the old file is moved
    /// aside first and deleted if possible (or on the next install if not).
    /// </summary>
    static void WriteFile(string target, byte[] data)
    {
        string fresh = target + ".new";
        File.WriteAllBytes(fresh, data);

        for (int attempt = 1; ; attempt++)
        {
            try
            {
                if (File.Exists(target))
                {
                    string old = target + ".old";
                    TryDelete(old);
                    if (File.Exists(old)) old = target + "." + DateTime.UtcNow.Ticks + ".old";
                    File.Move(target, old);
                    TryDelete(old);
                }
                File.Move(fresh, target);
                return;
            }
            catch (Exception e)
            {
                if (!(e is IOException || e is UnauthorizedAccessException)) throw;
                Log.Write("Replacing " + Path.GetFileName(target) + ", attempt " + attempt + ": " + e.Message);
                if (attempt >= 8)
                {
                    TryDelete(fresh);
                    throw new SetupException(
                        "Thermal Bridge is still running and could not be updated. Quit it from its icon in the system tray, then try again.", e);
                }
                Thread.Sleep(250 * attempt);
            }
        }
    }

    /// <summary>Files set aside by an earlier install that could not delete them then.</summary>
    static void RemoveLeftovers()
    {
        foreach (string pattern in new[] { "*.old", "*.new" })
            foreach (string file in Directory.GetFiles(InstallDir, pattern)) TryDelete(file);
    }

    static void RemovePreviousInstaller()
    {
        try
        {
            // unins000.exe, unins000.dat, unins001.msg... and never Uninstall.exe, which "unins*" would also match.
            Regex previous = new Regex(@"^unins\d{3}\.(exe|dat|msg)$", RegexOptions.IgnoreCase);
            foreach (string file in Directory.GetFiles(InstallDir))
                if (previous.IsMatch(Path.GetFileName(file))) TryDelete(file);
            Registry.CurrentUser.DeleteSubKeyTree(PreviousUninstallKey, false);
        }
        catch (Exception e)
        {
            Log.Write("Could not remove the previous uninstaller: " + e.Message);
        }
    }

    static void WriteUninstallEntry(long appBytes)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            key.SetValue("DisplayName", "Thermal Bridge");
            key.SetValue("DisplayVersion", BuildInfo.Version);
            key.SetValue("Publisher", "XenithPulse");
            key.SetValue("DisplayIcon", AppExe + ",0");
            key.SetValue("InstallLocation", InstallDir);
            key.SetValue("UninstallString", "\"" + UninstallExe + "\"");
            key.SetValue("QuietUninstallString", "\"" + UninstallExe + "\" /S");
            key.SetValue("URLInfoAbout", HomepageUrl);
            key.SetValue("HelpLink", SupportUrl);
            key.SetValue("URLUpdateInfo", ReleasesUrl);
            key.SetValue("Comments", "Silent receipt printing for web apps");
            key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            long bytes = appBytes;
            try { bytes += new FileInfo(UninstallExe).Length; } catch (Exception) { }
            key.SetValue("EstimatedSize", (int)(bytes / 1024), RegistryValueKind.DWord);
        }
    }

    // ── Uninstall ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Remove everything but Uninstall.exe itself, which is still running (or
    /// whose first copy is still waiting) and goes in FinishUninstall.
    /// </summary>
    public static void Uninstall(bool deleteData, Report report)
    {
        Log.Write("Uninstalling from " + InstallDir + (deleteData ? ", deleting settings" : ", keeping settings"));

        Step(report, 0f, 0.35f, "Closing Thermal Bridge…");
        QuitRunningCopy();

        Step(report, 0.35f, 0.75f, "Removing Thermal Bridge…");
        RemoveStartWithWindows();
        TryDelete(Shortcut);
        if (Directory.Exists(InstallDir))
        {
            foreach (string file in Directory.GetFiles(InstallDir))
            {
                if (SamePath(file, UninstallExe)) continue;
                DeleteWithRetry(file);
            }
        }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch (Exception) { }
        try { Registry.CurrentUser.DeleteSubKeyTree(PreviousUninstallKey, false); } catch (Exception) { }

        if (deleteData)
        {
            Step(report, 0.75f, 1f, "Deleting settings and print history…");
            DeleteDirectoryWithRetry(DataDir);
        }
        else
        {
            Step(report, 0.75f, 1f, "Finishing…");
            ForgetStartupChoice();
        }
        Log.Write("Uninstalled");
    }

    /// <summary>
    /// The app registers "Start with Windows" once, then remembers that it did
    /// (app-state.json, src/app/app-state.ts) so turning it off sticks across
    /// updates. Uninstalling removed the registration, so forget that too: a
    /// later install should start with Windows again, as its first page says.
    /// </summary>
    static void ForgetStartupChoice()
    {
        string file = Path.Combine(DataDir, "app-state.json");
        try
        {
            if (!File.Exists(file)) return;
            JavaScriptSerializer json = new JavaScriptSerializer();
            Dictionary<string, object> state = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file).TrimStart('﻿'));
            if (state == null || !state.Remove("startupConfigured")) return;
            File.WriteAllText(file, json.Serialize(state));
        }
        catch (Exception e)
        {
            Log.Write("Could not update " + file + ": " + e.Message);
        }
    }

    /// <summary>Delete Uninstall.exe and the program folder, once nothing runs from it.</summary>
    public static void FinishUninstall(int waitForPid)
    {
        if (waitForPid > 0)
        {
            try
            {
                using (Process parent = Process.GetProcessById(waitForPid)) parent.WaitForExit(15000);
            }
            catch (ArgumentException)
            {
                // Already gone.
            }
        }

        if (!SamePath(System.Windows.Forms.Application.ExecutablePath, UninstallExe)) DeleteWithRetry(UninstallExe);
        try
        {
            if (Directory.Exists(InstallDir) && Directory.GetFileSystemEntries(InstallDir).Length == 0)
                Directory.Delete(InstallDir);
        }
        catch (Exception e)
        {
            Log.Write("Could not remove " + InstallDir + ": " + e.Message);
        }
    }

    /// <summary>"Start with Windows" goes with the app, but only if it points at this install.</summary>
    static void RemoveStartWithWindows()
    {
        try
        {
            using (RegistryKey run = Registry.CurrentUser.OpenSubKey(RunKey, true))
            {
                if (run == null) return;
                string command = run.GetValue(RunValue) as string;
                if (command != null && command.IndexOf(InstallDir, StringComparison.OrdinalIgnoreCase) >= 0)
                    run.DeleteValue(RunValue, false);
            }
        }
        catch (Exception e)
        {
            Log.Write("Could not remove Start with Windows: " + e.Message);
        }
    }

    // ── Shortcut ──────────────────────────────────────────────────────────────

    static void CreateShortcut()
    {
        IShellLinkW link = (IShellLinkW)new ShellLink();
        try
        {
            link.SetPath(AppExe);
            link.SetWorkingDirectory(InstallDir);
            link.SetDescription("Silent receipt printing for web apps");
            link.SetIconLocation(AppExe, 0);
            Directory.CreateDirectory(Path.GetDirectoryName(Shortcut));
            ((IPersistFile)link).Save(Shortcut, true);
        }
        finally
        {
            Marshal.ReleaseComObject(link);
        }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr findData, int flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int max);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int max);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCmd);
        void SetShowCmd(int showCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int max, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, int reserved);
        void Resolve(IntPtr hwnd, int flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    // ── Files and registry ────────────────────────────────────────────────────

    static string ReadString(string keyPath, string name)
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(keyPath))
                return key == null ? null : key.GetValue(name) as string;
        }
        catch (Exception)
        {
            return null;
        }
    }

    static void TryDelete(string file)
    {
        try { if (File.Exists(file)) File.Delete(file); } catch (Exception) { }
    }

    static void DeleteWithRetry(string file)
    {
        for (int attempt = 1; File.Exists(file); attempt++)
        {
            try
            {
                File.Delete(file);
            }
            catch (Exception e)
            {
                if (attempt >= 10)
                {
                    Log.Write("Could not delete " + file + ": " + e.Message);
                    throw new SetupException("Windows would not let " + Path.GetFileName(file) +
                        " be removed. Restart the computer, then uninstall again.", e);
                }
                Thread.Sleep(200 * attempt);
            }
        }
    }

    static void DeleteDirectoryWithRetry(string dir)
    {
        for (int attempt = 1; Directory.Exists(dir); attempt++)
        {
            try
            {
                Directory.Delete(dir, true);
            }
            catch (Exception e)
            {
                if (attempt >= 10)
                {
                    // The program is gone either way; a log file held open by
                    // something else should not turn that into a failure.
                    Log.Write("Could not delete " + dir + ": " + e.Message);
                    return;
                }
                Thread.Sleep(250 * attempt);
            }
        }
    }
}

/// <summary>The app exe and the uninstaller, embedded in the setup exe.</summary>
static class Payload
{
    const string AppResource = "ThermalBridge.exe.lzms";
    const string UninstallerResource = "Uninstall.exe";

    /// <summary>False in Uninstall.exe, which is this program without the app inside.</summary>
    public static bool Present
    {
        get { return typeof(Payload).Assembly.GetManifestResourceInfo(AppResource) != null; }
    }

    public static byte[] Extract()
    {
        byte[] app;
        try
        {
            app = Lzms.Decompress(ReadResource(AppResource), BuildInfo.AppSize);
        }
        catch (Exception e)
        {
            Log.Write("Unpacking failed: " + e);
            throw new SetupException("This installer file is damaged. Download it again from xenithpulse.com.", e);
        }

        string hash;
        using (SHA256 sha = SHA256.Create()) hash = Hex(sha.ComputeHash(app));
        if (!string.Equals(hash, BuildInfo.AppSha256, StringComparison.OrdinalIgnoreCase))
        {
            Log.Write("Checksum mismatch: " + hash + " != " + BuildInfo.AppSha256);
            throw new SetupException("This installer file is damaged. Download it again from xenithpulse.com.");
        }
        return app;
    }

    public static byte[] Uninstaller()
    {
        return ReadResource(UninstallerResource);
    }

    static byte[] ReadResource(string name)
    {
        using (Stream stream = typeof(Payload).Assembly.GetManifestResourceStream(name))
        {
            if (stream == null) throw new SetupException("This installer file is incomplete. Download it again from xenithpulse.com.");
            byte[] data = new byte[stream.Length];
            int read = 0;
            while (read < data.Length)
            {
                int n = stream.Read(data, read, data.Length - read);
                if (n <= 0) throw new EndOfStreamException();
                read += n;
            }
            return data;
        }
    }

    static string Hex(byte[] bytes)
    {
        StringBuilder text = new StringBuilder(bytes.Length * 2);
        foreach (byte b in bytes) text.Append(b.ToString("x2"));
        return text.ToString();
    }
}

/// <summary>%TEMP%\ThermalBridge-Setup.log: what happened, for support.</summary>
static class Log
{
    public static readonly string FilePath = Path.Combine(Path.GetTempPath(), "ThermalBridge-Setup.log");
    static readonly object Gate = new object();

    public static void Write(string line)
    {
        try
        {
            lock (Gate)
            {
                File.AppendAllText(FilePath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  [" +
                    Process.GetCurrentProcess().Id + "] " + line + Environment.NewLine);
            }
        }
        catch (Exception)
        {
            // Logging is never a reason to fail an install.
        }
    }
}
