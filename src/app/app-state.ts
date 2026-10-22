/**
 * Small app-level flags that are not print configuration: whether startup has
 * been registered once, whether the legacy import was offered. Kept out of
 * config.json because ConfigManager rewrites that file from its schema and
 * would drop anything it does not know.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AppState {
  /** Set once the installed app has registered itself to start with Windows. */
  startupConfigured?: boolean;
  /** The operator answered the "import from XP Thermal Service" offer. */
  legacyImportHandled?: boolean;
}

function statePath(dataDir: string): string {
  return path.join(dataDir, 'app-state.json');
}

export function readAppState(dataDir: string): AppState {
  try {
    return JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8').replace(/^\uFEFF/, '')) as AppState;
  } catch {
    return {};
  }
}

export function updateAppState(dataDir: string, changes: Partial<AppState>): AppState {
  const next = { ...readAppState(dataDir), ...changes };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${statePath(dataDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, statePath(dataDir));
  } catch {
    // Best effort: the worst case is being asked the same question twice.
  }
  return next;
}
