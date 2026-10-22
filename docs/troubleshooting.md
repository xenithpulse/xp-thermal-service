# Troubleshooting

Audience: whoever supports the till. Symptom-first. Each entry states how to confirm the cause before applying a fix.

See [install.md](install.md) for deployment, [daily-use.md](daily-use.md) for normal operation, [web-integration.md](web-integration.md) for API integration issues. For the old XP Thermal Print Service, see [legacy/README.md](../legacy/README.md).

---

## Start here: identify the layer

```powershell
Get-Process ThermalBridge, ThermalBridgeTray -ErrorAction SilentlyContinue
type "$env:LOCALAPPDATA\ThermalBridge\active_port.txt"
9100..9110 | ForEach-Object {
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$_/health" -TimeoutSec 1
        "{0}  {1}  {2}  {3}  {4}" -f $_, $r.service, $r.name, $r.mode, $r.status
    } catch {}
}
```

| Result | Layer at fault | Go to |
|---|---|---|
| No `ThermalBridge` process | App not running | [Thermal Bridge is not running](#thermal-bridge-is-not-running) |
| Running, nothing answers 9100–9110 | Print server | [Nothing is listening](#nothing-is-listening) |
| Answers without a `name` | The old XP Thermal Print Service | [Tray says the installed service is printing](#tray-says-the-installed-service-is-printing) |
| A port answers, but not with `xp-thermal-service` | Port conflict | [Wrong application on the port](#wrong-application-on-the-port) |
| Answers with `Thermal Bridge` | Up | [Printers](#printers) or [A website cannot print](#a-website-cannot-print) |

For a service install, use `Get-Service ThermalBridge` and `%ProgramData%\ThermalBridge` instead.

---

## Thermal Bridge is not running

1. Start it from the Start Menu (**Thermal Bridge**). If it was already running, that just opens the dashboard.
2. If it should have started with Windows: dashboard → Settings → General → *Start with Windows*. Or check:
   ```powershell
   Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name ThermalBridge
   ```
3. If it starts and disappears, read `%LOCALAPPDATA%\ThermalBridge\logs\supervisor.log` and `console.log`.

---

## Tray says the installed service is printing

Thermal Bridge found the old XP Thermal Print Service (or a Thermal Bridge Windows service) already answering, and stood aside so the two do not fight over printers. Printing works through that service.

To switch to Thermal Bridge: import your printers from the dashboard notice, then remove the old service (`legacy\uninstall.bat` as Administrator, or `sc stop xpthermalprintservice.exe` and `sc delete xpthermalprintservice.exe`). Thermal Bridge takes over within about three minutes.

---

## Dashboard shows 404 or "page not found"

**The exact error text tells you the cause.** Get it before doing anything else.

| What the browser shows | Cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` / "This site can't be reached" | Nothing listening on that port | It is on 9101+; use the tray's **Open dashboard** |
| A styled 404 belonging to some other product | Another application owns the port | [Wrong application on the port](#wrong-application-on-the-port) |

### A query string you did not type

If the address bar gains something like `?compiler=wasm`, it did **not** come from this service. Nothing in the codebase appends query parameters, and the `/` to `/dashboard` redirect strips them. It cannot cause a 404 either: routing matches on path only. The usual sources are browser autocomplete, an extension, or another application on the port.

---

## Nothing is listening

The app is running but no port in range answers.

1. Read the logs (tray → **Open logs folder**). `console.log` shows a crash before logging started; `supervisor.log` shows restarts. The supervisor restarts the print server after 5 s, 10 s, then 30 s, so a server that keeps exiting shows there as a repeating pattern.
2. All ten ports occupied is possible but rare. `netstat -ano | findstr ":910"` will show it.

---

## Wrong application on the port

```powershell
netstat -ano | findstr ":9100"
tasklist /FI "PID eq <pid>"
```

Common occupants: a network printer's Standard TCP/IP port monitor, print-server software, another vendor's POS bridge, or the old XP Thermal Print Service.

The fallback handles this automatically, so no action is strictly required. But **record what holds 9100**: it will hold it again after every reboot, and the next person will also assume 9100.

---

## Windows says "Windows protected your PC"

The download is not code-signed yet. Click **More info → Run anyway**. To be sure the file is genuine, compare `Get-FileHash .\ThermalBridge-Setup.exe` with `SHA256SUMS.txt` from the same release.

---

## Setup could not finish

The setup window says why, in plain words. Every run, silent or not, also logs to `%TEMP%\ThermalBridge-Setup.log`.

- *"Thermal Bridge is still running and could not be updated"*: it did not quit when asked. Right-click the tray icon → **Quit**, then click **Try again**.
- *"This installer file is damaged"*: the unpacked app did not match the checksum built into the installer. Download it again.
- A silent install (`/S`) returning exit code `1`: read the log.

---

## Printers

### No printers found

1. Confirm Windows itself sees the device. Nothing downstream can find a printer that Windows does not have:
   ```powershell
   Get-Printer | Select-Object Name, PortName, DriverName
   ```
2. **Detect printers** reporting *"Printer connected but not installed"* means the USB device is present but has no driver. Install one; `Generic / Text Only` works for most ESC/POS units.
3. A **WMI damaged** warning is survivable: detection falls back to the spooler. Repair when convenient:
   ```powershell
   winmgmt /salvagerepository
   ```
   Run as Administrator, then reboot. `Invalid class "Win32_Printer"` is the same underlying fault.
4. Network printers: the network scan only covers this PC's own subnet. Otherwise use **Add Printer** with the IP address from the printer's self-test page.

### Printer shows "Not connected"

Press **Details** for the full reasoning rather than guessing from the label.

| Reported | Meaning | Handling |
|---|---|---|
| Moved to USB port `USB0xx` | Cable is in a different socket | **Fix this** repoints the role |
| Stale "Use Printer Offline" flag | Windows flag never cleared | Cleared automatically |
| No USB printing device attached | Unplugged or powered off | Physical check |
| Out of paper / cover open | Physical | Load paper, close cover |
| Print Spooler not running | Windows service stopped | Start the Print Spooler; restarting it needs admin rights, which the per-user app does not have |

### Printers vanished from config

A `config.json` that fails to parse is preserved as `config.corrupt.*.json` and **never overwritten**. Restore from it:

```powershell
dir "$env:LOCALAPPDATA\ThermalBridge\config.corrupt.*.json"
```

### Cash drawer will not open

Almost always the wrong pin. Try the other pin or a longer pulse via **Test drawer now**. If the printer's own self-test cannot fire the drawer, it is wiring, not software.

---

## A website cannot print

1. Look at the top of the dashboard for *"https://… wants to print"* and click **Allow**. Until then the site gets a **403 that names its origin**. If it was blocked by mistake, **Websites** → Blocked → Unblock.
2. The site must send `X-API-Key`. `/api/auth/local-token` serves it, but **only to callers on this computer**.
3. Confirm the site targets the real port, not a hard-coded 9100.

---

## Health reports `degraded` or `unhealthy`

Read `reasons` first. It is a plain-language explanation, not a hint, and the dashboard shows it under the banner.

- **`degraded`**: accepting work it cannot currently complete. Usually an offline printer or a stalled queue. Fix the printer and health follows.
- **`unhealthy`**, or `/health` returning **503**: the job store itself is unusable. The server's watchdog exits and the supervisor starts a fresh one. If it recurs, collect the logs.

---

## Update problems

- *"Thermal Bridge will not run this installer"*: the downloaded installer is not signed by XenithPulse (or not signed at all). This is deliberate. Download it from the releases page and run it yourself if you trust it.
- *"FAILED verification"*: the download did not match the checksum in the update manifest and was deleted. Try again; if it persists, the download is being altered on the way.

---

## What to collect before escalating

```powershell
$out = "$env:TEMP\thermal-bridge-diag"
New-Item -ItemType Directory -Force $out | Out-Null
Get-Process ThermalBridge, ThermalBridgeTray -ErrorAction SilentlyContinue | Out-File "$out\processes.txt"
netstat -ano | findstr ":910" | Out-File "$out\ports.txt"
Get-Printer | Out-File "$out\printers.txt"
Copy-Item "$env:LOCALAPPDATA\ThermalBridge\logs\*" $out -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\ThermalBridge\config.json" $out -ErrorAction SilentlyContinue
Copy-Item "$env:TEMP\ThermalBridge-Setup.log" $out -ErrorAction SilentlyContinue
explorer $out
```

Include the **exact** error text or a screenshot of the failing page. "It shows an error" and "it shows `ERR_CONNECTION_REFUSED`" lead to entirely different diagnoses.

> `config.json` contains the API key. Redact it before sending outside the organisation.
