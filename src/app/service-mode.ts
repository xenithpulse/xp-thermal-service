/**
 * `--install-service` / `--uninstall-service`: run Thermal Bridge as a Windows
 * service, for Pulsar POS and fleet installs whose installer is already
 * elevated. Everything goes through sc.exe.
 *
 * A Windows service must answer the Service Control Manager, which a Node
 * executable cannot do on its own. ThermalBridgeService.exe (helpers/
 * ServiceHost.cs, embedded in the exe) is the registered binary: it starts
 * `ThermalBridge.exe --service` and tells it to stop when Windows does.
 *
 * Both binaries are copied to %ProgramFiles%\ThermalBridge first. A service
 * runs as LocalSystem, and registering a binary that a standard user can
 * overwrite (anything under %LOCALAPPDATA%) would hand that user SYSTEM.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runPowerShell } from '../printers/windows-printers';
import { extractAsset, isSea } from './assets';
import { findRunningServices } from './discover';
import {
  WINDOWS_SERVICE_NAME as NAME,
  WINDOWS_SERVICE_DISPLAY_NAME as DISPLAY_NAME,
  LEGACY_SERVICE_NAME,
  LEGACY_SERVICE_DISPLAY_NAME
} from './identity';
import { serviceDataDir, serviceInstallDir } from './paths';

export class ServiceModeError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export const NOT_ELEVATED_MESSAGE =
  'Installing or removing the Thermal Bridge Windows service needs administrator rights.\n\n' +
  'Right-click Command Prompt, choose "Run as administrator", and run the same command again.\n\n' +
  'Most people do not need the service: just run ThermalBridge.exe, which needs no admin rights.';

function system32(exe: string): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
}

function run(exe: string, args: string[], timeoutMs = 30000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(system32(exe), args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

async function sc(args: string[]): Promise<void> {
  const { code, out } = await run('sc.exe', args);
  if (code !== 0) throw new ServiceModeError(`sc.exe ${args[0]} failed: ${out || `exit code ${code}`}`);
}

/** RUNNING, STOPPED, START_PENDING..., or 'missing'. */
async function serviceState(name: string): Promise<string> {
  const { code, out } = await run('sc.exe', ['query', name]);
  if (code !== 0) return 'missing';
  return /STATE\s*:\s*\d+\s+(\w+)/.exec(out)?.[1] ?? 'UNKNOWN';
}

async function waitForState(name: string, state: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await serviceState(name)) === state) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** True only for an elevated token; a non-elevated admin under UAC is false. */
export async function isElevated(): Promise<boolean> {
  const result = await runPowerShell(
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    {},
    20000
  );
  return result.stdout.trim() === 'True';
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export async function installService(log: (line: string) => void): Promise<void> {
  if (!isSea()) throw new ServiceModeError('--install-service must be run from ThermalBridge.exe.');
  if (!(await isElevated())) throw new ServiceModeError(NOT_ELEVATED_MESSAGE, 5);

  const installDir = serviceInstallDir();
  const dataDir = serviceDataDir();
  const existing = await serviceState(NAME);

  if (existing !== 'missing' && existing !== 'STOPPED') {
    log('Stopping the running Thermal Bridge service so its files can be replaced...');
    await run('sc.exe', ['stop', NAME]);
    await waitForState(NAME, 'STOPPED', 30000);
  }

  fs.mkdirSync(installDir, { recursive: true });
  const exeTarget = path.join(installDir, 'ThermalBridge.exe');
  if (!samePath(process.execPath, exeTarget)) {
    fs.copyFileSync(process.execPath, exeTarget);
  }
  const host = extractAsset('ThermalBridgeService.exe', installDir);
  if (!host) throw new ServiceModeError('This build does not include the service host (ThermalBridgeService.exe).');
  log(`Program:  ${installDir}`);

  // Data: SYSTEM and Administrators may change it; users may only read it
  // (the POS reads active_port.txt). Owner reset too, in case a standard user
  // created the folder first to plant files in it.
  fs.mkdirSync(dataDir, { recursive: true });
  await run('icacls.exe', [dataDir, '/setowner', '*S-1-5-32-544', '/T', '/C', '/Q']);
  const acl = await run('icacls.exe', [
    dataDir, '/inheritance:r',
    '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX',
    '/T', '/C', '/Q'
  ]);
  if (acl.code !== 0) log(`Warning: could not restrict permissions on ${dataDir}: ${acl.out}`);
  log(`Data:     ${dataDir}`);

  // The path is quoted inside the value: an unquoted path with spaces is a
  // classic privilege-escalation hole in service registrations.
  const binPath = `"${host}"`;
  const verb = existing === 'missing' ? 'create' : 'config';
  await sc([verb, NAME, 'binPath=', binPath, 'start=', 'delayed-auto', 'DisplayName=', DISPLAY_NAME]);
  await run('sc.exe', ['description', NAME, 'Thermal Bridge - local receipt printing service']);
  // Same recovery as the old service: restart after 5s, 10s, then 30s.
  await sc(['failure', NAME, 'reset=', '86400', 'actions=', 'restart/5000/restart/10000/restart/30000']);
  await run('sc.exe', ['failureflag', NAME, '1']);
  log(`Registered the "${DISPLAY_NAME}" service (${NAME}), starting automatically with Windows.`);

  await sc(['start', NAME]);
  if (!(await waitForState(NAME, 'RUNNING', 30000))) {
    throw new ServiceModeError('The service was registered but did not reach RUNNING. See the logs folder under ' + dataDir);
  }

  // The service has a startup delay; give it time to bind a port.
  const deadline = Date.now() + 60000;
  let port: number | undefined;
  while (!port && Date.now() < deadline) {
    port = (await findRunningServices()).find((s) => s.mode === 'service')?.port;
    if (!port) await new Promise((r) => setTimeout(r, 1000));
  }
  log(port ? `Running. Dashboard: http://127.0.0.1:${port}/dashboard` : 'Started, but it is not answering yet. Check the logs folder.');

  if ((await serviceState(LEGACY_SERVICE_NAME)) !== 'missing') {
    log('');
    log(`Note: the older "${LEGACY_SERVICE_DISPLAY_NAME}" service is also installed. While it is running,`);
    log('Thermal Bridge leaves printing to it. To switch over, stop and remove it:');
    log(`  sc stop ${LEGACY_SERVICE_NAME}`);
    log(`  sc delete ${LEGACY_SERVICE_NAME}`);
  }
}

export async function uninstallService(log: (line: string) => void): Promise<void> {
  if (!(await isElevated())) throw new ServiceModeError(NOT_ELEVATED_MESSAGE, 5);

  if ((await serviceState(NAME)) === 'missing') {
    log('The Thermal Bridge service is not installed. Nothing to do.');
    return;
  }

  await run('sc.exe', ['stop', NAME]);
  await waitForState(NAME, 'STOPPED', 30000);
  await sc(['delete', NAME]);
  log(`Removed the "${DISPLAY_NAME}" service.`);

  const installDir = serviceInstallDir();
  if (!samePath(path.dirname(process.execPath), installDir)) {
    for (const file of ['ThermalBridgeService.exe', 'ThermalBridge.exe']) {
      try {
        fs.rmSync(path.join(installDir, file), { force: true });
      } catch {
        // Still in use by a process that has not exited yet; harmless.
      }
    }
  }
  log(`Settings and print history were kept in ${serviceDataDir()}.`);
}
