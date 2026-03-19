/**
 * Test Template
 * Comprehensive printer test with all formatting features.
 * Uses simple fixed-column padding for guaranteed single-line alignment.
 */

import { TemplateRenderer } from './engine';
import { PrinterCapabilities, TestPayload } from '../types';
import { EscPosBuilder } from '../escpos/builder';
import { LayoutCalculator } from './layout-utils';

export class TestTemplate implements TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer {
    const data = (payload || {}) as TestPayload;
    const builder = EscPosBuilder.create(capabilities);
    const W = capabilities.maxWidth;
    const L = new LayoutCalculator(W);

    const lv = (label: string, value: string) => {
      for (const ln of L.labelValue(label, value)) builder.line(ln);
    };

    // === HEADER (hardware center) ===
    builder.align(1);
    builder.fontSize(3).bold(true);
    builder.line('PRINTER TEST');
    builder.fontSize(0).bold(false);
    builder.newline();

    builder.align(0);
    builder.line(L.doubleDivider());
    builder.newline();

    // === PRINTER INFO ===
    builder.line(`Printer Width: ${W} characters`);
    builder.line(`Time: ${new Date().toLocaleString()}`);
    builder.newline();

    // === CUSTOM MESSAGE ===
    if (data.message) {
      builder.line('Message:');
      for (const ln of L.wordWrap(data.message)) builder.line(ln);
      builder.newline();
    }

    // === FONT TESTS ===
    if (data.includeAllFonts) {
      builder.line(L.divider());
      builder.line('Font Tests:');
      builder.newline();

      builder.line('Normal text');
      builder.bold(true).line('Bold text'); builder.bold(false);
      builder.underline(true).line('Underlined text'); builder.underline(false);
      builder.inverse(true).line('Inverse text'); builder.inverse(false);
      builder.newline();

      builder.fontSize(1).line('Double Width'); builder.fontSize(0);
      builder.fontSize(2).line('Double Height'); builder.fontSize(0);
      builder.fontSize(3).line('Double Both'); builder.fontSize(0);
      builder.newline();
    }

    // === ALIGNMENT TEST ===
    builder.line(L.divider());
    builder.line('Alignment Test:');
    builder.align(0).line('Left aligned');
    builder.align(1).line('Center aligned');
    builder.align(2).line('Right aligned');
    builder.align(0);
    builder.newline();

    // === COLUMN TEST ===
    builder.line(L.divider());
    builder.line('Column Layout Test:');

    // Label-value test
    lv('Label', 'Value on Right');

    // Three-column item test
    builder.line(L.itemsHeader('Item', 'Qty', 'Amount'));
    for (const ln of L.itemRow('Item Name', '2', '$19.99')) builder.line(ln);

    // Wrap test
    lv('Long Label', 'This value is intentionally very long to test wrapping behavior');

    builder.newline();

    // === CHARACTER TEST ===
    builder.line(L.divider());
    builder.line('Character Test:');
    builder.line('0123456789');
    builder.line('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    builder.line('abcdefghijklmnopqrstuvwxyz');
    builder.line('!@#$%^&*()_+-=[]{}|;:,.<>?');
    builder.newline();

    // === WIDTH VERIFICATION ===
    builder.line(L.divider());
    builder.line('Width Verification:');
    builder.line('|' + '-'.repeat(W - 2) + '|');
    const msg = `<-- ${W} chars -->`;
    builder.line('|' + msg.padStart(Math.floor((W - 2 + msg.length) / 2)).padEnd(W - 2) + '|');
    builder.line('|' + '-'.repeat(W - 2) + '|');
    builder.newline();

    // === BARCODE TEST ===
    if (data.includeBarcode && capabilities.supportsBarcode) {
      builder.line(L.divider());
      builder.line('Barcode Test:');
      builder.align(1);
      builder.barcode('123456789012', {
        type: 73, // CODE128
        width: 2,
        height: 60,
        position: 'below'
      });
      builder.align(0);
      builder.newline();
    }

    // === QR CODE TEST ===
    if (data.includeQR && capabilities.supportsQRCode) {
      builder.line(L.divider());
      builder.line('QR Code Test:');
      builder.align(1);
      builder.qrCode('https://example.com/test', {
        moduleSize: 4
      });
      builder.align(0);
      builder.newline();
    }

    // === FOOTER ===
    builder.line(L.doubleDivider());
    builder.align(1);
    builder.bold(true);
    builder.line('TEST COMPLETE');
    builder.bold(false);
    builder.newline();

    builder.font('B');
    builder.line('Powered By XenithPulse.com');
    builder.font('A');
    builder.newline();

    builder.feedAndCut(4);
    return builder.build();
  }

  validate(_payload: Record<string, unknown>): boolean {
    return true;
  }
}
