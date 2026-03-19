/**
 * Layout Utilities for Thermal Printer Templates
 *
 * Every method guarantees output is EXACTLY <= this.width characters.
 * Uses the proven "build right side first, name takes remainder" pattern.
 *
 * Key rules:
 *  - NO padStart/padEnd without prior truncation (they don't truncate!)
 *  - Item rows: right side (qty + amount) built first → name gets remainder
 *  - Totals: label + spaces + value → exactly width chars
 *  - Dividers: char.repeat(width) — exactly width, never more
 *  - Every output hard-clipped to width as a final safety net
 */

// ── helpers (module-private) ───────────────────────────────────────────────
/** Pad-end that NEVER exceeds `w` characters. */
const rpad = (s: string, w: number): string =>
  s.length >= w ? s.substring(0, w) : s + ' '.repeat(w - s.length);

/** Pad-start that NEVER exceeds `w` characters (keeps rightmost chars). */
const lpad = (s: string, w: number): string =>
  s.length >= w ? s.substring(s.length - w) : ' '.repeat(w - s.length) + s;

/**
 * Adaptive layout helper for thermal printers.
 * All methods produce plain strings that are always <= this.width characters.
 */
export class LayoutCalculator {
  public readonly width: number;

  /**
   * Fixed label column width for label:value rows (adaptive to printer).
   * 48-char → 12,  32-char → 9,  64-char → 14
   */
  public readonly labelWidth: number;

  /** Fixed column width for item table: quantity column. */
  public readonly qtyColW: number;
  /** Fixed column width for item table: amount column. */
  public readonly amtColW: number;
  /** Fixed column width for item table: name/description column. */
  public readonly nameColW: number;

  constructor(printerWidth: number) {
    this.width = printerWidth;
    // Compact label column: ~25% of width, clamped 8-14
    this.labelWidth = Math.min(14, Math.max(8, Math.floor(printerWidth * 0.25)));

    // Fixed item-table column widths — never change per row, guaranteeing alignment
    // Layout: [name] [1-sp] [qty] [2-sp] [amount]
    this.qtyColW = 3;
    this.amtColW = Math.min(12, Math.max(8, Math.ceil(printerWidth * 0.2)));
    this.nameColW = Math.max(6, printerWidth - 1 - this.qtyColW - 2 - this.amtColW);
  }

  // ── clip ────────────────────────────────────────────────────────────────
  /** Hard-clip string to printer width (safety net). */
  private clip(s: string): string {
    return s.length > this.width ? s.substring(0, this.width) : s;
  }

  // ── Dividers ────────────────────────────────────────────────────────────
  divider(char = '-'): string {
    return char.repeat(this.width);
  }

  doubleDivider(): string {
    return '='.repeat(this.width);
  }

  // ── Label : Value rows ─────────────────────────────────────────────────
  /**
   * "Label : Value" — label is left-aligned in a fixed column, value after ": ".
   * Value wraps with indentation if it overflows.  Returns string[].
   */
  labelValue(label: string, value: string): string[] {
    const prefix = rpad(label, this.labelWidth) + ': ';
    const valueSpace = this.width - prefix.length;

    if (valueSpace <= 0) {
      return [this.clip(label), this.clip(value)];
    }

    if (value.length <= valueSpace) {
      return [this.clip(prefix + value)];
    }

    // Wrap long values
    const lines = this.wordWrap(value, valueSpace);
    const indent = ' '.repeat(prefix.length);
    return [
      this.clip(prefix + lines[0]),
      ...lines.slice(1).map(l => this.clip(indent + l))
    ];
  }

  // ── Right-aligned totals row ───────────────────────────────────────────
  /**
   * "Label          Value" — exactly `width` chars.
   * Label left, value right, gap filled with spaces.
   */
  totalsRow(label: string, value: string): string {
    const gap = this.width - label.length - value.length;
    if (gap >= 1) {
      return this.clip(label + ' '.repeat(gap) + value);
    }
    // Value overflows — shrink label to fit
    const maxLabel = this.width - value.length - 1;
    if (maxLabel <= 0) {
      return this.clip(value);
    }
    return this.clip(label.substring(0, maxLabel) + ' ' + value);
  }

  // ── Three-column item rows ─────────────────────────────────────────────
  /**
   * Items table header — uses the same fixed column widths as itemRow().
   */
  itemsHeader(col1 = 'ITEM', col2 = 'QTY', col3 = 'AMT'): string {
    const right = ' ' + lpad(col2, this.qtyColW) + '  ' + lpad(col3, this.amtColW);
    return this.clip(rpad(col1, this.nameColW) + right);
  }

  /**
   * Item row — uses FIXED column widths so every row aligns with the header.
   *
   * Returns string[] because a long item name word-wraps to continuation
   * lines while qty + amount stay on the first line.
   *
   * If a particular amount/qty is wider than the fixed column, that column
   * grows for that row only (the name column absorbs the squeeze).
   */
  itemRow(name: string, qty: string, amount: string): string[] {
    // Grow column only when content exceeds the fixed width (rare)
    const usedAmtW = Math.max(this.amtColW, amount.length);
    const usedQtyW = Math.max(this.qtyColW, qty.length);
    const right = ' ' + lpad(qty, usedQtyW) + '  ' + lpad(amount, usedAmtW);
    const nameW = Math.max(1, this.width - right.length);

    if (name.length <= nameW) {
      return [this.clip(rpad(name, nameW) + right)];
    }

    // Name overflows — word-wrap; qty + amount appear on the first line only
    const nameLines = this.wordWrap(name, nameW);
    const firstLine = this.clip(rpad(nameLines[0], nameW) + right);
    const rest = nameLines.slice(1).map(l => this.clip('  ' + l));
    return [firstLine, ...rest];
  }

  // ── Text utilities ─────────────────────────────────────────────────────
  /**
   * Word-wrap text to fit within maxWidth.
   * Preserves words where possible; breaks overly long words.
   */
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
        while (rem.length > w) {
          lines.push(rem.substring(0, w));
          rem = rem.substring(w);
        }
        if (rem) cur = rem;
        continue;
      }
      const test = cur ? `${cur} ${word}` : word;
      if (test.length <= w) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    return lines.length > 0 ? lines : [''];
  }

  /**
   * Truncate text with suffix if it exceeds maxWidth.
   */
  truncate(text: string, maxWidth: number, suffix = '..'): string {
    if (text.length <= maxWidth) return text;
    if (maxWidth <= suffix.length) return text.substring(0, maxWidth);
    return text.substring(0, maxWidth - suffix.length) + suffix;
  }

  /**
   * Indent text with optional prefix symbol (for modifiers / notes).
   * Returns array of lines, each <= width.
   */
  indented(text: string, indent = 2, prefix = ''): string[] {
    const pfx = prefix ? ' '.repeat(indent) + prefix + ' ' : ' '.repeat(indent);
    const contentWidth = this.width - pfx.length;
    if (contentWidth <= 0) return [this.clip(text)];

    if (text.length <= contentWidth) return [this.clip(pfx + text)];

    const wrapped = this.wordWrap(text, contentWidth);
    const continuationIndent = ' '.repeat(pfx.length);
    return [
      this.clip(pfx + wrapped[0]),
      ...wrapped.slice(1).map(l => this.clip(continuationIndent + l))
    ];
  }
}

/**
 * Preset paper widths for reference
 */
export const PAPER_WIDTHS = {
  PAPER_58MM: 32,
  PAPER_80MM: 48,
  PAPER_112MM: 64
} as const;
