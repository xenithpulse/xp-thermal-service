/**
 * Invoice Template
 * Uses simple fixed-column padding for guaranteed single-line alignment.
 */

import { TemplateRenderer } from './engine';
import { PrinterCapabilities, InvoicePayload } from '../types';
import { EscPosBuilder, EscPosUtils } from '../escpos/builder';
import { LayoutCalculator } from './layout-utils';

export class InvoiceTemplate implements TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer {
    const data = payload as unknown as InvoicePayload;
    const builder = EscPosBuilder.create(capabilities);
    const W = capabilities.maxWidth;
    const L = new LayoutCalculator(W);

    /** shorthand: print all lines from a label-value pair */
    const lv = (label: string, value: string) => {
      for (const ln of L.labelValue(label, value)) builder.line(ln);
    };

    // === HEADER (centered via hardware) ===
    if (data.header) {
      builder.align(1);

      if (data.header.storeName) {
        builder.fontSize(1).bold(true);
        builder.line(data.header.storeName);
        builder.fontSize(0).bold(false);
      }

      if (data.header.storeAddress) {
        builder.align(0);
        for (const addr of data.header.storeAddress) {
          for (const ln of L.wordWrap(addr)) builder.line(ln);
        }
        builder.align(1);
      }

      if (data.header.storePhone) builder.line(`Tel: ${data.header.storePhone}`);
      if (data.header.taxId) builder.line(`Tax ID: ${data.header.taxId}`);
      builder.newline();
    }

    // === INVOICE TITLE ===
    builder.align(1);
    builder.bold(true);
    builder.line('INVOICE');
    builder.bold(false);
    builder.newline();

    // === INVOICE DETAILS ===
    builder.align(0);
    builder.line(L.divider());

    lv('Invoice #', data.invoiceNumber);
    lv('Date', data.invoiceDate);
    if (data.dueDate) lv('Due Date', data.dueDate);

    builder.line(L.divider());
    builder.newline();

    // === BILL TO ===
    builder.bold(true);
    builder.line('Bill To:');
    builder.bold(false);

    for (const ln of L.wordWrap(data.customer.name)) builder.line(ln);
    if (data.customer.address) {
      for (const addr of data.customer.address) {
        for (const ln of L.wordWrap(addr)) builder.line(ln);
      }
    }
    if (data.customer.phone) builder.line(`Tel: ${data.customer.phone}`);
    if (data.customer.taxId) builder.line(`Tax ID: ${data.customer.taxId}`);

    builder.newline();
    builder.line(L.divider());

    // === ITEMS HEADER ===
    builder.bold(true);
    builder.line(L.itemsHeader('Description', 'Qty', 'Amount'));
    builder.bold(false);
    builder.line(L.divider());

    // === ITEMS ===
    for (const item of data.items) {
      for (const ln of L.itemRow(
        item.description,
        item.quantity.toString(),
        EscPosUtils.formatCurrency(item.total)
      )) builder.line(ln);
      // Unit price detail
      for (const ln of L.indented(
        `${item.quantity} x ${EscPosUtils.formatCurrency(item.unitPrice)}`, 2
      )) builder.line(ln);

      if (item.sku) builder.line(`  SKU: ${item.sku}`);
    }

    builder.line(L.divider());

    // === TOTALS ===
    builder.line(L.totalsRow('Subtotal:', EscPosUtils.formatCurrency(data.subtotal)));

    if (data.discount && data.discount > 0) {
      builder.line(L.totalsRow('Discount:', `-${EscPosUtils.formatCurrency(data.discount)}`));
    }
    if (data.tax !== undefined && data.tax > 0) {
      const taxLabel = data.taxRate ? `Tax (${data.taxRate}%):` : 'Tax:';
      builder.line(L.totalsRow(taxLabel, EscPosUtils.formatCurrency(data.tax)));
    }

    builder.line(L.divider());

    // Total — bold
    builder.bold(true);
    builder.line(L.totalsRow('TOTAL DUE:', EscPosUtils.formatCurrency(data.total)));
    builder.bold(false);

    builder.line(L.divider());
    builder.newline();

    // === NOTES & TERMS ===
    if (data.notes) {
      builder.line('Notes:');
      for (const ln of L.wordWrap(data.notes)) builder.line(ln);
      builder.newline();
    }
    if (data.terms) {
      builder.line('Terms:');
      for (const ln of L.wordWrap(data.terms)) builder.line(ln);
      builder.newline();
    }

    // === FOOTER ===
    builder.align(1);
    builder.newline();

    builder.line('Powered By XenithPulse.com');
    builder.font('A');
    builder.newline();

    builder.feedAndCut(4);
    return builder.build();
  }

  validate(payload: Record<string, unknown>): boolean {
    const data = payload as Partial<InvoicePayload>;
    return !!(
      data.invoiceNumber &&
      data.invoiceDate &&
      data.customer?.name &&
      Array.isArray(data.items) &&
      data.items.length > 0 &&
      typeof data.subtotal === 'number' &&
      typeof data.total === 'number'
    );
  }
}
