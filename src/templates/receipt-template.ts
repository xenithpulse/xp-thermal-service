/**
 * Receipt Template
 * Uses simple fixed-column padding approach for guaranteed single-line alignment.
 * Mirrors the proven layout pattern from generateEscPosReceipt.
 */

import { TemplateRenderer } from './engine';
import { PrinterCapabilities, ReceiptPayload } from '../types';
import { EscPosBuilder, EscPosUtils } from '../escpos/builder';
import { LayoutCalculator } from './layout-utils';

export class ReceiptTemplate implements TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer {
    const data = payload as unknown as ReceiptPayload;
    const builder = EscPosBuilder.create(capabilities);
    const W = capabilities.maxWidth;
    const L = new LayoutCalculator(W);

    // === STORE HEADER (centered via hardware) ===
    if (data.header) {
      builder.align(1); // hardware center

      if (data.header.storeName) {
        builder.fontSize(1).bold(true);
        builder.line(data.header.storeName);
        builder.fontSize(0).bold(false);
      }

      if (data.header.storePhone) {
        builder.line(data.header.storePhone);
      }

      builder.newline();

      // Address lines left-aligned
      builder.align(0);
      if (data.header.storeAddress) {
        for (const addr of data.header.storeAddress) {
          for (const ln of L.wordWrap(addr)) builder.line(ln);
        }
      }
      if (data.header.taxId) {
        builder.line(`Tax ID: ${data.header.taxId}`);
      }
    }

    builder.align(0);
    builder.line(L.divider());

    // === ORDER INFO (label:value rows) ===
    const lv = (label: string, value: string) => {
      for (const ln of L.labelValue(label, value)) builder.line(ln);
    };

    builder.bold(true);
    lv('Order', `#${data.orderNumber}`);
    builder.bold(false);

    lv('Date', data.orderDate);
    if (data.orderTime) lv('Time', data.orderTime);
    if (data.tableName) lv('Table', data.tableName);
    if (data.serverName) lv('Server', data.serverName);
    if (data.customerName) lv('Customer', data.customerName);

    builder.line(L.divider());

    // === ITEMS HEADER ===
    builder.bold(true);
    builder.line(L.itemsHeader('Item', 'Qty', 'Amount'));
    builder.bold(false);
    builder.line(L.divider());

    // === ITEMS ===
    for (const item of data.items) {
      for (const ln of L.itemRow(
        item.name,
        item.quantity.toString(),
        EscPosUtils.formatCurrency(item.total)
      )) builder.line(ln);

      if (item.modifiers?.length) {
        for (const mod of item.modifiers) {
          for (const ln of L.indented(mod, 2, '+')) builder.line(ln);
        }
      }
      if (item.notes) {
        for (const ln of L.indented(item.notes, 2, '*')) builder.line(ln);
      }
    }

    builder.line(L.divider());

    // === TOTALS ===
    builder.line(L.totalsRow('Subtotal:', EscPosUtils.formatCurrency(data.subtotal)));

    if (data.discount && data.discount > 0) {
      const discLabel = data.discountName ? `Discount (${data.discountName}):` : 'Discount:';
      builder.line(L.totalsRow(discLabel, `-${EscPosUtils.formatCurrency(data.discount)}`));
    }

    if (data.tax !== undefined && data.tax > 0) {
      const taxLabel = data.taxRate ? `Tax (${data.taxRate}%):` : 'Tax:';
      builder.line(L.totalsRow(taxLabel, EscPosUtils.formatCurrency(data.tax)));
    }

    builder.line(L.divider());

    // Total — bold + large
    builder.bold(true);
    builder.line(L.totalsRow('TOTAL:', EscPosUtils.formatCurrency(data.total)));
    builder.bold(false);

    builder.line(L.divider());

    // === PAYMENT ===
    if (data.paymentMethod) {
      builder.line(L.totalsRow('Payment:', data.paymentMethod));
    }
    if (data.amountPaid !== undefined) {
      builder.line(L.totalsRow('Amount Paid:', EscPosUtils.formatCurrency(data.amountPaid)));
    }
    if (data.change !== undefined && data.change > 0) {
      builder.line(L.totalsRow('Return Amount:', EscPosUtils.formatCurrency(data.change)));
    }

    builder.line(L.divider());

    // === BARCODE / QR ===
    if (data.barcode && capabilities.supportsBarcode) {
      builder.align(1);
      builder.barcode(data.barcode, { type: 73, width: 2, height: 60, position: 'below' });
      builder.newline();
    }
    if (data.qrCode && capabilities.supportsQRCode) {
      builder.align(1);
      builder.qrCode(data.qrCode, { moduleSize: 4, errorCorrection: 49 });
      builder.newline();
    }

    // === FOOTER (centered via hardware) ===
    builder.align(1);
    if (data.footer) {
      if (data.footer.message) {
        for (const msg of data.footer.message) {
          for (const ln of L.wordWrap(msg)) builder.line(ln);
        }
      }
      builder.newline();
    }

    builder.line('Powered By XenithPulse.com');
    builder.newline();

    builder.feedAndCut(4);
    return builder.build();
  }

  validate(payload: Record<string, unknown>): boolean {
    const data = payload as Partial<ReceiptPayload>;
    return !!(
      data.orderNumber &&
      data.orderDate &&
      Array.isArray(data.items) &&
      data.items.length > 0 &&
      typeof data.subtotal === 'number' &&
      typeof data.total === 'number'
    );
  }
}
