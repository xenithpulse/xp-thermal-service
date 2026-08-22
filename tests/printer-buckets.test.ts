/**
 * Which printer states count as working — Phase 4, and the fix for a false
 * positive the 4-hour verification soak caught.
 *
 * The run measured, over 240 samples on real hardware:
 *
 *     printer_state : receipt=busy   236 samples
 *     print_status  : degraded       236 samples
 *     prints        : 214 ok, 0 failed
 *
 * The service reported "running, but it cannot print" for the entire run while
 * printing 214 receipts, because BUSY — the state a printer is in BECAUSE it is
 * printing — fell through a `default:` into the error bucket.
 *
 * Nothing noticed until Layer 5, because until then nothing drew a verdict from
 * these counts. The first test below is that run, and it must never pass with
 * BUSY counted as a fault again.
 */

import { bucketPrinterStates } from '../src/printers/printer-manager';
import { decideHealth } from '../src/api/health-verdict';
import { PrinterStatus } from '../src/types';

describe('a busy printer is a working printer', () => {
  it('counts BUSY as online, not as an error', () => {
    expect(bucketPrinterStates([PrinterStatus.BUSY])).toEqual({
      online: 1,
      offline: 0,
      error: 0
    });
  });

  it('does not report degraded for the state the soak actually saw', () => {
    // One receipt printer, busy printing. 236 samples said "cannot print".
    const counts = bucketPrinterStates([PrinterStatus.BUSY]);
    const verdict = decideHealth({
      printers: { total: 1, ...counts, initializing: false },
      queue: { deadLetter: 0, oldestPendingAgeMs: null }
    });

    expect(verdict.status).toBe('healthy');
    expect(verdict.reasons).toEqual([]);
  });

  it('still reports degraded when the printer genuinely cannot print', () => {
    for (const bad of [PrinterStatus.ERROR, PrinterStatus.PAPER_OUT, PrinterStatus.COVER_OPEN]) {
      const counts = bucketPrinterStates([bad]);
      const verdict = decideHealth({
        printers: { total: 1, ...counts, initializing: false },
        queue: { deadLetter: 0, oldestPendingAgeMs: null }
      });
      expect(verdict.status).toBe('degraded');
    }
  });
});

describe('every printer state lands in a deliberate bucket', () => {
  const expected: Array<[PrinterStatus, 'online' | 'offline' | 'error']> = [
    [PrinterStatus.ONLINE, 'online'],
    [PrinterStatus.BUSY, 'online'],
    [PrinterStatus.OFFLINE, 'offline'],
    [PrinterStatus.UNKNOWN, 'offline'],
    [PrinterStatus.ERROR, 'error'],
    [PrinterStatus.PAPER_OUT, 'error'],
    [PrinterStatus.COVER_OPEN, 'error']
  ];

  it.each(expected)('%s -> %s', (status, bucket) => {
    const counts = bucketPrinterStates([status]);
    expect(counts[bucket]).toBe(1);
    // ...and nowhere else.
    expect(counts.online + counts.offline + counts.error).toBe(1);
  });

  it('covers the whole enum, so a new state cannot be added without a decision', () => {
    const covered = new Set(expected.map(([s]) => s));
    const all = Object.values(PrinterStatus) as PrinterStatus[];
    const uncovered = all.filter((s) => !covered.has(s));
    expect(uncovered).toEqual([]);
  });

  it('counts a mixed rig correctly', () => {
    // kitchen printing, cashier out of paper, a third unplugged.
    expect(
      bucketPrinterStates([PrinterStatus.BUSY, PrinterStatus.PAPER_OUT, PrinterStatus.OFFLINE])
    ).toEqual({ online: 1, offline: 1, error: 1 });
  });

  it('an empty rig counts nothing', () => {
    expect(bucketPrinterStates([])).toEqual({ online: 0, offline: 0, error: 0 });
  });
});
