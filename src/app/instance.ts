/**
 * Single instance, via a named pipe.
 *
 * Listening on a pipe is atomic and Windows releases it the moment the process
 * dies, so unlike a lock file it can never be left behind by a crash or a power
 * cut. It is also the channel a second launch uses: "open" brings up the
 * dashboard of the copy already running, and "quit" (sent by the installer
 * before it replaces files) asks it to stop.
 *
 * Pipes are machine-wide, so the name carries a hash of the user, letting two
 * people signed in to the same PC each run their own copy.
 */

import { createHash } from 'crypto';
import * as net from 'net';
import * as os from 'os';
import { AppMode } from './paths';

export function pipeName(mode: AppMode): string {
  const owner = mode === 'service' ? 'service' : createHash('sha256')
    .update(`${os.userInfo().username}|${process.env.LOCALAPPDATA ?? os.homedir()}`)
    .digest('hex')
    .slice(0, 16);
  return `\\\\.\\pipe\\ThermalBridge-${owner}`;
}

/**
 * Become the running instance. Resolves to the server when this process owns
 * the pipe, or null when another instance already does.
 */
export function claimInstance(
  name: string,
  onCommand: (command: string) => string | void
): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          let reply: string | void = 'ok';
          try {
            reply = onCommand(line) ?? 'ok';
          } catch (error) {
            reply = `error ${(error as Error).message}`;
          }
          socket.write(`${reply}\n`);
        }
      });
      socket.on('error', () => undefined);
    });
    server.once('error', () => resolve(null));
    server.listen(name, () => resolve(server));
  });
}

/** Send one command to the running instance; null when nothing is listening. */
export function sendCommand(name: string, command: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect(name);
    let reply = '';
    const done = (value: string | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(reply || null), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk: string) => {
      reply += chunk;
      if (reply.includes('\n')) done(reply.trim());
    });
    socket.on('error', () => done(null));
  });
}

/** Wait until no instance is listening (it has exited), up to timeoutMs. */
export async function waitForExit(name: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await sendCommand(name, 'ping', 1000)) === null) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
