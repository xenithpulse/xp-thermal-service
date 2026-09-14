/**
 * The queue ceiling.
 *
 * ErrorCodes.QUEUE_FULL was defined from the start and never thrown, so a
 * printer switched off overnight while the POS kept sending grew the job store
 * without limit and without complaint — silent on both sides, with disk usage
 * as the only symptom.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobQueue } from '../src/queue/job-queue';
import { JobStore } from '../src/queue/job-store';
import {
  JobStatus,
  QueueConfig,
  TemplateType,
  PrintRequest,
  PrintServiceError,
  ErrorCodes
} from '../src/types';

const silent = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}
} as never;

let dir: string;
let store: JobStore;
let queue: JobQueue;

function config(overrides: Partial<QueueConfig> = {}): QueueConfig {
  return {
    maxConcurrentJobs: 3,
    maxQueueDepth: 3,
    maxRetries: 3,
    retryDelayMs: 1000,
    retryBackoffMultiplier: 2,
    maxRetryDelayMs: 60000,
    jobTimeoutMs: 30000,
    cleanupIntervalMs: 3600000,
    maxJobAgeMs: 604800000,
    persistPath: path.join(dir, 'jobs.db'),
    ...overrides
  };
}

function request(key: string): PrintRequest {
  return {
    idempotencyKey: key,
    templateType: TemplateType.TEST,
    payload: {}
  } as PrintRequest;
}

async function build(overrides: Partial<QueueConfig> = {}): Promise<void> {
  const cfg = config(overrides);
  store = new JobStore(
    { dbPath: cfg.persistPath, maxJobAgeMs: cfg.maxJobAgeMs, cleanupIntervalMs: 0 },
    silent
  );
  await store.waitForInit();
  queue = new JobQueue(store, cfg, silent);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-queue-test-'));
});

afterEach(() => {
  try { store?.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('queue depth ceiling', () => {
  it('accepts work up to the limit', async () => {
    await build();
    for (let i = 0; i < 3; i++) {
      expect(queue.enqueue(request(`job-${i}`), 'receipt').created).toBe(true);
    }
    expect(queue.getStats().pending).toBe(3);
  });

  it('refuses the job that would exceed it, with QUEUE_FULL and a 503', async () => {
    await build();
    for (let i = 0; i < 3; i++) queue.enqueue(request(`job-${i}`), 'receipt');

    try {
      queue.enqueue(request('one-too-many'), 'receipt');
      throw new Error('expected the queue to refuse this job');
    } catch (error) {
      expect(error).toBeInstanceOf(PrintServiceError);
      const e = error as PrintServiceError;
      expect(e.code).toBe(ErrorCodes.QUEUE_FULL);
      // 503, not 400: the request was valid, the service is temporarily unable.
      expect(e.statusCode).toBe(503);
      expect(e.message).toContain('limit 3');
    }
  });

  it('still returns the original job for a duplicate key when full', async () => {
    /*
     * The important one. A POS retrying a receipt it already submitted must keep
     * getting that job back — if a full queue turned retries into errors, the
     * backlog would start destroying exactly the tickets idempotency exists to
     * protect, at the worst possible moment.
     */
    await build();
    const first = queue.enqueue(request('order-88'), 'receipt');
    queue.enqueue(request('filler-1'), 'receipt');
    queue.enqueue(request('filler-2'), 'receipt');

    const retry = queue.enqueue(request('order-88'), 'receipt');
    expect(retry.created).toBe(false);
    expect(retry.job.id).toBe(first.job.id);
  });

  it('counts unfinished work only, so completed jobs never block new ones', async () => {
    // Otherwise a busy-but-healthy till stops printing after N receipts ever,
    // which is the opposite of what the ceiling is for.
    await build();
    const jobs = [0, 1, 2].map((i) => queue.enqueue(request(`done-${i}`), 'receipt').job);
    for (const job of jobs) queue.complete(job.id);

    expect(queue.enqueue(request('after-completion'), 'receipt').created).toBe(true);
  });

  it('does not count dead-lettered jobs', async () => {
    // Dead letters are history and are cleared separately. A site that lost a
    // night's tickets must still be able to print in the morning.
    await build({ maxQueueDepth: 2, maxRetries: 1 });
    const job = queue.enqueue(request('doomed'), 'receipt').job;
    queue.dequeue();
    queue.fail(job.id, 'printer offline', true);
    expect(store.getById(job.id)?.status).toBe(JobStatus.DEAD_LETTER);

    expect(queue.enqueue(request('fresh'), 'receipt').created).toBe(true);
  });

  it('counts jobs waiting to retry', async () => {
    /*
     * Regression. The first version of the ceiling used getStats(), whose
     * `pending` counts the exact status 'pending' and misses 'retry_scheduled'.
     * A switched-off printer parks its whole backlog in retry_scheduled, so the
     * ceiling read zero at exactly the moment it was supposed to trip — caught
     * against a live service, not by the unit tests, because those jobs were
     * all still 'pending'.
     */
    await build({ maxQueueDepth: 2, maxRetries: 5 });

    const a = queue.enqueue(request('retry-a'), 'receipt').job;
    queue.dequeue();
    queue.fail(a.id, 'printer offline', true);
    expect(store.getById(a.id)?.status).toBe(JobStatus.RETRY_SCHEDULED);

    const b = queue.enqueue(request('retry-b'), 'receipt').job;
    queue.dequeue();
    queue.fail(b.id, 'printer offline', true);

    expect(store.countUnfinished()).toBe(2);
    expect(() => queue.enqueue(request('should-be-refused'), 'receipt')).toThrow(
      /queue is full/i
    );
  });

  it('is disabled by 0, restoring unbounded behaviour', async () => {
    await build({ maxQueueDepth: 0 });
    for (let i = 0; i < 25; i++) {
      expect(queue.enqueue(request(`unbounded-${i}`), 'receipt').created).toBe(true);
    }
  });
});
