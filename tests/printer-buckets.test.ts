/**
 * Which printer states count as working — Phase 4.
 *
 * ── The mistake this file exists to prevent ────────────────────────────────
 *
 * The 4-hour verification run measured, over 240 samples on real hardware:
 *
 *     printer_state : receipt=busy   236 samples
 *     print_status  : degraded       236 samples
 *     prints        : 214 ok, 0 failed
 *
 * Read quickly, that says the service cried wolf through a working service, and
 * BUSY was briefly moved into the `online` bucket on exactly that reading.
 *
 * It was wrong. The operator had pulled the paper roll out and left the printer
 * connected. `prints_ok` counts jobs the soak SUBMITTED and the service
 * ACCEPTED — an HTTP result, not a receipt. The queue drained to `pending: 0`
 * at every sample while 408 jobs went through it, and nothing came out of the
 * printer at all.
 *
 * So BUSY is what this hardware reports BOTH while printing AND while blocked,
 * and no signal available to the service separates them — the queue-stall check
 * cannot, because the queue drained. The bias is therefore chosen deliberately,
 * on Phase 4's own rule: no single failure may be both silent and permanent. A
 * false amber costs a glance at the printer; a false green costs a service.
 */

import { bucketPrinterStates } from '../src/printers/printer-manager';
import { decideHealth } from '../src/api/health-verdict';
import { PrinterStatus } from '../src/types';

describe('BUSY is ambiguous, so it is not treated as healthy', () => {
  it('counts BUSY as a fault, and separately as busy', () => {
    expect(bucketPrinterStates([PrinterStatus.BUSY])).toEqual({
      online: 0,
      offline: 0,
      error: 1,
      busy: 1
    });
  });

  it('does NOT report healthy for the state the soak actually saw', () => {
    // One receipt printer, reporting BUSY, with the paper roll removed. This is
    // the exact shape of 236 samples, and health must not call it fine.
    const counts = bucketPrinterStates([PrinterStatus.BUSY]);
    const verdict = decideHealth({
      printers: { total: 1, ...counts, initializing: false },
      queue: { deadLetter: 0, oldestPendingAgeMs: null }
    });

    expect(verdict.status).toBe('degraded');
  });

  it('words it as the uncertainty it is, rather than asserting a jam', () => {
    const counts = bucketPrinterStates([PrinterStatus.BUSY]);
    const verdict = decideHealth({
      printers: { total: 1, ...counts, initializing: false },
      queue: { deadLetter: 0, oldestPendingAgeMs: null }
    });

    const said = verdict.reasons.join(' ');
    expect(said).toMatch(/BUSY/);
    expect(said).toMatch(/either printing or blocked/i);
    expect(said).toMatch(/paper/i);
  });

  it('falls back to the plain wording when the faults are not all BUSY', () => {
    const counts = bucketPrinterStates([PrinterStatus.PAPER_OUT, PrinterStatus.OFFLINE]);
    const verdict = decideHealth({
      printers: { total: 2, ...counts, initializing: false },
      queue: { deadLetter: 0, oldestPendingAgeMs: null }
    });

    expect(verdict.status).toBe('degraded');
    expect(verdict.reasons.join(' ')).toMatch(/None of the 2 configured printer\(s\) are online/);
  });
});

describe('every printer state lands in a deliberate bucket', () => {
  const expected: Array<[PrinterStatus, 'online' | 'offline' | 'error']> = [
    [PrinterStatus.ONLINE, 'online'],
    [PrinterStatus.OFFLINE, 'offline'],
    [PrinterStatus.UNKNOWN, 'offline'],
    [PrinterStatus.ERROR, 'error'],
    [PrinterStatus.PAPER_OUT, 'error'],
    [PrinterStatus.COVER_OPEN, 'error'],
    [PrinterStatus.BUSY, 'error']
  ];

  it.each(expected)('%s -> %s', (status, bucket) => {
    const counts = bucketPrinterStates([status]);
    expect(counts[bucket]).toBe(1);
    // online + offline + error must account for it exactly once. `busy` is a
    // subset of error and deliberately not part of this sum.
    expect(counts.online + counts.offline + counts.error).toBe(1);
  });

  it('covers the whole enum, so a new state cannot be added without a decision', () => {
    const covered = new Set(expected.map(([s]) => s));
    const all = Object.values(PrinterStatus) as PrinterStatus[];
    expect(all.filter((s) => !covered.has(s))).toEqual([]);
  });

  it('counts a mixed rig correctly', () => {
    // one printing, one out of paper, one unplugged.
    expect(
      bucketPrinterStates([PrinterStatus.ONLINE, PrinterStatus.PAPER_OUT, PrinterStatus.OFFLINE])
    ).toEqual({ online: 1, offline: 1, error: 1, busy: 0 });
  });

  it('an empty rig counts nothing', () => {
    expect(bucketPrinterStates([])).toEqual({ online: 0, offline: 0, error: 0, busy: 0 });
  });

  it('a genuinely working printer is still healthy', () => {
    const counts = bucketPrinterStates([PrinterStatus.ONLINE]);
    const verdict = decideHealth({
      printers: { total: 1, ...counts, initializing: false },
      queue: { deadLetter: 0, oldestPendingAgeMs: null }
    });
    expect(verdict.status).toBe('healthy');
    expect(verdict.reasons).toEqual([]);
  });
});
