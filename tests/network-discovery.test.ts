/**
 * LAN printer discovery.
 *
 * The value of this is not "found an open port" — it is telling a printer
 * apart from everything else that sits on 9100. Print servers, terminal
 * servers and unrelated software all listen there, and a discovery list full
 * of devices that will never print is worse than no list, because the operator
 * configures one and finds out at service.
 */

import * as net from 'net';
import { probePrinter, sweepForPrinters, prefixLength } from '../src/printers/network-discovery';

/** A fake device on loopback. `reply` is what it sends when spoken to. */
function fakeDevice(reply: Buffer | null): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        if (reply) socket.write(reply);
      });
      socket.on('error', () => { /* client hung up */ });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

/** A valid ESC/POS status byte: bits 1 and 4 set, bits 0 and 7 clear. */
const STATUS_OK = Buffer.from([0x12]);

describe('prefixLength', () => {
  it('reads standard masks', () => {
    expect(prefixLength('255.255.255.0')).toBe(24);
    expect(prefixLength('255.255.240.0')).toBe(20);
    expect(prefixLength('255.255.0.0')).toBe(16);
  });

  it('rejects a non-contiguous mask', () => {
    expect(prefixLength('255.0.255.0')).toBeNull();
  });

  it('rejects nonsense', () => {
    expect(prefixLength(undefined)).toBeNull();
    expect(prefixLength('not.a.mask')).toBeNull();
    expect(prefixLength('255.255.255')).toBeNull();
  });
});

describe('probePrinter', () => {
  it('confirms a device that answers with a real status byte', async () => {
    const device = await fakeDevice(STATUS_OK);
    try {
      const hit = await probePrinter('127.0.0.1', device.port, 2000);
      expect(hit).not.toBeNull();
      expect(hit!.respondsToEscPos).toBe(true);
      expect(hit!.note).toMatch(/thermal printer/i);
    } finally {
      await device.close();
    }
  });

  it('reports a device that replies with something else as probably not a printer', async () => {
    // An HTTP server on 9100 would do exactly this.
    const device = await fakeDevice(Buffer.from('HTTP/1.1 400 Bad Request'));
    try {
      const hit = await probePrinter('127.0.0.1', device.port, 2000);
      expect(hit).not.toBeNull();
      expect(hit!.respondsToEscPos).toBe(false);
      expect(hit!.note).toMatch(/probably not/i);
    } finally {
      await device.close();
    }
  });

  it('still lists a silent device, because many printers never answer', async () => {
    // Calling these "not printers" would hide real hardware.
    const device = await fakeDevice(null);
    try {
      const hit = await probePrinter('127.0.0.1', device.port, 2000);
      expect(hit).not.toBeNull();
      expect(hit!.respondsToEscPos).toBe(false);
      expect(hit!.note).toMatch(/may still be a printer/i);
    } finally {
      await device.close();
    }
  });

  it('returns null for a closed port', async () => {
    // A closed port and an unreachable host are the same answer to an operator.
    const hit = await probePrinter('127.0.0.1', 9, 1000);
    expect(hit).toBeNull();
  });
});

describe('sweepForPrinters', () => {
  it('finds the one live device among many dead addresses', async () => {
    const device = await fakeDevice(STATUS_OK);
    try {
      // Reserved TEST-NET-1 addresses: guaranteed not to be anything real.
      const hosts = ['192.0.2.1', '192.0.2.2', '127.0.0.1', '192.0.2.3'];
      const result = await sweepForPrinters(hosts, {
        port: device.port,
        connectTimeoutMs: 300,
        budgetMs: 8000
      });

      expect(result.complete).toBe(true);
      expect(result.scanned).toBe(hosts.length);
      expect(result.found).toHaveLength(1);
      expect(result.found[0].host).toBe('127.0.0.1');
    } finally {
      await device.close();
    }
  });

  it('puts confirmed printers above unconfirmed devices', async () => {
    // The thing the operator wants belongs at the top of the list.
    const printer = await fakeDevice(STATUS_OK);
    const notPrinter = await fakeDevice(Buffer.from('nope'));
    try {
      const a = await probePrinter('127.0.0.1', printer.port, 2000);
      const b = await probePrinter('127.0.0.1', notPrinter.port, 2000);
      expect(a!.respondsToEscPos).toBe(true);
      expect(b!.respondsToEscPos).toBe(false);

      const sorted = [b!, a!].sort((x, y) =>
        x.respondsToEscPos === y.respondsToEscPos ? 0 : x.respondsToEscPos ? -1 : 1
      );
      expect(sorted[0].respondsToEscPos).toBe(true);
    } finally {
      await printer.close();
      await notPrinter.close();
    }
  });

  it('returns what it has when the budget runs out', async () => {
    // The dashboard is waiting on this request; a partial list beats a spinner
    // that never resolves.
    const hosts = Array.from({ length: 400 }, (_, i) => `192.0.2.${(i % 254) + 1}`);
    const result = await sweepForPrinters(hosts, {
      port: 9100,
      connectTimeoutMs: 800,
      concurrency: 2,
      budgetMs: 600
    });
    expect(result.complete).toBe(false);
    expect(result.scanned).toBeLessThan(hosts.length);
  }, 15000);

  it('handles an empty target list', async () => {
    const result = await sweepForPrinters([], {});
    expect(result.found).toEqual([]);
    expect(result.complete).toBe(true);
  });
});
