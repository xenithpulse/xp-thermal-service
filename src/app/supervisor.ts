/**
 * The supervisor: what ThermalBridge.exe is while it runs.
 *
 * It keeps the print server alive without needing a Windows service. The
 * server runs as a child process (`ThermalBridge.exe --server`) and is
 * restarted whenever it exits without being asked to, after 5s, 10s, then 30s,
 * the same backoff the old service's recovery settings used. Everything that
 * can go wrong with printing happens in the child; the supervisor stays small.
 *
 * It also owns the single-instance pipe, the tray icon, Start with Windows,
 * and standing aside when a machine-wide service already handles printing.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { extractAsset, isSea } from './assets';
import { readAppState, updateAppState } from './app-state';
import { findRunningServices, machineWideService, RunningService } from './discover';
import { PRODUCT_NAME, VERSION } from './identity';
import { claimInstance, pipeName, sendCommand } from './instance';
import { AppMode, dataDirFor, isInstalledCopy, logsDir } from './paths';
import { getStartWithWindows, setStartWithWindows } from './startup';
import { Tray, TrayAction } from './tray';

export interface SupervisorOptions {
  mode: Exclude<AppMode, 'legacy'>;
  /** Started by Windows at sign-in: no dashboard, no notices. */
  background: boolean;
}

const RESTART_BACKOFF_MS = [5000, 10000, 30000];
/** A child that ran this long is considered healthy; the backoff starts over. */
const STABLE_RUN_MS = 60000;
/** While deferring to another service, how often to look again. */
const DEFER_RECHECK_MS = 60000;
/** Consecutive misses before taking over from a service that disappeared. */
const DEFER_TAKEOVER_MISSES = 3;
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

interface ChildMessage {
  type?: string;
  port?: number;
  printers?: Array<{ id: string; name: string; online: boolean }>;
  ok?: boolean;
  message?: string;
  enabled?: boolean;
}

function rotate(file: string): void {
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) {
      fs.renameSync(file, file.replace(/\.log$/, '.1.log'));
    }
  } catch {
    // Missing or locked: nothing to rotate.
  }
}

function openUrl(url: string): void {
  spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref();
}

function openFolder(dir: string): void {
  spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
}

export async function runSupervisor(options: SupervisorOptions): Promise<void> {
  const { mode, background } = options;
  const dataDir = dataDirFor(mode);
  const logs = logsDir(dataDir);
  fs.mkdirSync(logs, { recursive: true });
  for (const name of ['supervisor.log', 'console.log', 'service.log']) rotate(path.join(logs, name));

  const supervisorLog = path.join(logs, 'supervisor.log');
  const consoleStream = fs.createWriteStream(path.join(logs, 'console.log'), { flags: 'a' });
  // Synchronous: a few lines a day, and the last one before an exit must land.
  const log = (message: string) => {
    try {
      fs.appendFileSync(supervisorLog, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Logging must never be the reason the supervisor fails.
    }
  };

  let child: ChildProcess | null = null;
  let childStartedAt = 0;
  let failures = 0;
  let port: number | null = null;
  let printers: NonNullable<ChildMessage['printers']> = [];
  let deferredTo: RunningService | null = null;
  let quitting = false;
  let openWhenReady = !background && mode === 'user';
  let tray: Tray | null = null;
  let pipe: net.Server | null = null;

  // ── Single instance ────────────────────────────────────────────────────────
  const pipePath = pipeName(mode);
  pipe = await claimInstance(pipePath, (command) => {
    if (command === 'open') openDashboard();
    else if (command === 'quit') setImmediate(() => void quit('asked to quit'));
    return command === 'ping' ? 'pong' : 'ok';
  });

  if (!pipe) {
    // Already running. A user launching it again wants to see it; Windows
    // starting it again at sign-in wants nothing.
    if (!background && mode === 'user') await sendCommand(pipePath, 'open');
    log('Another instance is already running; handed over and exiting.');
    process.exit(0);
  }

  log(`${PRODUCT_NAME} ${VERSION} starting in ${mode} mode${background ? ' (background)' : ''}, data in ${dataDir}`);

  // ── Tray (user mode only: services run in a session with no desktop) ──────
  function dashboardUrl(hash = ''): string | null {
    const target = deferredTo?.port ?? port;
    return target ? `http://127.0.0.1:${target}/dashboard${hash}` : null;
  }

  function openDashboard(hash = ''): void {
    const url = dashboardUrl(hash);
    if (url) openUrl(url);
    else openWhenReady = true;
  }

  function refreshTray(): void {
    if (!tray) return;
    if (deferredTo) {
      tray.setTooltip(`${PRODUCT_NAME} · Installed service is printing`);
      tray.setHeader(`Printing handled by the installed service · port ${deferredTo.port}`);
      tray.setPrinters([]);
      return;
    }
    if (!port) {
      tray.setTooltip(`${PRODUCT_NAME} · Starting…`);
      tray.setHeader('Starting…');
      return;
    }
    const online = printers.filter((p) => p.online).length;
    const summary = printers.length === 0 ? 'no printers yet' : `${online} of ${printers.length} printer${printers.length === 1 ? '' : 's'} online`;
    tray.setTooltip(`${PRODUCT_NAME} · Running on port ${port}`);
    tray.setHeader(`Running · ${summary} · port ${port}`);
    tray.setPrinters(printers);
  }

  async function refreshStartup(): Promise<void> {
    if (!tray) return;
    tray.setStartup((await getStartWithWindows()).enabled);
  }

  async function onTrayAction(action: TrayAction): Promise<void> {
    switch (action) {
      case 'open':
        openDashboard();
        break;
      case 'printers':
        openDashboard('#printers');
        break;
      case 'test':
        if (child && port) child.send({ type: 'testPrint' });
        else openDashboard();
        break;
      case 'startup': {
        const { enabled } = await getStartWithWindows();
        await setStartWithWindows(!enabled).catch((error: Error) => tray?.notify(PRODUCT_NAME, error.message));
        updateAppState(dataDir, { startupConfigured: true });
        await refreshStartup();
        break;
      }
      case 'logs':
        openFolder(logs);
        break;
      case 'updates':
        openDashboard('#updates');
        break;
      case 'quit':
        await quit('quit from the tray');
        break;
    }
  }

  if (mode === 'user') {
    const binDir = path.join(dataDir, 'bin');
    const hostExe = extractAsset('ThermalBridgeTray.exe', binDir);
    const icon = extractAsset('icon.ico', binDir);
    if (hostExe && icon) {
      tray = new Tray(hostExe, icon);
      tray.on('action', (action: TrayAction) => {
        onTrayAction(action).catch((error: Error) => log(`Tray action ${action} failed: ${error.message}`));
      });
      tray.on('error', (error: Error) => log(`Tray: ${error.message}`));
      tray.start();
      refreshTray();
      void refreshStartup();
    } else {
      log('No tray host in this build; running without a tray icon.');
    }

    // The installed app starts with Windows unless the user said otherwise.
    // Done once, so turning it off from the tray sticks across updates.
    if (isSea() && isInstalledCopy() && !readAppState(dataDir).startupConfigured) {
      await setStartWithWindows(true).catch((error: Error) => log(`Could not register startup: ${error.message}`));
      updateAppState(dataDir, { startupConfigured: true });
      void refreshStartup();
    }
  }

  // ── The print server child ────────────────────────────────────────────────
  function startChild(): void {
    if (quitting || child) return;
    const args = isSea() ? ['--server'] : [process.argv[1], '--server'];
    const proc = spawn(process.execPath, args, {
      cwd: dataDir,
      env: { ...process.env, TB_MODE: mode, TB_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    });
    child = proc;
    childStartedAt = Date.now();
    log(`Started the print server (pid ${proc.pid}).`);

    proc.stdout?.pipe(consoleStream, { end: false });
    proc.stderr?.pipe(consoleStream, { end: false });

    proc.on('error', (error) => {
      log(`Could not run the print server: ${error.message}`);
      // A process that never spawned emits no 'exit'; retry on the backoff.
      if (proc.pid === undefined && child === proc) {
        child = null;
        setTimeout(startChild, RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1]);
      }
    });

    proc.on('message', (raw: unknown) => {
      const msg = raw as ChildMessage;
      if (msg?.type === 'ready' || msg?.type === 'status') {
        port = msg.port ?? port;
        printers = msg.printers ?? printers;
        refreshTray();
        if (msg.type === 'ready') {
          log(`Print server ready on port ${port}.`);
          if (openWhenReady) {
            openWhenReady = false;
            openDashboard();
          }
        }
      } else if (msg?.type === 'testPrintResult') {
        tray?.notify(PRODUCT_NAME, msg.ok ? 'Test page sent to the printer.' : msg.message ?? 'The test page could not be sent.');
      } else if (msg?.type === 'startupChanged') {
        void refreshStartup();
      }
    });

    proc.on('exit', (code, signal) => {
      child = null;
      port = null;
      if (quitting) return;

      const ranFor = Date.now() - childStartedAt;
      if (ranFor > STABLE_RUN_MS) failures = 0;
      const delay = RESTART_BACKOFF_MS[Math.min(failures, RESTART_BACKOFF_MS.length - 1)];
      failures++;
      log(`Print server exited (code ${code}${signal ? `, signal ${signal}` : ''}) after ${Math.round(ranFor / 1000)}s; restarting in ${delay / 1000}s.`);
      tray?.setTooltip(`${PRODUCT_NAME} · Restarting…`);
      tray?.setHeader('Restarting the print server…');
      setTimeout(startChild, delay);
    });
  }

  // ── Stand aside for a machine-wide service ────────────────────────────────
  async function lookForService(): Promise<RunningService | undefined> {
    return machineWideService(await findRunningServices());
  }

  let misses = 0;
  async function deferLoop(): Promise<void> {
    if (quitting || !deferredTo) return;
    const other = await lookForService();
    if (other) {
      deferredTo = other;
      misses = 0;
    } else if (++misses >= DEFER_TAKEOVER_MISSES) {
      log(`The installed service stopped answering ${misses} times in a row; taking over printing.`);
      deferredTo = null;
      refreshTray();
      startChild();
      return;
    }
    setTimeout(() => void deferLoop(), DEFER_RECHECK_MS);
  }

  // A service install wins over this per-user app; a service never defers to
  // a per-user app, but does stand aside for the old XP Thermal Print Service.
  const existing = await lookForService();
  const shouldDefer = existing && (mode === 'user' || existing.legacy);
  if (shouldDefer) {
    deferredTo = existing;
    const what = existing.legacy ? 'the older XP Thermal Print Service' : 'the installed Thermal Bridge service';
    log(`Printing is already handled by ${what} on port ${existing.port}; not starting a second server.`);
    refreshTray();
    if (!background) {
      tray?.notify(PRODUCT_NAME, 'Printing is already handled by the installed service.');
    }
    openWhenReady = false;
    setTimeout(() => void deferLoop(), DEFER_RECHECK_MS);
  } else {
    startChild();
  }

  // ── Quitting ───────────────────────────────────────────────────────────────
  async function quit(reason: string): Promise<void> {
    if (quitting) return;
    quitting = true;
    log(`Quitting: ${reason}.`);
    tray?.close();

    const proc = child;
    if (proc) {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      try {
        proc.send('shutdown');
      } catch {
        proc.kill();
      }
      // The server drains in-flight receipts first; it gives itself 15s.
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20000))
      ]);
      if (timedOut) {
        log('The print server did not exit in time; stopping it.');
        proc.kill();
      }
    }

    pipe?.close();
    consoleStream.end();
    setTimeout(() => process.exit(0), 200);
  }

  // Service mode: ThermalBridgeService.exe closes our stdin when Windows asks
  // the service to stop. (In user mode there is no stdin to watch.)
  if (mode === 'service') {
    process.stdin.on('end', () => void quit('the service is stopping'));
    process.stdin.on('close', () => void quit('the service is stopping'));
    process.stdin.resume();
  }

  process.on('SIGINT', () => void quit('SIGINT'));
  process.on('SIGTERM', () => void quit('SIGTERM'));
  // The supervisor holds no print state, so an unexpected error is logged and
  // survived: exiting would take the print server and the tray down with it.
  process.on('uncaughtException', (error) => {
    log(`Supervisor error: ${error.stack ?? error.message}`);
  });
}
