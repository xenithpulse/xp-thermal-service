/**
 * `ThermalBridge.exe --server`: the print server, as the supervisor's child.
 *
 * Runs the same server as `node dist/index.js`, from the data directory, and
 * reports to the supervisor over the IPC channel so the tray can show the
 * port and which printers are online.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runServer } from '../index';
import { readAsset } from './assets';
import { AppMode, dataDirFor } from './paths';

const STATUS_INTERVAL_MS = 5000;

export async function runServerChild(): Promise<void> {
  const mode: AppMode = process.env.TB_MODE === 'service' ? 'service' : 'user';
  const dataDir = process.env.TB_DATA_DIR || dataDirFor(mode);
  fs.mkdirSync(dataDir, { recursive: true });
  process.chdir(dataDir);

  // The example config seeds config.json on first run, and stays beside it as
  // the fallback the config loader repairs a corrupt file from.
  const example = readAsset('config.example.json');
  const examplePath = path.join(dataDir, 'config.example.json');
  if (example) {
    try {
      if (!fs.existsSync(examplePath) || !fs.readFileSync(examplePath).equals(example)) {
        fs.writeFileSync(examplePath, example);
      }
    } catch {
      // Without the example, the loader falls back to built-in defaults.
    }
  }

  const service = await runServer({ mode, configPath: path.join(dataDir, 'config.json') });

  const report = (type: 'ready' | 'status') => {
    try {
      process.send?.({ type, port: service.getActivePort(), printers: service.getPrinterBrief() });
    } catch {
      // Supervisor gone; the disconnect handler shuts us down.
    }
  };
  report('ready');
  setInterval(() => report('status'), STATUS_INTERVAL_MS).unref();

  process.on('message', (msg: { type?: string; printerId?: string }) => {
    if (msg?.type !== 'testPrint') return;
    try {
      const result = service.printTestPage(msg.printerId);
      process.send?.({ type: 'testPrintResult', ok: true, ...result });
    } catch (error) {
      process.send?.({ type: 'testPrintResult', ok: false, message: (error as Error).message });
    }
  });
}
