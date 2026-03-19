/**
 * KOT Template (Kitchen Order Ticket)
 * Uses simple fixed-column padding for guaranteed single-line alignment.
 */

import { TemplateRenderer } from './engine';
import { PrinterCapabilities, KOTPayload } from '../types';
import { EscPosBuilder } from '../escpos/builder';
import { LayoutCalculator } from './layout-utils';

export class KOTTemplate implements TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer {
    const data = payload as unknown as KOTPayload;
    const builder = EscPosBuilder.create(capabilities);
    const W = capabilities.maxWidth;
    const L = new LayoutCalculator(W);

    /** shorthand: print all lines from a label-value pair */
    const lv = (label: string, value: string) => {
      for (const ln of L.labelValue(label, value)) builder.line(ln);
    };

    // === KOT HEADER (centered via hardware) ===
    builder.align(1);
    builder.bold(true).fontSize(3);

    if (data.isVoid) {
      builder.line('*** VOID ***');
    } else if (data.isReprint) {
      builder.line('** REPRINT **');
    }

    builder.line('KITCHEN ORDER');
    builder.fontSize(0).bold(false);
    builder.newline();

    // === ORDER INFO ===
    builder.align(0);
    builder.line(L.divider());

    builder.bold(true).fontSize(1);
    lv('Order', `#${data.orderNumber}`);
    builder.fontSize(0).bold(false);

    lv('Time', data.orderTime);

    if (data.tableName) {
      builder.bold(true);
      lv('Table', data.tableName);
      builder.bold(false);
    }

    if (data.serverName) lv('Server', data.serverName);
    if (data.category) lv('Category', data.category.toUpperCase());

    builder.line(L.divider());
    builder.newline();

    // === ITEMS (large & bold for kitchen readability) ===
    builder.align(0);
    for (const item of data.items) {
      builder.bold(true).fontSize(1);

      const itemText = item.isVoid
        ? `${item.quantity}x ${item.name} [VOID]`
        : `${item.quantity}x ${item.name}`;

      // Double-width font halves available columns
      const maxItemWidth = Math.floor(W / 2);
      for (const ln of L.wordWrap(itemText, maxItemWidth)) builder.line(ln);

      builder.fontSize(0).bold(false);

      // Modifiers
      if (item.modifiers?.length) {
        for (const mod of item.modifiers) {
          for (const ln of L.indented(mod, 3, '+')) builder.line(ln);
        }
      }

      // Item notes
      if (item.notes) {
        builder.bold(true);
        for (const ln of L.indented(item.notes, 3, '**')) builder.line(ln);
        builder.bold(false);
      }

      builder.newline();
    }

    // === ORDER NOTES ===
    if (data.notes) {
      builder.line(L.divider());
      builder.bold(true);
      builder.line('NOTES:');
      builder.bold(false);
      for (const ln of L.wordWrap(data.notes)) builder.line(ln);
      builder.newline();
    }

    builder.line(L.divider());

    // === FOOTER ===
    builder.align(1);
    builder.font('B');
    builder.line('Powered By XenithPulse.com');
    builder.font('A');
    builder.newline();

    builder.feedAndCut(3);
    return builder.build();
  }

  validate(payload: Record<string, unknown>): boolean {
    const data = payload as Partial<KOTPayload>;
    return !!(
      data.orderNumber &&
      data.orderTime &&
      Array.isArray(data.items) &&
      data.items.length > 0
    );
  }
}
