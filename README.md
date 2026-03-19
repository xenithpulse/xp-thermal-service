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
- Windows 10/11 (for Windows service)
- USB drivers for USB printers
- Network access for LAN printers

## License

MIT License - See LICENSE file for details.
