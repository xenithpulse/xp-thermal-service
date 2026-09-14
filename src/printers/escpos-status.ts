/**
 * Reading ESC/POS real-time status bytes.
 *
 * `DLE EOT n` asks a printer how it is. Which question you asked determines
 * what the bits mean, and the network adapter got this wrong: it sent `n=1`
 * (printer status) and then read bit 3 as "paper out" and bit 2 as "cover
 * open". Under `n=1` those bits are *offline* and *the cash drawer pin*. A
 * printer that was merely offline reported itself out of paper, and a drawer
 * left open could read as a cover fault.
 *
 * Pure and byte-level on purpose, like health-verdict and printer-resolver:
 * the bit tables below are the part worth being able to prove without a
 * printer on the desk.
 *
 * Command reference (Epson ESC/POS, followed by essentially every clone):
 *
 *   n=1  Printer status
 *          bit 2 (0x04)  drawer kick-out connector pin 3
 *          bit 3 (0x08)  0 = online, 1 = OFFLINE
 *   n=2  Offline cause
 *          bit 2 (0x04)  cover open
 *          bit 3 (0x08)  paper being fed by the button
 *          bit 5 (0x20)  an error occurred
 *          bit 6 (0x40)  printing stopped because paper ran out
 *   n=3  Error cause
 *          bit 3 (0x08)  auto-cutter error
 *          bit 5 (0x20)  unrecoverable error
 *          bit 6 (0x40)  auto-recoverable error
 *   n=4  Paper sensor
 *          bits 2,3 (0x0C)  paper near end
 *          bits 5,6 (0x60)  paper NOT present
 */

import { PrinterStatus } from '../types';

export const DLE_EOT = {
  PRINTER: 1,
  OFFLINE_CAUSE: 2,
  ERROR_CAUSE: 3,
  PAPER: 4
} as const;

/** Build a `DLE EOT n` request. */
export function statusRequest(n: number): Buffer {
  return Buffer.from([0x10, 0x04, n]);
}

/**
 * Every real-time status byte carries the same four fixed bits: bit 1 and
 * bit 4 set, bit 0 and bit 7 clear.
 *
 * Checking them is what separates "the printer answered" from "something on
 * this port sent us bytes". A raw socket on 9100 might be a print server, a
 * terminal server, or another application entirely, and treating whatever it
 * returns as a status byte is how a non-printer gets reported as online.
 */
export function isStatusByte(byte: number): boolean {
  return (byte & 0x93) === 0x12;
}

export interface StatusVerdict {
  status: PrinterStatus;
  /** Plain-language explanation, or null when the printer is simply ready. */
  reason: string | null;
}

/**
 * Turn the replies into a verdict.
 *
 * `printer` is the only required byte. The others are consulted solely to
 * explain an offline printer — asking why a healthy printer is unhealthy
 * wastes a round trip on every poll.
 */
export function readStatus(bytes: {
  printer?: number;
  offlineCause?: number;
  paper?: number;
}): StatusVerdict {
  const { printer, offlineCause, paper } = bytes;

  // Paper is worth reporting even on a printer that still calls itself online:
  // most units stay online until the roll actually runs out, and by then the
  // ticket is already lost.
  if (paper !== undefined && isStatusByte(paper) && (paper & 0x60) === 0x60) {
    return {
      status: PrinterStatus.PAPER_OUT,
      reason: 'The printer is out of paper — load a new roll'
    };
  }

  if (printer === undefined || !isStatusByte(printer)) {
    // No usable answer. Deliberately not an error: plenty of cheap units do
    // not implement real-time status over a raw socket at all, and calling
    // them faulty would take working printers offline.
    return { status: PrinterStatus.UNKNOWN, reason: null };
  }

  const offline = (printer & 0x08) !== 0;
  if (!offline) {
    if (paper !== undefined && isStatusByte(paper) && (paper & 0x0c) === 0x0c) {
      return {
        status: PrinterStatus.ONLINE,
        reason: 'Paper is nearly out — have a replacement roll ready'
      };
    }
    return { status: PrinterStatus.ONLINE, reason: null };
  }

  // Offline. Say why, if the printer told us.
  if (offlineCause !== undefined && isStatusByte(offlineCause)) {
    if ((offlineCause & 0x40) !== 0) {
      return {
        status: PrinterStatus.PAPER_OUT,
        reason: 'Printing stopped because the paper ran out — load a new roll'
      };
    }
    if ((offlineCause & 0x04) !== 0) {
      return {
        status: PrinterStatus.COVER_OPEN,
        reason: 'The printer cover is open — close it'
      };
    }
    if ((offlineCause & 0x20) !== 0) {
      return {
        status: PrinterStatus.ERROR,
        reason: 'The printer reports an error — check for a paper jam, then power-cycle it'
      };
    }
    if ((offlineCause & 0x08) !== 0) {
      // The feed button is held down. Transient and self-resolving, so this is
      // not a fault the operator needs to be told to fix.
      return {
        status: PrinterStatus.BUSY,
        reason: 'Paper is being fed by the button'
      };
    }
  }

  return {
    status: PrinterStatus.OFFLINE,
    reason: 'The printer reports itself offline — check that it is switched on and has paper'
  };
}
