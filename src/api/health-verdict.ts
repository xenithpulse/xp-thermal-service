/**
 * Does this service work? — Phase 4, Layer 5, and the fix for D31.
 *
 * Kept as a pure function, deliberately. The old verdict lived inside the
 * Express handler as a one-line ternary:
 *
 *     status = printerSummary.initializing ? 'initializing' : 'healthy'
 *
 * which nothing could test without standing up an HTTP server, and which was
 * wrong for fourteen hours on a real till without anybody noticing. A decision
 * this load-bearing should be readable on its own and provable on its own, the
 * way printer-resolver's classifyStatus is.
 *
 * The distinction the whole of Phase 4 turns on:
 *
 *   LIVENESS    is the process up?           Layers 0 and 1 already answer this
 *   CAPABILITY  can it do its job?           nothing answered this until now
 *
 * Every serious defect the soaks found is a process that is alive and unable to
 * serve, so liveness is the question whose answer never helps.
 */

import { HealthStatus } from '../types';

/**
 * How long the oldest unfinished job may sit before this service stops calling
 * itself healthy.
 *
 * Five minutes. A receipt is wanted in seconds, so five minutes is already far
 * past "slow" and unambiguously "not printing" — while still being long enough
 * that a genuine lunch-rush backlog, or a printer taking its time waking up,
 * does not flap the status. D30's real case sat at fourteen hours.
 */
export const QUEUE_STALL_MS = 5 * 60 * 1000;

export interface HealthVerdictInput {
  printers: {
    total: number;
    online: number;
    offline: number;
    error: number;
    /**
     * Printers reporting BUSY. A SUBSET of `error`, not an addition to it.
     *
     * BUSY is what this hardware reports both while printing and while blocked
     * with no paper, and nothing available to this service tells the two apart
     * — see bucketPrinterStates. It counts as a fault, because a false amber
     * costs a glance and a false green costs a dinner service, but the wording
     * below has to admit what is actually known.
     */
    busy?: number;
    initializing: boolean;
  };
  queue: {
    deadLetter: number;
    /** Age of the oldest unfinished job in ms, or null when none is waiting. */
    oldestPendingAgeMs: number | null;
  };
  /** Injectable so the tests do not have to wait five minutes. */
  stallMs?: number;
}

export interface HealthVerdict {
  status: HealthStatus;
  /**
   * Why the status is what it is, in words meant for a person. The connection
   * card, qa-check and the watchdog log all surface these verbatim, so they
   * must read as sentences and must name numbers rather than say "a problem".
   */
  reasons: string[];
}

export function decideHealth(input: HealthVerdictInput): HealthVerdict {
  const { printers, queue } = input;
  const stallMs = input.stallMs ?? QUEUE_STALL_MS;

  // Transient and NOT a fault. Kept as its own value so nothing downstream
  // escalates a service that is three seconds into starting up — the watchdog
  // restarting a service mid-initialisation is how LIFE-20's tug-of-war
  // started.
  if (printers.initializing) {
    return { status: 'initializing', reasons: [] };
  }

  const reasons: string[] = [];

  // Tracked explicitly rather than inferred from the reasons list: some reasons
  // are worth reporting without being faults, and deciding that by re-reading
  // the strings we just wrote would break the moment somebody rewords one.
  let cannotComplete = false;

  if (printers.total === 0) {
    // A site with no printers configured is a legitimate deployment — plenty
    // run the POS with no thermal printer at all — so this is not a fault, and
    // reporting it as one would teach every such site to ignore this field.
    // But it is not "can complete work" either: anything sent here queues
    // forever. Say it, do not escalate it.
    reasons.push('No printers are configured, so nothing sent here can print.');
  } else if (printers.online === 0) {
    const busy = printers.busy ?? 0;
    if (busy > 0 && busy === printers.error && printers.offline === 0) {
      // Every fault is a BUSY, which is the ambiguous one. Say what is known
      // and what is not, rather than asserting a jam that may be a rush.
      reasons.push(
        `${busy} printer(s) report BUSY. That means either printing or blocked — ` +
        'commonly out of paper — and the printer does not distinguish them. Check the paper.'
      );
    } else {
      reasons.push(
        `None of the ${printers.total} configured printer(s) are online ` +
        `(${printers.error} in error, ${printers.offline} offline).`
      );
    }
    cannotComplete = true;
  } else if (printers.error > 0) {
    // Some printers work and some do not: receipts print and the kitchen gets
    // nothing. This is the exact shape the 15-minute soak window recorded —
    // kitchen=error, cashier=error, usb-receipt=offline — while this endpoint
    // answered "healthy" on every single sample.
    reasons.push(
      `${printers.error} of ${printers.total} printer(s) are in a fault state ` +
      '(paper out, cover open, or unreachable).'
    );
    cannotComplete = true;
  }

  // The Phase 4 invariant: "if the queue has grown for N consecutive minutes
  // with zero completions, health is not healthy." Asked as an age rather than
  // as a trend, because an age is true the moment it is asked and needs no
  // sampler running to have noticed.
  if (queue.oldestPendingAgeMs !== null && queue.oldestPendingAgeMs > stallMs) {
    reasons.push(
      'The queue is not draining: the oldest unfinished job has been waiting ' +
      `${Math.round(queue.oldestPendingAgeMs / 60000)} minutes.`
    );
    cannotComplete = true;
  }

  if (queue.deadLetter > 0) {
    // Reported always, but NOT a fault on its own. Past failures are history: a
    // service that can never return to healthy after one bad night is a service
    // whose health nobody reads, and a status that is permanently amber is the
    // same as no status at all.
    reasons.push(
      `${queue.deadLetter} job(s) have exhausted their retries and will never print.`
    );
  }

  return { status: cannotComplete ? 'degraded' : 'healthy', reasons };
}
