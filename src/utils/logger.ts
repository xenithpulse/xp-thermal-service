/**
 * Logger Utility
 * Production-grade logging with Pino
 *
 * Streams are in-process rather than pino transports. Transports run in a
 * worker thread that loads its target module by file path, which cannot work
 * from a single bundled executable. Log volume here is a few lines per print
 * job, so writing synchronously on the main thread costs nothing measurable and
 * means a crash never loses the line that explains it.
 */

import pino, { Logger as PinoLogger, LoggerOptions } from 'pino';
import pretty from 'pino-pretty';
import * as fs from 'fs';
import * as path from 'path';
import { LoggingConfig } from '../types';

export type Logger = PinoLogger;

function prettyStream() {
  return pretty({
    colorize: !!process.stdout.isTTY,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
    destination: process.stdout,
    sync: true
  });
}

export function createLogger(config: LoggingConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
      bindings: () => ({})
    }
  };

  const streams: pino.StreamEntry[] = [];

  if (config.console) {
    streams.push({ level: config.level, stream: prettyStream() });
  }

  if (config.file) {
    const logDir = path.dirname(config.file);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    streams.push({
      level: config.level,
      stream: pino.destination({ dest: config.file, mkdir: true, sync: true })
    });
  }

  if (streams.length === 0) {
    return pino(options);
  }

  return pino(options, pino.multistream(streams));
}

/**
 * Create a child logger with additional context
 */
export function createChildLogger(parent: Logger, context: Record<string, unknown>): Logger {
  return parent.child(context);
}

/**
 * Default logger (for use before configuration is loaded)
 */
export const defaultLogger = pino({ level: 'info' }, prettyStream());

export default createLogger;
