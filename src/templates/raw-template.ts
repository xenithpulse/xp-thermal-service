/**
 * Raw Template
 * Passes through raw ESC/POS commands directly to the printer
 */

import { TemplateRenderer } from './engine';
import { PrinterCapabilities, RawPayload } from '../types';

export class RawTemplate implements TemplateRenderer {
  render(payload: Record<string, unknown>, _capabilities: PrinterCapabilities): Buffer {
    const data = payload as unknown as RawPayload;

    // Handle different input formats based on encoding
    if (data.commands) {
      // Direct Buffer
      if (Buffer.isBuffer(data.commands)) {
        return data.commands;
      }

      // Number array (raw bytes)
      if (Array.isArray(data.commands)) {
        return Buffer.from(data.commands);
      }

      // String with encoding
      if (typeof data.commands === 'string') {
        switch (data.encoding) {
          case 'hex':
            return Buffer.from(data.commands.replace(/\s/g, ''), 'hex');
          case 'base64':
            return Buffer.from(data.commands, 'base64');
          case 'raw':
          default:
            // Assume base64 if no encoding specified for string input
            return Buffer.from(data.commands, 'base64');
        }
      }
    }

    // Empty buffer if no valid commands
    return Buffer.alloc(0);
  }

  validate(payload: Record<string, unknown>): boolean {
    const data = payload as Partial<RawPayload>;
    return !!data.commands;
  }
}
