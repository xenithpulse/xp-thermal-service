/**
 * Receipt Template — tenant-configurable (4 variants + field toggles + currency + QR + logo).
 *
 * ⚠️  MUST STAY IN SYNC WITH  xp-pos/pos_modules/orders/printing-facility/receiptLayout.ts
 *     The layout engine below (Layout class, formatMoney, PRESETS, buildLines)
 *     is a byte-for-byte port of the POS module so the POS live preview matches
 *     what this template prints. Change one → change both.
 *
 * The POS sends `payload.options` (ReceiptRenderOptions). This template builds
 * the same StyledLine[] the preview builds, then emits them via the ESC/POS
 * builder (hardware alignment/bold/size, raster logo, QR).
 */

import * as QRCode from 'qrcode';
import { TemplateRenderer } from './engine';
import {
  PrinterCapabilities,
  ReceiptPayload,
  ReceiptRenderOptions,
  ReceiptTemplateId,
  TextAlign,
  FontSize,
  QRErrorCorrection,
} from '../types';
import { EscPosBuilder } from '../escpos/builder';

/**
 * Render a QR string to a 1-bit raster (same packed format as the logo) so it
 * can be printed via GS v 0. Native QR (GS ( k) isn't supported on all firmware
 * — it prints the raw link as text — but raster graphics are, so we draw the QR
 * ourselves. `scale` = dots per module, `quiet` = white border in modules.
 */
function qrToRaster(text: string, scale = 5, quiet = 3): { data: string; width: number; height: number } | null {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const dim = (size + quiet * 2) * scale;
    const bytesPerRow = Math.ceil(dim / 8);
    const out = new Uint8Array(bytesPerRow * dim);
    for (let y = 0; y < dim; y++) {
      const my = Math.floor(y / scale) - quiet;
      for (let x = 0; x < dim; x++) {
        const mx = Math.floor(x / scale) - quiet;
        const dark = my >= 0 && my < size && mx >= 0 && mx < size && qr.modules.get(my, mx) === 1;
        if (dark) out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { data: Buffer.from(out).toString('base64'), width: dim, height: dim };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared line model
// ─────────────────────────────────────────────────────────────────────────────

interface StyledLine {
  text: string;
  align: 'l' | 'c' | 'r';
  bold?: boolean;
  size?: 'normal' | 'large';
  kind?: 'text' | 'divider' | 'logo' | 'qr' | 'blank';
}

interface LayoutData {
  storeName: string;
  address: string[];
  phone?: string;
  email?: string;
  website?: string;
  taxId?: string;
  orderNumber: string;
  date: string;
  time: string;
  table?: string;
  server?: string;
  customer?: string;
  orderMode?: string;
  items: { name: string; quantity: number; unitPrice: number; total: number; modifiers?: string[]; notes?: string }[];
  subtotal: number;
  discount?: number;
  discountName?: string;
  tax?: number;
  taxRate?: number;
  taxLabel?: string;
  serviceCharge?: number;
  serviceChargeName?: string;
  tip?: number;
  adjustments?: { name: string; amount: number; isDeduction: boolean }[];
  total: number;
  paymentMethod?: string;
  amountPaid?: number;
  change?: number;
  /**
   * Every payment taken on this order. `label` is the tenant's own method name
   * so a custom method survives onto the receipt. Only used when there is more
   * than one — a single-method order prints exactly as it always has.
   */
  payments?: { label: string; amount: number }[];
  footerMessage?: string;
  hasLogo?: boolean;
  qrValue?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Currency + column math (ported from POS receiptLayout.ts)
// ─────────────────────────────────────────────────────────────────────────────

function formatMoney(amount: number, c: ReceiptRenderOptions['currency']): string {
  // Round to the currency's precision, then drop trailing zeros:
  // 5 → "5", 5.50 → "5.5", 5.00 → "5". (No forced ".00".)
  const rounded = Number((Number.isFinite(amount) ? amount : 0).toFixed(c.decimals));
  const n = String(rounded);
  return c.position === 'after' ? `${n} ${c.symbol}` : `${c.symbol}${n}`;
}

const rpad = (s: string, w: number): string => (s.length >= w ? s.substring(0, w) : s + ' '.repeat(w - s.length));
const lpad = (s: string, w: number): string => (s.length >= w ? s.substring(s.length - w) : ' '.repeat(w - s.length) + s);

class Layout {
  readonly width: number;
  readonly labelWidth: number;
  readonly qtyColW = 3;
  readonly amtColW: number;

  constructor(width: number) {
    this.width = width;
    this.labelWidth = Math.min(14, Math.max(8, Math.floor(width * 0.25)));
    this.amtColW = Math.min(12, Math.max(8, Math.ceil(width * 0.2)));
  }

  private clip(s: string): string {
    return s.length > this.width ? s.substring(0, this.width) : s;
  }

  divider(char = '-'): string {
    return char.repeat(this.width);
  }

  labelValue(label: string, value: string): string[] {
    const prefix = rpad(label, this.labelWidth) + ': ';
    const valueSpace = this.width - prefix.length;
    if (valueSpace <= 0) return [this.clip(label), this.clip(value)];
    if (value.length <= valueSpace) return [this.clip(prefix + value)];
    const lines = this.wordWrap(value, valueSpace);
    const indent = ' '.repeat(prefix.length);
    return [this.clip(prefix + lines[0]), ...lines.slice(1).map((l) => this.clip(indent + l))];
  }

  totalsRow(label: string, value: string): string {
    const gap = this.width - label.length - value.length;
    if (gap >= 1) return this.clip(label + ' '.repeat(gap) + value);
    const maxLabel = this.width - value.length - 1;
    if (maxLabel <= 0) return this.clip(value);
    return this.clip(label.substring(0, maxLabel) + ' ' + value);
  }

  itemsHeader(col1 = 'ITEM', col2 = 'QTY', col3 = 'AMT'): string {
    const right = ' ' + lpad(col2, this.qtyColW) + '  ' + lpad(col3, this.amtColW);
    const nameW = Math.max(1, this.width - right.length);
    return this.clip(rpad(col1, nameW) + right);
  }

  itemRow(name: string, qty: string, amount: string): string[] {
    const usedAmtW = Math.max(this.amtColW, amount.length);
    const usedQtyW = Math.max(this.qtyColW, qty.length);
    const right = ' ' + lpad(qty, usedQtyW) + '  ' + lpad(amount, usedAmtW);
    const nameW = Math.max(1, this.width - right.length);
    if (name.length <= nameW) return [this.clip(rpad(name, nameW) + right)];
    const nameLines = this.wordWrap(name, nameW);
    const first = this.clip(rpad(nameLines[0], nameW) + right);
    const rest = nameLines.slice(1).map((l) => this.clip('  ' + l));
    return [first, ...rest];
  }

  nameAmountRow(name: string, amount: string): string[] {
    const usedAmtW = Math.max(this.amtColW, amount.length);
    const right = '  ' + lpad(amount, usedAmtW);
    const nameW = Math.max(1, this.width - right.length);
    if (name.length <= nameW) return [rpad(name, nameW) + right];
    const nameLines = this.wordWrap(name, nameW);
    return [rpad(nameLines[0], nameW) + right, ...nameLines.slice(1).map((l) => '  ' + l)];
  }

  wordWrap(text: string, maxWidth?: number): string[] {
    const w = maxWidth ?? this.width;
    if (text.length <= w) return [text];
    const lines: string[] = [];
    const words = text.split(' ');
    let cur = '';
    for (const word of words) {
      if (word.length > w) {
        if (cur) { lines.push(cur); cur = ''; }
        let rem = word;
        while (rem.length > w) { lines.push(rem.substring(0, w)); rem = rem.substring(w); }
        if (rem) cur = rem;
        continue;
      }
      const test = cur ? `${cur} ${word}` : word;
      if (test.length <= w) cur = test;
      else { if (cur) lines.push(cur); cur = word; }
    }
    if (cur) lines.push(cur);
    return lines.length > 0 ? lines : [''];
  }

  indented(text: string, indent = 2, prefix = ''): string[] {
    const pfx = prefix ? ' '.repeat(indent) + prefix + ' ' : ' '.repeat(indent);
    const contentWidth = this.width - pfx.length;
    if (contentWidth <= 0) return [this.clip(text)];
    if (text.length <= contentWidth) return [this.clip(pfx + text)];
    const wrapped = this.wordWrap(text, contentWidth);
    const cont = ' '.repeat(pfx.length);
    return [this.clip(pfx + wrapped[0]), ...wrapped.slice(1).map((l) => this.clip(cont + l))];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Presets + renderer (ported from POS receiptLayout.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface Preset {
  spacer: boolean;
  div: string;
  unitPriceLine: boolean;
  heroTotal: boolean;
  title?: string;
  minimal: boolean;
}

const PRESETS: Record<ReceiptTemplateId, Preset> = {
  classic: { spacer: true, div: '-', unitPriceLine: true, heroTotal: false, minimal: false },
  compact: { spacer: false, div: '-', unitPriceLine: false, heroTotal: false, minimal: false },
  elegant: { spacer: true, div: '=', unitPriceLine: true, heroTotal: true, title: 'RECEIPT', minimal: false },
  minimal: { spacer: false, div: '-', unitPriceLine: false, heroTotal: false, minimal: true },
};

const DEFAULT_OPTIONS: ReceiptRenderOptions = {
  template: 'classic',
  paperWidth: 48,
  currency: { symbol: '', decimals: 2, position: 'before' },
  fields: {
    logo: true, businessName: true, address: true, phone: true, email: false, website: false, taxId: true,
    orderNumber: true, dateTime: true, table: true, server: true, customer: true, orderMode: false,
    itemModifiers: true, itemNotes: true, unitPrice: true,
    taxBreakdown: true, discount: true, serviceCharge: true, tip: true,
    paymentMethod: true, amountPaid: true, change: true,
    qrCode: false, footerMessage: true, thankYou: true, poweredBy: true,
  },
};

function buildLines(data: LayoutData, options: ReceiptRenderOptions): StyledLine[] {
  const p = PRESETS[options.template] ?? PRESETS.classic;
  const f = options.fields;
  const L = new Layout(options.paperWidth);
  const money = (n: number) => formatMoney(n, options.currency);
  const out: StyledLine[] = [];

  const push = (text: string, align: StyledLine['align'] = 'l', extra: Partial<StyledLine> = {}) =>
    out.push({ text, align, kind: 'text', ...extra });
  const divider = () => out.push({ text: L.divider(p.div), align: 'l', kind: 'divider' });
  const blank = () => { if (p.spacer) out.push({ text: '', align: 'l', kind: 'blank' }); };

  if (f.logo && data.hasLogo) out.push({ text: '', align: 'c', kind: 'logo' });
  if (f.businessName && data.storeName) push(data.storeName, 'c', { bold: true, size: p.heroTotal ? 'large' : 'normal' });
  if (!p.minimal) {
    if (f.address) for (const a of data.address) for (const ln of L.wordWrap(a)) push(ln, 'c');
    if (f.phone && data.phone) push(`Tel: ${data.phone}`, 'c');
    if (f.email && data.email) push(data.email, 'c');
    if (f.website && data.website) push(data.website, 'c');
    if (f.taxId && data.taxId) push(`Tax ID: ${data.taxId}`, 'c');
  }
  if (p.title) { blank(); push(p.title, 'c', { bold: true }); }
  blank();

  if (p.minimal) {
    if (f.orderNumber) push(`Order #${data.orderNumber}`, 'c');
    divider();
    for (const it of data.items) for (const ln of L.nameAmountRow(`${it.quantity} ${it.name}`, money(it.total))) push(ln, 'l');
    divider();
    push(L.totalsRow('TOTAL', money(data.total)), 'l', { bold: true });
    divider();
    if (f.thankYou) push('Thank you!', 'c');
    if (f.poweredBy) push('Powered By XenithPulse.com', 'c');
    return out;
  }

  divider();
  const lv = (label: string, value: string, bold = false) => {
    for (const ln of L.labelValue(label, value)) push(ln, 'l', bold ? { bold: true } : {});
  };
  if (f.orderNumber) lv('Order', `#${data.orderNumber}`, true);
  if (f.dateTime) { lv('Date', data.date); if (data.time) lv('Time', data.time); }
  if (f.table && data.table) lv('Table', data.table);
  if (f.orderMode && data.orderMode) lv('Mode', data.orderMode);
  if (f.server && data.server) lv('Server', data.server);
  if (f.customer && data.customer) lv('Customer', data.customer);
  divider();

  push(L.itemsHeader('Item', 'Qty', 'Amount'), 'l', { bold: true });
  divider();
  for (const it of data.items) {
    for (const ln of L.itemRow(it.name, String(it.quantity), money(it.total))) push(ln, 'l');
    if (p.unitPriceLine && f.unitPrice) for (const ln of L.indented(`${it.quantity} x ${money(it.unitPrice)}`, 2)) push(ln, 'l');
    if (f.itemModifiers && it.modifiers?.length) for (const m of it.modifiers) for (const ln of L.indented(m, 2, '+')) push(ln, 'l');
    if (f.itemNotes && it.notes) for (const ln of L.indented(it.notes, 2, '*')) push(ln, 'l');
  }
  divider();

  push(L.totalsRow('Subtotal:', money(data.subtotal)), 'l');
  if (f.discount && data.discount && data.discount > 0) {
    push(L.totalsRow(data.discountName ? `${data.discountName}:` : 'Discount:', `-${money(data.discount)}`), 'l');
  }
  if (f.serviceCharge && data.serviceCharge && data.serviceCharge > 0) {
    push(L.totalsRow(data.serviceChargeName ? `${data.serviceChargeName}:` : 'Service:', money(data.serviceCharge)), 'l');
  }
  if (f.taxBreakdown && data.tax && data.tax > 0) {
    const label = data.taxRate ? `${data.taxLabel || 'Tax'} (${data.taxRate}%):` : `${data.taxLabel || 'Tax'}:`;
    push(L.totalsRow(label, money(data.tax)), 'l');
  }
  // Custom bill adjustments (discounts/surcharges/fees) — one line each, signed.
  if (data.adjustments?.length) {
    for (const adj of data.adjustments) {
      const amt = adj.isDeduction ? `-${money(adj.amount)}` : money(adj.amount);
      push(L.totalsRow(`${adj.name}:`, amt), 'l');
    }
  }
  if (f.tip && data.tip && data.tip > 0) push(L.totalsRow('Tip:', money(data.tip)), 'l');
  divider();
  if (p.heroTotal) push(`TOTAL  ${money(data.total)}`, 'c', { bold: true, size: 'large' });
  else push(L.totalsRow('TOTAL:', money(data.total)), 'l', { bold: true });
  divider();

  // A bill settled across two methods used to print as though one method had
  // paid all of it. An order paid by ONE method still prints byte-identically
  // to before. Mirrors receiptLayout.ts — change one, change both.
  const isSplit = f.amountPaid && (data.payments?.length ?? 0) > 1;

  if (isSplit) {
    const pays = data.payments!;
    const indentedRow = (label: string, value: string) => L.totalsRow('  ' + label, value);
    push('Paid', 'l', { bold: true });
    pays.forEach((pay, i) => {
      push(indentedRow(f.paymentMethod ? pay.label : `Payment ${i + 1}`, money(pay.amount)), 'l');
    });
    push('  ' + p.div.repeat(Math.max(1, L.width - 2)), 'l');
    push(indentedRow('Total Paid', money(data.amountPaid ?? pays.reduce((s, x) => s + x.amount, 0))), 'l', { bold: true });
    if (f.change && data.change !== undefined && data.change > 0) {
      push(indentedRow('Change', money(data.change)), 'l');
    }
    divider();
  } else {
    const hasPayment = (f.paymentMethod && data.paymentMethod) ||
      (f.amountPaid && data.amountPaid !== undefined) ||
      (f.change && data.change !== undefined && data.change > 0);
    if (hasPayment) {
      if (f.paymentMethod && data.paymentMethod) push(L.totalsRow('Payment:', data.paymentMethod), 'l');
      if (f.amountPaid && data.amountPaid !== undefined) push(L.totalsRow('Amount Paid:', money(data.amountPaid)), 'l');
      if (f.change && data.change !== undefined && data.change > 0) push(L.totalsRow('Change:', money(data.change)), 'l');
      divider();
    }
  }

  if (f.qrCode && data.qrValue) {
    blank();
    out.push({ text: data.qrValue, align: 'c', kind: 'qr' });
    push('Scan for details', 'c');
  }

  blank();
  if (f.footerMessage && data.footerMessage) for (const ln of L.wordWrap(data.footerMessage)) push(ln, 'c');
  if (f.thankYou) push('Thank you!', 'c', { bold: p.heroTotal });
  if (f.poweredBy) { blank(); push('Powered By XenithPulse.com', 'c'); }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template
// ─────────────────────────────────────────────────────────────────────────────

export class ReceiptTemplate implements TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer {
    const p = payload as unknown as ReceiptPayload;
    const builder = EscPosBuilder.create(capabilities);

    // Resolve options. IMPORTANT: the layout width comes from the tenant's paper
    // setting (options.paperWidth = 32 for 58mm / 48 for 80mm), NOT from the
    // printer's capabilities.maxWidth. This keeps the printed body the SAME width
    // as the on-screen preview and centered header/footer — otherwise a mis-set
    // maxWidth makes the middle (items/totals) print narrow while the centered
    // header/footer span the full page. Legacy callers (no options) fall back to
    // a sane width from capabilities.
    // Layout width = the tenant's configured characters-per-line (32/48/or a
    // custom value they dialed to their exact printer). This keeps print == preview.
    const legacyWidth = capabilities.maxWidth || 48;
    const options: ReceiptRenderOptions = p.options
      ? { ...p.options, paperWidth: p.options.paperWidth || legacyWidth }
      : { ...DEFAULT_OPTIONS, paperWidth: legacyWidth };

    const h = p.header;
    const data: LayoutData = {
      storeName: h?.storeName || '',
      address: h?.storeAddress || [],
      phone: h?.storePhone,
      email: h?.storeEmail,
      website: undefined,
      taxId: h?.taxId,
      orderNumber: p.orderNumber,
      date: p.orderDate,
      time: p.orderTime || '',
      table: p.tableName,
      server: p.serverName,
      customer: p.customerName,
      orderMode: p.orderMode,
      items: (p.items || []).map((it) => ({
        name: it.name,
        quantity: it.quantity,
        unitPrice: it.price,
        total: it.total,
        modifiers: it.modifiers,
        notes: it.notes,
      })),
      subtotal: p.subtotal,
      discount: p.discount,
      discountName: p.discountName,
      tax: p.tax,
      taxRate: p.taxRate,
      taxLabel: p.taxLabel,
      serviceCharge: p.serviceCharge,
      serviceChargeName: p.serviceChargeName,
      tip: p.tip,
      adjustments: p.adjustments,
      total: p.total,
      paymentMethod: p.paymentMethod,
      amountPaid: p.amountPaid,
      change: p.change,
      payments: p.payments,
      footerMessage: p.footer?.message?.[0],
      hasLogo: !!h?.logo,
      qrValue: p.qrCode,
    };

    const lines = buildLines(data, options);

    for (const ln of lines) {
      builder.align(ln.align === 'c' ? TextAlign.CENTER : ln.align === 'r' ? TextAlign.RIGHT : TextAlign.LEFT);
      switch (ln.kind) {
        case 'blank':
          builder.newline();
          break;
        case 'divider':
          builder.line(ln.text);
          break;
        case 'logo':
          if (h?.logo) { builder.raster(h.logo); builder.newline(); }
          break;
        case 'qr':
          // Prefer a rendered QR raster (works wherever graphics work); fall
          // back to the native QR command only if the printer can't do images.
          if (capabilities.supportsImage) {
            const qrRaster = qrToRaster(ln.text);
            if (qrRaster) { builder.raster(qrRaster); builder.newline(); }
          } else if (capabilities.supportsQRCode) {
            builder.qrCode(ln.text, { moduleSize: 5, errorCorrection: QRErrorCorrection.M });
            builder.newline();
          }
          break;
        default:
          if (ln.bold) builder.bold(true);
          if (ln.size === 'large') builder.fontSize(FontSize.DOUBLE_BOTH);
          builder.line(ln.text);
          if (ln.size === 'large') builder.fontSize(FontSize.NORMAL);
          if (ln.bold) builder.bold(false);
      }
    }

    builder.align(TextAlign.LEFT);
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
