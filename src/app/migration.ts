/**
 * Moving over from the old XP Thermal Service.
 *
 * Its printers live in %ProgramData%\XPThermalService\config.json, which a
 * standard user can read but not change. Importing copies the printer entries
 * into this app's own config. The old service itself is left alone: removing a
 * Windows service needs admin rights, and it does no harm while it runs (this
 * app stands aside whenever it answers on the print port).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../utils/config';
import { PrinterConfig } from '../types';
import { legacyDataDir } from './paths';
import { LEGACY_SERVICE_NAME } from './identity';

export function legacyConfigPath(): string {
  return path.join(legacyDataDir(), 'config.json');
}

export function readLegacyPrinters(): PrinterConfig[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(legacyConfigPath(), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(raw?.printers) ? (raw.printers as PrinterConfig[]) : [];
  } catch {
    return null;
  }
}

/** Is the old Windows service registered? `sc query` needs no admin rights. */
export function isLegacyServiceInstalled(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const sc = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe');
  return new Promise((resolve) => {
    execFile(sc, ['query', LEGACY_SERVICE_NAME], { windowsHide: true, timeout: 10000 }, (error) => {
      resolve(!error);
    });
  });
}

export interface ImportResult {
  imported: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/** Copy the old printers in, never overwriting one that already exists here. */
export function importLegacyPrinters(config: ConfigManager): ImportResult {
  const printers = readLegacyPrinters();
  if (printers === null) {
    throw new Error(`Could not read ${legacyConfigPath()}.`);
  }

  const result: ImportResult = { imported: [], skipped: [] };
  const hadDefault = config.getPrinters().some((p) => p.isDefault);

  for (const printer of printers) {
    if (!printer?.id) continue;
    if (config.getPrinter(printer.id)) {
      result.skipped.push({ id: printer.id, reason: 'A printer with this id is already set up here.' });
      continue;
    }
    try {
      config.addPrinter({ ...printer, isDefault: hadDefault ? false : !!printer.isDefault });
      result.imported.push(printer.id);
    } catch (error) {
      result.skipped.push({ id: printer.id, reason: (error as Error).message });
    }
  }

  return result;
}
