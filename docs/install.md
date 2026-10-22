# Installation & Verification

Audience: whoever sets up the till: the owner, or on-site IT. No administrator
rights are needed for the standard install.

For day-to-day operation see [daily-use.md](daily-use.md). When something is broken see [troubleshooting.md](troubleshooting.md). To connect a web app to the API see [web-integration.md](web-integration.md). For POS or fleet installs as a Windows service see [SERVICE-MODE.md](SERVICE-MODE.md).

---

## Read this first: the dashboard is not always on port 9100

Thermal Bridge listens on the first free port from **9100** (up to 9109). Port 9100 is also the standard RAW/JetDirect printing port, so on a machine with a network printer, a print server, or the old XP Thermal Service, **it will land on 9101 or higher.**

This is by design. The dashboard's banner always shows the real port, and so does the tray tooltip. From a script:

```powershell
type "$env:LOCALAPPDATA\ThermalBridge\active_port.txt"      # installed app (this user)
type "$env:ProgramData\ThermalBridge\active_port.txt"       # Windows service install
```

Or ask each port. Only Thermal Bridge (and the old service) answers with `"service":"xp-thermal-service"`:

```powershell
9100..9110 | ForEach-Object {
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$_/health" -TimeoutSec 1
        "{0}  {1}  {2}  {3}" -f $_, $r.service, $r.name, $r.mode
    } catch {}
}
```

A response without `name` is the old XP Thermal Print Service.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Windows 10 or 11, x64 | Windows 7/8.1 are not supported |
| Print Spooler running | USB printing goes through it |
| Printer driver installed | `Generic / Text Only` is correct for most ESC/POS units |

Not needed: Node.js, administrator rights, firewall changes.

---

## Install

1. Download `ThermalBridge-Setup.exe` from the [latest release](https://github.com/xenithpulse/xp-thermal-service/releases/latest).
2. Double-click it. There is no UAC prompt: it installs for the current Windows
   user into `%LOCALAPPDATA%\Programs\ThermalBridge`.
3. Click **Install**. It takes a few seconds. Leave **Open Thermal Bridge now**
   ticked and click **Finish**; the dashboard opens.

Until the releases are code-signed, Windows may show *"Windows protected your PC"*.
Click **More info → Run anyway**, after checking the file against
`SHA256SUMS.txt` from the release if you want to be sure:

```powershell
Get-FileHash .\ThermalBridge-Setup.exe -Algorithm SHA256
```

Thermal Bridge now runs in the background with a tray icon, and starts
whenever this user signs in to Windows (turn that off from the tray or the
dashboard's Settings → General).

**Portable instead:** `ThermalBridge-Portable-<version>.exe` runs from any
folder or USB stick, without installing. It uses the same settings folder.

**Silent install** (same per-user install, no window):

```bat
ThermalBridge-Setup.exe /S              :: install, then start Thermal Bridge in the background
ThermalBridge-Setup.exe /S /NOLAUNCH    :: install only
```

Exit code `0` means installed, `1` failed. `/SILENT` and `/VERYSILENT` also
work, so existing deployment scripts need no change. Every run, silent or not,
writes a log to `%TEMP%\ThermalBridge-Setup.log`.

---

## What gets installed where

| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\Programs\ThermalBridge\ThermalBridge.exe` | The app |
| `%LOCALAPPDATA%\Programs\ThermalBridge\Uninstall.exe` | The uninstaller |
| `%LOCALAPPDATA%\ThermalBridge\config.json` | Printers, allowed websites, settings |
| `%LOCALAPPDATA%\ThermalBridge\data\jobs.db` | Print queue and history |
| `%LOCALAPPDATA%\ThermalBridge\active_port.txt` | The port actually bound |
| `%LOCALAPPDATA%\ThermalBridge\logs\` | `service.log`, `supervisor.log`, `console.log` |
| `%LOCALAPPDATA%\ThermalBridge\bin\` | Tray icon helper, extracted on first run |
| Start Menu → **Thermal Bridge** | Shortcut |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ThermalBridge` | Start with Windows |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ThermalBridge` | The entry in Settings → Apps |

Not created: no Windows service, no firewall rule, no scheduled task.
Thermal Bridge listens on `127.0.0.1` only, so Windows Firewall has nothing to ask about.

---

## Verify the install

```powershell
# 1. It is running (supervisor, print server, tray)
Get-Process ThermalBridge, ThermalBridgeTray

# 2. It is Thermal Bridge, and it is healthy
$port = (type "$env:LOCALAPPDATA\ThermalBridge\active_port.txt").Trim()
Invoke-RestMethod "http://127.0.0.1:$port/health" | Format-List status, reasons, name, mode, service, port

# 3. It starts with Windows
Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name ThermalBridge
```

`status` is `healthy`, `degraded` or `unhealthy`, and `reasons` explains any
non-healthy status in plain words. A `503` from `/health` means the job store
itself is unusable; the supervisor restarts the server by itself.

---

## First printer setup

Dashboard → **Detect printers**. It lists the printers Windows knows about and
scans the local network for printers on port 9100. For each one you want:
type a name, then under **Use as** click **Receipt**, **Kitchen (KOT)**, **Bar** or **Labels**.

A test receipt prints on assignment. Then click **Print test page** at the top
of the dashboard to print on the default printer.

Printer ids are **roles**, not devices. `receipt` and `kitchen` are what the
POS addresses; which physical unit fills the role is configuration. Pointing a
role at a different printer needs no POS change.

### Coming from XP Thermal Service

If the old service's settings are found, the dashboard offers **Import printers**.
While the old service is running, Thermal Bridge leaves printing to it. Remove
it when ready; see [legacy/README.md](../legacy/README.md).

---

## Updating

Tray → **Check for updates** (or Settings → General → Updates). Thermal Bridge downloads
the new installer, verifies its SHA-256 against the update manifest and its
code signature, and then offers **Install update**. A small progress window
closes Thermal Bridge, updates it, starts it again and closes itself; settings
and the print queue are kept. Nothing is downloaded or installed without a
click.

Installing a newer `ThermalBridge-Setup.exe` by hand does the same.

---

## Uninstall

*Settings → Apps → Installed apps → Thermal Bridge → Uninstall.* It stops the
app and removes it, its Start Menu shortcut and its Start-with-Windows entry.
Your printer settings and print history (in `%LOCALAPPDATA%\ThermalBridge`) are
kept, so installing again picks up where you left off, unless you tick **Also
delete printer settings and print history**.

Silently, keeping settings:

```bat
"%LOCALAPPDATA%\Programs\ThermalBridge\Uninstall.exe" /S
```

---

## Handover checklist

- [ ] Dashboard banner says **Running** with the expected number of printers online
- [ ] Actual port noted for the POS integrator (**not assumed to be 9100**)
- [ ] Test page printed from each configured role
- [ ] Cash drawer verified via **Test drawer now**, if fitted
- [ ] The POS website allowed (it appears as *"… wants to print"* the first time it calls)
- [ ] Start with Windows is on (Settings → General)
- [ ] Survives a reboot: actually reboot, sign in, and check the dashboard

---

## Connecting a web application

Hand the integrator [web-integration.md](web-integration.md). It covers port
discovery, the API key, CORS, and the print/job contract.
