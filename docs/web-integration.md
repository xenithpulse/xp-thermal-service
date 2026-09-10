# Web Integration Guide

How to drive XP Thermal Service from your own web application.

Audience: a developer integrating a third-party web app — hosted anywhere, including a public HTTPS site — with a copy of this service running on the customer's Windows machine.

Every shape in this document is taken from the running code and then **exercised against a live service** — request/response examples below are real, not illustrative. Route table: [server.ts:404-481](../src/api/server.ts#L404-L481). Types: [types/index.ts](../src/types/index.ts).

---

## The shape of the problem

This service is **not** a cloud API. It runs on the customer's own PC, bound to `127.0.0.1`, and drives USB printers attached to that PC.

So your web page — wherever it is served from — makes requests **from the customer's browser to their own machine**:

```
[ your web app, any origin ]
            |
            |  fetch() from the customer's browser
            v
[ http://127.0.0.1:<port> ]  <-- XP Thermal Service, on the customer's PC
            |
            v
      [ USB thermal printer ]
```

Three consequences that shape everything below:

1. **The port is not fixed.** You must discover it. See [Step 1](#step-1-discover-the-port).
2. **You need CORS clearance**, because your origin is not the service's origin. See [Step 3](#step-3-get-your-origin-allowed).
3. **A public HTTPS page calling `http://127.0.0.1` triggers Private Network Access checks** in Chromium. The service supports this, but mixed content rules still apply. See [Private Network Access](#private-network-access-https-sites).

---

## Step 1: Discover the port

The service binds the first free port in **9100-9109** ([server.ts:1768](../src/api/server.ts#L1768)). Port 9100 is the RAW/JetDirect printing port and is frequently already taken. **Never hard-code 9100.**

Scan the range and confirm identity. `/health` needs no API key, and only this service answers with `service: "xp-thermal-service"`:

```js
async function discoverService({ timeoutMs = 800 } = {}) {
  for (let port = 9100; port <= 9109; port++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const body = await res.json();
      if (body.service === 'xp-thermal-service') {
        return { baseUrl: `http://127.0.0.1:${port}`, health: body };
      }
    } catch {
      // Port closed or something else is listening. Keep scanning.
    }
  }
  throw new Error('XP Thermal Service not found on ports 9100-9109');
}
```

Cache the result, but **re-discover on any connection failure** — the port can change after a reboot if something else claims 9100 first.

Every response also carries an `X-Service-Port` header ([server.ts:196-199](../src/api/server.ts#L196-L199)), which is exposed to CORS clients. It lets you confirm the port you reached without parsing the body.

### `/health` response

```json
{
  "status": "healthy",
  "reasons": [],
  "uptime": 8052341,
  "version": "1.0.0",
  "printers": { "total": 2, "online": 2, "offline": 0, "error": 0, "busy": 0, "initializing": false },
  "queue": { "pending": 0, "processing": 0, "failed": 0, "deadLetter": 0, "oldestPendingAgeMs": null },
  "service": "xp-thermal-service",
  "port": 9101,
  "configuredPort": 9100
}
```

| `status` | Meaning | What you should do |
|---|---|---|
| `healthy` | Can accept and complete work | Print normally |
| `degraded` | Accepting work it cannot currently complete | Warn the operator; jobs will queue, not vanish |
| `unhealthy` | Cannot accept work at all | Block printing and surface `reasons` |

`reasons` is an array of plain-language strings. Show it to the user verbatim — it is written to be read. A live example:

```json
"reasons": ["None of the 2 configured printer(s) are online (0 in error, 2 offline)."]
```

`queue.oldestPendingAgeMs` is `null` when nothing is pending, so guard before doing arithmetic on it.

A **503** from `/health` means the job store itself is unusable ([server.ts:534-552](../src/api/server.ts#L534-L552)). Nothing you send will be recorded.

---

## Step 2: Authenticate

Send the key in an `X-API-Key` header on every request:

```
X-API-Key: dd1dec49968c15a02f785faf5c8dfb94...
```

**Exempt from the key** ([server.ts:333-340](../src/api/server.ts#L333-L340)) — `/health`, `/api/health`, `/`, `/dashboard`, `/api/auth/local-token`.

A missing or wrong key returns **401**:

```json
{ "error": "Unauthorized", "message": "Invalid or missing API key" }
```

### Getting the key without asking the user to paste it

If your page runs on the same machine (loopback), fetch it:

```
GET /api/auth/local-token
```

```json
{ "apiKey": "dd1dec...", "authRequired": true }
```

When API-key auth is disabled in config, it returns `{ "apiKey": "", "authRequired": false }`.

This endpoint is **loopback-only** ([server.ts:563-570](../src/api/server.ts#L563-L570)) — `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. From anywhere else it returns 403:

```json
{ "error": "Forbidden", "message": "Only available from localhost" }
```

So a **remotely-hosted page cannot bootstrap the key this way.** For a public site, have the operator copy the key from the dashboard's Settings page once and store it in your app's own settings.

---

## Step 3: Get your origin allowed

Policy source: [origin-policy.ts](../src/api/origin-policy.ts). Checked per request, so config changes apply without a restart.

Evaluated in order — the first match wins:

| # | Rule | Allowed? |
|---|---|---|
| 1 | **No `Origin` header** (server-to-server, curl) | Yes — host check and API key still apply |
| 2 | Malformed `Origin` | No |
| 3 | **Loopback hostname, any port** (`localhost`, `127.0.0.1`, `::1`) | Yes, always |
| 4 | An address this machine currently holds | Yes |
| 5 | Exact match in `security.allowedOrigins` | Yes |
| 6 | `*` in `allowedOrigins` | Yes |
| 7 | Wildcard pattern match, e.g. `https://*.pos.example.com` | Yes |
| 8 | **Private network** origin (RFC1918, link-local, `.local`) when `allowPrivateNetwork` is on | Yes |
| — | Anything else | **403** |

The rejection tells you exactly how to fix it:

```json
{
  "error": "Forbidden",
  "message": "Origin \"https://app.example.com\" is not allowed. Add it to security.allowedOrigins in config.json (wildcards such as \"https://*.example.com\" are supported), or use the Settings page in the dashboard.",
  "origin": "https://app.example.com"
}
```

Add your origin via the dashboard's **Settings → Allowed Origins**, or in `config.json`:

```json
"allowedOrigins": ["https://app.example.com", "https://*.staging.example.com"]
```

Wildcards expand to `[^/]*`, so `*` does not cross `/`. `https://*.example.com` matches a subdomain, not a path.

### CORS details worth knowing

- The service **reflects your origin** rather than returning `*`, and sets `credentials: true` ([server.ts:170-172](../src/api/server.ts#L170-L172)). Credentialed requests work.
- Allowed request headers: `Content-Type`, `Authorization`, `X-Idempotency-Key`, `X-API-Key`, `X-Requested-With`. **Sending any other custom header will fail preflight.**
- Exposed response headers: `X-Service-Port`, `Retry-After`. Others are invisible to your JS.
- Preflight (`OPTIONS`) is deliberately let through to a header-free 204, so a blocked origin surfaces as a clean browser CORS error rather than a confusing 403 ([server.ts:248-251](../src/api/server.ts#L248-L251)).

### A separate `Host` check

Distinct from origin: the `Host` header must also pass ([server.ts:269-283](../src/api/server.ts#L269-L283)). Loopback, this machine's own addresses, entries in `security.allowedHosts`, and — when enabled — private addresses are accepted. Reaching the service by a hostname that is none of these returns 403 even with a valid key.

Since you address the service as `127.0.0.1`, this is normally automatic.

### Private Network Access (HTTPS sites)

Chromium blocks requests from a public page into the private network unless the target opts in. The service answers the PNA preflight ([server.ts:150-157](../src/api/server.ts#L150-L157)):

```
Access-Control-Allow-Private-Network: true
```

**But that does not solve mixed content.** A page served over HTTPS calling `http://127.0.0.1:...` is a mixed-content request. Browsers vary in how they treat `http://127.0.0.1` — Chromium generally treats loopback as a secure context and permits it; other browsers and enterprise policies may not.

If you must support arbitrary browsers from a public HTTPS origin, plan for the possibility of failure and give the operator a fallback (run your app from `http://localhost`, or use the built-in dashboard for printer work).

---

## Step 4: Print

```
POST /api/print
Content-Type: application/json
X-API-Key: <key>
```

Schema — [server.ts:42-50](../src/api/server.ts#L42-L50):

| Field | Type | Required | Notes |
|---|---|---|---|
| `idempotencyKey` | string, 1-255 chars | **Yes** | See [Idempotency](#idempotency-read-this) |
| `templateType` | `receipt` \| `kot` \| `invoice` \| `test` \| `raw` | **Yes** | |
| `payload` | object | **Yes** | Shape depends on `templateType` |
| `printerId` | string | No | Defaults to the configured default printer |
| `priority` | 0 \| 1 \| 2 \| 3 | No | LOW, NORMAL, HIGH, CRITICAL |
| `copies` | number 1-10 | No | Defaults to 1 |
| `metadata` | object | No | Stored with the job, not printed |

`POST /api/print/:printerId` is identical but takes the printer from the path ([server.ts:653-657](../src/api/server.ts#L653-L657)).

### Response

```json
{
  "success": true,
  "jobId": "3f2a9c14-8e6b-4d51-9a77-1c0e2b5d8f43",
  "status": "pending",
  "message": "Job created"
}
```

> **Do not use the status code to detect a duplicate.** The code reflects the returned **job's status**, not whether it was created ([server.ts:641](../src/api/server.ts#L641)):
>
> - `201` when the job's status is `pending`
> - `200` otherwise
>
> A duplicate request for a job that is still pending therefore returns **201**, exactly like the original. Verified against a running service — both calls returned `201`, and only `message` differed.
>
> **The reliable duplicate signal is `message`:** `"Job created"` vs `"Duplicate job (idempotent)"`. The `jobId` is also identical to the original.

**With `copies` > 1** the response shape changes to an array, always 201 ([server.ts:641-646](../src/api/server.ts#L641-L646)):

```json
{ "jobs": [ { "success": true, "jobId": "...", "status": "pending", "message": "Job created" } ] }
```

Handle both shapes:

```js
const body = await res.json();
const jobs = body.jobs ?? [body];
```

Each copy gets its own key, suffixed `_copy_1`, `_copy_2`, … so copies are independently idempotent.

---

## Idempotency (read this)

`idempotencyKey` is **required on every print request**. This is the single most important thing to get right.

The service deduplicates on it. Resending the same key returns **the original `jobId`** with `message: "Duplicate job (idempotent)"` — **it does not print again.** (Check `message`, not the status code — see the note above.)

That makes retries safe. A network timeout after the printer already printed is the classic double-receipt bug; retrying with the same key cannot cause one.

**Derive the key from the business event, not from the attempt:**

```js
const idempotencyKey = `order-${order.id}-receipt-v${order.revision}`;
```

- ✅ `order-8842-receipt` — retry-safe, one receipt per order
- ✅ `order-8842-kot-rev2` — a genuine reprint after an amendment gets a new key
- ❌ `crypto.randomUUID()` — every retry prints another copy, defeating the entire mechanism
- ❌ `Date.now()` — same problem

If the operator asks for a deliberate reprint, that is a *new* business event: add a counter or timestamp to the key on purpose.

---

## Step 5: Track the job

A 201 means **queued**, not printed. The queue dispatches asynchronously.

### Poll for status

```
GET /api/jobs/:jobId/status
```

```json
{
  "found": true,
  "job": { "id": "...", "status": "completed", "printerId": "receipt", "attempts": 1 },
  "history": [ ... ]
}
```

> **Gotcha:** this endpoint returns **200 with `{"found": false, "job": null}`** for an unknown id — not a 404 ([server.ts:681-696](../src/api/server.ts#L681-L696)). Check `found`, not the status code.
>
> `GET /api/jobs/:jobId` (without `/status`) *does* 404 with `JOB_NOT_FOUND`. Pick one and be consistent.

### Job statuses

| Status | Terminal? | Meaning |
|---|---|---|
| `pending` | No | Accepted, not yet dispatched |
| `queued` | No | Waiting for a printer slot |
| `processing` | No | Being rendered |
| `printing` | No | Bytes going to the device |
| `completed` | **Yes** | Printed |
| `failed` | No | Attempt failed; may retry |
| `retry_scheduled` | No | Backoff before the next attempt |
| `cancelled` | **Yes** | Cancelled by request |
| `dead_letter` | **Yes** | Retries exhausted. Needs intervention |

Poll until terminal. Treat `dead_letter` as a hard failure worth showing the operator.

```js
async function waitForJob(baseUrl, apiKey, jobId, { timeoutMs = 30000 } = {}) {
  const terminal = new Set(['completed', 'cancelled', 'dead_letter']);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
      headers: { 'X-API-Key': apiKey }
    });
    const { found, job } = await res.json();
    if (!found) throw new Error(`Job ${jobId} not found`);
    if (terminal.has(job.status)) return job;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}
```

### Other job endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/jobs` | `?status=`, `?printerId=`, `?limit=` (1-100, default 50). **With no filter it returns pending jobs only** ([server.ts:740](../src/api/server.ts#L740)). An unknown `status` gives `400 {"error":"Invalid status value"}` |
| `DELETE` | `/api/jobs/:jobId` | Cancel. **Only works before the job is terminal** — cancelling a `completed` / `dead_letter` / already-cancelled job returns `400 JOB_CANCELLED`, `"Cannot cancel job: <id>"` |
| `POST` | `/api/jobs/:jobId/retry` | Re-queue a failed job |
| `POST` | `/api/jobs/clear-failed` | Discard failed jobs. Returns `{"success":true,"message":"Cleared 3 failed jobs","count":3}` — and it does clear `dead_letter` jobs, not just `failed` ones |

---

## Step 6: Live printer state (optional)

```
GET /api/events?key=<apiKey>
```

Server-Sent Events. `EventSource` cannot set headers, so this endpoint **also accepts the key as a `key` query parameter** ([server.ts:342-347](../src/api/server.ts#L342-L347)).

```js
const es = new EventSource(`${baseUrl}/api/events?key=${encodeURIComponent(apiKey)}`);
es.addEventListener('printers', (e) => {
  const { printers, summary } = JSON.parse(e.data);
  render(printers, summary);
});
es.onerror = () => { /* EventSource reconnects on its own */ };
```

Behaviour ([server.ts:1509-1579](../src/api/server.ts#L1509-L1579)):

- One event name: **`printers`**, with `{ printers, summary }`.
- A snapshot is pushed **immediately on connect** — no need to also call `/api/printers`.
- Changes are **coalesced over 150 ms**, so one physical unplug produces one event, not three.
- A `: keep-alive` comment every **25 s** keeps intermediaries from dropping the connection.
- Exempt from rate limiting — it is one long-lived connection.

Because the key travels in the URL, avoid logging these URLs.

---

## Template payloads

Source: [types/index.ts:154-340](../src/types/index.ts#L154-L340). `payload` is validated as a generic object at the API boundary (`z.record(z.unknown())`), so a malformed payload fails **at render time, on the job**, not at the request. Always check the job's terminal status — a 201 does not mean the payload was correct.

### `receipt`

```json
{
  "idempotencyKey": "order-8842-receipt",
  "templateType": "receipt",
  "printerId": "receipt",
  "payload": {
    "orderNumber": "8842",
    "orderDate": "2026-09-10",
    "orderTime": "20:14",
    "items": [
      { "name": "Chicken Karahi", "quantity": 1, "price": 1450, "total": 1450,
        "modifiers": ["Extra spicy"], "notes": "No coriander" },
      { "name": "Naan", "quantity": 3, "price": 60, "total": 180 }
    ],
    "subtotal": 1630,
    "tax": 261,
    "taxRate": 16,
    "taxLabel": "GST",
    "total": 1891,
    "paymentMethod": "Card",
    "amountPaid": 2000,
    "change": 109,
    "tableName": "T4",
    "serverName": "Ali",
    "header": { "storeName": "Zafar Kitchen", "storePhone": "+92 300 1234567" },
    "footer": { "thankYouMessage": "Thank you!" }
  }
}
```

Required: `orderNumber`, `orderDate`, `items[]`, `subtotal`, `total`. Each item needs `name`, `quantity`, `price`, `total`.

Optional extras: `discount` / `discountName`, `serviceCharge` / `serviceChargeName`, `tip`, `adjustments[]` (`{name, amount, isDeduction}`), `customerName`, `orderMode`, `barcode`, `qrCode`.

**Multiple payments** — pass `payments: [{label, amount}]`. Itemised only when there is more than one; a single method keeps the classic Payment / Amount Paid / Change lines.

**`options`** is the tenant render contract ([types/index.ts:200-243](../src/types/index.ts#L200-L243)): `template` (`classic` | `compact` | `elegant` | `minimal`), `paperWidth` in characters, `currency` (`{symbol, decimals, position}`), and a `fields` object of ~27 booleans toggling individual lines. Omit it to accept the printer's configured defaults.

### `kot` — kitchen ticket

```json
{
  "idempotencyKey": "order-8842-kot-1",
  "templateType": "kot",
  "printerId": "kitchen",
  "payload": {
    "orderNumber": "8842",
    "orderTime": "20:14",
    "tableName": "T4",
    "serverName": "Ali",
    "items": [ { "name": "Chicken Karahi", "quantity": 1, "modifiers": ["Extra spicy"] } ],
    "isReprint": false
  }
}
```

Required: `orderNumber`, `orderTime`, `items[]` (each `name` + `quantity`). Optional: `notes`, `category`, `isVoid`, `isReprint`, per-item `isVoid`.

### `invoice`

Required: `invoiceNumber`, `invoiceDate`, `customer` (`{name, ...}`), `items[]` (`description`, `quantity`, `unitPrice`, `total`), `subtotal`, `total`. Optional: `dueDate`, `tax`, `taxRate`, `discount`, `notes`, `terms`, `header`.

### `test`

```json
{ "idempotencyKey": "test-1757530000", "templateType": "test",
  "payload": { "message": "Connection OK", "includeBarcode": true, "includeQR": true } }
```

All fields optional. Use it to prove the path end to end.

### `raw` — ESC/POS passthrough

```json
{ "idempotencyKey": "raw-1757530000", "templateType": "raw",
  "payload": { "commands": "1B4001", "encoding": "hex" } }
```

`commands` accepts a byte array, a string, or a Buffer; `encoding` is `hex`, `base64`, or `raw`. You are responsible for valid ESC/POS — malformed sequences can leave the printer in a strange state until power-cycled.

---

## Printers

```
GET /api/printers
```

```json
{ "printers": [ {
    "id": "receipt", "name": "Receipt", "type": "usb", "enabled": true, "isDefault": true,
    "printerName": "Generic / Text Only",
    "capabilities": { "maxWidth": 48, "supportsCut": true, "supportsQRCode": true },
    "state": {
      "id": "receipt", "status": "online", "isConnected": true,
      "lastSeen": 1757529000000, "consecutiveFailures": 0, "totalJobsPrinted": 214,
      "reason": "Ready", "boundPrinterName": "Generic / Text Only", "healable": false
    }
} ] }
```

`status` is one of `online`, `offline`, `error`, `paper_out`, `cover_open`, `busy`, `unknown` ([types/index.ts:68-76](../src/types/index.ts#L68-L76)).

**`state.reason` is a plain-language explanation — show it to the operator instead of the raw status.** `state.healable: true` means `POST /api/printers/:id/repair` is likely to fix it, which you can offer as a one-click action.

`printerId` values are **roles** (`receipt`, `kitchen`), not devices. Address roles and let the operator decide which hardware fills them — swapping a printer then needs no change in your app.

Other useful endpoints: `GET /api/printers/:id/status`, `POST /api/printers/:id/test`, `POST /api/printers/:id/reconnect`, `GET /api/printers/:id/diagnose`, `POST /api/printers/:id/repair`, `POST /api/printers/:id/cash-drawer`.

---

## Errors

Handler: [server.ts:1709-1745](../src/api/server.ts#L1709-L1745).

```json
{ "error": "PRINTER_NOT_FOUND", "message": "Printer not found: kitchen", "details": { } }
```

> **Inconsistency to code around:** for domain errors `error` holds a machine-readable **code**; for middleware rejections it holds a human title (`"Unauthorized"`, `"Forbidden"`, `"Too Many Requests"`). Branch on **HTTP status first**, then on `error`.

Verified live responses:

```json
{"error":"Unauthorized","message":"Invalid or missing API key"}
{"error":"PRINTER_NOT_FOUND","message":"Printer not found: nosuch"}
{"error":"JOB_CANCELLED","message":"Cannot cancel job: 269d38cd-..."}
```

Schema failures embed the raw Zod issue list **as a JSON string inside `message`** — machine-readable, but you must parse the substring after `"Invalid request: "` to use it:

```json
{"error":"INVALID_REQUEST","message":"Invalid request: [\n  {\n    \"code\": \"too_big\",\n    \"maximum\": 10,\n    \"path\": [\n      \"copies\"\n    ]\n  }\n]"}
```

For user-facing messages, prefer your own validation before sending.

| Status | When |
|---|---|
| `400` | Schema validation failed — `INVALID_REQUEST` or `VALIDATION_ERROR` |
| `401` | Missing or wrong `X-API-Key` |
| `403` | Origin rejected, host rejected, or a loopback-only endpoint called remotely |
| `404` | `JOB_NOT_FOUND`, `PRINTER_NOT_FOUND` |
| `408` | Request exceeded the 30 s processing timeout |
| `429` | Rate limited — see below |
| `503` | `PRINTER_NOT_FOUND` with no default printer configured, or health check failure |

Codes ([types/index.ts:711-737](../src/types/index.ts#L711-L737)): `PRINTER_NOT_FOUND`, `PRINTER_OFFLINE`, `PRINTER_BUSY`, `PRINTER_ERROR`, `PRINTER_PAPER_OUT`, `PRINTER_TIMEOUT`, `PRINTER_CONNECTION_FAILED`, `JOB_NOT_FOUND`, `JOB_DUPLICATE`, `JOB_CANCELLED`, `JOB_TIMEOUT`, `JOB_INVALID_PAYLOAD`, `QUEUE_FULL`, `QUEUE_ERROR`, `INVALID_REQUEST`, `UNAUTHORIZED`, `RATE_LIMITED`, `INTERNAL_ERROR`.

### Rate limits

[server.ts:362-400](../src/api/server.ts#L362-L400):

- **Loopback callers are exempt entirely.** A page on the same machine is never throttled.
- `/health`, `/api/health` and `/api/events` are exempt for everyone.
- Everyone else: a burst limit of **20 requests/second**, then `security.rateLimitPerMinute` (default **120**) per minute. Exceeding it blocks that IP for 60 s.

```json
{ "error": "Too Many Requests", "message": "Rate limit exceeded. Please try again later.", "retryAfter": 47 }
```

`Retry-After` is also sent as a header and exposed to CORS. Honour it.

### Other limits

| Limit | Value | Configurable |
|---|---|---|
| Max request body | 1 MB | `security.maxPayloadSize` |
| Request processing timeout | 30 s → `408` | No |
| Max concurrent connections | 100 | No |
| `copies` per request | 1-10 | No |
| `idempotencyKey` length | 1-255 | No |

---

## Endpoint summary

Everything except `/health`, `/api/health`, `/`, `/dashboard` and `/api/auth/local-token` needs `X-API-Key`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Discovery, identity, health. No key |
| `GET` | `/api/auth/local-token` | API key, **loopback only** |
| `POST` | `/api/print` | Queue a job |
| `POST` | `/api/print/:printerId` | Queue to a specific role |
| `GET` | `/api/jobs/:jobId/status` | Status + history (200 with `found:false` if unknown) |
| `GET` | `/api/jobs/:jobId` | Job (404 if unknown) |
| `GET` | `/api/jobs` | List; defaults to pending |
| `DELETE` | `/api/jobs/:jobId` | Cancel |
| `POST` | `/api/jobs/:jobId/retry` | Retry |
| `GET` | `/api/printers` | Printers + live state |
| `POST` | `/api/printers/:id/test` | Test print |
| `POST` | `/api/printers/:id/cash-drawer` | Open drawer |
| `GET` | `/api/printers/:id/diagnose` | Structured diagnosis |
| `POST` | `/api/printers/:id/repair` | Apply repairs |
| `GET` | `/api/events` | SSE printer state. Key via `?key=` |
| `GET` | `/api/queue/stats` | Queue depth |
| `POST` | `/api/queue/pause` \| `/resume` | Hold dispatch |
| `GET` | `/api/metrics`, `/api/system/info` | Diagnostics |

Config endpoints (`/api/config/...`) and backup endpoints exist too, but are the dashboard's job — a third-party integration should not need them. `POST /api/backup/restore` and `POST /api/service/restart` are loopback-only.

---

## Worked example

```js
const KEY = '...';  // from the operator, or /api/auth/local-token on loopback

class ThermalClient {
  constructor(apiKey) { this.apiKey = apiKey; this.baseUrl = null; }

  async connect() {
    ({ baseUrl: this.baseUrl } = await discoverService());
    return this.baseUrl;
  }

  async request(path, init = {}) {
    if (!this.baseUrl) await this.connect();
    const send = () => fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey, ...init.headers }
    });

    let res;
    try {
      res = await send();
    } catch {
      // Port may have moved since we cached it. Re-discover once.
      await this.connect();
      res = await send();
    }

    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After') ?? 60);
      throw Object.assign(new Error(`Rate limited, retry in ${wait}s`), { retryAfter: wait });
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.message ?? res.statusText), {
        status: res.status, code: body.error
      });
    }
    return res.json();
  }

  printReceipt(order) {
    return this.request('/api/print', {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: `order-${order.id}-receipt`,   // stable across retries
        templateType: 'receipt',
        printerId: 'receipt',
        payload: {
          orderNumber: String(order.id),
          orderDate: order.date,
          items: order.items.map(i => ({
            name: i.name, quantity: i.qty, price: i.price, total: i.qty * i.price
          })),
          subtotal: order.subtotal,
          total: order.total
        }
      })
    });
  }
}

// Usage
const client = new ThermalClient(KEY);
await client.connect();

const { jobId } = await client.printReceipt(order);
const job = await waitForJob(client.baseUrl, KEY, jobId);

if (job.status !== 'completed') {
  showOperatorError(`Receipt did not print: ${job.status}`);
}
```

---

## Integration checklist

- [ ] Port is **discovered**, never hard-coded, and re-discovered on connection failure
- [ ] `/health` identity checked (`service === 'xp-thermal-service'`) before trusting a port
- [ ] `idempotencyKey` derived from the business event, stable across retries
- [ ] Both `{jobId}` and `{jobs:[...]}` response shapes handled
- [ ] Duplicates detected via `message`, **not** via a 200/201 status code
- [ ] Job polled to a terminal status — a 201 is not a printed receipt
- [ ] `found: false` handled on `/api/jobs/:id/status` (it is a 200, not a 404)
- [ ] Origin added to `allowedOrigins`, and the 403 `message` surfaced during setup
- [ ] Only the five allowed custom request headers used
- [ ] `429` honours `Retry-After`
- [ ] `degraded` / `unhealthy` health surfaced to the operator with `reasons`
- [ ] `state.reason` shown for offline printers rather than the raw status
- [ ] For a public HTTPS origin: mixed-content behaviour tested in the browsers you support
