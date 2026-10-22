/**
 * "Start with Windows": a value under the current user's Run key.
 *
 * HKCU needs no admin rights, and Windows starts the app at sign-in with no
 * scheduled task or service. reg.exe is used rather than PowerShell because it
 * answers in a few milliseconds and exists on every Windows install.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { RUN_KEY_VALUE } from './identity';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function regExe(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
}

function reg(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(regExe(), args, { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

/** The command line the Run key should hold for this exe. */
export function startupCommand(exePath: string = process.execPath): string {
  return `"${exePath}" --background`;
}

export async function getStartWithWindows(): Promise<{ enabled: boolean; command: string | null }> {
  if (process.platform !== 'win32') return { enabled: false, command: null };
  const { code, stdout } = await reg(['query', RUN_KEY, '/v', RUN_KEY_VALUE]);
  if (code !== 0) return { enabled: false, command: null };
  const match = stdout.match(/REG_\w+\s+(.+)\s*$/m);
  return { enabled: true, command: match ? match[1].trim() : null };
}

export async function setStartWithWindows(enabled: boolean, exePath: string = process.execPath): Promise<void> {
  if (process.platform !== 'win32') return;
  const result = enabled
    ? await reg(['add', RUN_KEY, '/v', RUN_KEY_VALUE, '/t', 'REG_SZ', '/d', startupCommand(exePath), '/f'])
    : await reg(['delete', RUN_KEY, '/v', RUN_KEY_VALUE, '/f']);

  // Deleting a value that is already gone is success, as far as the user is concerned.
  if (result.code !== 0 && enabled) {
    throw new Error('Windows did not accept the startup setting (reg.exe failed).');
  }
}
