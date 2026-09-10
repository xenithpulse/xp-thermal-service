# Troubleshooting

Audience: on-site IT installer. Symptom-first. Each entry states how to confirm the cause before applying a fix.

See [install.md](install.md) for deployment, [daily-use.md](daily-use.md) for normal operation, [web-integration.md](web-integration.md) for API integration issues.

---

## Start here: identify the layer

Run this before anything else. It answers "is the service running, on which port, and does it think it is healthy" in one pass.

```powershell
Get-Service -Name xpthermalprintservice.exe
type "$env:ProgramData\XPThermalService\active_port.txt"
netstat -ano | findstr ":910"
9100..9109 | ForEach-Object {
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$_/health" -TimeoutSec 1
        "{0}  {1}  {2}" -f $_, $r.service, $r.status
    } catch {}
}
```

| Result | Layer at fault | Go to |
|---|---|---|
| Service not found or stopped | Service | [Service will not start](#service-will-not-start) |
| Service running, nothing answers 9100-9109 | Bind | [Nothing is listening](#nothing-is-listening) |
| A port answers, but not with `xp-thermal-service` | Port conflict | [Wrong application on the port](#wrong-application-on-the-port) |
| Answers with `xp-thermal-service` | Service is up | [Dashboard 404](#dashboard-shows-404-or-page-not-found) or [Printers](#printers) |

---

## Dashboard shows 404 or "page not found"

**The exact error text tells you the cause.** Get it before doing anything else.

| What the browser shows | Cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` / "This site can't be reached" | Nothing listening on that port | The service is on 9101+ - resolve the real port |
| A styled 404 belonging to some other product | Another application owns the port | [Wrong application on the port](#wrong-application-on-the-port) |
| Plain text `Dashboard not found. Ensure public/dashboard.html exists.` | Our service is up, but `public\dashboard.html` did not deploy | Reinstall with `-Repair` |

### The port is the usual answer

The service binds the first free port in **9100-9109**. Port 9100 is the RAW/JetDirect printing port and is very often already taken.

```powershell
type "$env:ProgramData\XPThermalService\active_port.txt"
```

Open the dashboard on *that* port.

### Missing dashboard file

```powershell
dir "$env:ProgramData\XPThermalService\public\dashboard.html"
```

The service looks in three locations relative to the working directory and its own install path. If none exists it returns that plain-text 404. Fix by reinstalling - do not copy the file in by hand, because a missing `public\` folder means the deploy was incomplete in other ways too:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Repair
```

### A query string you did not type

If the address bar gains something like `?compiler=wasm`, it did **not** come from this service. Nothing in the codebase appends query parameters, and the `/` to `/dashboard` redirect strips them.

It also cannot cause a 404: routing matches on path only, so `/dashboard?anything=x` reaches the same handler as `/dashboard`.

Sources, in order of likelihood: browser omnibox autocomplete from history; a browser extension; or another application on the port. Confirm by opening the URL in a private window with the autocomplete suggestion dismissed. **Then go diagnose the real problem** - the query string is a distraction.

---

## Nothing is listening

Service reports Running, but no port in range answers.

1. Check the daemon log - a crash before logging initialises surfaces only here:
   ```powershell
   Get-Content "$env:ProgramData\XPThermalService\daemon\*.log" -Tail 50
   ```
2. All ten ports occupied is possible but rare. `netstat -ano | findstr ":910"` will show it.
3. **`Restart-Service` does not cycle the Node child process.** If you restarted that way and nothing changed, that is why. Use `-Restart` on the installer or the dashboard's restart.

---

## Wrong application on the port

Map the listener to a process:

```powershell
netstat -ano | findstr ":9100"
tasklist /FI "PID eq <pid>"
```

Common occupants: a network printer's Standard TCP/IP port monitor, print-server software, another vendor's POS bridge, or a leftover instance of this service.

The fallback handles this automatically - no action is strictly required. But **record what holds 9100**, because it will hold it again after every reboot, and the next person will also assume 9100.

If the POS is pinned to a fixed port, either free 9100 or point the POS at `active_port.txt` / `/health` discovery instead.

---

## Service will not start

```powershell
Get-Service -Name xpthermalprintservice.exe
(Get-CimInstance Win32_Service -Filter "Name='xpthermalprintservice.exe'").StartMode
Get-Content "$env:TEMP\XPThermalInstall_*.log" -Tail 60
```

| Symptom | Cause | Fix |
|---|---|---|
| `Get-Service` finds nothing | Wrong name - `-Name` matches `xpthermalprintservice.exe`, not the display name | Query by `-Name xpthermalprintservice.exe` or `-DisplayName "XP Thermal Print Service"` |
| Exit code 4 | Another instance already running | Stop it, or use the service rather than launching by hand |
| Starts then stops | Print Spooler dependency unmet | `Start-Service Spooler`, then start the service |
| Start type is not `Auto` | Registration incomplete | Reinstall with `-Repair` |

Half-finished installs are not worth repairing by hand:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Repair
```

### Service name vs display name

The service is registered under the **Name** `xpthermalprintservice.exe` with the **DisplayName** `XP Thermal Print Service`. Which one you need depends on the tool:

```powershell
Get-Service -Name xpthermalprintservice.exe          # works
Get-Service -Name "XP Thermal Print Service"         # also works - PowerShell resolves display names
sc.exe query xpthermalprintservice.exe               # works
sc.exe query "XP Thermal Print Service"              # FAILS 1060 - sc.exe needs the real Name
```

PowerShell's service cmdlets accept either. `sc.exe` accepts only the Name. If a repair step fails with *"The specified service does not exist as an installed service"* while `Get-Service` clearly finds it, that mismatch is the cause.

---

## Printers

### No printers found

1. Confirm Windows itself sees the device - nothing downstream can find a printer that Windows does not have:
   ```powershell
   Get-Printer | Select-Object Name, PortName, DriverName
   ```
2. **Find Printers** reporting *"Printer connected but not installed"* means USB presence without a driver. Install one; `Generic / Text Only` works for most ESC/POS units.
3. A **WMI damaged** warning is survivable - detection falls back to the spooler. Repair when convenient:
   ```powershell
   winmgmt /salvagerepository
   ```
   Run as Administrator, then reboot. `Invalid class "Win32_Printer"` is the same underlying fault.

### Printer shows "Not connected"

Press **Details** for the full reasoning rather than guessing from the label.

| Reported | Meaning | Handling |
|---|---|---|
| Moved to USB port `USB0xx` | Cable is in a different socket | **Fix this** repoints the role |
| Stale "Use Printer Offline" flag | Windows flag never cleared | Cleared automatically |
| No USB printing device attached | Unplugged or powered off | Physical check |
| Out of paper / cover open | Physical | Load paper, close cover |
| Print Spooler not running | Windows service stopped | **Fix this** restarts it |

### Printers vanished from config

A `config.json` that fails to parse is preserved as `config.corrupt.*.json` and **never overwritten**. Restore from it:

```powershell
dir "$env:ProgramData\XPThermalService\config.corrupt.*.json"
```

### Cash drawer will not open

Almost always the wrong pin. Try the other pin or a longer pulse via **Test drawer now**. If the printer's own self-test cannot fire the drawer, it is wiring, not software.

---

## POS cannot connect

1. Confirm the service is healthy and note the real port (see [Start here](#start-here-identify-the-layer)).
2. Confirm the POS is targeting that port and not a hard-coded 9100.
3. A CORS rejection returns a **403 naming the origin and how to allow it** - read the body and add the origin to `security.allowedOrigins`. Loopback is always allowed on any port.
4. Non-loopback callers need the API key. `/api/auth/local-token` serves it, but **only to 127.0.0.1 / ::1** - a 403 from that endpoint means the caller is not on loopback.

---

## Health reports `degraded` or `unhealthy`

Read `reasons` first - it is a plain-language explanation, not a hint.

```powershell
$port = (type "$env:ProgramData\XPThermalService\active_port.txt").Trim()
(Invoke-RestMethod "http://127.0.0.1:$port/health").reasons
```

- **`degraded`** - accepting work it cannot currently complete. Usually an offline printer or a stalled queue. Fix the printer; health follows.
- **`unhealthy`**, or `/health` returning **503** - the job store itself is unusable, so nothing sent will even be recorded. Restart the process. The watchdog does this too. If it recurs, capture the service and daemon logs before repairing.

---

## New build not taking effect

The deployed copy does not self-update, and `Restart-Service` does not cycle the Node child. Re-run the installer with `-Repair`, then restart via the dashboard or `POST /api/service/restart`.

---

## What to collect before escalating

```powershell
$out = "$env:TEMP\xp-diag"
New-Item -ItemType Directory -Force $out | Out-Null
Get-Service -Name xpthermalprintservice.exe | Out-File "$out\service.txt"
netstat -ano | findstr ":910" | Out-File "$out\ports.txt"
Get-Printer | Out-File "$out\printers.txt"
Copy-Item "$env:ProgramData\XPThermalService\logs\*" $out -ErrorAction SilentlyContinue
Copy-Item "$env:ProgramData\XPThermalService\daemon\*.log" $out -ErrorAction SilentlyContinue
Copy-Item "$env:TEMP\XPThermalInstall_*.log" $out -ErrorAction SilentlyContinue
Copy-Item "$env:ProgramData\XPThermalService\config.json" $out -ErrorAction SilentlyContinue
explorer $out
```

Include the **exact** error text or a screenshot of the failing page. "It shows an error" and "it shows `ERR_CONNECTION_REFUSED`" lead to entirely different diagnoses.

> `config.json` contains the API key. Redact it before sending outside the organisation.
