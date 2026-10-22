// ThermalBridgeService.exe - the Windows service wrapper for Thermal Bridge.
//
// Windows only starts a service binary that answers the Service Control
// Manager, which a Node executable cannot do. This does that and nothing
// else: on start it runs "ThermalBridge.exe --service" from its own folder,
// and on stop it closes that process's stdin, which is Thermal Bridge's cue to
// finish in-flight receipts and exit.
//
// If Thermal Bridge exits on its own, this exits with an error so the
// service's recovery actions (restart after 5s, 10s, 30s) bring it back.
//
// Built by scripts/build-exe.mjs; registered by "ThermalBridge.exe --install-service".

using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

class ThermalBridgeService : ServiceBase
{
    Process app;
    volatile bool stopping;

    ThermalBridgeService()
    {
        ServiceName = "ThermalBridge";
        CanStop = true;
        CanShutdown = true;
        AutoLog = true;
    }

    static void Main()
    {
        ServiceBase.Run(new ThermalBridgeService());
    }

    protected override void OnStart(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        var info = new ProcessStartInfo(Path.Combine(dir, "ThermalBridge.exe"), "--service")
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            CreateNoWindow = true,
            WorkingDirectory = dir
        };
        app = Process.Start(info);
        app.EnableRaisingEvents = true;
        app.Exited += (s, e) =>
        {
            if (stopping) return;
            EventLog.WriteEntry("Thermal Bridge exited unexpectedly (code " + app.ExitCode + "); Windows will restart the service.",
                EventLogEntryType.Warning);
            // Exiting without reporting STOPPED counts as a failure, which is
            // what triggers the recovery actions.
            Environment.Exit(1);
        };
    }

    protected override void OnStop()
    {
        stopping = true;
        RequestAdditionalTime(30000);
        try { app.StandardInput.Close(); } catch { }
        try
        {
            if (!app.WaitForExit(25000)) app.Kill();
        }
        catch { }
    }

    protected override void OnShutdown()
    {
        OnStop();
    }
}
