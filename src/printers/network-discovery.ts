/**
 * Finding printers on the local network.
 *
 * USB discovery is ranked, excludes the fake queues, and explains a missing
 * driver. LAN setup asked the operator for an IP address — which usually meant
 * walking to the printer, holding the feed button to print a self-test page,
 * and reading it off. This closes that gap.
 *
 * Two deliberate limits:
 *
 *   - Only /24-or-smaller subnets on this machine's own interfaces are swept.
 *     A /16 is 65k probes and nobody's till is on one; a /20 (Hyper-V's default
 *     switch, for example) is 4094 and is not where the printer is either.
 *   - Nothing is written and nothing is printed. Discovery reports what it
 *     found; the operator chooses.
 *
 * An open socket on 9100 is not proof of a printer — print servers, terminal
 * servers and unrelated software sit there too — so each candidate is asked
 * `DLE EOT 1` and the reply is checked for the four fixed bits every ESC/POS
 * status byte carries. That is the difference between "something answered" and
 * "a printer answered", and it is what stops the list filling with devices
 * that will never print.
 */

import * as net from 'net';
import * as os from 'os';
import { isStatusByte, statusRequest, DLE_EOT } from './escpos-status';
import { RAW_PRINT_PORT } from './network-diagnosis';

export interface DiscoveredNetworkPrinter {
  host: string;
  port: number;
  /** True when the device answered DLE EOT with a valid ESC/POS status byte. */
  respondsToEscPos: boolean;
  /** Round-trip time of the successful connect, in ms. */
  ms: number;
  /** What we can honestly say about it. */
  note: string;
}

export interface SweepOptions {
  port?: number;
  /** Per-host connect timeout. Short: these are LAN hops, not internet ones. */
  connectTimeoutMs?: number;
  /** How many probes are in flight at once. */
  concurrency?: number;
  /** Overall ceiling, so a slow network cannot hang the request. */
  budgetMs?: number;
}

/** Subnets worth sweeping: IPv4, non-internal, /24 or smaller. */
export function localSweepTargets(): string[] {
  const hosts: string[] = [];

  let interfaces: ReturnType<typeof os.networkInterfaces>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return hosts;
  }

  const seen = new Set<string>();

  for (const entries of Object.values(interfaces)) {
    for (const iface of entries ?? []) {
      // Node <18 reports family as a string, newer as a number. Accept both.
      const isV4 = iface.family === 'IPv4' || (iface.family as unknown as number) === 4;
      if (!isV4 || iface.internal) continue;

      const prefix = prefixLength(iface.netmask);
      if (prefix === null || prefix < 24) continue;

      const octets = iface.address.split('.');
      if (octets.length !== 4) continue;

      const base = octets.slice(0, 3).join('.');
      for (let last = 1; last <= 254; last++) {
        const host = `${base}.${last}`;
        // Never probe ourselves: the service listens on 9100 too, and finding
        // it would offer the operator this machine as a printer.
        if (host === iface.address) continue;
        if (seen.has(host)) continue;
        seen.add(host);
        hosts.push(host);
      }
    }
  }

  return hosts;
}

/** Turn a dotted netmask into a prefix length, or null if it is not contiguous. */
export function prefixLength(netmask: string | undefined): number | null {
  if (!netmask) return null;
  const parts = netmask.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }

  const bits = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const ones = bits.toString(2).padStart(32, '0');
  const match = /^(1*)(0*)$/.exec(ones);
  return match ? match[1].length : null;
}

/**
 * Probe one address. Resolves to null when nothing useful is there — a closed
 * port and an unreachable host are the same answer to the operator.
 */
export function probePrinter(
  host: string,
  port: number,
  connectTimeoutMs: number
): Promise<DiscoveredNetworkPrinter | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const done = (result: DiscoveredNetworkPrinter | null): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const connectTimer = setTimeout(() => done(null), connectTimeoutMs);

    socket.once('error', () => {
      clearTimeout(connectTimer);
      done(null);
    });

    socket.once('connect', () => {
      clearTimeout(connectTimer);
      const ms = Date.now() - started;

      // Ask whether it is a printer. A device that ignores the question is
      // still reported — many cheap units never answer — but it is reported
      // for what it is, rather than as a confirmed printer.
      const replyTimer = setTimeout(() => {
        done({
          host,
          port,
          respondsToEscPos: false,
          ms,
          note: 'Something is listening, but it did not answer a printer status request. It may still be a printer.'
        });
      }, 1200);

      socket.once('data', (data: Buffer) => {
        clearTimeout(replyTimer);
        const ok = data.length > 0 && isStatusByte(data[0]);
        done({
          host,
          port,
          respondsToEscPos: ok,
          ms,
          note: ok
            ? 'Answered an ESC/POS status request — this is a thermal printer.'
            : 'Replied, but not with an ESC/POS status byte. Probably not a thermal printer.'
        });
      });

      try {
        socket.write(statusRequest(DLE_EOT.PRINTER));
      } catch {
        clearTimeout(replyTimer);
        done({ host, port, respondsToEscPos: false, ms, note: 'Something is listening at this address.' });
      }
    });

    socket.connect(port, host);
  });
}

/**
 * Sweep the local subnets.
 *
 * Bounded three ways — concurrency, per-host timeout and an overall budget —
 * because this runs inside an HTTP request that the dashboard is waiting on.
 * Whatever has been found when the budget runs out is returned; a partial list
 * beats a spinner that never resolves.
 */
export async function sweepForPrinters(
  hosts: string[],
  options: SweepOptions = {}
): Promise<{ found: DiscoveredNetworkPrinter[]; scanned: number; complete: boolean }> {
  const port = options.port ?? RAW_PRINT_PORT;
  const connectTimeoutMs = options.connectTimeoutMs ?? 400;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 64, 256));
  const budgetMs = options.budgetMs ?? 20000;

  const deadline = Date.now() + budgetMs;
  const found: DiscoveredNetworkPrinter[] = [];
  let cursor = 0;
  let scanned = 0;

  async function worker(): Promise<void> {
    while (cursor < hosts.length && Date.now() < deadline) {
      const host = hosts[cursor++];
      scanned++;
      const hit = await probePrinter(host, port, connectTimeoutMs);
      if (hit) found.push(hit);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, hosts.length) }, () => worker())
  );

  // Confirmed printers first, then by address, so the list is stable between
  // runs and the thing the operator wants is at the top.
  found.sort((a, b) => {
    if (a.respondsToEscPos !== b.respondsToEscPos) return a.respondsToEscPos ? -1 : 1;
    return compareHosts(a.host, b.host);
  });

  return { found, scanned, complete: cursor >= hosts.length };
}

/** Numeric comparison, so .9 sorts before .10. */
function compareHosts(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
