/**
 * Logger Utility
 * Production-grade logging with Pino
 */

import pino, { Logger as PinoLogger, LoggerOptions } from 'pino';
import * as fs from 'fs';
import * as path from 'path';
import { LoggingConfig } from '../types';

export type Logger = PinoLogger;

export function createLogger(config: LoggingConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
      bindings: () => ({})
    }
  };

  // Determine transport targets
  const targets: pino.TransportTargetOptions[] = [];

  // Console transport (pretty print in development)
  if (config.console) {
    targets.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      },
      level: config.level
    });
  }

  // File transport
  if (config.file) {
    // Ensure log directory exists
    const logDir = path.dirname(config.file);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    targets.push({
      target: 'pino/file',
      options: {
        destination: config.file,
        mkdir: true
      },
      level: config.level
    });
  }

  // Use transport if we have targets, otherwise plain pino
  if (targets.length > 0) {
    return pino(options, pino.transport({ targets }));
  }

  return pino(options);
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
export const defaultLogger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard'
    }
  }
});

export default createLogger;
