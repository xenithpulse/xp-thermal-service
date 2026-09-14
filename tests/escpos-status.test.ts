/**
 * ESC/POS real-time status parsing.
 *
 * The bug these exist to prevent: the network adapter sent `DLE EOT 1` and
 * then read bit 3 as paper-out and bit 2 as cover-open. Under n=1 those bits
 * mean *offline* and *the cash drawer pin*, so a printer that was merely
 * switched off reported itself out of paper — sending an operator to change a
 * roll that was already full.
 */

import { readStatus, isStatusByte, statusRequest, DLE_EOT } from '../src/printers/escpos-status';
import { PrinterStatus } from '../src/types';

/** Real-time status bytes always carry bit 1 and bit 4 set, bits 0 and 7 clear. */
const BASE = 0x12;

describe('isStatusByte', () => {
  it('accepts a byte with the fixed bits correct', () => {
    expect(isStatusByte(BASE)).toBe(true);
    expect(isStatusByte(BASE | 0x08)).toBe(true);
  });

  it('rejects bytes from something that is not a printer', () => {
    // A raw socket on 9100 might be a print server, a terminal server, or an
    // unrelated application. Treating its bytes as status is how a non-printer
    // gets reported online.
    expect(isStatusByte(0x00)).toBe(false);
    expect(isStatusByte(0xff)).toBe(false);
    expect(isStatusByte(0x41)).toBe(false); // 'A'
  });
});

describe('statusRequest', () => {
  it('builds DLE EOT n', () => {
    expect([...statusRequest(DLE_EOT.PRINTER)]).toEqual([0x10, 0x04, 1]);
    expect([...statusRequest(DLE_EOT.PAPER)]).toEqual([0x10, 0x04, 4]);
  });
});

describe('readStatus', () => {
  it('reports a ready printer with no reason to show', () => {
    const v = readStatus({ printer: BASE, paper: BASE });
    expect(v.status).toBe(PrinterStatus.ONLINE);
    expect(v.reason).toBeNull();
  });

  it('reads bit 3 of n=1 as OFFLINE, not paper-out', () => {
    // The exact misread. 0x08 under n=1 is the offline bit.
    const v = readStatus({ printer: BASE | 0x08 });
    expect(v.status).toBe(PrinterStatus.OFFLINE);
    expect(v.status).not.toBe(PrinterStatus.PAPER_OUT);
    expect(v.reason).toMatch(/switched on/i);
  });

  it('ignores the drawer pin, which is bit 2 of n=1', () => {
    // An open cash drawer must not read as a printer fault.
    const v = readStatus({ printer: BASE | 0x04 });
    expect(v.status).toBe(PrinterStatus.ONLINE);
  });

  it('names a cover left open', () => {
    const v = readStatus({ printer: BASE | 0x08, offlineCause: BASE | 0x04 });
    expect(v.status).toBe(PrinterStatus.COVER_OPEN);
    expect(v.reason).toMatch(/close it/i);
  });

  it('prefers paper-end over cover when the printer reports both', () => {
    // Paper is the actionable one; a cover flag often accompanies a roll change.
    const v = readStatus({ printer: BASE | 0x08, offlineCause: BASE | 0x40 | 0x04 });
    expect(v.status).toBe(PrinterStatus.PAPER_OUT);
  });

  it('reports an error cause', () => {
    const v = readStatus({ printer: BASE | 0x08, offlineCause: BASE | 0x20 });
    expect(v.status).toBe(PrinterStatus.ERROR);
    expect(v.reason).toMatch(/jam|power-cycle/i);
  });

  it('treats the feed button as busy rather than broken', () => {
    const v = readStatus({ printer: BASE | 0x08, offlineCause: BASE | 0x08 });
    expect(v.status).toBe(PrinterStatus.BUSY);
  });

  it('catches paper out from the sensor even while the printer claims online', () => {
    // Most units stay online until the roll actually runs out; by then the
    // ticket is already lost.
    const v = readStatus({ printer: BASE, paper: BASE | 0x60 });
    expect(v.status).toBe(PrinterStatus.PAPER_OUT);
    expect(v.reason).toMatch(/load a new roll/i);
  });

  it('warns on paper near-end without taking the printer offline', () => {
    const v = readStatus({ printer: BASE, paper: BASE | 0x0c });
    expect(v.status).toBe(PrinterStatus.ONLINE);
    expect(v.reason).toMatch(/nearly out/i);
  });

  it('returns UNKNOWN when the printer does not answer', () => {
    // Not an error: plenty of cheap units do not implement real-time status
    // over a raw socket, and calling them faulty would take working printers
    // offline.
    expect(readStatus({}).status).toBe(PrinterStatus.UNKNOWN);
    expect(readStatus({}).reason).toBeNull();
  });

  it('returns UNKNOWN for a reply that is not a status byte', () => {
    expect(readStatus({ printer: 0xff }).status).toBe(PrinterStatus.UNKNOWN);
  });
});
