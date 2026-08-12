# XP Thermal Service

A local thermal printing service for restaurant POS systems. It runs as a Windows service, finds your receipt printers by itself, keeps working when Windows gets in the way, and exposes a small HTTP API your POS can call. Powered by [XenithPulse.com](https://xenithpulse.com).

Designed as a zero-maintenance replacement for QZ Tray: no browser extension, no certificates, no per-till babysitting.

---

## Why this exists

Thermal printing on Windows fails in ways that have nothing to do with the printer. This service exists because of specific, reproducible failures — each one is handled below, and each fix was verified against real hardware rather than assumed.

**The printer works, but the software says it's offline.**
Windows sets a `WorkOffline` flag on a print queue when a USB device disappears, and frequently never clears it when the device comes back. Captured from a real XPrinter-class device that was printing Windows test pages perfectly:

```
Name        : Generic / Text Only
PortName    : USB011
WorkOffline : True      <- naive check reports OFFLINE
PrinterState: 0         <- Ready
DetectedErrorState : 0  <- no error
```

This service never trusts that flag on its own. It must be corroborated by a real fault or by physical absence, and the stale flag is cleared automatically in the background.

**"It only works on the USB port it was installed on."**
Every physical socket a printer is plugged into mints a new Windows port. On the reference machine that produced `USB001` through `USB018`, with eight stale device instances left in the registry. The print queue stays pinned to whichever port existed at install time, so moving the cable silently breaks printing.

The service reads the live device-to-port mapping from `HKLM\SYSTEM\CurrentControlSet\Enum\<device>\Device Parameters\PortName`, notices the migration, and repoints the queue. **Move the cable to any socket and it follows.**

**Windows itself is broken on some machines.**
A field machine reported:

```
Could not enumerate printers: Invalid class "Win32_Printer"
Could not enumerate USB printing devices: Invalid class "Win32_PnPEntity"
```

That is a damaged WMI repository — the Print Spooler was running fine, but every printer was invisible. The service now reaches printers through **four independent paths** and keeps working when WMI is gone (see [Resilience](#resilience)).

---

## Features

### Connectivity — the part that actually matters

- **Corroborated status.** `WorkOffline` alone never means offline. Unknown status codes mean *ready*, not *error* — cheap thermal units report `PrinterStatus` 1 ("Other") or 2 ("Unknown") while working perfectly.
- **Follows the cable.** Detects USB port migration and repoints the queue automatically. Works through hubs and Type-C docks.
- **Follows renames.** When a driver reinstall creates `XP-80C (Copy 1)`, the service recognises it and rebinds — but never onto a queue another configured printer already owns, so kitchen tickets can't be hijacked by the receipt printer.
- **Refuses to guess.** With several indistinguishable printers on a hub, it asks rather than risking order tickets going to the wrong station.
- **Survives a damaged WMI repository** via direct spooler enumeration.
- **Ground truth is the write.** A completed write marks a printer online regardless of what Windows claims about it.

### Detection speed

- **Event-driven, not polled.** Subscribes to `Win32_DeviceChangeEvent` (extrinsic — instant, zero polling cost) and a 2-second intrinsic watch on `Win32_Printer`. A plug or unplug is noticed in about **one second**.
- **Live dashboard.** Server-sent events push state to the browser as it changes; current state arrives within ~10ms of opening the page.
- **Degrades, never breaks.** If WMI events are unavailable, it falls back to faster polling and says so.

### Setup

- **Role-based.** Choose *Receipt*, *Kitchen (KOT)*, *Bar* or *Labels*. The role becomes the printer id, so your POS can always address `receipt` and `kitchen` without a lookup. Paper width, capabilities, cash-drawer defaults and identity breadcrumbs are all derived — nothing to type.
- **Ranked discovery.** Real receipt printers are scored and listed first; `Microsoft Print to PDF`, XPS and Fax are excluded.
- **Tells you when a driver is missing.** A printer plugged in with no driver is the most common "it doesn't detect my printer" case on a fresh machine. It is reported explicitly instead of showing an empty list.

### Self-repair

An ordered, least-invasive ladder, run automatically and on demand:

1. Repoint a migrated USB port
2. Clear a stale "Use Printer Offline" flag
3. Resume a paused queue / clear jobs wedged behind a failed one
4. Restart the Print Spooler

Physical problems are deliberately **not** auto-healed. Out of paper gets an instruction, not a repair loop.

### Durability

- **No silently lost receipts.** The job store batches saves; every abrupt exit path — restart, watchdog, uncaught exception — flushes first.
- **Restarts drain.** In-flight receipts finish before exit, bounded at 8 seconds so a restart never hangs a till.
- **One instance only.** A PID lock stops a second copy starting and corrupting `config.json`. It waits out a restart handover rather than refusing, and takes over a stale lock left by a hard reset.
- **Config is never destroyed.** A file that fails to parse is backed up and the service refuses to overwrite it. UTF-8 BOMs (Notepad, `Out-File`) are handled. Concurrent writers are merged instead of clobbered.

### Everything else

- USB and network printers, ESC/POS with barcodes, QR codes and formatting
- Templates: receipt, KOT, invoice, label, test, raw
- Cash drawer: pin 2/5, configurable pulse, open-on-print, test pulse before saving
- Priority queue, idempotency keys, retry with exponential backoff
- Automatic port fallback (9100–9109) with published endpoint descriptors
- Windows service with SCM recovery, watchdog and delayed auto-start

---

## Quick Start

### One-Click Install (Recommended)

Double-click `setup.bat` as Administrator. It will:

1. Check for Node.js 18+
2. Install dependencies
3. Build the TypeScript project
4. Create `config.json` from example if missing
5. Install as a Windows service with auto-start, SCM recovery, and a Print Spooler dependency
6. Open the dashboard in your browser

### Set up a printer

Open `http://127.0.0.1:9100/dashboard` → **Printers** → **Find Printers**, then press **Use as Receipt** or **Use as Kitchen** next to your printer. A test receipt is sent automatically.

That is the whole setup. No ids, no capability checkboxes, no paper-width arithmetic.

### Manual Installation

```bash
git clone https://github.com/your-org/xp-thermal-service.git
cd xp-thermal-service

npm install
cp config.example.json config.json
npm run build
npm start
```

### As a Windows Service

```bash
npm run service:install     # requires Administrator
npm run service:start
npm run service:stop
npm run service:uninstall
```

### PowerShell Installer (Advanced)

```powershell
.\scripts\install.ps1            # Install
.\scripts\install.ps1 -Repair    # Reinstall without losing config
.\scripts\install.ps1 -Start     # Start / Stop / Restart
```

> **Updating an existing install:** the deployed copy does not update itself. Re-run the installer on each machine. `Restart-Service` alone does **not** cycle the Node child process — use the dashboard's restart, or `POST /api/service/restart`.

---

## Resilience

### Four independent paths to your printers

Tried in order, first success wins:

| # | Path | Survives |
|---|------|----------|
| 1 | `Get-CimInstance Win32_Printer` | — |
| 2 | `Get-WmiObject Win32_Printer` | Older PowerShell |
| 3 | **`winspool.drv` EnumPrinters** | **Damaged WMI repository** |
| 4 | **`Get-Printer`** (`root\standardcimv2`) | Damaged WMI *and* blocked `Add-Type` |

Path 3 talks to the Print Spooler directly with no WMI involved. `PRINTER_INFO_2.Status` uses the same bit values as WMI's `PrinterState`, and `Attributes` carries the `WorkOffline` flag, so the status logic needs no special-casing — it loses almost nothing.

Verified by simulating the failure on a healthy machine:

```
===== WMI BROKEN (simulated) =====
  wmiHealthy=false  presenceDegraded=true
  os="Windows 10 Pro for Workstations"   <- registry, not WMI
  spooler=true  printers=3  usbDevices=1 <- registry, not WMI
   - Generic / Text Only  port=USB016  verdict=online  printable=true
   - Canon G3020 series   state=128    verdict=offline
```

The OS name and USB presence also have registry-based fallbacks. When presence detection is degraded, absence is treated as **unknown** rather than "unplugged" — reporting a working printer as disconnected is the worse mistake.

The dashboard explains the situation in plain language and gives the repair command (`winmgmt /salvagerepository`), with the raw errors tucked into a collapsed "Technical details" section.

To exercise the fallback on a healthy machine, set `XP_FORCE_SPOOLER_FALLBACK=1`.

### Printing without runtime compilation

The winspool shim is compiled **once at startup** into `data/RawPrinterHelper.dll` instead of on every job. Measured: **~600ms of C# compilation per receipt → ~180ms to load the cached assembly.** More importantly it removes the dependency on a working C# compiler and writable `%TEMP%` at print time, which matters on locked-down machines. Inline compilation remains as a fallback.

### Errors in plain language

Win32 spooler codes are translated. `WritePrinter failed (win32 error 1801)` becomes:

> The printer name is not valid — the queue may have been renamed or removed. (Windows error 1801)

Failed jobs show their reason inline in the dashboard. An offline printer can never report a successful cash-drawer pulse.

---

## API Reference

Base URL: `http://127.0.0.1:9100` (see [Smart Port Handling](#smart-port-handling)).

### Health & identity

```bash
GET /health
```

```json
{
  "status": "healthy",
  "service": "xp-thermal-service",
  "port": 9100,
  "configuredPort": 9100,
  "uptime": 123456,
  "printers": { "total": 2, "online": 2, "offline": 0, "error": 0 },
  "queue": { "pending": 0, "processing": 0, "failed": 0 }
}
```

The `service` field lets a client scanning 9100–9109 confirm it found the right process. The port is also returned in an `X-Service-Port` header on every response.

### Printing

```bash
POST /api/print
POST /api/print/{printerId}
```

```json
{
  "idempotencyKey": "order-1234-receipt",
  "printerId": "receipt",
  "templateType": "receipt",
  "copies": 1,
  "priority": "high",
  "payload": { "orderNumber": "1234", "items": [] },
  "metadata": { "openCashDrawer": true }
}
```

### Discovery & setup

```bash
GET  /api/printers/discover          # ranked candidates + printers needing a driver
GET  /api/printers/discover?all=1    # include virtual queues (PDF/XPS/Fax)
GET  /api/printers/roles             # receipt / kitchen / bar / label
POST /api/printers/setup             # { role, windowsName, test }
POST /api/printers/auto-setup        # configure every recommended thermal printer
```

`POST /api/printers/setup` is the whole add-a-printer flow. Re-running it for an existing role repoints that role at a different printer — what you want when replacing a broken unit.

### Diagnosis & repair

```bash
GET  /api/printers/{printerId}/diagnose   # what Windows says, what we concluded, why
POST /api/printers/{printerId}/repair     # run the repair ladder
GET  /api/system/print-system             # raw snapshot, for support
```

`diagnose` returns the reasoning, not just a status: whether the queue was found, which queue it is bound to, the `WorkOffline` flag, physical presence, port migration and suggested port, reported faults, spooler state — plus the repair plan and any manual instruction.

### Live updates

```bash
GET /api/events        # Server-Sent Events
```

Pushes `printers` events on every state change. Current state is sent immediately on connect. Because `EventSource` cannot set headers, this endpoint also accepts the API key as `?key=`.

### Printers, jobs, queue

```bash
GET    /api/printers
GET    /api/printers/{printerId}
GET    /api/printers/{printerId}/status
POST   /api/printers/{printerId}/test
POST   /api/printers/{printerId}/reconnect
POST   /api/printers/{printerId}/cash-drawer   # { pin, onTimeMs, offTimeMs }

GET    /api/jobs?status=failed&limit=50
GET    /api/jobs/{jobId}
GET    /api/jobs/{jobId}/status
POST   /api/jobs/{jobId}/retry
DELETE /api/jobs/{jobId}
POST   /api/jobs/clear-failed

GET    /api/queue/stats
POST   /api/queue/pause
POST   /api/queue/resume
```

### Configuration & system

```bash
GET    /api/config
PUT    /api/config/server
PUT    /api/config/security
GET    /api/system/printers
POST   /api/config/printers
PUT    /api/config/printers/{printerId}
DELETE /api/config/printers/{printerId}

GET    /api/metrics            # includes printerEvents.mode: event-driven | polling
GET    /api/system/info
GET    /api/system/connections
POST   /api/service/restart    # loopback only; drains in-flight work first
GET    /api/auth/local-token   # loopback only
```

### Dashboard

```
http://127.0.0.1:9100/dashboard
```

---

## Configuration

`config.json` in the install directory. Copy `config.example.json` to get started.

```json
{
  "server": { "host": "127.0.0.1", "port": 9100, "enableHttps": false },

  "security": {
    "allowedOrigins": [
      "http://pos.xenithpulse.local:8090",
      "http://pos.xenithpulse.local:8080",
      "http://127.0.0.1:8080",
      "http://127.0.0.1:8090"
    ],
    "allowedHosts": ["localhost", "127.0.0.1"],
    "allowPrivateNetwork": true,
    "rateLimitPerMinute": 120,
    "enableApiKey": true,
    "maxPayloadSize": 1048576
  },

  "queue": {
    "maxConcurrentJobs": 3,
    "maxRetries": 5,
    "retryDelayMs": 1000,
    "retryBackoffMultiplier": 2,
    "maxRetryDelayMs": 60000,
    "jobTimeoutMs": 30000,
    "cleanupIntervalMs": 3600000,
    "maxJobAgeMs": 604800000,
    "persistPath": "./data/jobs.db"
  },

  "logging": { "level": "info", "console": true },

  "printers": [
    {
      "id": "receipt",
      "name": "Receipt",
      "type": "usb",
      "enabled": true,
      "isDefault": true,
      "printerName": "XP-80C",
      "timeout": 10000,
      "maxRetries": 3,
      "capabilities": { "maxWidth": 48, "supportsCashDrawer": true, "codepage": 0 },
      "cashDrawer": {
        "enabled": true,
        "pin": 2,
        "onTimeMs": 50,
        "offTimeMs": 200,
        "openOnPrint": true
      },
      "metadata": {
        "role": "receipt",
        "windowsPort": "USB016",
        "windowsDriver": "Generic / Text Only",
        "usbHardwareId": "USBPRINT\\UnknownPrinter"
      }
    }
  ]
}
```

### Printer ids are roles

`receipt`, `kitchen`, `bar`, `label`. Your POS addresses printers by role and never needs to know which physical device is behind one.

### `metadata` is written by the service

Identity breadcrumbs learned at runtime. They are how the service re-finds a printer that moved port or was renamed. Leave them alone; they are maintained automatically.

### Cash drawer

`pin` is 2 for almost all printers, 5 for a minority and for the second drawer of a twin setup. `onTimeMs`/`offTimeMs` are clamped to the 10–510ms the single-byte ESC/POS encoding allows. If a drawer does not open, try the other pin or a longer pulse — the dashboard has a **Test drawer now** button that fires with unsaved values.

### CORS

Loopback is trusted on **every port**, so the dashboard keeps working when the service falls back from 9100. `allowedOrigins` entries may contain wildcards (`https://*.pos.example.com`). `allowPrivateNetwork` lets POS terminals elsewhere on the LAN connect. The four POS origins above are added to every configuration automatically.

A rejected origin gets a 403 that says exactly how to allow it, rather than an opaque CORS failure.

---

## Template Types

| Type | Description |
|------|-------------|
| `receipt` | Header, items, totals, adjustments, payment info, optional barcode/QR |
| `kot` | Kitchen ticket with large text, modifiers, special instructions |
| `invoice` | Detailed invoice with customer info and line items |
| `test` | Font samples, alignment tests, optional barcode/QR |
| `label` | Label printing |
| `raw` | Direct ESC/POS (hex, base64, or raw bytes) |

---

## Connecting from XP-POS

Find the service, then talk to it by role:

```ts
// Ports 9100-9109; confirm identity so you don't latch onto something else.
async function findService(): Promise<string | null> {
  for (let port = 9100; port <= 9109; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(800)
      });
      if (!res.ok) continue;
      const body = await res.json();
      if (body.service && body.service !== 'xp-thermal-service') continue;
      return `http://127.0.0.1:${port}`;
    } catch { /* keep looking */ }
  }
  return null;
}

await fetch(`${base}/api/print`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
  body: JSON.stringify({
    idempotencyKey: `order-${orderId}-receipt`,
    printerId: 'receipt',
    templateType: 'receipt',
    payload: receipt
  })
});
```

The service also publishes its endpoint on disk, so a client need not scan at all:

```
<install>\active_port.txt
<install>\data\service-endpoint.json
C:\ProgramData\XPThermalService\active_port.txt
C:\ProgramData\XPThermalService\service-endpoint.json
```

The API key is available to loopback callers from `GET /api/auth/local-token`.

---

## Smart Port Handling

If 9100 is busy the service takes the next free port up to 9109 and publishes where it landed. `/health` reports both `port` and `configuredPort`, and the dashboard shows a note when they differ.

---

## Testing

```bash
npm test        # 79 unit tests - decision logic, config durability, roles, CORS, drawer encoding
npm run qa      # integration suite against the running service (read-only)
npm run qa:write   # + create/update/delete a temporary printer
npm run qa:full    # + send a physical test receipt
```

The unit tests cover the pure logic with fixtures captured from real hardware — including the `WorkOffline=true` queue that used to break everything.

`scripts/deep-qa.js` exercises what only exists on a real machine: the PowerShell bridge, WMI event delivery, CORS on whichever port was actually bound, discovery, diagnosis and repair, config CRUD, the print pipeline, and resilience. It asserts behaviour, not just status codes — for example that a repair which did nothing does not claim success, and that an accepted job survives a restart.

Latest full run: **79 unit tests and 62 integration checks, 0 failures**, including a physical receipt.

---

## Development

```bash
npm run dev            # ts-node, foreground
npm run build          # tsc
npm test               # jest
npm run qa             # integration suite
npm run lint
```

### Support switches

| Variable | Effect |
|----------|--------|
| `XP_FORCE_SPOOLER_FALLBACK=1` | Skip WMI and use the spooler/registry path — reproduces a damaged-WMI machine |
| `XP_CONFIG_PATH` | Path to `config.json` |
| `XP_LOG_LEVEL` | `trace`…`fatal` |

---

## Troubleshooting

### The dashboard shows no printers

1. **Find Printers** → does it report *"Printer connected but not installed"*? Install the driver; `Generic / Text Only` works for most ESC/POS units.
2. Does it warn that **WMI is damaged**? Detection still works via the spooler; repair Windows with `winmgmt /salvagerepository` (Administrator) and reboot when convenient.
3. Confirm Windows can see it at all:
   ```powershell
   Get-Printer | Select-Object Name, PortName, DriverName
   ```
   Nothing listed means no printer is installed — no software can find one that isn't there.

### A printer shows "Not connected"

Press **Details** for the full reasoning. The common causes and what happens:

| Reported | Meaning | Handled by |
|----------|---------|------------|
| Moved to USB port `USB0xx` | Cable is in a different socket | **Fix this** repoints the queue |
| Stale "Use Printer Offline" flag | Windows flag never cleared | Cleared automatically |
| No USB printing device attached | Genuinely unplugged or powered off | Check the cable |
| Out of paper / cover open | Physical | Load paper / close the cover |
| Print Spooler not running | Windows service stopped | **Fix this** restarts it |

### POS can't connect

1. `Get-Service "XP Thermal Print Service"`
2. `type C:\ProgramData\XPThermalService\active_port.txt`
3. `curl http://127.0.0.1:9100/health`
4. A CORS rejection returns a 403 that names the origin and how to allow it. Loopback is always allowed on any port.

### Common issues

| Issue | Resolution |
|-------|------------|
| Port 9100 in use | Auto-switches to 9101–9109; check `active_port.txt` or `/health` |
| `Invalid class "Win32_Printer"` | Damaged WMI; the spooler fallback handles it. Repair with `winmgmt /salvagerepository` |
| New build not taking effect | `Restart-Service` does not cycle the Node child — use the dashboard restart or `POST /api/service/restart` |
| Service refuses to start, exit code 4 | Another instance is running. Stop it, or use the Windows service rather than launching by hand |
| Printers vanished from config | A config that fails to parse is backed up as `config.corrupt.*.json` and never overwritten — restore from it |
| Cash drawer won't open | Try the other pin, or a longer pulse, via **Test drawer now** |
| Config edited in Notepad | UTF-8 BOMs are handled; the file is rewritten without one |

### Logs

```
C:\ProgramData\XPThermalService\logs\
C:\ProgramData\XPThermalService\daemon\*.log
%TEMP%\XPThermalInstall_*.log
```

---

## Security

- **Loopback binding** by default — not reachable from the network
- **CORS**: loopback trusted on any port; wildcard patterns; optional private-LAN access; rejections explain the fix
- **API key** via `X-API-Key`, served to loopback callers only
- **Host validation**, **Helmet** headers, **rate limiting** (120/min + 20/sec burst, loopback exempt so a busy till is never throttled)
- **Zod validation** on every request body; 1MB payload cap; 30s request timeout
- **No injection surface in the PowerShell bridge** — printer names travel via environment variables and are never interpolated into script text, which is why names like `XP-80C @ Kitchen` or `Drucker (Küche)` are accepted
- Restore and restart endpoints are **loopback-only**

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Windows Service (node-windows) - LocalSystem, depends on     │
│  Print Spooler, SCM recovery 5s/10s/30s, single-instance lock │
├──────────────────────────────────────────────────────────────┤
│  Express API (127.0.0.1:9100-9109)                            │
│  Helmet · CORS policy · rate limit · Zod · SSE /api/events     │
├──────────────────────────────────────────────────────────────┤
│  Job Queue (sql.js) - priority, idempotency, backoff retry     │
│  flushed on every exit path so accepted jobs are never lost    │
├──────────────────────────────────────────────────────────────┤
│  Template Engine - receipt · KOT · invoice · label · raw       │
├──────────────────────────────────────────────────────────────┤
│  Printer Manager                                              │
│   ├── Device Watcher   WMI events -> ~1s reaction              │
│   ├── Printer Resolver classify · rebind · plan repairs        │
│   ├── USB Adapter      winspool RAW writes, cached helper      │
│   └── Network Adapter  TCP 9100                                │
├──────────────────────────────────────────────────────────────┤
│  Windows Print System (one cached snapshot, single-flight)     │
│   CIM -> WMI -> winspool EnumPrinters -> Get-Printer           │
│   registry fallbacks for USB presence and OS identity          │
└──────────────────────────────────────────────────────────────┘
```

### Design rules

- **One snapshot, shared.** A health check across N printers costs one PowerShell process, not 2N. Cached 4s with single-flight deduplication.
- **Never trust one signal.** Every offline verdict requires corroboration.
- **Degrade, don't fail.** Broken WMI, no event subscription, unwritable lock, missing helper assembly — each has a fallback, and the service says which mode it is in.
- **Repair the cheap thing first.** Port, then flag, then queue, then spooler.
- **Refuse to guess when wrong is expensive.** Order tickets going to the wrong station is worse than asking.

---

## System Requirements

- Windows 8 or later (Windows 10/11 recommended)
- Node.js 18+
- Administrator rights to install the service

---

## License

MIT License - See LICENSE file for details.
