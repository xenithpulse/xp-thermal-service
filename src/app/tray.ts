/**
 * The system tray icon.
 *
 * Drawn by ThermalBridgeTray.exe, a ~15 KB WinForms NotifyIcon host compiled
 * from helpers/TrayHost.cs and embedded in the exe. It speaks one line per
 * message over stdin/stdout, so it holds no logic of its own: when this process
 * exits its stdin closes and the icon disappears with it, never orphaned.
 *
 *   to tray:   header<TAB>text      tooltip<TAB>text      startup<TAB>1|0
 *              printers<TAB>name|1<TAB>name|0             notify<TAB>title<TAB>text
 *   from tray: open  test  printers  startup  logs  updates  quit
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as readline from 'readline';

export type TrayAction = 'open' | 'test' | 'printers' | 'startup' | 'logs' | 'updates' | 'quit';

const ACTIONS: readonly string[] = ['open', 'test', 'printers', 'startup', 'logs', 'updates', 'quit'];

/** Tabs and newlines are the protocol's separators; nothing else needs escaping. */
function clean(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').trim();
}

export class Tray extends EventEmitter {
  private proc: ChildProcess | null = null;
  private closing = false;
  private crashes = 0;
  /** Last value per message kind, replayed if the tray host has to restart. */
  private readonly lastSent = new Map<string, string>();

  constructor(private readonly hostExe: string, private readonly iconPath: string) {
    super();
  }

  start(): void {
    if (this.proc || this.closing) return;
    const proc = spawn(this.hostExe, [this.iconPath], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc = proc;

    readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
      const action = line.trim();
      if (ACTIONS.includes(action)) this.emit('action', action as TrayAction);
    });
    proc.stdin!.on('error', () => undefined);
    proc.on('error', (error) => this.emit('error', error));
    proc.on('exit', () => {
      this.proc = null;
      if (this.closing) return;
      // Explorer restarting or a one-off crash should not cost the icon, but a
      // host that cannot start at all must not be respawned forever.
      if (++this.crashes <= 3) {
        setTimeout(() => this.start(), 2000 * this.crashes);
      } else {
        this.emit('error', new Error('The tray icon host keeps exiting; running without a tray icon.'));
      }
    });

    for (const line of this.lastSent.values()) this.write(line);
  }

  private write(line: string): void {
    try {
      this.proc?.stdin?.write(`${line}\n`);
    } catch {
      // Host is going away; the exit handler deals with it.
    }
  }

  private send(kind: string, ...fields: string[]): void {
    const line = [kind, ...fields.map(clean)].join('\t');
    if (kind !== 'notify') this.lastSent.set(kind, line);
    this.write(line);
  }

  setHeader(text: string): void {
    this.send('header', text);
  }

  setTooltip(text: string): void {
    this.send('tooltip', text);
  }

  setStartup(enabled: boolean): void {
    this.send('startup', enabled ? '1' : '0');
  }

  setPrinters(printers: Array<{ name: string; online: boolean }>): void {
    this.send('printers', ...printers.map((p) => `${clean(p.name).replace(/\|/g, '/')}|${p.online ? 1 : 0}`));
  }

  notify(title: string, text: string): void {
    this.send('notify', title, text);
  }

  close(): void {
    this.closing = true;
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      // Already closed.
    }
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
    }, 2000).unref();
  }
}
