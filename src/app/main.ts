/**
 * ThermalBridge.exe
 *
 *   (no flags)            start in the background and open the dashboard;
 *                         if already running, just open the dashboard
 *   --background          start without opening anything (Start with Windows)
 *   --quit                ask the running copy to stop (used by the installer)
 *   --install-service     register the Windows service (admin)
 *   --uninstall-service   remove the Windows service (admin)
 *   --version, --help
 *
 * Internal: --server (the print server child), --service (run by the
 * service host under the Service Control Manager).
 *
 * The exe is a Windows GUI program, so double-clicking it never opens a
 * console. Command-line output therefore goes to stdout only when a caller
 * redirected it (an installer capturing output); otherwise it is shown in a
 * message box.
 */

import { runPowerShell } from '../printers/windows-printers';
import { PRODUCT_NAME, TAGLINE, VERSION } from './identity';
import { pipeName, sendCommand, waitForExit } from './instance';
import { runServerChild } from './server-child';
import { installService, uninstallService, ServiceModeError } from './service-mode';
import { runSupervisor } from './supervisor';

const HELP = `${PRODUCT_NAME} ${VERSION} - ${TAGLINE}

  ThermalBridge.exe                       Start, or open the dashboard if already running
  ThermalBridge.exe --background          Start without opening the dashboard
  ThermalBridge.exe --quit                Stop the running copy
  ThermalBridge.exe --install-service     Install as a Windows service (needs admin)
  ThermalBridge.exe --uninstall-service   Remove the Windows service (needs admin)
  ThermalBridge.exe --version`;

/** Redirected stdout is a real file or pipe; a GUI launch gets a no-op stream. */
function hasStdout(): boolean {
  return typeof (process.stdout as { fd?: unknown }).fd === 'number';
}

async function messageBox(text: string, kind: 'info' | 'error'): Promise<void> {
  await runPowerShell(
    `
      Add-Type -AssemblyName System.Windows.Forms
      $icon = if ($env:TB_KIND -eq 'error') { 'Error' } else { 'Information' }
      [void][System.Windows.Forms.MessageBox]::Show($env:TB_TEXT, $env:TB_TITLE, 'OK', $icon)
    `,
    { TB_TEXT: text, TB_TITLE: PRODUCT_NAME, TB_KIND: kind },
    10 * 60_000
  );
}

async function say(text: string, kind: 'info' | 'error' = 'info'): Promise<void> {
  if (hasStdout()) {
    (kind === 'error' ? process.stderr : process.stdout).write(`${text}\n`);
  } else {
    await messageBox(text, kind);
  }
}

async function serviceCommand(install: boolean): Promise<never> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    if (hasStdout()) process.stdout.write(`${line}\n`);
  };
  try {
    await (install ? installService(log) : uninstallService(log));
    if (!hasStdout()) await messageBox(lines.join('\n'), 'info');
    process.exit(0);
  } catch (error) {
    const message = (error as Error).message;
    await say(lines.length ? `${lines.join('\n')}\n\n${message}` : message, 'error');
    process.exit(error instanceof ServiceModeError ? error.exitCode : 1);
  }
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(1).filter((a) => a.startsWith('--') || a === '-h'));

  if (flags.has('--server')) return runServerChild();
  if (flags.has('--version')) return say(`${PRODUCT_NAME} ${VERSION}`);
  if (flags.has('--help') || flags.has('-h')) return say(HELP);
  if (flags.has('--install-service')) return serviceCommand(true);
  if (flags.has('--uninstall-service')) return serviceCommand(false);

  if (flags.has('--quit')) {
    const name = pipeName('user');
    if (await sendCommand(name, 'quit')) await waitForExit(name, 30000);
    process.exit(0);
  }

  if (flags.has('--service')) return runSupervisor({ mode: 'service', background: true });
  return runSupervisor({ mode: 'user', background: flags.has('--background') });
}

main().catch(async (error: Error) => {
  await say(`${PRODUCT_NAME} could not start: ${error.message}`, 'error').catch(() => undefined);
  process.exit(1);
});
