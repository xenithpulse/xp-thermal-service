# XP Thermal Service

A production-grade local thermal printing service for restaurant POS systems. Designed to be a reliable, open-source alternative to QZ Tray for thermal printing needs.

## Features

- **Reliable Printing**: Job persistence, retry logic, and crash recovery
- **Multiple Printers**: Support for USB and network thermal printers
- **ESC/POS Support**: Full ESC/POS command support including barcodes and QR codes
- **Templates**: Built-in templates for receipts, KOT, invoices, and custom formats
- **Secure API**: Localhost-only by default, CORS protection, rate limiting
- **Windows Service**: Run as a background Windows service
- **Idempotent**: Duplicate job prevention with idempotency keys
- **Queue Management**: Priority queuing, concurrent job processing
- **Health Monitoring**: Health checks, metrics, and status endpoints

## Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/xp-thermal-service.git
cd xp-thermal-service

# Install dependencies
npm install

# Copy and configure
cp config.example.json config.json
# Edit config.json with your printer settings

# Build
npm run build

# Start
npm start
```

### As a Windows Service

```bash
# Install as Windows service (requires admin)
npm run service:install

# Start the service
npm run service:start

# Stop the service
npm run service:stop

# Uninstall
npm run service:uninstall
```

## API Reference

### Print a Receipt

```bash
POST http://localhost:9100/api/print
Content-Type: application/json

{
  "idempotencyKey": "order-12345-receipt",
  "templateType": "receipt",
  "payload": {
    "orderNumber": "12345",
    "orderDate": "2024-01-15",
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

```bash
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

### Check Job Status

```bash
GET http://localhost:9100/api/jobs/{jobId}/status
```

### List Printers

```bash
GET http://localhost:9100/api/printers
```

### Health Check

```bash
GET http://localhost:9100/health
```

## Configuration

Create a `config.json` file in the project root:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 9100
  },
  "security": {
    "allowedOrigins": ["http://localhost:3000"],
    "allowedHosts": ["localhost", "127.0.0.1"],
    "rateLimitPerMinute": 120
  },
  "queue": {
    "maxConcurrentJobs": 3,
    "maxRetries": 5,
    "retryDelayMs": 1000
  },
  "printers": [
    {
      "id": "cashier",
      "name": "Receipt Printer",
      "type": "network",
      "enabled": true,
      "isDefault": true,
      "host": "192.168.1.100",
      "port": 9100,
      "capabilities": {
        "maxWidth": 48,
        "supportsBold": true,
        "supportsBarcode": true,
        "supportsQRCode": true,
        "supportsCut": true
      }
    }
  ]
}
```

## Template Types

### Receipt
Full receipt with header, items, totals, payment info, and optional barcode/QR code.

### KOT (Kitchen Order Ticket)
Kitchen order with large text, modifiers, and special instructions.

### Invoice
Detailed invoice with customer info and line items.

### Test
Test print with font samples, alignment tests, and optional barcode/QR code.

### Raw
Direct ESC/POS commands (hex, base64, or raw bytes).

## Integration with Next.js

```typescript
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

## Error Handling

The service uses specific error codes:

- `PRINTER_NOT_FOUND` - Specified printer doesn't exist
- `PRINTER_OFFLINE` - Printer is not connected
- `PRINTER_TIMEOUT` - Print operation timed out
- `JOB_NOT_FOUND` - Job ID doesn't exist
- `JOB_DUPLICATE` - Job with same idempotency key exists
- `INVALID_REQUEST` - Invalid request payload
- `RATE_LIMITED` - Too many requests

## Job Lifecycle

1. `pending` - Job created, waiting to be processed
2. `queued` - Job added to processing queue
3. `processing` - Template being rendered
4. `printing` - Data being sent to printer
5. `completed` - Print successful
6. `failed` - Print failed (may retry)
7. `retry_scheduled` - Waiting for retry
8. `dead_letter` - Failed after max retries
9. `cancelled` - Cancelled by user

## Development

```bash
# Run in development mode
npm run dev

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint
```

## System Requirements

- Node.js 18+
- Windows 7/10/11 (for Windows service)
- USB drivers for USB printers
- Network access for LAN printers

## Deployment to Client PCs

### Installation (Administrator Required)

```powershell
# 1. Build the service
npm run build

# 2. Install as Windows service (Run PowerShell as Admin)
cd scripts
.\install.ps1

# The installer will:
# - Copy files to C:\ProgramData\XPThermalService
# - Register the Windows service with auto-start
# - Configure service recovery (restart on failure)
# - Add firewall rule for port 9100
# - Verify the service is running
```

### Verify Installation

```powershell
# Run diagnostics (no admin required)
.\scripts\diagnose.ps1

# Run with auto-fix for common issues (admin required)
.\scripts\diagnose.ps1 -Fix
```

### Service Management

```powershell
# Start/Stop/Restart
.\scripts\install.ps1 -Start
.\scripts\install.ps1 -Stop
.\scripts\install.ps1 -Restart

# Uninstall
.\scripts\install.ps1 -Uninstall

# Check status
Get-Service "XP Thermal Print Service"
```

### Auto-Start Behavior

The service is configured to:
- Start automatically on Windows boot
- Restart automatically on failure (after 5s, 10s, 30s delays)
- Write the active port to `C:\ProgramData\XPThermalService\data\active_port.txt`

## Smart Port Handling

The service uses smart port allocation:

1. **Service Side**: If port 9100 is in use, automatically tries 9101, 9102, etc.
2. **Client Side**: The ThermalPrintAdapter scans ports 9100-9109 to find the service
3. **Port Persistence**: The discovered port is cached in localStorage

This ensures connectivity even if:
- Another application is using port 9100
- The service restarts on a different port
- Multiple instances exist (not recommended)

## Connecting from XP-POS

### ThermalPrintAdapter Integration

```typescript
import { getThermalAdapter, ThermalPrintService } from './printing-facility';

// Initialize the print service (singleton)
const printService = ThermalPrintService.getInstance({
  autoReconnect: true,
  reconnectInterval: 5000,
  healthCheckInterval: 30000,
  onConnectionChange: (connected) => {
    console.log(`Thermal service: ${connected ? 'connected' : 'disconnected'}`);
  }
});

// Initialize and check connection
await printService.initialize();

if (printService.isConnected()) {
  // Print a bill
  const result = await printService.printBill(billData, {
    copies: 2,
    openCashDrawer: true
  });
  
  console.log('Print job:', result.jobId);
}
```

### Connection Recovery

The adapter automatically:
- Caches the last successful port in localStorage
- Probes cached port first on reconnection
- Scans port range if cached port fails
- Retries with exponential backoff on failures

### Manual Reconnection

```typescript
// Force reconnect with port re-discovery
await printService.reconnect();

// Get current service URL (for debugging)
console.log('Service URL:', printService.getServiceUrl());
```

## Troubleshooting

### Service Won't Start

1. Run diagnostics: `.\scripts\diagnose.ps1`
2. Check logs: `C:\ProgramData\XPThermalService\logs\`
3. Verify Node.js is in PATH
4. Check Windows Event Viewer for errors

### POS Can't Connect

1. Verify service is running: `Get-Service "XP Thermal Print Service"`
2. Check dashboard: `http://127.0.0.1:9100/dashboard`
3. Test health endpoint: `curl http://127.0.0.1:9100/health`
4. Check CORS config includes your POS origin

### Printer Not Printing

1. Verify printer is online in dashboard
2. Test print from dashboard
3. Check if printer name matches Windows printer exactly
4. For network printers, verify IP and port

### Common Issues

| Issue | Solution |
|-------|----------|
| Port 9100 in use | Service auto-switches ports; check dashboard for actual port |
| Service crashes on boot | Check logs; may be config.json syntax error |
| CORS errors | Add POS URL to `security.allowedOrigins` in config.json |
| Printer offline | Verify Windows can print test page; check printer name spelling |

## Security Notes

- Service binds to localhost (127.0.0.1) by default
- CORS headers restrict cross-origin access
- Rate limiting prevents abuse (120 req/min default)
- API key optional for additional security
- No external network access required

## License

MIT License - See LICENSE file for details.
