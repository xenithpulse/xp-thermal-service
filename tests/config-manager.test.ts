/**
 * Tests for configuration durability.
 *
 * These cover data-loss paths, which matter more than any feature here: a
 * service that boots with an empty config and then writes it back has silently
 * deleted every printer the site configured.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../src/utils/config';
import { PrinterType } from '../src/types';

let dir: string;
let configPath: string;

const TWO_PRINTERS = {
  server: { host: '127.0.0.1', port: 9100 },
  printers: [
    {
      id: 'receipt',
      name: 'Receipt',
      type: 'usb',
      enabled: true,
      isDefault: true,
      printerName: 'Generic / Text Only',
      timeout: 10000,
      maxRetries: 3
    },
    {
      id: 'kitchen',
      name: 'Kitchen',
      type: 'usb',
      enabled: true,
      isDefault: false,
      printerName: 'Generic / Text Only',
      timeout: 10000,
      maxRetries: 3
    }
  ]
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-config-test-'));
  configPath = path.join(dir, 'config.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(contents: string): void {
  fs.writeFileSync(configPath, contents, 'utf8');
}

function readPrinterIds(): string[] {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  return (parsed.printers || []).map((p: { id: string }) => p.id);
}

describe('ConfigManager loading', () => {
  it('reads a normal config', () => {
    write(JSON.stringify(TWO_PRINTERS));
    const cm = new ConfigManager(configPath);
    expect(cm.getPrinters().map((p) => p.id)).toEqual(['receipt', 'kitchen']);
  });

  it('reads a config saved with a UTF-8 BOM', () => {
    // Notepad and PowerShell's Out-File both add one. Without BOM stripping
    // this parses as corrupt and the printers vanish.
    write('\uFEFF' + JSON.stringify(TWO_PRINTERS));
    const cm = new ConfigManager(configPath);
    expect(cm.getPrinters().map((p) => p.id)).toEqual(['receipt', 'kitchen']);
  });

  it('refuses to overwrite a config it could not parse', () => {
    write('{ this is not valid json');
    const cm = new ConfigManager(configPath);

    // It runs on defaults so the service can still start and be repaired...
    expect(cm.getPrinters()).toHaveLength(0);
    // ...but it must never write those defaults over the real file.
    expect(() => cm.saveConfig()).toThrow(/Refusing to overwrite/);
  });

  it('leaves the unparseable file on disk untouched', () => {
    const original = '{ broken';
    write(original);
    const cm = new ConfigManager(configPath);

    expect(() => cm.addPrinter({
      id: 'x', name: 'X', type: PrinterType.USB, enabled: true, isDefault: false,
      printerName: 'X', timeout: 10000, maxRetries: 3
    } as never)).toThrow();

    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('backs up a corrupt config so it can be recovered', () => {
    write('{ broken');
    // eslint-disable-next-line no-new
    new ConfigManager(configPath);
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('refuses to save when the config fails schema validation', () => {
    // Valid JSON, invalid shape: the port is out of range.
    write(JSON.stringify({ server: { port: 999999 } }));
    const cm = new ConfigManager(configPath);
    expect(() => cm.saveConfig()).toThrow(/Refusing to overwrite/);
  });
});

describe('ConfigManager writing', () => {
  it('persists an added printer', () => {
    write(JSON.stringify(TWO_PRINTERS));
    const cm = new ConfigManager(configPath);

    cm.addPrinter({
      id: 'bar', name: 'Bar', type: PrinterType.USB, enabled: true, isDefault: false,
      printerName: 'Generic / Text Only', timeout: 10000, maxRetries: 3
    } as never);

    expect(readPrinterIds()).toEqual(['receipt', 'kitchen', 'bar']);
  });

  it('writes without a BOM so the file stays readable', () => {
    write('\uFEFF' + JSON.stringify(TWO_PRINTERS));
    const cm = new ConfigManager(configPath);
    cm.updatePrinter('receipt', { name: 'Renamed' });

    expect(fs.readFileSync(configPath, 'utf8').startsWith('\uFEFF')).toBe(false);
    expect(readPrinterIds()).toEqual(['receipt', 'kitchen']);
  });

  it('preserves printers added to the file by another process', () => {
    // Two service instances, or a hand edit between our read and our write.
    // A blind write would drop whatever the other writer added.
    write(JSON.stringify(TWO_PRINTERS));
    const cm = new ConfigManager(configPath);

    const external = JSON.parse(JSON.stringify(TWO_PRINTERS));
    external.printers.push({
      id: 'bar', name: 'Bar', type: 'usb', enabled: true, isDefault: false,
      printerName: 'Generic / Text Only', timeout: 10000, maxRetries: 3
    });
    // Make the change look newer than what we loaded.
    write(JSON.stringify(external));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(configPath, future, future);

    cm.updatePrinter('receipt', { name: 'Renamed' });

    const ids = readPrinterIds();
    expect(ids).toContain('bar');
    expect(ids).toContain('receipt');
    expect(ids).toContain('kitchen');
    expect(cm.getPrinter('receipt')?.name).toBe('Renamed');
  });

  it('does not resurrect a printer deleted through the API', () => {
    write(JSON.stringify(TWO_PRINTERS));
    const cm = new ConfigManager(configPath);

    cm.removePrinter('kitchen');

    // Something else touches the file afterwards; the merge must not bring
    // the deleted printer back.
    const stale = JSON.parse(JSON.stringify(TWO_PRINTERS));
    write(JSON.stringify(stale));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(configPath, future, future);

    cm.updatePrinter('receipt', { name: 'Renamed again' });

    expect(readPrinterIds()).not.toContain('kitchen');
  });

  it('rejects an out-of-range cash drawer pulse', () => {
    write(JSON.stringify(TWO_PRINTERS));
    const cm = new ConfigManager(configPath);

    expect(() =>
      cm.updatePrinter('receipt', {
        cashDrawer: { enabled: true, pin: 2, onTimeMs: 99999, offTimeMs: 200, openOnPrint: false }
      })
    ).toThrow(/Invalid printer config/);
  });

  it('accepts printer names with characters the old allow-list rejected', () => {
    write(JSON.stringify(TWO_PRINTERS));
    const cm = new ConfigManager(configPath);

    for (const name of ['XP-80C @ Kitchen', 'HP LaserJet M15w+', "Bob's Printer", 'Drucker (Küche)']) {
      expect(() => cm.updatePrinter('receipt', { printerName: name })).not.toThrow();
    }
  });
});
