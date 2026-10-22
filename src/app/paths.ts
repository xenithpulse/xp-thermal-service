/**
 * Where Thermal Bridge keeps things, per run mode.
 *
 *   user     The default. A per-user background app: program files under
 *            %LOCALAPPDATA%\Programs\ThermalBridge, data under
 *            %LOCALAPPDATA%\ThermalBridge. Needs no admin rights at all.
 *   service  `--install-service`, for Pulsar POS and fleet installs. Runs as
 *            LocalSystem with data under %ProgramData%\ThermalBridge.
 *   legacy   `node dist/index.js`, which is how Pulsar POS's WinSW wrapper and
 *            `npm run dev` run it. Everything stays relative to the working
 *            directory, exactly as before the rebrand.
 */

import * as os from 'os';
import * as path from 'path';

export type AppMode = 'user' | 'service' | 'legacy';

function localAppData(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

export function programDataRoot(): string {
  return process.env.ProgramData || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
}

export function userDataDir(): string {
  return path.join(localAppData(), 'ThermalBridge');
}

export function serviceDataDir(): string {
  return path.join(programDataRoot(), 'ThermalBridge');
}

/** Data directory of the old XP Thermal Service. Pulsar POS reads it too. */
export function legacyDataDir(): string {
  return path.join(programDataRoot(), 'XPThermalService');
}

export function dataDirFor(mode: AppMode): string {
  if (mode === 'service') return serviceDataDir();
  if (mode === 'user') return userDataDir();
  return process.cwd();
}

/** Where the per-user installer puts the program. */
export function userInstallDir(): string {
  return path.join(localAppData(), 'Programs', 'ThermalBridge');
}

/** Where `--install-service` puts the program: admin-only, so SYSTEM never runs a user-writable binary. */
export function serviceInstallDir(): string {
  return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ThermalBridge');
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Is this exe the installed copy, rather than the portable one?
 *
 * Only an installed copy registers itself to start with Windows by default
 * and runs the installer to update; a portable exe on a USB stick does neither.
 */
export function isInstalledCopy(exePath: string = process.execPath): boolean {
  const dir = path.dirname(exePath);
  return samePath(dir, userInstallDir()) || samePath(dir, serviceInstallDir());
}

export function logsDir(dataDir: string): string {
  return path.join(dataDir, 'logs');
}
