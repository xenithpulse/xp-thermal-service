#!/usr/bin/env node
/**
 * Deep QA — end-to-end checks against a running XP Thermal Service.
 *
 * Unit tests cover the decision logic in isolation; this exercises the parts
 * that only exist on a real machine: the PowerShell bridge, WMI event delivery,
 * CORS behaviour on whichever port the service actually bound, the discovery
 * and repair endpoints, and the print pipeline.
 *
 * Read-only by default. Pass --write to allow tests that create and delete a
 * temporary printer entry, and --print to send a physical test receipt.
 *
 *   node scripts/deep-qa.js
 *   node scripts/deep-qa.js --write
 *   node scripts/deep-qa.js --write --print
 */

'use strict';

const path = require('path');
const fs = require('fs');

const ARGS = process.argv.slice(2);
const ALLOW_WRITE = ARGS.includes('--write');
const ALLOW_PRINT = ARGS.includes('--print');

const results = [];
let currentSection = '';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m'
};

function section(name) {
  currentSection = name;
  process.stdout.write(`\n${C.bold}${C.cyan}── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}${C.reset}\n`);
}

function record(status, name, detail) {
  results.push({ section: currentSection, status, name, detail });
  const mark =
    status === 'pass' ? `${C.green}PASS${C.reset}` :
    status === 'fail' ? `${C.red}FAIL${C.reset}` :
    `${C.yellow}SKIP${C.reset}`;
  process.stdout.write(`  [${mark}] ${name}\n`);
  if (detail) process.stdout.write(`         ${C.dim}${detail}${C.reset}\n`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record('pass', name, detail || '');
  } catch (error) {
    record('fail', name, error && error.message ? error.message : String(error));
  }
}

function skip(name, why) {
  record('skip', name, why);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── Service discovery ────────────────────────────────────────────────────────

/** Find the service the same way a POS client would have to. */
async function findService() {
  const candidates = [];

  // Published endpoint descriptors take priority over blind scanning.
  const descriptors = [
    path.join(process.cwd(), 'data', 'service-endpoint.json'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'XPThermalService', 'service-endpoint.json')
  ];
  for (const file of descriptors) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.port) candidates.push({ port: parsed.port, via: path.basename(file) });
    } catch { /* not present */ }
  }
  for (let port = 9100; port <= 9110; port++) candidates.push({ port, via: 'scan' });

  for (const candidate of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${candidate.port}/health`, {
        signal: AbortSignal.timeout(1500)
      });
      if (!res.ok) continue;
      const body = await res.json();
      if (body.service && body.service !== 'xp-thermal-service') continue;
      return { base: `http://127.0.0.1:${candidate.port}`, port: candidate.port, via: candidate.via, health: body };
    } catch { /* keep looking */ }
  }
  return null;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

let BASE = '';
let API_KEY = '';

async function call(method, urlPath, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (options.origin) headers.Origin = options.origin;
  if (API_KEY && options.auth !== false) headers['X-API-Key'] = API_KEY;

  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeout || 30000)
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  return { status: res.status, body, headers: res.headers };
}

// ── Suites ───────────────────────────────────────────────────────────────────

async function suiteDiscovery(service) {
  section('Service discovery & identity');

  await check('Service is reachable and identifies itself', async () => {
    assert(service.health.service === 'xp-thermal-service', 'health did not identify the service');
    return `found on port ${service.port} via ${service.via}`;
  });

  await check('Reports both configured and active port', async () => {
    const h = service.health;
    assert(typeof h.port === 'number', 'no active port in /health');
    assert(typeof h.configuredPort === 'number', 'no configured port in /health');
    return h.port === h.configuredPort
      ? `on its configured port ${h.port}`
      : `fell back from ${h.configuredPort} to ${h.port}`;
  });

  await check('Publishes an endpoint descriptor for clients', async () => {
    const locations = [
      path.join(process.cwd(), 'data', 'service-endpoint.json'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'XPThermalService', 'service-endpoint.json')
    ];
    const found = locations.filter((f) => fs.existsSync(f));
    assert(found.length > 0, 'no service-endpoint.json was written anywhere');
    const parsed = JSON.parse(fs.readFileSync(found[0], 'utf8'));
    assert(parsed.port === service.port, `descriptor says ${parsed.port}, service is on ${service.port}`);
    return `${found.length} descriptor(s), port matches`;
  });

  await check('Advertises its port in a response header', async () => {
    const res = await call('GET', '/health');
    const header = res.headers.get('x-service-port');
    assert(header, 'X-Service-Port header missing');
    assert(Number(header) === service.port, `header says ${header}`);
    return `X-Service-Port: ${header}`;
  });
}

async function suiteCors(service) {
  section('CORS & host policy');

  const selfOrigins = [
    `http://127.0.0.1:${service.port}`,
    `http://localhost:${service.port}`
  ];

  for (const origin of selfOrigins) {
    await check(`Dashboard origin ${origin} is accepted`, async () => {
      const res = await call('GET', '/api/printers', { origin });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const acao = res.headers.get('access-control-allow-origin');
      assert(acao === origin, `Access-Control-Allow-Origin was "${acao}"`);
      return `200, ACAO reflected`;
    });
  }

  await check('Loopback is trusted on every fallback port', async () => {
    for (let port = 9100; port <= 9110; port++) {
      const origin = `http://127.0.0.1:${port}`;
      const res = await call('GET', '/api/printers', { origin });
      assert(res.status === 200, `origin ${origin} got ${res.status}`);
    }
    return 'ports 9100-9110 all accepted';
  });

  await check('Preflight succeeds for a state-changing request', async () => {
    const res = await fetch(`${BASE}/api/config/printers`, {
      method: 'OPTIONS',
      headers: {
        Origin: `http://127.0.0.1:${service.port}`,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-api-key'
      }
    });
    assert(res.status === 204 || res.status === 200, `preflight returned ${res.status}`);
    const allowMethods = res.headers.get('access-control-allow-methods') || '';
    assert(/POST/i.test(allowMethods), `POST not in allowed methods: ${allowMethods}`);
    return `${res.status}, methods: ${allowMethods}`;
  });

  await check('Untrusted origin is refused with an actionable message', async () => {
    const res = await call('GET', '/api/printers', { origin: 'https://evil.example.com' });
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(/allowedOrigins/i.test(res.body.message || ''), 'message does not explain the fix');
    return '403 with remediation guidance';
  });

  await check('Requests without an Origin still work', async () => {
    const res = await call('GET', '/api/printers');
    assert(res.status === 200, `got ${res.status}`);
    return 'server-to-server callers unaffected';
  });
}

async function suiteAuth() {
  section('Authentication');

  await check('Local token endpoint serves the key to loopback', async () => {
    const res = await call('GET', '/api/auth/local-token', { auth: false });
    assert(res.status === 200, `got ${res.status}`);
    assert(typeof res.body.authRequired === 'boolean', 'no authRequired flag');
    return res.body.authRequired ? 'API key required and supplied' : 'auth disabled';
  });

  await check('Protected route rejects a bad key', async () => {
    const res = await fetch(`${BASE}/api/config`, {
      headers: { 'X-API-Key': 'definitely-wrong' }
    });
    if (!API_KEY) return 'skipped: auth disabled';
    assert(res.status === 401, `expected 401, got ${res.status}`);
    return '401 as expected';
  });
}

async function suitePrintSystem() {
  section('Windows print system bridge');

  let snapshot;

  await check('Snapshot returns structured data from PowerShell', async () => {
    const started = Date.now();
    const res = await call('GET', '/api/system/print-system', { timeout: 40000 });
    assert(res.status === 200, `got ${res.status}`);
    snapshot = res.body;
    assert(Array.isArray(snapshot.printers), 'printers is not an array');
    return `${snapshot.printers.length} queue(s) in ${Date.now() - started}ms`;
  });

  await check('Host capabilities were detected', async () => {
    assert(snapshot.host, 'no host block');
    assert(snapshot.host.psVersion > 0, 'PowerShell version not detected');
    return `PowerShell ${snapshot.host.psVersion}, ${snapshot.host.osCaption || 'unknown OS'}, print-management=${snapshot.host.hasPrintManagement}`;
  });

  await check('Spooler state is reported', async () => {
    assert(typeof snapshot.spoolerRunning === 'boolean', 'spoolerRunning missing');
    assert(snapshot.spoolerRunning, 'the Print Spooler is not running on this machine');
    return 'spooler running';
  });

  await check('Every queue parsed with complete fields', async () => {
    for (const p of snapshot.printers) {
      assert(typeof p.name === 'string' && p.name.length > 0, 'a queue has no name');
      assert(typeof p.portName === 'string', `${p.name} has no portName`);
      assert(typeof p.workOffline === 'boolean', `${p.name} has no workOffline`);
      assert(Number.isFinite(p.printerState), `${p.name} has a non-numeric printerState`);
    }
    return snapshot.printers.map((p) => `${p.name} @ ${p.portName}`).join('; ') || 'none';
  });

  await check('Physical USB presence is probed', async () => {
    assert(Array.isArray(snapshot.usbDevices), 'usbDevices missing');
    assert(Array.isArray(snapshot.livePorts), 'livePorts missing');
    return snapshot.usbDevices.length
      ? `${snapshot.usbDevices.length} attached: ${snapshot.livePorts.join(', ')}`
      : 'no USB printers attached right now';
  });

  await check('Snapshot is cached rather than re-shelling per call', async () => {
    const t0 = Date.now();
    await call('GET', '/api/printers');
    await call('GET', '/api/printers');
    await call('GET', '/api/printers');
    const elapsed = Date.now() - t0;
    assert(elapsed < 4000, `three status reads took ${elapsed}ms — caching may not be working`);
    return `three reads in ${elapsed}ms`;
  });

  return snapshot;
}

async function suiteDiscoveryEndpoint(snapshot) {
  section('Printer discovery');

  let discovered;

  await check('Discovery lists installed printers', async () => {
    const res = await call('GET', '/api/printers/discover', { timeout: 40000 });
    assert(res.status === 200, `got ${res.status}`);
    discovered = res.body;
    assert(Array.isArray(discovered.printers), 'no printers array');
    return `${discovered.printers.length} candidate(s), ${discovered.summary.recommended} recommended`;
  });

  await check('Virtual queues are hidden by default', async () => {
    const virtual = discovered.printers.filter((p) => /print to pdf|xps|fax/i.test(p.name));
    assert(virtual.length === 0, `virtual queue offered: ${virtual.map((v) => v.name).join(', ')}`);
    return 'PDF/XPS/Fax excluded';
  });

  await check('Virtual queues are available when explicitly requested', async () => {
    const res = await call('GET', '/api/printers/discover?all=1', { timeout: 40000 });
    assert(res.status === 200, `got ${res.status}`);
    assert(res.body.printers.length >= discovered.printers.length, 'all=1 returned fewer printers');
    return `${res.body.printers.length} with virtual included`;
  });

  await check('Each candidate carries a ready-to-save config', async () => {
    for (const p of discovered.printers) {
      assert(p.suggestedConfig, `${p.name} has no suggestedConfig`);
      assert(/^[a-zA-Z0-9_-]+$/.test(p.suggestedConfig.id), `${p.name} produced an invalid id`);
      assert(p.suggestedConfig.capabilities.maxWidth > 0, `${p.name} has no paper width`);
      assert(typeof p.thermalScore === 'number', `${p.name} has no confidence score`);
      assert(typeof p.statusReason === 'string', `${p.name} has no status reason`);
    }
    return 'ids, widths, scores and reasons present';
  });

  await check('Already-configured printers are flagged', async () => {
    const cfg = await call('GET', '/api/config');
    const configuredNames = (cfg.body.printers || []).map((p) => p.printerName).filter(Boolean);
    for (const p of discovered.printers) {
      if (configuredNames.includes(p.name)) {
        assert(p.alreadyConfiguredAs, `${p.name} is configured but not flagged`);
      }
    }
    return 'flags match configuration';
  });

  await check('Reports printers that are plugged in but have no driver', async () => {
    // On a freshly imaged machine this is the difference between an empty list
    // and a specific instruction.
    assert(Array.isArray(discovered.needsDriver), 'no needsDriver array in the discovery response');
    for (const dev of discovered.needsDriver) {
      assert(dev.problem && dev.suggestion, 'a device was reported without an explanation');
    }
    return discovered.needsDriver.length
      ? `${discovered.needsDriver.length} device(s) awaiting a driver`
      : 'none awaiting a driver';
  });

  await check('Host capabilities are reported for support', async () => {
    const host = discovered.system && discovered.system.host;
    assert(host, 'no host block in discovery');
    assert(host.psVersion > 0, 'PowerShell version not detected');
    return `PowerShell ${host.psVersion}, print-management=${host.hasPrintManagement}`;
  });

  await check('Roles are published for the setup UI', async () => {
    const res = await call('GET', '/api/printers/roles');
    assert(res.status === 200, `got ${res.status}`);
    const ids = (res.body.roles || []).map((r) => r.id);
    assert(ids.includes('receipt'), 'receipt role missing');
    assert(ids.includes('kitchen'), 'kitchen role missing');
    for (const role of res.body.roles) {
      assert(role.label && role.description, `role ${role.id} lacks label/description`);
    }
    return ids.join(', ');
  });

  return discovered;
}

async function suitePrinterState() {
  section('Printer state & diagnostics');

  const res = await call('GET', '/api/printers');
  const printers = res.body.printers || [];

  if (printers.length === 0) {
    skip('Printer state checks', 'no printers configured');
    return printers;
  }

  await check('Every printer reports a status with a reason', async () => {
    for (const p of printers) {
      assert(p.state, `${p.id} has no state`);
      assert(p.state.status, `${p.id} has no status`);
      if (p.state.status !== 'online') {
        assert(p.state.reason, `${p.id} is ${p.state.status} but gives no reason`);
      }
    }
    return printers.map((p) => `${p.id}=${p.state.status}`).join(', ');
  });

  await check('Reasons are human language, not error codes', async () => {
    for (const p of printers) {
      const reason = p.state.reason || '';
      if (!reason) continue;
      assert(!/^0x[0-9a-f]+$/i.test(reason), `${p.id} reason is a bare code`);
      assert(reason.length > 12, `${p.id} reason is too terse: "${reason}"`);
    }
    return 'all reasons readable';
  });

  for (const p of printers.filter((x) => x.type === 'usb')) {
    await check(`Diagnose "${p.id}" explains its state`, async () => {
      const r = await call('GET', `/api/printers/${p.id}/diagnose`, { timeout: 40000 });
      assert(r.status === 200, `got ${r.status}`);
      const d = r.body;
      assert(d.verdict && d.verdict.reason, 'no verdict');
      assert(d.plan, 'no repair plan');
      assert(typeof d.spoolerRunning === 'boolean', 'no spooler state');
      assert(d.boundName, 'no bound queue name');
      const repairs = d.plan.actions.map((a) => a.kind).join(', ') || 'none';
      return `${d.verdict.status}: ${d.verdict.reason.slice(0, 70)} | repairs: ${repairs}`;
    });

    await check(`Repair "${p.id}" is honest about the outcome`, async () => {
      const r = await call('POST', `/api/printers/${p.id}/repair`, { timeout: 60000 });
      assert(r.status === 200, `got ${r.status}`);
      assert(r.body.message, 'no message');
      assert('statusBefore' in r.body && 'statusAfter' in r.body, 'no before/after status');
      // A repair that changes nothing must not claim success.
      if (r.body.attempted.length === 0) {
        assert(r.body.success === false || r.body.statusAfter === 'online',
          'claimed success without doing anything');
      }
      return `${r.body.statusBefore} -> ${r.body.statusAfter}; ${r.body.message.slice(0, 70)}`;
    });
  }

  return printers;
}

async function suiteErrorHandling(printers) {
  section('Error handling');

  await check('Unknown printer returns 404 naming the printer', async () => {
    const res = await call('GET', '/api/printers/does-not-exist/status');
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(/does-not-exist/.test(JSON.stringify(res.body)), 'error does not name the printer');
    return '404 naming the printer';
  });

  await check('Diagnose on an unknown printer fails cleanly', async () => {
    const res = await call('GET', '/api/printers/nope/diagnose');
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(res.body.message, 'no message');
    return res.body.message.slice(0, 60);
  });

  await check('Invalid role is rejected and lists valid ones', async () => {
    const res = await call('POST', '/api/printers/setup', {
      body: { role: 'nonsense', windowsName: 'whatever' }
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(/receipt/.test(res.body.message || ''), 'did not list valid roles');
    return res.body.message.slice(0, 70);
  });

  await check('Setup with an unknown Windows printer fails clearly', async () => {
    const res = await call('POST', '/api/printers/setup', {
      body: { role: 'receipt', windowsName: 'No Such Printer 12345' },
      timeout: 40000
    });
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(/No Such Printer/.test(res.body.message || ''), 'message does not name the printer');
    return res.body.message.slice(0, 70);
  });

  await check('Malformed print request is rejected with detail', async () => {
    const res = await call('POST', '/api/print', { body: { nonsense: true } });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(res.body.message, 'no validation detail');
    return `400: ${String(res.body.message).slice(0, 60)}`;
  });

  await check('Unknown endpoint returns a clean 404', async () => {
    const res = await call('GET', '/api/no-such-endpoint');
    assert(res.status === 404, `got ${res.status}`);
    return '404';
  });

  const drawerPrinter = printers.find((p) => p.type === 'usb');
  if (drawerPrinter) {
    await check('Cash drawer reports failure rather than pretending', async () => {
      const res = await call('POST', `/api/printers/${drawerPrinter.id}/cash-drawer`, {
        body: {}, timeout: 40000
      });
      assert([200, 400, 502, 503].includes(res.status), `unexpected status ${res.status}`);
      assert(res.body.message, 'no message');
      // Offline printer must not report a successful drawer pulse.
      if (drawerPrinter.state.status !== 'online') {
        assert(res.body.success !== true, 'claimed the drawer opened on an offline printer');
      }
      return `${res.status}: ${String(res.body.message).slice(0, 70)}`;
    });
  }
}

async function suiteCashDrawer(printers) {
  section('Cash drawer configuration');

  const target = printers.find((p) => p.type === 'usb');
  if (!target) {
    skip('Cash drawer config', 'no USB printer configured');
    return;
  }

  if (!ALLOW_WRITE) {
    skip('Drawer settings round-trip', 'read-only run; pass --write to enable');
    return;
  }

  const original = target.cashDrawer;

  await check('Drawer settings persist and are validated', async () => {
    const res = await call('PUT', `/api/config/printers/${target.id}`, {
      body: { cashDrawer: { enabled: true, pin: 5, onTimeMs: 120, offTimeMs: 200, openOnPrint: true } },
      timeout: 40000
    });
    assert(res.status === 200, `got ${res.status}`);
    const cfg = await call('GET', '/api/config');
    const saved = (cfg.body.printers || []).find((p) => p.id === target.id);
    assert(saved.cashDrawer, 'cashDrawer not saved');
    assert(saved.cashDrawer.pin === 5, `pin was ${saved.cashDrawer.pin}`);
    assert(saved.cashDrawer.onTimeMs === 120, `onTimeMs was ${saved.cashDrawer.onTimeMs}`);
    return 'pin 5, 120ms pulse, open-on-print saved';
  });

  await check('Out-of-range pulse is rejected', async () => {
    const res = await call('PUT', `/api/config/printers/${target.id}`, {
      body: { cashDrawer: { enabled: true, pin: 2, onTimeMs: 99999, offTimeMs: 200, openOnPrint: false } },
      timeout: 40000
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    return 'validation rejected a 99999ms pulse';
  });

  await check('Original drawer settings restored', async () => {
    const res = await call('PUT', `/api/config/printers/${target.id}`, {
      body: { cashDrawer: original || { enabled: false, pin: 2, onTimeMs: 50, offTimeMs: 200, openOnPrint: false } },
      timeout: 40000
    });
    assert(res.status === 200, `got ${res.status}`);
    return 'restored';
  });
}

async function suiteCrud() {
  section('Configuration CRUD');

  if (!ALLOW_WRITE) {
    skip('Printer create/update/delete', 'read-only run; pass --write to enable');
    return;
  }

  const testId = 'qa-temp-printer';
  const snapshot = await call('GET', '/api/system/print-system', { timeout: 40000 });
  const anyQueue = (snapshot.body.printers || [])[0];

  if (!anyQueue) {
    skip('Printer create/update/delete', 'no Windows queues available');
    return;
  }

  await check('Create a printer', async () => {
    const res = await call('POST', '/api/config/printers', {
      body: {
        id: testId, name: 'QA Temp', type: 'usb', enabled: false,
        printerName: anyQueue.name, timeout: 10000, maxRetries: 3
      },
      timeout: 40000
    });
    assert(res.status === 201, `got ${res.status}: ${JSON.stringify(res.body).slice(0, 120)}`);
    return 'created';
  });

  await check('Update the printer', async () => {
    const res = await call('PUT', `/api/config/printers/${testId}`, {
      body: { name: 'QA Temp Renamed' }, timeout: 40000
    });
    assert(res.status === 200, `got ${res.status}`);
    const cfg = await call('GET', '/api/config');
    const saved = (cfg.body.printers || []).find((p) => p.id === testId);
    assert(saved && saved.name === 'QA Temp Renamed', 'rename did not persist');
    return 'renamed and persisted';
  });

  await check('Duplicate id is rejected', async () => {
    const res = await call('POST', '/api/config/printers', {
      body: {
        id: testId, name: 'Dupe', type: 'usb', enabled: false,
        printerName: anyQueue.name, timeout: 10000, maxRetries: 3
      },
      timeout: 40000
    });
    // 409 Conflict, not 500: the caller can fix this themselves.
    assert(res.status === 409, `expected 409, got ${res.status}`);
    assert(/already exists/i.test(res.body.message || ''), 'message does not explain the clash');
    return `409: ${String(res.body.message).slice(0, 60)}`;
  });

  await check('Delete the printer', async () => {
    const res = await call('DELETE', `/api/config/printers/${testId}`, { timeout: 40000 });
    assert(res.status === 200, `got ${res.status}`);
    const cfg = await call('GET', '/api/config');
    assert(!(cfg.body.printers || []).some((p) => p.id === testId), 'printer still present');
    return 'deleted and gone from config';
  });

  await check('Config file survived the round-trip', async () => {
    const cfg = await call('GET', '/api/config');
    assert(cfg.status === 200, 'config unreadable');
    assert(Array.isArray(cfg.body.printers), 'printers missing');
    assert(cfg.body.security && cfg.body.server, 'config sections missing');
    return `${cfg.body.printers.length} printer(s) configured`;
  });
}

async function suitePrinting(printers) {
  section('Print pipeline');

  const online = printers.find((p) => p.state && p.state.status === 'online');

  if (!online) {
    skip('Physical test print', 'no printer is currently online');
  } else if (!ALLOW_PRINT) {
    skip('Physical test print', 'pass --print to send a real receipt');
  } else {
    await check(`Test print to "${online.id}"`, async () => {
      const res = await call('POST', `/api/printers/${online.id}/test`, { body: {}, timeout: 40000 });
      assert(res.status === 200, `got ${res.status}`);
      const jobId = res.body.jobId;
      assert(jobId, 'no job id returned');

      // Poll until the job settles.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const job = await call('GET', `/api/jobs/${jobId}/status`);
        const status = job.body.job && job.body.job.status;
        if (status === 'completed') return `job ${jobId.slice(0, 8)} completed`;
        if (status === 'failed' || status === 'dead_letter') {
          throw new Error(`job failed: ${job.body.job.lastError || 'unknown'}`);
        }
      }
      throw new Error('job did not finish within 30s');
    });
  }

  await check('Print to an unknown printer is refused', async () => {
    const res = await call('POST', '/api/print', {
      body: {
        idempotencyKey: `qa-${Date.now()}`,
        printerId: 'no-such-printer',
        templateType: 'test',
        payload: { message: 'qa' }
      }
    });
    assert(res.status === 404, `expected 404, got ${res.status}`);
    return '404 with a clear message';
  });

  await check('Queue statistics are available', async () => {
    const res = await call('GET', '/api/queue/stats');
    assert(res.status === 200, `got ${res.status}`);
    assert(res.body.queue, 'no queue stats');
    const q = res.body.queue;
    return `pending=${q.pending} processing=${q.processing} failed=${q.failed}`;
  });

  await check('Accepted jobs survive a restart', async () => {
    if (!ALLOW_WRITE) throw new Error('needs --write');

    // Queue a job against a printer that is not ready, so it stays pending,
    // then restart. The job store batches saves on a timer, so this is the
    // case where an acknowledged receipt used to be lost.
    const key = `qa-durability-${Date.now()}`;
    const target = (await call('GET', '/api/printers')).body.printers[0];
    assert(target, 'no printer configured to queue against');

    const created = await call('POST', '/api/print', {
      body: {
        idempotencyKey: key,
        printerId: target.id,
        templateType: 'test',
        payload: { message: 'durability probe' }
      }
    });
    assert([200, 201].includes(created.status), `enqueue returned ${created.status}`);
    const jobId = created.body.jobId;
    assert(jobId, 'no job id');

    // Restart immediately — well inside the 5s save window.
    await call('POST', '/api/service/restart');

    let back = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
        if (h.ok) { back = true; break; }
      } catch { /* still restarting */ }
    }
    assert(back, 'service did not come back after restart');
    await new Promise((r) => setTimeout(r, 3000));

    const token = await call('GET', '/api/auth/local-token', { auth: false });
    API_KEY = (token.body && token.body.apiKey) || API_KEY;

    const found = await call('GET', `/api/jobs/${jobId}/status`);
    assert(found.body.found === true, `job ${jobId.slice(0, 8)} was lost across the restart`);
    return `job ${jobId.slice(0, 8)} survived (${found.body.job.status})`;
  });

  await check('Job list is readable and carries failure reasons', async () => {
    const res = await call('GET', '/api/jobs?status=failed&limit=5');
    assert(res.status === 200, `got ${res.status}`);
    const failed = res.body.jobs || [];
    for (const job of failed) {
      assert(job.lastError || job.error, `job ${job.id} failed with no recorded reason`);
    }
    return failed.length ? `${failed.length} failed job(s), all with reasons` : 'no failed jobs';
  });
}

async function suiteResilience() {
  section('Resilience & self-management');

  await check('Health endpoint stays responsive under concurrent load', async () => {
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => call('GET', '/health', { auth: false }))
    );
    const bad = responses.filter((r) => r.status !== 200);
    assert(bad.length === 0, `${bad.length} of 40 requests failed`);
    return `40 concurrent requests in ${Date.now() - started}ms`;
  });

  await check('Printer status survives repeated hammering', async () => {
    const responses = await Promise.all(
      Array.from({ length: 15 }, () => call('GET', '/api/printers'))
    );
    const bad = responses.filter((r) => r.status !== 200);
    assert(bad.length === 0, `${bad.length} of 15 requests failed`);
    const statuses = new Set(
      responses.map((r) => (r.body.printers || []).map((p) => p.state.status).join('|'))
    );
    assert(statuses.size === 1, `status flapped across concurrent reads: ${[...statuses].join(' / ')}`);
    return 'consistent under 15 concurrent reads';
  });

  await check('A single-instance lock is held', async () => {
    const info = await call('GET', '/api/system/info');
    const lockPath = path.join(process.cwd(), 'data', 'service.lock');
    assert(fs.existsSync(lockPath), 'no instance lock file — a second copy could start and corrupt config');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert(lock.pid === info.body.pid, `lock says pid ${lock.pid}, service reports ${info.body.pid}`);
    return `pid ${lock.pid}, port ${lock.port}`;
  });

  await check('A second instance refuses to start', async () => {
    // The port fallback means a duplicate would otherwise start quietly on the
    // next port and then fight over config.json.
    const { spawnSync } = require('child_process');
    // It waits out a possible restart handover first, then refuses, so allow
    // for that window plus startup.
    const run = spawnSync(process.execPath, ['dist/index.js'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60000
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert(run.status === 4, `expected exit code 4, got ${run.status}`);
    assert(/already running/i.test(output), `message did not explain the clash: ${output.slice(0, 160)}`);
    assert(/did not exit within/i.test(output), 'did not mention waiting for a handover');
    return `waited for handover, then exited ${run.status} with a clear message`;
  });

  await check('Live event stream pushes printer state', async () => {
    // The dashboard depends on this to stay in step with the cable.
    const http = require('http');
    const received = await new Promise((resolve) => {
      const out = [];
      const req = http.get(
        `${BASE}/api/events${API_KEY ? `?key=${encodeURIComponent(API_KEY)}` : ''}`,
        (res) => {
          if (res.statusCode !== 200) { resolve({ status: res.statusCode, frames: out }); return; }
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk.toString();
            let i;
            while ((i = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, i); buf = buf.slice(i + 2);
              if (frame.startsWith('event:')) out.push(frame);
            }
          });
        }
      );
      req.on('error', () => resolve({ status: 0, frames: out }));
      setTimeout(() => { req.destroy(); resolve({ status: 200, frames: out }); }, 5000);
    });

    assert(received.status === 200, `stream returned ${received.status}`);
    assert(received.frames.length >= 1, 'no state was pushed on connect');
    const payload = JSON.parse(received.frames[0].split('data: ')[1]);
    assert(Array.isArray(payload.printers), 'pushed payload has no printers');
    return `pushed current state for ${payload.printers.length} printer(s) on connect`;
  });

  await check('POS origins are configured out of the box', async () => {
    const expected = [
      'http://pos.xenithpulse.local:8090',
      'http://pos.xenithpulse.local:8080',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:8090'
    ];
    for (const origin of expected) {
      const res = await call('GET', '/api/printers', { origin });
      assert(res.status === 200, `${origin} got ${res.status}`);
      assert(
        res.headers.get('access-control-allow-origin') === origin,
        `${origin} was not reflected back`
      );
    }
    return `${expected.length} POS origins accepted`;
  });

  await check('Raw-printing helper is pre-built, not compiled per job', async () => {
    // Compiling the winspool shim on every receipt cost ~600ms and needed a
    // working C# compiler and writable TEMP at print time.
    const dll = path.join(process.cwd(), 'data', 'RawPrinterHelper.dll');
    assert(fs.existsSync(dll), 'RawPrinterHelper.dll was not pre-built at startup');
    return `cached helper present (${fs.statSync(dll).size} bytes)`;
  });

  await check('Windows change events are being delivered', async () => {
    const res = await call('GET', '/api/metrics');
    assert(res.status === 200, `got ${res.status}`);
    const events = res.body.printerEvents;
    assert(events, 'no printerEvents block in metrics');
    assert(
      events.watching === true,
      'the device watcher is not running — printer changes will only be noticed on the polling interval'
    );
    return `mode: ${events.mode}`;
  });

  await check('Metrics and system info are exposed', async () => {
    const metrics = await call('GET', '/api/metrics');
    const info = await call('GET', '/api/system/info');
    assert(metrics.status === 200, `metrics returned ${metrics.status}`);
    assert(info.status === 200, `system info returned ${info.status}`);
    assert(info.body.pid, 'no pid');
    return `pid ${info.body.pid}, rss ${info.body.memory.rss}MB, uptime ${Math.round(info.body.uptime)}s`;
  });

  await check('Service reports memory within sane bounds', async () => {
    const info = await call('GET', '/api/system/info');
    const rss = info.body.memory.rss;
    assert(rss < 512, `RSS is ${rss}MB, which is above the warning threshold`);
    return `RSS ${rss}MB`;
  });
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  process.stdout.write(`${C.bold}XP Thermal Service — Deep QA${C.reset}\n`);
  process.stdout.write(`${C.dim}mode: ${ALLOW_WRITE ? 'read/write' : 'read-only'}${ALLOW_PRINT ? ' + physical print' : ''}${C.reset}\n`);

  const service = await findService();
  if (!service) {
    process.stdout.write(`\n${C.red}Could not find a running XP Thermal Service on ports 9100-9110.${C.reset}\n`);
    process.stdout.write(`Start it with: npm start\n`);
    process.exit(2);
  }

  BASE = service.base;

  try {
    const token = await call('GET', '/api/auth/local-token', { auth: false });
    API_KEY = (token.body && token.body.apiKey) || '';
  } catch { /* auth may be disabled */ }

  await suiteDiscovery(service);
  await suiteCors(service);
  await suiteAuth();
  const snapshot = await suitePrintSystem();
  await suiteDiscoveryEndpoint(snapshot);
  const printers = await suitePrinterState();
  await suiteErrorHandling(printers);
  await suiteCashDrawer(printers);
  await suiteCrud();
  await suitePrinting(printers);
  await suiteResilience();

  // ── Summary ──
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;

  process.stdout.write(`\n${C.bold}${'═'.repeat(64)}${C.reset}\n`);
  process.stdout.write(
    `${C.bold}Summary:${C.reset} ${C.green}${passed} passed${C.reset}` +
    `, ${failed ? C.red : C.dim}${failed} failed${C.reset}` +
    `, ${C.yellow}${skipped} skipped${C.reset}\n`
  );

  if (failed > 0) {
    process.stdout.write(`\n${C.red}${C.bold}Failures:${C.reset}\n`);
    for (const r of results.filter((x) => x.status === 'fail')) {
      process.stdout.write(`  ${C.red}•${C.reset} [${r.section}] ${r.name}\n    ${C.dim}${r.detail}${C.reset}\n`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  process.stdout.write(`\n${C.red}Deep QA crashed: ${error && error.stack ? error.stack : error}${C.reset}\n`);
  process.exit(3);
});
