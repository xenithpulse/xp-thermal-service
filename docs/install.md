# Installation & Verification

Audience: on-site IT installer. Assumes Administrator access, PowerShell, and familiarity with Windows Services.

For day-to-day operation see [daily-use.md](daily-use.md). When something is broken see [troubleshooting.md](troubleshooting.md). To connect a web app to the API see [web-integration.md](web-integration.md).

---

## Read this first: the dashboard is not always on port 9100

The service binds the first free port in **9100–9109**. Port 9100 is the IANA-registered RAW/JetDirect printing port, so on any machine with a network printer, a print server, or a previous instance still holding the socket, **the service will silently land on 9101 or higher.**

This is by design, not a fault. It is also the single most common support call, because the operator types `127.0.0.1:9100` and gets someone else's 404.

Never assume 9100. Always resolve the port:

```powershell
type "$env:ProgramData\XPThermalService\active_port.txt"
```

If that file is missing or stale, ask the service directly — only the real service answers with `"service":"xp-thermal-service"`:

```powershell
9100..9109 | ForEach-Object {
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$_/health" -TimeoutSec 1
        "{0}  {1}  {2}" -f $_, $r.service, $r.status
    } catch {}
}
```

Any port that responds with something *other* than `xp-thermal-service` is a different application squatting on the port. That is worth noting on the handover sheet — it will happen again on every reboot.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Windows 10/11 or Server 2016+ | x64 |
| Node.js 18 or newer | `node --version` — the installer aborts without it |
| Administrator rights | Service registration, firewall rules, scheduled tasks |
| Print Spooler running | The service declares a dependency on it |
| Printer driver installed | `Generic / Text Only` is correct for most ESC/POS units |

The service must reach the printer through Windows. If `Get-Printer` does not list it, no amount of configuration here will help.

---

## Install

### Standard install

Right-click `setup.bat` → **Run as administrator**.

It checks Node, runs `npm install`, builds TypeScript, creates `config.json` from `config.example.json` if absent, registers the Windows service, then probes 9100–9110 and opens the dashboard on whichever port answered.

If the browser does not open, the install still probably succeeded — verify manually below.

### Direct PowerShell install

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

Switches:

| Switch | Effect |
|---|---|
| `-Repair` | Reinstall over an existing install, preserving `config.json` |
| `-Start` / `-Stop` / `-Restart` | Service lifecycle |
| `-Uninstall` | Remove service, firewall rules, scheduled tasks |
| `-Silent` | Suppress console output, for unattended deployment |

`-Repair` is the correct response to a half-finished or previously failed install. Do not attempt to fix a broken install by hand.

---

## What gets installed where

| Path | Contents |
|---|---|
| `%ProgramData%\XPThermalService\` | Install root |
| `%ProgramData%\XPThermalService\config.json` | Printer roles, security, backup policy |
| `%ProgramData%\XPThermalService\active_port.txt` | The port actually bound |
| `%ProgramData%\XPThermalService\logs\` | Service logs |
| `%ProgramData%\XPThermalService\daemon\*.log` | Service wrapper stdout/stderr |
| `%TEMP%\XPThermalInstall_*.log` | Installer transcript — read this when an install fails |

`%ProgramData%` is normally `C:\ProgramData`, but the installer falls back through `%ALLUSERSPROFILE%` and `%SystemDrive%\ProgramData` on redirected systems.

Also registered:

- Windows service — **name** `xpthermalprintservice.exe`, **display name** `XP Thermal Print Service`
- Inbound firewall rule `XP Thermal Service`, TCP 9100–9110, private + domain profiles
- Scheduled tasks `XPThermalServiceWatchdog` and `XPThermalServiceHeartbeat`

### The service name trips people up

The service's **Name** and its **DisplayName** differ, and not every tool accepts both:

```powershell
Get-Service -Name xpthermalprintservice.exe          # works
Get-Service -Name "XP Thermal Print Service"         # works - PowerShell resolves display names
sc.exe query xpthermalprintservice.exe               # works
sc.exe query "XP Thermal Print Service"              # FAILS 1060 - sc.exe needs the real Name
```

Use `xpthermalprintservice.exe` in anything that shells out to `sc.exe`, `net start`, or the registry. `XP Thermal Print Service` is additionally listed as a *legacy* service name that the installer actively removes.

---

## Verify the install

Run all five. Any failure sends you to [troubleshooting.md](troubleshooting.md).

```powershell
# 1. Service exists and is running
Get-Service -Name xpthermalprintservice.exe

# 2. Start type is Automatic
(Get-CimInstance Win32_Service -Filter "Name='xpthermalprintservice.exe'").StartMode

# 3. Something is listening in range
netstat -ano | findstr ":910"

# 4. It is OUR service, and it is healthy
$port = (type "$env:ProgramData\XPThermalService\active_port.txt").Trim()
Invoke-RestMethod "http://127.0.0.1:$port/health" | Format-List status, reasons, service, port, configuredPort

# 5. Dashboard renders
Start-Process "http://127.0.0.1:$port/dashboard"
```

`status` is `healthy`, `degraded`, or `unhealthy`, and `reasons` is a plain-language array explaining any non-healthy status. `port` versus `configuredPort` tells you immediately whether the fallback engaged.

A `503` from `/health` means the job store itself is unusable — the process needs restarting, not reconfiguring.

---

## First printer setup

Dashboard → **Printers** → **Find Printers** → **Use as Receipt** or **Use as Kitchen** on the printer you want.

A test receipt prints automatically on assignment. If it prints, that role is done — there are no widths, ids, or capability checkboxes to set.

Printer ids are **roles**, not devices. `receipt` and `kitchen` are what the POS addresses; which physical unit fills the role is configuration. Repointing a role at a different device requires no POS change.

---

## Updating an existing install

The deployed copy does **not** self-update. Re-run the installer on each machine.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Repair
```

Critically: **`Restart-Service` does not cycle the Node child process.** A new build will not take effect after a plain service restart. Use the dashboard's restart button, or:

```powershell
$port = (type "$env:ProgramData\XPThermalService\active_port.txt").Trim()
Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/service/restart"
```

That endpoint is loopback-only.

---

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
```

or `scripts\uninstall.bat` as Administrator. Removes the service, firewall rule, and scheduled tasks. `config.json` and logs are left in place deliberately — delete `%ProgramData%\XPThermalService\` by hand if you want a clean slate.

---

## Handover checklist

- [ ] `/health` returns `status: healthy` with `service: xp-thermal-service`
- [ ] Actual port recorded and given to the POS integrator (**not assumed to be 9100**)
- [ ] If the port is not 9100, note what is holding 9100
- [ ] Service start type is `Auto`
- [ ] Test receipt printed from each configured role
- [ ] Cash drawer verified via **Test drawer now**, if fitted
- [ ] POS origin present in `security.allowedOrigins`
- [ ] Survives a reboot — actually reboot and re-check `/health`

---

## Connecting a web application

If the site also needs to drive the printers from its own web app, hand the integrator [web-integration.md](web-integration.md) — it covers port discovery, the API key, CORS clearance, and the print/job contract.

Two things they will need from you at handover: the **API key** (dashboard → Settings) and their **origin added to `security.allowedOrigins`**.
