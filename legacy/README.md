# Legacy scripts (XP Thermal Service 1.x)

These scripts installed the old **XP Thermal Print Service**: Node.js 18+
installed separately, `setup.bat` run as Administrator, a `node-windows`
service under `C:\ProgramData\XPThermalService`, a firewall rule, and two
scheduled watchdog tasks.

Thermal Bridge replaces all of that with one installer that needs no Node.js
and no admin rights (see the main [README](../README.md)). These files are kept
only so existing installs can still be repaired or removed.

| Script | What it does |
|---|---|
| `uninstall.bat` | **Removes the old service**, its firewall rule and its scheduled tasks. Run as Administrator. Settings in `C:\ProgramData\XPThermalService` are kept. |
| `setup.bat` | Old one-click installer. Run from this folder of a full repository checkout, as Administrator. |
| `install.ps1` | The installer behind `setup.bat` (`-Repair`, `-Restart`, `-Uninstall`, ...). |
| `install.bat` | Wrapper for `install.ps1`. |
| `diagnose.ps1` | Health report for the old service. |
| `trigger-restart.ps1` | Asks the old service to restart via its trigger file. |

To move from the old service to Thermal Bridge:

1. Install Thermal Bridge. While the old service is running, Thermal Bridge
   leaves printing to it and says so in the tray.
2. In the Thermal Bridge dashboard, click **Import printers** to copy the old
   printer settings across.
3. Remove the old service: run `legacy\uninstall.bat` as Administrator, or in
   an Administrator prompt run `sc stop xpthermalprintservice.exe` then
   `sc delete xpthermalprintservice.exe`. Within about three minutes Thermal
   Bridge notices the old service is gone and starts printing itself.

Pulsar POS does not use these scripts. It installs the print service with
its own WinSW wrapper; see [docs/SERVICE-MODE.md](../docs/SERVICE-MODE.md).
