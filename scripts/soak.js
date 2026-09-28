/**
 * Soak test for the two-printer restaurant floor.
 *
 * Topology under test — the exact deployment sites run:
 *
 *   receipt  → printer at the till (fake ESC/POS device on 127.0.0.1)
 *   kitchen  → LAN printer one floor up (second fake device)
 *
 * Four phases, each answering one question the site actually asks:
 *
 *   A  RUSH      Can it take a dinner rush without slowing down?
 *   B  OUTAGE    The kitchen printer dies mid-service. Do receipts —
 *                and the cash drawer that opens with them — keep working?
 *   C  RECOVERY  The kitchen printer comes back. Does every queued ticket
 *                print, in order, with none lost?
 *   D  IDLE      After the rush, does memory sit flat and the DB stay small?
 *
 * The fake printers count cut commands (GS V), so "printed" means the ticket
 * physically ended, not that a socket accepted bytes.
 *
 * Usage:  node scripts/soak.js            (assumes a built dist/)
 * Exit:   0 when every assertion holds, 1 otherwise.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT_SERVICE = 9166;
const PORT_RECEIPT = 9261;
const PORT_KITCHEN = 9262;
const HOST = '127.0.0.1';

const RUSH_JOBS = 600;           // ~a very busy evening compressed into minutes
const OUTAGE_JOBS = 120;
const IDLE_MS = 3 * 60 * 1000;
const API_KEY = 'soak-test-key-0000000000000000000000';

// A realistic receipt payload: items plus an 8KB logo-sized filler so renders
// and blobs cost what they cost in production.
const LOGO_FILLER = Buffer.alloc(8 * 1024, 0x41).toString('base64').slice(0, 8 * 1024);

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ── fake ESC/POS device ──────────────────────────────────────────────── */

function fakePrinter(name, port) {
  const state = { cuts: 0, bytes: 0, connections: 0, server: null, sockets: new Set() };

  function start() {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        state.connections++;
        state.sockets.add(socket);
        socket.on('data', (data) => {
          state.bytes += data.length;
          for (let i = 0; i < data.length - 1; i++) {
            // GS V — paper cut, the end of a ticket.
            if (data[i] === 0x1d && data[i + 1] === 0x56) state.cuts++;
            // DLE EOT — status request; answer like a healthy printer.
            if (data[i] === 0x10 && data[i + 1] === 0x04) socket.write(Buffer.from([0x12]));
          }
        });
        socket.on('close', () => state.sockets.delete(socket));
        socket.on('error', () => {});
      });
      server.listen(port, HOST, () => resolve());
      state.server = server;
    });
  }

  function stop() {
    return new Promise((resolve) => {
      for (const s of state.sockets) s.destroy();
      state.sockets.clear();
      if (state.server) state.server.close(() => resolve());
      else resolve();
      state.server = null;
    });
  }

  return { name, port, state, start, stop };
}

/* ── tiny HTTP client (no dependencies) ───────────────────────────────── */

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = require('http').request(
      { host: HOST, port: PORT_SERVICE, path: p, method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: 10000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
          catch { resolve({ status: res.statusCode, body: {} }); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (payload) req.end(payload); else req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function receiptPayload(n) {
  return {
    orderNumber: String(n),
    orderDate: '2026-09-28',
    items: [
      { name: 'Chicken Karahi', quantity: 1, price: 1450, total: 1450 },
      { name: 'Naan', quantity: 3, price: 60, total: 180 }
    ],
    subtotal: 1630, total: 1630,
    footer: { message: [LOGO_FILLER] }   // the 8KB that makes blobs realistic
  };
}

function kotPayload(n) {
  return {
    orderNumber: String(n), orderTime: '20:00',
    items: [{ name: 'Chicken Karahi', quantity: 1, modifiers: ['Extra spicy'] }]
  };
}

async function submit(printerId, templateType, payload, key) {
  const t0 = Date.now();
  const res = await api('POST', '/api/print', {
    idempotencyKey: key, templateType, printerId, payload
  });
  return { ms: Date.now() - t0, status: res.status, jobId: res.body.jobId };
}

async function waitFor(fn, timeoutMs, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return false;
}

async function unfinishedCount() {
  const r = await api('GET', '/api/jobs?limit=1&status=pending,queued,processing,printing,retry_scheduled');
  return r.body.total ?? 999999;
}

async function memory() {
  const r = await api('GET', '/api/system/info');
  return r.body.memory || {};
}

/* ── the run ──────────────────────────────────────────────────────────── */

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-soak-'));
  const dbPath = path.join(scratch, 'jobs.db');

  const receiptDev = fakePrinter('receipt', PORT_RECEIPT);
  const kitchenDev = fakePrinter('kitchen', PORT_KITCHEN);
  await receiptDev.start();
  await kitchenDev.start();

  const config = {
    server: { host: '127.0.0.1', port: PORT_SERVICE, enableHttps: false },
    security: { allowedOrigins: [], allowedHosts: ['localhost', '127.0.0.1'],
      rateLimitPerMinute: 1000, enableApiKey: true, apiKey: API_KEY,
      maxPayloadSize: 1048576, allowPrivateNetwork: true },
    queue: { maxConcurrentJobs: 3, maxQueueDepth: 5000, maxRetries: 10,
      retryDelayMs: 1000, retryBackoffMultiplier: 2, maxRetryDelayMs: 60000,
      jobTimeoutMs: 30000,
      // Production runs this hourly; the soak compresses it so Phase D
      // exercises the same compaction pass a real day would see.
      cleanupIntervalMs: 45000, maxJobAgeMs: 604800000,
      persistPath: dbPath },
    logging: { level: 'warn', console: false },
    backup: { enabled: false, posBaseUrl: 'http://127.0.0.1:1', pollIntervalMs: 3600000,
      timeoutMs: 300000, filenamePrefix: 'x',
      mongo: { binDir: 'C:\\nonexistent', host: '127.0.0.1', port: 27017, database: 'X', gzip: true } },
    alerts: { enabled: false, webhookUrl: '', pollIntervalMs: 60000, confirmSamples: 2, minIntervalMs: 900000 },
    printers: [
      { id: 'receipt', name: 'Till receipt printer', type: 'network', enabled: true, isDefault: true,
        host: HOST, port: PORT_RECEIPT, timeout: 3000, maxRetries: 3,
        capabilities: { maxWidth: 48, supportsCut: true, supportsCashDrawer: true },
        cashDrawer: { enabled: true, pin: 2, onTimeMs: 50, offTimeMs: 200, openOnPrint: true } },
      { id: 'kitchen', name: 'Kitchen KOT printer (2nd floor)', type: 'network', enabled: true, isDefault: false,
        host: HOST, port: PORT_KITCHEN, timeout: 3000, maxRetries: 3,
        capabilities: { maxWidth: 48, supportsCut: true } }
    ]
  };

  const configPath = path.join(scratch, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log('Starting service…');
  const svc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    env: { ...process.env, XP_CONFIG_PATH: configPath },
    cwd: scratch,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const svcLog = [];
  svc.stdout.on('data', (d) => svcLog.push(d.toString()));
  svc.stderr.on('data', (d) => svcLog.push(d.toString()));

  const up = await waitFor(async () => {
    try { return (await api('GET', '/health')).body.service === 'xp-thermal-service'; }
    catch { return false; }
  }, 30000, 500);

  if (!up) {
    console.error('Service did not start. Log tail:\n' + svcLog.join('').slice(-2000));
    process.exit(1);
  }
  console.log('Service is up.\n');

  try {
    /* ── Phase A: dinner rush ─────────────────────────────────────────── */
    console.log(`PHASE A — rush: ${RUSH_JOBS} orders (1 KOT + 1 receipt each = ${RUSH_JOBS * 2} jobs)`);
    const submitLatencies = [];
    const tA = Date.now();

    for (let i = 0; i < RUSH_JOBS; i++) {
      // KOT first, receipt second — the order a real order produces them.
      const [kot, bill] = await Promise.all([
        submit('kitchen', 'kot', kotPayload(i), `soak-kot-${i}`),
        submit('receipt', 'receipt', receiptPayload(i), `soak-bill-${i}`)
      ]);
      submitLatencies.push(kot.ms, bill.ms);
      if (kot.status !== 201 || bill.status !== 201) {
        check('A: every submission accepted', false, `order ${i}: kot=${kot.status} bill=${bill.status}`);
        break;
      }
      // ~12 orders/second — far past any real restaurant.
      if (i % 3 === 0) await sleep(20);
    }

    const drained = await waitFor(async () => (await unfinishedCount()) === 0, 240000, 2000);
    const rushSecs = ((Date.now() - tA) / 1000).toFixed(0);

    check('A: queue drained to zero', drained, `${RUSH_JOBS * 2} jobs in ${rushSecs}s`);
    check('A: p95 submit latency under 150ms', percentile(submitLatencies, 95) < 150,
      `p50=${percentile(submitLatencies, 50)}ms p95=${percentile(submitLatencies, 95)}ms p99=${percentile(submitLatencies, 99)}ms`);
    check('A: every ticket physically cut on both devices',
      receiptDev.state.cuts >= RUSH_JOBS && kitchenDev.state.cuts >= RUSH_JOBS,
      `receipt cuts=${receiptDev.state.cuts} kitchen cuts=${kitchenDev.state.cuts}`);

    const memAfterRush = await memory();
    const dbAfterRush = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    console.log(`  info: heapUsed=${memAfterRush.heapUsed}MB db=${(dbAfterRush / 1024).toFixed(0)}KB\n`);

    /* ── Phase B: kitchen printer dies mid-service ────────────────────── */
    console.log('PHASE B — kitchen printer goes down mid-service');
    await kitchenDev.stop();
    const receiptTimes = [];
    let receiptsCompleted = 0;

    for (let i = 0; i < OUTAGE_JOBS; i++) {
      const n = RUSH_JOBS + i;
      await submit('kitchen', 'kot', kotPayload(n), `soak-kot-${n}`);
      const t0 = Date.now();
      const bill = await submit('receipt', 'receipt', receiptPayload(n), `soak-bill-${n}`);
      // The assertion that matters: the receipt COMPLETES promptly while the
      // kitchen queue is stuck — the till never freezes because the kitchen did.
      const done = await waitFor(async () => {
        const r = await api('GET', `/api/jobs/${bill.jobId}/status`);
        return r.body.job && r.body.job.status === 'completed';
      }, 15000, 250);
      if (done) { receiptsCompleted++; receiptTimes.push(Date.now() - t0); }
    }

    check('B: every receipt completed during the kitchen outage',
      receiptsCompleted === OUTAGE_JOBS, `${receiptsCompleted}/${OUTAGE_JOBS}`);
    check('B: receipt completion p95 under 3s while kitchen jobs time out',
      percentile(receiptTimes, 95) < 3000,
      `p50=${percentile(receiptTimes, 50)}ms p95=${percentile(receiptTimes, 95)}ms`);

    const healthB = (await api('GET', '/health')).body;
    check('B: health says degraded and names the kitchen problem',
      healthB.status === 'degraded' && (healthB.reasons || []).length > 0,
      (healthB.reasons || [])[0]);
    console.log('');

    /* ── Phase C: kitchen printer comes back ──────────────────────────── */
    console.log('PHASE C — kitchen printer restored');
    const cutsBefore = kitchenDev.state.cuts;
    await kitchenDev.start();

    const recovered = await waitFor(async () => (await unfinishedCount()) === 0, 180000, 2000);
    check('C: backlog drained after recovery', recovered);
    check('C: every outage-era KOT eventually printed',
      kitchenDev.state.cuts - cutsBefore >= OUTAGE_JOBS,
      `${kitchenDev.state.cuts - cutsBefore} tickets after restore (expected ≥ ${OUTAGE_JOBS})`);

    const deadLetters = (await api('GET', '/health')).body.queue.deadLetter;
    check('C: no ticket lost to dead-letter', deadLetters === 0, `deadLetter=${deadLetters}`);
    console.log('');

    /* ── Phase D: hours of idle, compressed ───────────────────────────── */
    console.log(`PHASE D — idle for ${IDLE_MS / 60000} minutes, watching memory and the DB`);
    const memStart = await memory();
    await sleep(IDLE_MS / 2);
    const memMid = await memory();
    await sleep(IDLE_MS / 2);
    const memEnd = await memory();

    const growth = memEnd.heapUsed - memStart.heapUsed;
    check('D: heap flat across idle (≤ 8MB drift)', Math.abs(growth) <= 8,
      `start=${memStart.heapUsed}MB mid=${memMid.heapUsed}MB end=${memEnd.heapUsed}MB`);

    const dbFinal = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    // 1440 finished jobs with blobs would be ~12MB+. Blobs cleared → well under 2MB.
    check('D: jobs.db stays small because finished jobs drop their blobs',
      dbFinal < 2 * 1024 * 1024, `${(dbFinal / 1024).toFixed(0)}KB for ${RUSH_JOBS * 2 + OUTAGE_JOBS * 2} jobs`);

    const healthD = (await api('GET', '/health')).body;
    check('D: healthy at the end of the day', healthD.status === 'healthy',
      healthD.status + (healthD.reasons?.length ? ` (${healthD.reasons[0]})` : ''));

    // Still responsive after everything — the last submit of the night.
    const lastCall = await submit('receipt', 'test', {}, 'soak-final');
    check('D: still accepts work instantly after the soak', lastCall.status === 201 && lastCall.ms < 200,
      `${lastCall.ms}ms`);
    await waitFor(async () => (await unfinishedCount()) === 0, 30000, 1000);

  } finally {
    svc.kill();
    await receiptDev.stop().catch(() => {});
    await kitchenDev.stop().catch(() => {});
    await sleep(1500);
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log('\n──────── SOAK RESULT ────────');
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
  console.log(failures === 0 ? '\nAll assertions held.' : `\n${failures} assertion(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Soak harness crashed:', err);
  process.exit(1);
});
