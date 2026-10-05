/**
 * KOT Template (Kitchen Order Ticket) — tenant-configurable.
 *
 * ⚠️  MUST STAY IN SYNC WITH  xp-pos/pos_modules/orders/printing-facility/kotLayout.ts
 *     The layout engine below (Layout usage, modeLabel, buildLines) is a port of
 *     the POS module so the POS live preview matches what this template prints.
 *     Change one → change both. The receipt template carries the same warning
 *     for the same reason.
 *
 * The POS sends `payload.options` (KotRenderOptions): which fields to print,
 * the title, the base font, paper-saver mode and the feed length. This template
 * builds the same StyledLine[] the preview builds, then emits them through the
 * ESC/POS builder.
 *
 * ── WHY A KOT IS NOT A RECEIPT VARIANT ───────────────────────────────────────
 *
 * A bill is a commercial document for a guest; a KOT is a work order for a
 * cook. No prices, no tax, no totals — a cook who can see what the table is
 * paying is being shown a distraction, and on a split bill a wrong number too.
 * It is read across a hot line at arm's length, so the item lines are scaled
 * and the meta lines are not. And it is in the bin within the hour, which is
 * why paper-saver mode exists and why it defaults on.
 *
 * ── LEGACY CALLERS ───────────────────────────────────────────────────────────
 *
 * A POS build that predates KotRenderOptions sends no `options`. Those get
 * DEFAULT_KOT_OPTIONS, which reproduces the ticket this template printed before
 * it was configurable — every field on, airy spacing, long feed. An old till on
 * the same counter as a new one must not start printing differently.
 */

import { TemplateRenderer } from './engine';
import {
  PrinterCapabilities,
  KOTPayload,
  KotRenderOptions,
  KotItemTextSize,
  TextAlign,
  FontSize,
} from '../types';
import { EscPosBuilder } from '../escpos/builder';
import { LayoutCalculator } from './layout-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Shared line model (mirrors the POS StyledLine)
// ─────────────────────────────────────────────────────────────────────────────

interface StyledLine {
  text: string;
  align: 'l' | 'c' | 'r';
  bold?: boolean;
  /** 'large' = scaled dish line; 'compact' = condensed dish line. */
  size?: KotItemTextSize;
  kind?: 'text' | 'divider' | 'blank';
}

interface KotLayoutItem {
  name: string;
  quantity: number;
  modifiers?: string[];
  notes?: string;
  isVoid?: boolean;
}

interface KotLayoutData {
  storeName: string;
  kotNumber: string;
  roundNumber?: number;
  orderNumber: string;
  date: string;
  time: string;
  table?: string;
  tableSection?: string;
  server?: string;
  orderMode?: string;
  guestCount?: number;
  items: KotLayoutItem[];
  kitchenNotes?: string;
  priority?: boolean;
  isReprint?: boolean;
  isVoid?: boolean;
  footerText?: string;
}

/**
 * What a caller that sends no `options` gets: the ticket exactly as this
 * template printed it before it was configurable.
 */
const DEFAULT_KOT_OPTIONS: Omit<KotRenderOptions, 'paperWidth' | 'itemPaperWidth'> = {
  title: 'KITCHEN ORDER',
  fontSize: 'normal',
  itemTextSize: 'large',
  markReprint: true,
  // Off for legacy callers on purpose. Paper saver is a tenant CHOICE that the
  // new POS defaults on; silently applying it to an old till would change what
  // that kitchen sees without anybody having asked for it.
  paperSaver: false,
  feedLines: 3,
  footerText: undefined,
  fields: {
    businessName: false,
    kotNumber: false,
    roundNumber: true,
    orderNumber: true,
    dateTime: true,
    table: true,
    server: true,
    orderMode: false,
    guestCount: false,
    itemModifiers: true,
    itemNotes: true,
    kitchenNotes: true,
    itemCount: false,
    footerText: false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Human wording for the order mode. The stored values are machine tokens
 * (`dine_in`), and `DINE_IN` on a ticket reads as shouting.
 */
function modeLabel(mode?: string): string {
  if (!mode) return '';
  const map: Record<string, string> = {
    dine_in: 'Dine In',
    dinein: 'Dine In',
    takeaway: 'Takeaway',
    delivery: 'Delivery',
    pickup: 'Pickup',
  };
  return map[mode.toLowerCase()] ?? mode.replace(/_/g, ' ');
}

function buildLines(data: KotLayoutData, options: KotRenderOptions): StyledLine[] {
  const f = options.fields;
  const L = new LayoutCalculator(options.paperWidth);
  const out: StyledLine[] = [];

  const push = (text: string, align: StyledLine['align'] = 'l', extra: Partial<StyledLine> = {}) =>
    out.push({ text, align, kind: 'text', ...extra });
  const divider = (char = '-') => out.push({ text: L.divider(char), align: 'l', kind: 'divider' });

  // Paper saver swallows the spacer lines — each is a line of roll no cook
  // reads. Dividers stay either way: those separate routing from food.
  const blank = () => {
    if (!options.paperSaver) out.push({ text: '', align: 'l', kind: 'blank' });
  };

  // ── Banners ───────────────────────────────────────────────────────────────
  //
  // Before anything else, including the restaurant's own name. A void or a
  // reprint is the single most important thing on the paper and must survive
  // somebody reading only the top inch of a ticket still coming out.
  if (data.isVoid) {
    divider('=');
    push('*** VOID - DO NOT MAKE ***', 'c', { bold: true });
    divider('=');
  } else if (data.isReprint && options.markReprint) {
    divider('=');
    push('*** REPRINT - DO NOT REMAKE ***', 'c', { bold: true });
    divider('=');
  }
  if (data.priority) {
    push('!!! RUSH ORDER !!!', 'c', { bold: true });
    divider('=');
  }

  // ── Header ────────────────────────────────────────────────────────────────
  if (f.businessName && data.storeName) push(data.storeName, 'c', { bold: true });
  if (options.title) push(options.title, 'c', { bold: true });

  if (f.roundNumber && typeof data.roundNumber === 'number' && data.roundNumber > 0) {
    push(`-- ROUND ${data.roundNumber} --`, 'c', { bold: true });
  }
  divider();

  // ── Meta ──────────────────────────────────────────────────────────────────
  if (f.table && data.table) {
    const where = data.tableSection ? `TABLE ${data.table} (${data.tableSection})` : `TABLE ${data.table}`;
    // The table headline tracks the dish lines: it is routing, read in the same
    // glance. Never `compact` — shrinking the one line that says WHERE the food
    // goes to save a few millimetres is the wrong trade.
    push(where, 'c', { bold: true, size: options.itemTextSize === 'large' ? 'large' : 'normal' });
  } else if (f.orderMode && data.orderMode) {
    // No table: the mode IS the routing. A takeaway ticket with nothing
    // prominent on it gets plated as dine-in.
    push(modeLabel(data.orderMode).toUpperCase(), 'c', {
      bold: true,
      size: options.itemTextSize === 'large' ? 'large' : 'normal',
    });
  }

  if (f.kotNumber && data.kotNumber) for (const ln of L.labelValue('KOT', `#${data.kotNumber}`)) push(ln);
  if (f.orderNumber && data.orderNumber) for (const ln of L.labelValue('Order', `#${data.orderNumber}`)) push(ln);
  if (f.orderMode && data.orderMode && f.table && data.table) {
    for (const ln of L.labelValue('Mode', modeLabel(data.orderMode))) push(ln);
  }
  if (f.guestCount && typeof data.guestCount === 'number' && data.guestCount > 0) {
    for (const ln of L.labelValue('Covers', String(data.guestCount))) push(ln);
  }
  if (f.server && data.server) for (const ln of L.labelValue('Server', data.server)) push(ln);
  if (f.dateTime) {
    const when = data.date ? `${data.time}  ${data.date}` : data.time;
    for (const ln of L.labelValue('Time', when)) push(ln);
  }

  divider();

  // ── Items ─────────────────────────────────────────────────────────────────
  //
  // Quantity first and glued to the name ("2x Chicken Karahi") rather than in a
  // right-hand column. A KOT has no amount column to balance against, and a
  // quantity at the far edge of the paper reads as belonging to the line below.
  const size: StyledLine['size'] = options.itemTextSize;

  // Resolved by the POS (kotItemCharWidth), not recomputed here: a scaled line
  // is twice as wide so the usable columns halve, and a condensed one is
  // narrower so they grow. Wrapping a scaled line against the full width would
  // push dish names off the edge of the roll — the one failure a kitchen cannot
  // recover from, because the cook cannot tell that anything is missing.
  const itemLayout = new LayoutCalculator(Math.max(8, options.itemPaperWidth || options.paperWidth));

  if (data.items.length === 0) {
    push('(no items on this ticket)', 'c');
  }

  for (const item of data.items) {
    const headline = item.isVoid
      ? `${item.quantity}x ${item.name} [VOID]`
      : `${item.quantity}x ${item.name}`;
    for (const ln of itemLayout.wordWrap(headline)) push(ln, 'l', { bold: true, size });

    if (f.itemModifiers) {
      for (const mod of item.modifiers || []) {
        if (!mod) continue;
        for (const ln of L.indented(mod, 2, '+')) push(ln);
      }
    }
    if (f.itemNotes && item.notes) {
      // Marked with "!" and never abbreviated: this is where "no peanuts" lives.
      for (const ln of L.indented(item.notes, 2, '!')) push(ln, 'l', { bold: true });
    }

    // One blank line between dishes, so a cook's eye can separate them at a
    // glance. blank() drops it under paper saver; no paperSaver check here,
    // because blank() owns that decision and a second copy of it would be a
    // place for the two to disagree.
    if (data.items.length > 1) blank();
  }

  divider();

  // ── Tail ──────────────────────────────────────────────────────────────────
  if (f.itemCount) {
    const units = data.items.reduce((sum, i) => sum + (i.quantity || 0), 0);
    push(L.totalsRow('TOTAL ITEMS', String(units)), 'l', { bold: true });
  }

  if (f.kitchenNotes && data.kitchenNotes) {
    blank();
    const noteLines = L.wordWrap(data.kitchenNotes);
    if (options.paperSaver && noteLines.length === 1 && `NOTES: ${noteLines[0]}`.length <= options.paperWidth) {
      push(`NOTES: ${noteLines[0]}`, 'l', { bold: true });
    } else {
      push('NOTES:', 'l', { bold: true });
      for (const ln of noteLines) push(ln, 'l', { bold: true });
    }
  }

  if (f.footerText && data.footerText) {
    blank();
    push(data.footerText, 'c');
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template
// ─────────────────────────────────────────────────────────────────────────────

export class KOTTemplate implements TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer {
    const p = payload as unknown as KOTPayload;
    const builder = EscPosBuilder.create(capabilities);

    // Layout width comes from the tenant's configured characters-per-line, NOT
    // from capabilities.maxWidth — the same rule as the receipt template, and
    // for the same reason: it keeps print identical to the on-screen preview.
    // A mis-set maxWidth would otherwise print the items narrow while the
    // centered header spans the full page. Legacy callers fall back to the
    // printer's own width.
    const legacyWidth = capabilities.maxWidth || 48;
    const base = p.options?.paperWidth || legacyWidth;
    // Legacy callers send no item width. Halving for 'large' reproduces exactly
    // what this template did before the width was resolved on the POS side.
    const legacyItemWidth = DEFAULT_KOT_OPTIONS.itemTextSize === 'large' ? Math.floor(base / 2) : base;
    const options: KotRenderOptions = p.options
      ? {
          ...p.options,
          paperWidth: base,
          itemPaperWidth: p.options.itemPaperWidth || legacyItemWidth,
        }
      : { ...DEFAULT_KOT_OPTIONS, paperWidth: base, itemPaperWidth: legacyItemWidth };

    const data: KotLayoutData = {
      storeName: p.storeName || '',
      kotNumber: p.kotNumber || '',
      roundNumber: p.roundNumber,
      orderNumber: p.orderNumber,
      date: p.date || '',
      time: p.orderTime || '',
      table: p.tableName,
      tableSection: p.tableSection,
      server: p.serverName,
      orderMode: p.orderMode,
      guestCount: p.guestCount,
      items: (p.items || []).map((it) => ({
        name: it.name,
        quantity: it.quantity,
        modifiers: it.modifiers,
        notes: it.notes,
        isVoid: it.isVoid,
      })),
      kitchenNotes: p.notes,
      isReprint: p.isReprint,
      isVoid: p.isVoid,
      footerText: options.footerText,
    };

    const lines = buildLines(data, options);

    // ── Base font ───────────────────────────────────────────────────────────
    //
    // 'small' selects the printer's condensed font (Font B). It fits more
    // characters per line and sets shorter lines, so the ticket is physically
    // shorter — the cheapest paper saving there is. The POS has already
    // resolved paperWidth to match, so the wrap points agree with the preview.
    const baseFont: 'A' | 'B' = options.fontSize === 'small' ? 'B' : 'A';
    builder.font(baseFont);

    // Paper saver tightens the feed between lines. 24 dots is the usual default
    // for Font A; 22 is noticeably tighter without the lines touching.
    if (options.paperSaver) builder.lineSpacing(options.fontSize === 'small' ? 18 : 22);

    for (const ln of lines) {
      builder.align(ln.align === 'c' ? TextAlign.CENTER : ln.align === 'r' ? TextAlign.RIGHT : TextAlign.LEFT);
      switch (ln.kind) {
        case 'blank':
          builder.newline();
          break;
        case 'divider':
          builder.line(ln.text);
          break;
        default: {
          if (ln.bold) builder.bold(true);
          // 'large' lines are the ones a cook reads across the line. DOUBLE_BOTH
          // rather than DOUBLE_WIDTH: height is what carries at a distance, and
          // buildLines has already narrowed the wrap width to pay for the width.
          // A 'large' line in the condensed font switches to Font A first —
          // doubling Font B still lands smaller than plain Font A, which would
          // make "large" a downgrade.
          //
          // 'compact' is the opposite trade: the condensed face on the dish
          // lines even when the rest of the ticket is Font A, for the shortest
          // ticket the printer can produce.
          if (ln.size === 'large') {
            if (baseFont === 'B') builder.font('A');
            builder.fontSize(FontSize.DOUBLE_BOTH);
          } else if (ln.size === 'compact' && baseFont === 'A') {
            builder.font('B');
          }
          builder.line(ln.text);
          if (ln.size === 'large') {
            builder.fontSize(FontSize.NORMAL);
            if (baseFont === 'B') builder.font('B');
          } else if (ln.size === 'compact' && baseFont === 'A') {
            builder.font('A');
          }
          if (ln.bold) builder.bold(false);
        }
      }
    }

    // Restore the printer for whatever prints next — the builder is per-job but
    // the device is not, and a left-behind condensed font or tight line spacing
    // would show up on the next receipt.
    builder.align(TextAlign.LEFT);
    builder.font('A');
    if (options.paperSaver) builder.lineSpacing();

    // Enough feed that the tear does not run through the last line of food, and
    // no more. A docket spiked on a rail needs less than a receipt in a wallet.
    builder.feedAndCut(Math.max(0, Math.min(options.feedLines ?? 3, 8)));
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
