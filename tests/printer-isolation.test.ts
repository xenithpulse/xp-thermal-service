/**
 * Per-printer dispatch isolation and blob retention.
 *
 * The deployment these defend is the standard restaurant floor: a USB receipt
 * printer at the till and a LAN kitchen printer upstairs. The failure they
 * prevent is the kitchen printer wedging and taking the till down with it —
 * stuck KOT jobs eating every processing slot while receipts (and the cash
 * drawer that opens with them) sit frozen behind timeouts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobQueue } from '../src/queue/job-queue';
import { JobStore } from '../src/queue/job-store';
import { JobStatus, QueueConfig, TemplateType, PrintRequest } from '../src/types';

const silent = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}
} as never;

let dir: string;
let store: JobStore;
let queue: JobQueue;

function config(): QueueConfig {
  return {
    maxConcurrentJobs: 3,
    maxQueueDepth: 0,
    maxRetries: 3,
    retryDelayMs: 1000,
    retryBackoffMultiplier: 2,
    maxRetryDelayMs: 60000,
    jobTimeoutMs: 30000,
    cleanupIntervalMs: 0,
    maxJobAgeMs: 604800000,
    persistPath: path.join(dir, 'jobs.db')
  };
}

function request(key: string): PrintRequest {
  return { idempotencyKey: key, templateType: TemplateType.TEST, payload: {} } as PrintRequest;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-isolation-'));
  const cfg = config();
  store = new JobStore(
    { dbPath: cfg.persistPath, maxJobAgeMs: cfg.maxJobAgeMs, cleanupIntervalMs: 0 },
    silent
  );
  await store.waitForInit();
  queue = new JobQueue(store, cfg, silent);
});

afterEach(() => {
  try { store?.close(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('per-printer dispatch', () => {
  it('a busy printer holds exactly one slot, never the whole pool', () => {
    // Five kitchen tickets queued BEFORE the receipt — the realistic order,
    // since the KOT fires when the order is taken and the receipt at payment.
    for (let i = 0; i < 5; i++) queue.enqueue(request(`kot-${i}`), 'kitchen');
    queue.enqueue(request('bill-1'), 'receipt');

    const batch = queue.dequeueBatch(3);

    // One kitchen job (the oldest), one receipt job — and NOT three kitchen
    // jobs, which is what the old dequeue handed out.
    expect(batch.map((j) => j.printerId).sort()).toEqual(['kitchen', 'receipt']);
    expect(batch.find((j) => j.printerId === 'kitchen')!.idempotencyKey).toBe('kot-0');
  });

  it('finds a receipt buried behind a deep kitchen backlog', () => {
    // Deeper than the scan window. A skip-in-the-caller implementation passes
    // the previous test and fails this one — the filter must be in the query.
    for (let i = 0; i < 40; i++) queue.enqueue(request(`kot-${i}`), 'kitchen');
    queue.enqueue(request('bill-1'), 'receipt');

    const busy = new Set(['kitchen']); // kitchen already has a job in flight
    const job = queue.dequeue(busy);

    expect(job).not.toBeNull();
    expect(job!.printerId).toBe('receipt');
  });

  it('keeps per-station ordering: one batch never carries two jobs for one printer', () => {
    for (let i = 0; i < 4; i++) queue.enqueue(request(`kot-${i}`), 'kitchen');

    const batch = queue.dequeueBatch(3);
    expect(batch).toHaveLength(1);
    expect(batch[0].idempotencyKey).toBe('kot-0');
  });

  it('dequeues normally when nothing is busy', () => {
    queue.enqueue(request('a'), 'kitchen');
    queue.enqueue(request('b'), 'receipt');
    expect(queue.dequeueBatch(3)).toHaveLength(2);
  });
});

describe('blob retention on terminal rows', () => {
  function blobOnDisk(id: string): Uint8Array | undefined {
    return store.getById(id)?.rawCommands as unknown as Uint8Array | undefined;
  }

  it('drops raw commands when a job completes', () => {
    const job = queue.enqueue(request('done-1'), 'receipt').job;
    queue.dequeue();
    queue.setRawCommands(job.id, Buffer.alloc(32 * 1024, 0x1b)); // a receipt with a logo
    expect(blobOnDisk(job.id)?.length).toBe(32 * 1024);

    queue.complete(job.id);

    // The row survives (audit trail), the blob does not (it is what made
    // week-old instances slow and heavy — see markCompleted).
    expect(store.getById(job.id)?.status).toBe(JobStatus.COMPLETED);
    expect(blobOnDisk(job.id)).toBeUndefined();
  });

  it('drops raw commands on dead-letter, and retry still works from payload', () => {
    const cfg = config();
    const q = new JobQueue(store, { ...cfg, maxRetries: 1 }, silent);
    const job = q.enqueue(request('doomed-1'), 'kitchen').job;
    q.dequeue();
    q.setRawCommands(job.id, Buffer.alloc(8192, 0x1b));
    q.fail(job.id, 'printer offline', true);

    expect(store.getById(job.id)?.status).toBe(JobStatus.DEAD_LETTER);
    expect(blobOnDisk(job.id)).toBeUndefined();

    // The processor re-renders from payload whenever rawCommands is absent,
    // so the operator's Retry button loses nothing.
    expect(q.retryJob(job.id)).toBe(true);
    expect(store.getById(job.id)?.payload).toBeDefined();
  });

  it('drops raw commands on cancel, which goes through update() not markCompleted', () => {
    const job = queue.enqueue(request('cancel-1'), 'receipt').job;
    queue.setRawCommands(job.id, Buffer.alloc(4096, 0x1b));

    expect(queue.cancel(job.id)).toBe(true);
    expect(blobOnDisk(job.id)).toBeUndefined();
  });

  it('keeps the blob while a job is still retrying', () => {
    // The retry window is exactly when the cached render pays for itself.
    const job = queue.enqueue(request('retrying-1'), 'kitchen').job;
    queue.dequeue();
    queue.setRawCommands(job.id, Buffer.alloc(2048, 0x1b));
    queue.fail(job.id, 'connect timeout', true);

    expect(store.getById(job.id)?.status).toBe(JobStatus.RETRY_SCHEDULED);
    expect(blobOnDisk(job.id)?.length).toBe(2048);
  });
});

describe('disabled printers and health', () => {
  it('a parked printer does not count toward the health tally', async () => {
    /*
     * Health treats an offline printer as a fault, so the disable toggle must
     * be a real escape hatch: a seasonal terrace printer switched off in the
     * dashboard is a decision, not an outage. Without this exclusion a parked
     * spare holds the site in degraded forever, and a permanently amber
     * status is one nobody reads.
     */
    const { PrinterManager } = await import('../src/printers/printer-manager');
    const mgr = new PrinterManager(
      {
        printers: [
          { id: 'receipt', name: 'Receipt', type: 'usb', enabled: true, isDefault: true,
            printerName: 'Generic / Text Only', timeout: 10000, maxRetries: 3,
            capabilities: { maxWidth: 48 } },
          { id: 'terrace', name: 'Terrace (winter: off)', type: 'usb', enabled: false, isDefault: false,
            printerName: 'Generic / Text Only', timeout: 10000, maxRetries: 3,
            capabilities: { maxWidth: 48 } }
        ] as never,
        autoConnect: false,
        healthCheckInterval: 999999
      } as never,
      silent
    );

    try {
      const summary = mgr.getSummary();
      expect(summary.total).toBe(1);
      // The disabled printer is neither online, offline nor error — absent.
      expect(summary.online + summary.offline + summary.error).toBeLessThanOrEqual(1);
    } finally {
      await mgr.shutdown().catch(() => undefined);
    }
  });
});
