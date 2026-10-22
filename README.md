<div align="center">

<img src="assets/icon.png" alt="" width="72">

# Thermal Bridge

**Silent receipt printing for web apps.**

Formerly XP Thermal Service

Print receipts, kitchen tickets (KOT), barcodes and QR codes from any browser app to USB or network ESC/POS printers, with no print dialog. One installer, no Node.js, no admin rights.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20(x64)-blue)
[![Latest release](https://img.shields.io/github/v/release/xenithpulse/xp-thermal-service)](https://github.com/xenithpulse/xp-thermal-service/releases/latest)

[**Download ThermalBridge-Setup.exe**](https://github.com/xenithpulse/xp-thermal-service/releases/latest/download/ThermalBridge-Setup.exe) · [Product page](https://xenithpulse.com/products/thermal-bridge) · [Pulsar Restaurant POS](https://xenithpulse.com/products/restaurant-pos) · [Need integration help?](https://wa.me/97455911793?text=Thermal%20Bridge%20integration)

<img src="docs/dashboard.png" alt="Thermal Bridge dashboard" width="720">

<img src="docs/receipt.jpg" alt="Receipt and KOT printed with Thermal Bridge" width="720">

</div>

---

## Why this exists

Browsers can't talk to thermal printers directly, so most web POS systems rely on QZ Tray. QZ Tray is open source (LGPL), but printing silently, without a trust prompt on every job, needs its Premium Support certificate. We needed reliable printing for our own [Pulsar Restaurant POS](https://xenithpulse.com/products/restaurant-pos), so we built Thermal Bridge and open-sourced it.

| | Thermal Bridge | QZ Tray |
| --- | --- | --- |
| Silent printing (no trust prompts) | Free | Needs the Premium Support certificate ($599/year) |
| Licence | MIT | LGPL 2.1 |
| Install | One installer, no admin, no Node.js | Desktop installer + certificate signing setup |
| Runs as | Tray app with a self-healing print server, or a Windows service | Tray app |
| Built-in receipt/KOT templates | Yes, send JSON | No, you build the print data |

<sub>QZ Tray pricing from buy.qz.io as of October 2026; verify current terms with QZ.</sub>

## Built into Pulsar Restaurant POS

Thermal Bridge ships **built in** with [Pulsar Restaurant POS](https://xenithpulse.com/products/restaurant-pos). It installs as one of the POS's Windows services and handles receipts, KOTs and the cash drawer out of the box, with no extra setup.

Want the whole system instead of building your own? **Pulsar Restaurant POS is $299 once, with no subscription and unlimited tills.** [See the POS →](https://xenithpulse.com/products/restaurant-pos)

Building your own POS? Use Thermal Bridge standalone. It works with any web app that can send an HTTP request.

## Quick Start

1. **Download** [`ThermalBridge-Setup.exe`](https://github.com/xenithpulse/xp-thermal-service/releases/latest/download/ThermalBridge-Setup.exe) from Releases.
2. **Double-click** it. There is no admin prompt; it installs for your Windows user and opens the dashboard.
3. Click **Detect printers**, type a name for your printer and choose what it is for (Receipt, Kitchen, Label).
4. Click **Print test page**.

No Node.js, no admin rights, no terminal. Thermal Bridge then sits in the system tray and starts with Windows.

Prefer not to install? `ThermalBridge-Portable-<version>.exe` from the same release runs from any folder or a USB stick.

### Your first print

```js
await fetch("http://localhost:9100/api/print", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    idempotencyKey: "order-4821-kot",
    printerId: "kitchen",
    templateType: "kot",
    payload: {
      orderNumber: "4821",
      tableName: "Table 12",
      items: [
        { name: "Margherita", quantity: 2 },
        { name: "Garlic Bread", quantity: 1 }
      ]
    }
  })
});
```

Two things decide whether a website may print:

- **Its origin.** Pages on this computer (`localhost`) and on your local network can print straight away. Any other website, such as `https://your-pos.example.com`, appears at the top of the dashboard the first time it tries: *"https://your-pos.example.com wants to print — Allow / Block"*. Nobody has to edit `config.json`.
- **The API key**, when it is enabled (it is by default). Fetch it once from `GET /api/auth/local-token`, which only answers this computer, and send it as `X-API-Key`. See [docs/web-integration.md](docs/web-integration.md).

The service picks the first free port from 9100, so look it up rather than assuming 9100: probe `http://127.0.0.1:9100–9110/health` for `"service": "xp-thermal-service"`, or read `active_port.txt` (see [Where things live](#where-things-live)).

## Features

- **One-file install**: a per-user installer with no UAC prompt, or a portable exe. The Node.js runtime is built in.
- **Self-healing**: a small supervisor restarts the print server after 5s, 10s, then 30s if it ever exits; queued jobs survive crashes and reboots
- **Tray icon**: open the dashboard, print a test page, see which printers are online, turn Start with Windows on or off
- **Multiple printers**: USB (through the Windows spooler, any driver) and network printers, with detection of both
- **ESC/POS**: barcodes, QR codes, formatting, cash drawer pulses
- **Templates**: receipts, KOT, invoices, labels, test pages, and raw ESC/POS
- **Website pairing**: unknown websites are offered to the operator with Allow / Block
- **Secure by default**: listens on `127.0.0.1` only, CORS and host checks, API key, Chrome Private Network Access, rate limiting
- **Smart port handling**: falls back from 9100 to the next free port and tells clients where it landed
- **Job persistence**: SQLite-backed queue with idempotency keys, retries with backoff, and automatic database repair
- **Updates you control**: "Check for updates" verifies the download's SHA-256 and Authenticode signature, then offers to run the installer
- **Windows service mode** for POS and fleet installs: `ThermalBridge.exe --install-service`

## Where things live

| | Installed app | Windows service |
| --- | --- | --- |
| Program | `%LOCALAPPDATA%\Programs\ThermalBridge\ThermalBridge.exe` | `%ProgramFiles%\ThermalBridge\` |
| Settings (`config.json`) | `%LOCALAPPDATA%\ThermalBridge\` | `%ProgramData%\ThermalBridge\` |
| Print history (`data\jobs.db`) | `%LOCALAPPDATA%\ThermalBridge\data\` | `%ProgramData%\ThermalBridge\data\` |
| Logs | `%LOCALAPPDATA%\ThermalBridge\logs\` (tray → *Open logs folder*) | `%ProgramData%\ThermalBridge\logs\` |
| Active port | `%LOCALAPPDATA%\ThermalBridge\active_port.txt` | `%ProgramData%\ThermalBridge\active_port.txt`, and `%ProgramData%\XPThermalService\active_port.txt` for older POS builds |
| Starts with Windows | `HKCU\...\Run\ThermalBridge` (toggle in tray or dashboard) | Service, delayed automatic start |

The portable exe uses the same settings folder as the installed app.

## Moving from XP Thermal Service

If the old XP Thermal Print Service is installed and running, Thermal Bridge leaves printing to it and says so in the tray, so the two never fight over printers. The dashboard offers to **import your printers** from `C:\ProgramData\XPThermalService\config.json`. When you are ready, remove the old service from Windows Services (or run `legacy\uninstall.bat` as Administrator); Thermal Bridge notices within a few minutes and takes over. See [legacy/README.md](legacy/README.md).

## API Reference

### Health Check

```
GET http://localhost:9100/health
```

Response:

```json
{
  "status": "healthy",
  "reasons": [],
  "uptime": 3600000,
  "version": "3.0.1",
  "printers": { "total": 2, "online": 2, "offline": 0, "error": 0, "initializing": false },
  "queue": { "pending": 0, "processing": 0, "failed": 0, "deadLetter": 0, "oldestPendingAgeMs": null },
  "service": "xp-thermal-service",
  "name": "Thermal Bridge",
  "mode": "user",
  "port": 9100,
  "configuredPort": 9100
}
```

> `status` is `healthy`, `degraded` or `unhealthy`, and `reasons` says why in plain words. `service` is always `xp-thermal-service`, which is what clients match on; `name` and `mode` (`user`, `service` or `legacy`) were added in 3.0.

### Print a Receipt

```http
POST http://localhost:9100/api/print
Content-Type: application/json

{
  "idempotencyKey": "order-12345-receipt",
  "templateType": "receipt",
  "payload": {
    "orderNumber": "12345",
    "orderDate": "2026-01-15",
    "items": [
      {"name": "Burger", "quantity": 2, "price": 12.99, "total": 25.98},
      {"name": "Fries", "quantity": 2, "price": 4.99, "total": 9.98}
    ],
    "subtotal": 35.96,
    "tax": 2.88,
    "total": 38.84,
    "header": {
      "storeName": "Joe's Diner",
      "storeAddress": ["123 Main St", "City, State 12345"],
      "storePhone": "(555) 123-4567"
    },
    "footer": {
      "thankYouMessage": "Thank you for dining with us!"
    }
  }
}
```

### Print a Kitchen Order Ticket (KOT)

```http
POST http://localhost:9100/api/print
Content-Type: application/json

{
  "idempotencyKey": "order-12345-kot-kitchen",
  "printerId": "kitchen",
  "templateType": "kot",
  "priority": 2,
  "payload": {
    "orderNumber": "12345",
    "tableName": "Table 5",
    "serverName": "John",
    "orderTime": "14:35",
    "items": [
      {"name": "Burger", "quantity": 2, "modifiers": ["No onions", "Extra cheese"]},
      {"name": "Fries", "quantity": 2, "notes": "Extra crispy"}
    ],
    "notes": "Rush order"
  }
}
```

### Print to a Specific Printer

```http
POST http://localhost:9100/api/print/kitchen
Content-Type: application/json

{
  "idempotencyKey": "order-12345-kot",
  "templateType": "kot",
  "payload": { ... }
}
```

### Job Management

```
GET    /api/jobs/{jobId}                 # Job details
GET    /api/jobs/{jobId}/status          # Status with history
GET    /api/jobs?status=pending&limit=50 # List jobs (filters: status, printerId, limit)
DELETE /api/jobs/{jobId}                 # Cancel a job
POST   /api/jobs/{jobId}/retry           # Retry a failed job
POST   /api/jobs/clear-failed            # Clear all failed jobs
```

### Printer Management

```
GET  /api/printers                       # List all printers
GET  /api/printers/{printerId}           # Printer details
GET  /api/printers/{printerId}/status    # Printer status
POST /api/printers/{printerId}/test      # Send a test print
POST /api/printers/{printerId}/reconnect # Reconnect a printer
GET  /api/system/printers                # System-detected printers (Windows)
```

### Queue Management

```
GET  /api/queue/stats   # Queue stats
POST /api/queue/pause   # Pause the queue
POST /api/queue/resume  # Resume the queue
```

### System & Metrics

```
GET /api/metrics             # Service metrics
GET /api/system/info         # System info
GET /api/system/connections  # Active connections
```

### Configuration Management

```
GET    /api/config                        # Current config
PUT    /api/config/server                 # Update server settings
PUT    /api/config/security               # Update security settings
POST   /api/config/printers               # Add a printer
PUT    /api/config/printers/{printerId}   # Update a printer
DELETE /api/config/printers/{printerId}   # Delete a printer
```

### Dashboard

```
http://localhost:9100/dashboard
```

Web-based dashboard for monitoring printers, queue, jobs, and managing configuration.

## Configuration

Everything an operator needs is in the dashboard: printers are added with **Detect printers**, websites are approved with **Allow**, and Start with Windows is a checkbox. `config.json` (in the settings folder above) is still there for automation and support. It is created on first run from [config.example.json](config.example.json), which ships with no printers and allows only `http://localhost:3000` and `http://127.0.0.1:3000` beyond the always-trusted loopback and local network.

```json
{
  "server": { "host": "127.0.0.1", "port": 9100 },
  "security": {
    "allowedOrigins": ["http://localhost:3000", "http://127.0.0.1:3000"],
    "blockedOrigins": [],
    "enableApiKey": true,
    "rateLimitPerMinute": 120
  },
  "printers": [
    {
      "id": "receipt",
      "name": "Front counter",
      "type": "usb",
      "printerName": "Generic / Text Only",
      "isDefault": true
    },
    {
      "id": "kitchen",
      "name": "Kitchen",
      "type": "network",
      "host": "192.168.1.100",
      "port": 9100
    }
  ]
}
```

> **Allowed origins:** prefer the dashboard's Allow / Block prompt. If you list origins by hand, use exact URLs (or wildcards such as `https://*.example.com`) and avoid `"*"`: it lets any website you visit send jobs to your printer.

> **USB printers:** `printerName` is the Windows printer name, exactly as shown in *Settings → Printers & scanners*. Detect printers fills it in for you.

## Template Types

| Type      | Description                                                                         |
| --------- | ----------------------------------------------------------------------------------- |
| `receipt` | Full receipt with header, items, totals, payment info, and optional barcode/QR code |
| `kot`     | Kitchen order ticket with large text, modifiers, and special instructions           |
| `invoice` | Detailed invoice with customer info and line items                                  |
| `test`    | Test print with font samples, alignment tests, and optional barcode/QR code         |
| `label`   | Label printing                                                                      |
| `raw`     | Direct ESC/POS commands (hex, base64, or raw bytes)                                 |

## Integration with Next.js / React

```ts
// lib/print-service.ts
const PRINT_SERVICE_URL = 'http://localhost:9100';

export async function printReceipt(order: Order) {
  const response = await fetch(`${PRINT_SERVICE_URL}/api/print`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: `order-${order.id}-receipt`,
      templateType: 'receipt',
      payload: {
        orderNumber: order.id,
        orderDate: new Date().toLocaleDateString(),
        items: order.items.map(item => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          total: item.quantity * item.price
        })),
        subtotal: order.subtotal,
        tax: order.tax,
        total: order.total
      }
    })
  });

  return response.json();
}

export async function checkPrintStatus(jobId: string) {
  const response = await fetch(`${PRINT_SERVICE_URL}/api/jobs/${jobId}/status`);
  return response.json();
}
```

> **Chrome Private Network Access:** The service includes PNA headers (`Access-Control-Allow-Private-Network: true`) so a POS website hosted on the internet can call `localhost` without CORS errors in Chrome.

## Error Handling

| Code                | Description                          |
| ------------------- | ------------------------------------ |
| `PRINTER_NOT_FOUND` | Specified printer doesn't exist      |
| `PRINTER_OFFLINE`   | Printer is not connected             |
| `PRINTER_TIMEOUT`   | Print operation timed out            |
| `JOB_NOT_FOUND`     | Job ID doesn't exist                 |
| `JOB_DUPLICATE`     | Job with same idempotency key exists |
| `INVALID_REQUEST`   | Invalid request payload              |
| `RATE_LIMITED`      | Too many requests                    |

## Job Lifecycle

```
pending → queued → processing → printing → completed
                                    ↓
                                  failed → retry_scheduled → processing (retry)
                                    ↓
                               dead_letter (max retries exceeded)

                              cancelled (user-initiated)
```

| Status            | Description                             |
| ----------------- | --------------------------------------- |
| `pending`         | Job created, waiting to be processed    |
| `queued`          | Job added to processing queue           |
| `processing`      | Template being rendered                 |
| `printing`        | Data being sent to printer              |
| `completed`       | Print successful                        |
| `failed`          | Print failed (may retry)                |
| `retry_scheduled` | Waiting for retry (exponential backoff) |
| `dead_letter`     | Failed after max retries                |
| `cancelled`       | Cancelled by user                       |

## Build from source

Developers only; restaurant owners should use the installer above.

```bash
git clone https://github.com/xenithpulse/xp-thermal-service.git
cd xp-thermal-service
npm ci

npm run dev        # run the print server from source (ts-node), in the foreground
npm run app        # run the full app (supervisor, tray, server) from the bundled JS
npm run dev:dashboard  # rebuild the dashboard (src/dashboard/, Tailwind CSS) on every save
npm test           # unit tests
npm run lint
npm run build:exe  # build release/ThermalBridge-Setup-<v>.exe, ThermalBridge-Setup.exe, ThermalBridge-Portable-<v>.exe
```

Building the exe needs Windows 10/11 x64 and Node.js 20 or newer, nothing else: the installer is built from `installer/` with the C# compiler that ships with Windows, and the build downloads the Node 22 runtime it embeds. [docs/BUILD.md](docs/BUILD.md) explains the build, the native-module decisions, code signing, and how releases reach GitHub and the update channel.

`npm run build` still produces `dist/index.js`, which runs the print server under a plain `node` (this is how Pulsar POS's own installer bundles it today).

## System Requirements

- **Windows 10 or 11, x64.** Windows 7 and 8.1 are not supported: the built-in Node.js 22 runtime requires Windows 10 or Server 2016 or later.
- About 250 MB of disk space
- A Windows driver for USB printers (`Generic / Text Only` works for most ESC/POS printers)
- Network access for LAN printers

## Windows service mode (POS and fleet installs)

The installer above needs no admin rights because Thermal Bridge runs as a per-user background app. An installer that is already elevated, such as Pulsar POS's, can instead register it as a Windows service:

```bat
ThermalBridge.exe --install-service      :: needs an elevated prompt; prints a clear error otherwise
ThermalBridge.exe --uninstall-service
```

The service is named `ThermalBridge` (display name *Thermal Bridge*), keeps its data in `%ProgramData%\ThermalBridge`, and exposes the same API, port range and `active_port.txt` discovery. See [docs/SERVICE-MODE.md](docs/SERVICE-MODE.md).

## Smart Port Handling

1. **Service side**: if port 9100 is in use, it takes 9101, 9102 and so on (up to 9109).
2. **Client side**: clients probe 9100–9110 and accept the one answering `/health` with `"service": "xp-thermal-service"`.
3. **Port file**: the active port is written to `active_port.txt` (see [Where things live](#where-things-live)).

This keeps clients connected when another program holds 9100, which is common: 9100 is also the standard raw printing port.

## Connecting from Pulsar Restaurant POS

Pulsar Restaurant POS connects automatically through its built-in `ThermalPrintAdapter`. The snippet below shows how the adapter works if you're building something similar.

```ts
import { getThermalAdapter, ThermalPrintService } from './printing-facility';

const printService = ThermalPrintService.getInstance({
  autoReconnect: true,
  reconnectInterval: 5000,
  healthCheckInterval: 30000,
  onConnectionChange: (connected) => {
    console.log(`Thermal service: ${connected ? 'connected' : 'disconnected'}`);
  }
});

await printService.initialize();

if (printService.isConnected()) {
  const result = await printService.printBill(billData, {
    copies: 2,
    openCashDrawer: true
  });
  console.log('Print job:', result.jobId);
}
```

The adapter caches the last successful port in localStorage, probes it first on reconnection, scans the port range if it fails, and retries with exponential backoff.

```ts
await printService.reconnect();              // Force reconnect with port re-discovery
console.log(printService.getServiceUrl());   // Current service URL (for debugging)
```

## Troubleshooting

### Nothing prints

1. Open the dashboard (tray icon → **Open dashboard**). The banner at the top says whether printing works and why not.
2. Click **Print test page**.
3. For USB printers, check the printer appears in Windows *Settings → Printers & scanners*. Thermal Bridge prints through the Windows spooler.
4. For network printers, check the IP address and that the PC and printer are on the same network.

### A website can't print

1. Look at the top of the dashboard for *"… wants to print"* and click **Allow**.
2. Make sure the site sends the `X-API-Key` header (from `/api/auth/local-token`).
3. Check the port: `curl http://127.0.0.1:9100/health`, then 9101, 9102…

### Common issues

| Issue | Solution |
| --- | --- |
| Windows says "Windows protected your PC" | The download is not code-signed yet. Click *More info → Run anyway*, or verify it against `SHA256SUMS.txt` from the release |
| Port 9100 in use | Normal. Thermal Bridge moves to 9101+; check `active_port.txt` or the dashboard banner |
| Tray says "Installed service is printing" | The old XP Thermal Print Service or a Thermal Bridge service already prints on this PC. See [Moving from XP Thermal Service](#moving-from-xp-thermal-service) |
| Printing stopped after a crash | It restarts itself within 5–30 seconds; jobs queued before the crash still print. Logs: tray → *Open logs folder* (`supervisor.log`, `service.log`) |
| Config file damaged | Detected at startup, backed up as `config.corrupt.<time>.json`, and rebuilt from the example |
| Database corruption | Detected and rebuilt on startup; the old database is backed up |

More in [docs/troubleshooting.md](docs/troubleshooting.md).

## Security

- **Localhost only**: binds to `127.0.0.1`, so nothing on the network can reach it, and Windows Firewall never asks
- **Origins**: loopback and local network allowed; other websites only after the operator clicks Allow; Block always wins
- **API key**: `X-API-Key`, generated on first run, handed out only to callers on this computer
- **Host validation, rate limiting** (120/min plus a burst limit), **payload limit** (1 MB), **request timeout** (30 s), **Helmet** headers, **Zod** validation
- **No telemetry**: the only outbound requests are the ones you trigger with *Check for updates*
- **Updates**: SHA-256 from the manifest, and an Authenticode signature from XenithPulse, are both checked before an installer is offered

## Architecture

```
ThermalBridge.exe (supervisor)                one per Windows user; named-pipe single instance
├── ThermalBridgeTray.exe                      tray icon, ~15 KB, exits with the supervisor
└── ThermalBridge.exe --server                 restarted after 5s / 10s / 30s if it exits
    ├── Express API on 127.0.0.1:9100–9109
    │   ├── Helmet + CORS + PNA + origin pairing + rate limiter
    │   ├── /health, /dashboard
    │   ├── /api/print, /api/jobs, /api/printers
    │   └── /api/config, /api/metrics, /api/system, /api/app, /api/origins
    ├── Job queue (SQLite via sql.js WebAssembly, persisted to data\jobs.db)
    ├── Template engine (receipt, KOT, invoice, label, test, raw → ESC/POS)
    └── Printer manager
        ├── USB: Windows spooler, RAW datatype (no native modules)
        └── Network: TCP socket to port 9100

Service mode: ThermalBridgeService.exe (Windows service) → ThermalBridge.exe --service → --server
```

## Commercial support

Thermal Bridge is free forever. If you'd rather not wire it up yourself, XenithPulse offers:

- **Integration** into your existing POS or web app
- **Custom templates** for your receipt, KOT or label layouts
- **A complete POS**: [Pulsar Restaurant POS](https://xenithpulse.com/products/restaurant-pos), with thermal printing built in, for $299 once

[Message us on WhatsApp](https://wa.me/97455911793?text=Thermal%20Bridge%20integration) · [xenithpulse.com](https://xenithpulse.com)

## Contributing

Issues and pull requests are welcome. If this saved you a QZ Tray licence, a ⭐ helps other developers find it.

## License

[MIT](LICENSE) © XenithPulse
