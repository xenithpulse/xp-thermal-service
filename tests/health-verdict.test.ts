/**
 * Tests for the health verdict — Phase 4, Layer 5, and the proof for D31.
 *
 * The fixtures are the real observations from the 24-hour soak on the reference
 * hardware, not invented shapes. The first test is the defect itself: the exact
 * printer state that was recorded on every sample of a 15-minute window while
 * this service answered "healthy".
 *
 *     printer_state: kitchen=error | cashier=error | usb-receipt=offline
 *     print_status:  healthy
 *
 * If that test ever passes with 'healthy' again, a till can print nothing for
 * fourteen hours and report itself well throughout, which is what happened.
 */

import { decideHealth, QUEUE_STALL_MS } from '../src/api/health-verdict';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function printers(overrides: Partial<{
  total: number; online: number; offline: number; error: number; initializing: boolean;
}> = {}) {
  return {
    total: 3,
    online: 3,
    offline: 0,
    error: 0,
    initializing: false,
    ...overrides
  };
}

function queue(overrides: Partial<{ deadLetter: number; oldestPendingAgeMs: number | null }> = {}) {
  return { deadLetter: 0, oldestPendingAgeMs: null, ...overrides };
}

// ─── D31: the defect that started this ───────────────────────────────────────

describe('D31 — a service that cannot print must not call itself healthy', () => {
  it('reports degraded for the exact state the soak recorded', () => {
    // kitchen=error, cashier=error, usb-receipt=offline. Three configured,
    // none usable. The old rule returned 'healthy' here on every sample.
    const verdict = decideHealth({
      printers: printers({ total: 3, online: 0, offline: 1, error: 2 }),
      queue: queue()
    });

    expect(verdict.status).toBe('degraded');
    expect(verdict.status).not.toBe('healthy');
  });

  it('says why, in a sentence a person can act on', () => {
    const verdict = decideHealth({
      printers: printers({ total: 3, online: 0, offline: 1, error: 2 }),
      queue: queue()
    });

    expect(verdict.reasons.join(' ')).toMatch(/None of the 3 configured printer\(s\) are online/);
    // The counts matter: "a problem with the printers" sends an engineer to
    // the site. "2 in error, 1 offline" tells them what to bring.
    expect(verdict.reasons.join(' ')).toMatch(/2 in error/);
    expect(verdict.reasons.join(' ')).toMatch(/1 offline/);
  });

  it('reports degraded when only SOME printers are faulty', () => {
    // Receipts print, the kitchen gets nothing. Half-working is the case most
    // likely to be dismissed as fine, and it loses food rather than money.
    const verdict = decideHealth({
      printers: printers({ total: 3, online: 2, offline: 0, error: 1 }),
      queue: queue()
    });

    expect(verdict.status).toBe('degraded');
    expect(verdict.reasons.join(' ')).toMatch(/1 of 3 printer\(s\) are in a fault state/);
  });
});

// ─── The queue-not-draining invariant ────────────────────────────────────────

describe('the queue must be draining', () => {
  it('reports degraded when the oldest job has been waiting past the threshold', () => {
    const verdict = decideHealth({
      printers: printers(),
      queue: queue({ oldestPendingAgeMs: QUEUE_STALL_MS + MINUTE })
    });

    expect(verdict.status).toBe('degraded');
    expect(verdict.reasons.join(' ')).toMatch(/queue is not draining/);
  });

  it('stays healthy under a genuine rush, where jobs are many but young', () => {
    // The distinction that makes this signal usable: depth alone cannot tell a
    // busy Friday from a dead printer, so the verdict must not read depth.
    const verdict = decideHealth({
      printers: printers(),
      queue: queue({ oldestPendingAgeMs: 8 * 1000 })
    });

    expect(verdict.status).toBe('healthy');
  });

  it('reports the waiting time in minutes, not milliseconds', () => {
    const verdict = decideHealth({
      printers: printers(),
      queue: queue({ oldestPendingAgeMs: 14 * HOUR })   // D30's real duration
    });

    expect(verdict.reasons.join(' ')).toMatch(/840 minutes/);
  });

  it('is healthy when nothing is waiting at all', () => {
    expect(decideHealth({ printers: printers(), queue: queue({ oldestPendingAgeMs: null }) }).status)
      .toBe('healthy');
  });
});

// ─── Dead letters: always reported, never permanently amber ──────────────────

describe('dead-lettered jobs', () => {
  it('are reported even when everything is working', () => {
    // 272 is the count `jobs.db` actually held, every one at attempts=5, while
    // /api/health reported `failed: 0` because getCounts() does not count them.
    const verdict = decideHealth({
      printers: printers(),
      queue: queue({ deadLetter: 272 })
    });

    expect(verdict.reasons.join(' ')).toMatch(/272 job\(s\) have exhausted their retries/);
  });

  it('do NOT on their own make a working service degraded', () => {
    // A service that can never return to healthy after one bad night is a
    // service whose status nobody reads. Permanently amber is the same as off.
    const verdict = decideHealth({
      printers: printers(),
      queue: queue({ deadLetter: 272 })
    });

    expect(verdict.status).toBe('healthy');
  });

  it('are still reported alongside a real fault', () => {
    const verdict = decideHealth({
      printers: printers({ total: 3, online: 0, offline: 1, error: 2 }),
      queue: queue({ deadLetter: 272, oldestPendingAgeMs: 14 * HOUR })
    });

    expect(verdict.status).toBe('degraded');
    // All three facts, so one look at the connection card explains the night.
    expect(verdict.reasons).toHaveLength(3);
  });
});

// ─── States that are not faults ──────────────────────────────────────────────

describe('states that must not be escalated', () => {
  it('initializing is its own status and carries no reasons', () => {
    const verdict = decideHealth({
      printers: printers({ initializing: true, online: 0, offline: 3 }),
      queue: queue()
    });

    // A watchdog that restarts a service three seconds into starting up is how
    // LIFE-20's tug-of-war began. Initialising is transient, not a fault.
    expect(verdict.status).toBe('initializing');
    expect(verdict.reasons).toEqual([]);
  });

  it('a site with no printers configured is healthy, but says so', () => {
    // Plenty of sites run the POS with no thermal printer. Calling that a fault
    // would teach every one of them to ignore this field.
    const verdict = decideHealth({
      printers: printers({ total: 0, online: 0, offline: 0, error: 0 }),
      queue: queue()
    });

    expect(verdict.status).toBe('healthy');
    expect(verdict.reasons.join(' ')).toMatch(/No printers are configured/);
  });

  it('a fully working service is healthy and silent', () => {
    const verdict = decideHealth({ printers: printers(), queue: queue() });

    expect(verdict.status).toBe('healthy');
    expect(verdict.reasons).toEqual([]);
  });
});

// ─── The property Phase 4 exists to enforce ──────────────────────────────────

describe('no single failure may be both silent and permanent', () => {
  const silentAndPermanent = [
    {
      name: 'every printer in error (D31)',
      input: { printers: printers({ total: 2, online: 0, offline: 0, error: 2 }), queue: queue() }
    },
    {
      name: 'every printer offline overnight (PRN-03/04)',
      input: { printers: printers({ total: 2, online: 0, offline: 2, error: 0 }), queue: queue() }
    },
    {
      name: 'a queue that has not moved in fourteen hours (D30)',
      input: { printers: printers(), queue: queue({ oldestPendingAgeMs: 14 * HOUR, deadLetter: 272 }) }
    },
    {
      name: 'the kitchen printer alone is dead',
      input: { printers: printers({ total: 3, online: 2, offline: 0, error: 1 }), queue: queue() }
    }
  ];

  it.each(silentAndPermanent)('$name is visible in the status', ({ input }) => {
    const verdict = decideHealth(input);

    // The whole point: it may not be reported as healthy, and it must explain
    // itself. Either failing alone leaves an operator with nothing.
    expect(verdict.status).not.toBe('healthy');
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });
});
