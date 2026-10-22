#!/usr/bin/env node
/**
 * Thermal Bridge developer CLI
 *
 * Talks to a running service over its local API. Installing and running the
 * app is ThermalBridge.exe's job; see docs/BUILD.md and docs/SERVICE-MODE.md.
 */

import { Command } from 'commander';
import { ThermalPrintService } from './index';
import { findRunningServices } from './app/discover';
import { PRODUCT_NAME, VERSION } from './app/identity';

interface HealthResponse {
  status: string;
  name?: string;
  mode?: string;
  version: string;
  uptime: number;
  printers: { online: number; total: number };
  queue: { pending: number; processing: number };
}

interface PrinterInfo {
  id: string;
  name: string;
  type: string;
  state: { status: string; isConnected: boolean; totalJobsPrinted: number };
}

/** The first service answering in the discovery range, or exit with a hint. */
async function activePort(): Promise<number> {
  const [first] = await findRunningServices();
  if (!first) {
    console.error(`Error: no ${PRODUCT_NAME} is answering on 127.0.0.1:9100-9110. Is it running?`);
    process.exit(1);
  }
  return first.port;
}

/** The API key, which the service hands to callers on this machine. */
async function apiHeaders(port: number): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/local-token`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { apiKey?: string };
    if (body.apiKey) headers['X-API-Key'] = body.apiKey;
  } catch {
    // Auth may be disabled; let the real request report the problem.
  }
  return headers;
}

const program = new Command();

program
  .name('thermal-bridge')
  .description(`${PRODUCT_NAME} CLI`)
  .version(VERSION);

program
  .command('run')
  .description('Run the print server in the foreground (development mode)')
  .option('-c, --config <path>', 'Path to configuration file')
  .action(async (options) => {
    console.log(`Starting ${PRODUCT_NAME} in foreground mode... Press Ctrl+C to stop.\n`);
    const service = new ThermalPrintService(options.config);
    const shutdown = async () => {
      await service.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    try {
      await service.start();
    } catch (error) {
      console.error('Failed to start:', error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show what is answering on the print port range')
  .action(async () => {
    const services = await findRunningServices();
    if (services.length === 0) {
      console.log('Status: NOT RUNNING (nothing answers on 127.0.0.1:9100-9110)');
      return;
    }
    for (const s of services) {
      const res = await fetch(`http://127.0.0.1:${s.port}/health`, { signal: AbortSignal.timeout(2000) });
      const h = (await res.json()) as HealthResponse;
      console.log(`${h.name ?? 'XP Thermal Print Service (legacy)'} ${h.version} on port ${s.port}`);
      console.log(`  Status:    ${h.status}${h.mode ? ` (${h.mode} mode)` : ''}`);
      console.log(`  Dashboard: http://127.0.0.1:${s.port}/dashboard`);
      console.log(`  Uptime:    ${formatUptime(h.uptime)}`);
      console.log(`  Printers:  ${h.printers.online}/${h.printers.total} online`);
      console.log(`  Queue:     ${h.queue.pending} pending, ${h.queue.processing} processing`);
    }
  });

program
  .command('test-print')
  .description('Send a test print job')
  .option('-p, --printer <id>', 'Printer ID (defaults to the default printer)')
  .action(async (options) => {
    const port = await activePort();
    const res = await fetch(`http://127.0.0.1:${port}/api/print`, {
      method: 'POST',
      headers: await apiHeaders(port),
      body: JSON.stringify({
        idempotencyKey: `cli_test_${Date.now()}`,
        templateType: 'test',
        printerId: options.printer,
        priority: 2,
        payload: { message: 'Manual test print from CLI' }
      }),
      signal: AbortSignal.timeout(5000)
    });
    const body = (await res.json()) as { id?: string; jobs?: Array<{ id: string }>; message?: string };
    if (!res.ok) {
      console.error('Error:', body.message || `HTTP ${res.status}`);
      process.exit(1);
    }
    console.log(`Test print queued. Job ID: ${body.id ?? body.jobs?.[0]?.id ?? 'unknown'}`);
  });

program
  .command('printers')
  .description('List configured printers')
  .action(async () => {
    const port = await activePort();
    const res = await fetch(`http://127.0.0.1:${port}/api/printers`, {
      headers: await apiHeaders(port),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      console.error(`Error: HTTP ${res.status}`);
      process.exit(1);
    }
    const { printers } = (await res.json()) as { printers: PrinterInfo[] };
    if (printers.length === 0) {
      console.log('No printers configured. Open the dashboard and click "Detect printers".');
      return;
    }
    for (const p of printers) {
      console.log(`${p.state.isConnected ? 'online ' : 'offline'}  ${p.id}  ${p.name} (${p.type}, ${p.state.status}, ${p.state.totalJobsPrinted} printed)`);
    }
  });

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${totalSeconds % 60}s`);
  return parts.join(' ');
}

program.parse();
