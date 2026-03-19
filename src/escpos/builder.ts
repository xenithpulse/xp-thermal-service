/**
 * ESC/POS Command Builder
 * Comprehensive command builder for thermal printers
 */

import {
  TextAlign,
  FontSize,
  BarcodeOptions,
  QRCodeOptions,
  QRErrorCorrection,
  TextStyle,
  PrinterCapabilities
} from '../types';

// ESC/POS Command constants
export const ESC = 0x1B;
export const GS = 0x1D;
export const FS = 0x1C;
export const DLE = 0x10;
export const LF = 0x0A;
export const CR = 0x0D;
export const HT = 0x09;
export const FF = 0x0C;
export const NUL = 0x00;

/**
 * Raw ESC/POS command sequences
 */
export const Commands = {
  // Initialization
  INIT: [ESC, 0x40], // Initialize printer
  
  // Print commands
  PRINT_AND_FEED: [ESC, 0x4A], // Print and feed n dots
  PRINT_AND_LINE_FEED: [LF],
  PRINT_AND_CARRIAGE_RETURN: [CR],
  
  // Character formatting
  BOLD_ON: [ESC, 0x45, 0x01],
  BOLD_OFF: [ESC, 0x45, 0x00],
  UNDERLINE_ON: [ESC, 0x2D, 0x01],
  UNDERLINE_OFF: [ESC, 0x2D, 0x00],
  DOUBLE_UNDERLINE: [ESC, 0x2D, 0x02],
  INVERSE_ON: [GS, 0x42, 0x01],
  INVERSE_OFF: [GS, 0x42, 0x00],
  
  // Font selection  
  FONT_A: [ESC, 0x4D, 0x00], // Standard font
  FONT_B: [ESC, 0x4D, 0x01], // Compressed font
  FONT_C: [ESC, 0x4D, 0x02], // Font C (if available)
  
  // Text size (GS ! n)
  SIZE_NORMAL: [GS, 0x21, 0x00],
  SIZE_DOUBLE_WIDTH: [GS, 0x21, 0x10],
  SIZE_DOUBLE_HEIGHT: [GS, 0x21, 0x01],
  SIZE_DOUBLE_BOTH: [GS, 0x21, 0x11],
  
  // Alignment
  ALIGN_LEFT: [ESC, 0x61, 0x00],
  ALIGN_CENTER: [ESC, 0x61, 0x01],
  ALIGN_RIGHT: [ESC, 0x61, 0x02],
  
  // Paper handling
  CUT_FULL: [GS, 0x56, 0x00],
  CUT_PARTIAL: [GS, 0x56, 0x01],
  CUT_FEED_AND_CUT: [GS, 0x56, 0x42, 0x00], // Feed and cut
  
  // Line spacing
  LINE_SPACING_DEFAULT: [ESC, 0x32],
  LINE_SPACING_SET: [ESC, 0x33], // + n
  
  // Cash drawer
  CASH_DRAWER_PIN2: [ESC, 0x70, 0x00, 0x19, 0xFA],
  CASH_DRAWER_PIN5: [ESC, 0x70, 0x01, 0x19, 0xFA],
  
  // Status commands
  STATUS_PAPER: [DLE, 0x04, 0x01],
  STATUS_DRAWER: [DLE, 0x04, 0x02],
  
  // Barcode settings
  BARCODE_HEIGHT: [GS, 0x68], // + height
  BARCODE_WIDTH: [GS, 0x77], // + width (2-6)
  BARCODE_TEXT_POSITION: [GS, 0x48], // + position (0-3)
  BARCODE_PRINT: [GS, 0x6B], // + type + data
  
  // QR Code
  QR_MODEL: [GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41], // + model
  QR_SIZE: [GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43], // + size
  QR_ERROR: [GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45], // + level
  QR_STORE: [GS, 0x28, 0x6B], // + pL pH 31 50 30 + data
  QR_PRINT: [GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30],
  
  // Code page
  CODEPAGE: [ESC, 0x74], // + n
  
  // Character set
  CHARSET_USA: [ESC, 0x52, 0x00],
  CHARSET_FRANCE: [ESC, 0x52, 0x01],
  CHARSET_GERMANY: [ESC, 0x52, 0x02],
  CHARSET_UK: [ESC, 0x52, 0x03],
  
  // Density/Print density
  DENSITY: [GS, 0x7C], // + n
} as const;

/**
 * Code page mappings
 */
export const CodePages = {
  PC437_USA: 0,
  KATAKANA: 1,
  PC850_MULTILINGUAL: 2,
  PC860_PORTUGUESE: 3,
  PC863_CANADIAN_FRENCH: 4,
  PC865_NORDIC: 5,
  HIRAGANA: 6,
  PC437_GREEK: 13,
  WPC1252: 16,
  PC866_CYRILLIC2: 17,
  PC852_LATIN2: 18,
  PC858_EURO: 19,
  THAI42: 20,
  THAI11: 21,
  THAI13: 22,
  THAI14: 23,
  THAI16: 24,
  THAI17: 25,
  THAI18: 26,
  UTF8: 255,
} as const;

/**
 * ESC/POS Command Builder
 */
export class EscPosBuilder {
  private buffer: number[] = [];
  private capabilities: PrinterCapabilities;
  private encoding: BufferEncoding = 'utf8';

  constructor(capabilities?: Partial<PrinterCapabilities>) {
    this.capabilities = {
      maxWidth: 48,
      supportsBold: true,
      supportsUnderline: true,
      supportsBarcode: true,
      supportsQRCode: true,
      supportsImage: false,
      supportsCut: true,
      supportsPartialCut: true,
      supportsCashDrawer: true,
      supportsDensity: true,
      codepage: CodePages.PC437_USA,
      ...capabilities
    };
  }

  /**
   * Initialize the printer (reset to default settings)
   */
  init(): this {
    this.buffer.push(...Commands.INIT);
    return this;
  }

  /**
   * Set code page for character encoding
   */
  setCodePage(codepage: number): this {
    this.buffer.push(...Commands.CODEPAGE, codepage);
    return this;
  }

  /**
   * Add raw bytes to the command buffer
   */
  raw(bytes: number[] | Buffer | Uint8Array): this {
    if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
      this.buffer.push(...Array.from(bytes));
    } else {
      this.buffer.push(...bytes);
    }
    return this;
  }

  /**
   * Print text with optional styling
   */
  text(content: string, style?: TextStyle): this {
    // Apply style before text
    if (style) {
      this.applyStyle(style);
    }

    // Convert string to bytes
    const bytes = Buffer.from(content, this.encoding);
    this.buffer.push(...Array.from(bytes));

    // Reset style after text
    if (style) {
      this.resetStyle();
    }

    return this;
  }

  /**
   * Print a line of text with newline
   */
  line(content: string, style?: TextStyle): this {
    this.text(content, style);
    this.newline();
    return this;
  }

  /**
   * Print an empty line
   */
  newline(count = 1): this {
    for (let i = 0; i < count; i++) {
      this.buffer.push(LF);
    }
    return this;
  }

  /**
   * Feed paper by n lines
   */
  feed(lines: number): this {
    this.buffer.push(ESC, 0x64, lines);
    return this;
  }

  /**
   * Set text alignment
   */
  align(alignment: TextAlign): this {
    switch (alignment) {
      case TextAlign.LEFT:
        this.buffer.push(...Commands.ALIGN_LEFT);
        break;
      case TextAlign.CENTER:
        this.buffer.push(...Commands.ALIGN_CENTER);
        break;
      case TextAlign.RIGHT:
        this.buffer.push(...Commands.ALIGN_RIGHT);
        break;
    }
    return this;
  }

  /**
   * Set font size
   */
  fontSize(size: FontSize): this {
    switch (size) {
      case FontSize.NORMAL:
        this.buffer.push(...Commands.SIZE_NORMAL);
        break;
      case FontSize.DOUBLE_WIDTH:
        this.buffer.push(...Commands.SIZE_DOUBLE_WIDTH);
        break;
      case FontSize.DOUBLE_HEIGHT:
        this.buffer.push(...Commands.SIZE_DOUBLE_HEIGHT);
        break;
      case FontSize.DOUBLE_BOTH:
        this.buffer.push(...Commands.SIZE_DOUBLE_BOTH);
        break;
    }
    return this;
  }

  /**
   * Enable/disable bold text
   */
  bold(enabled = true): this {
    if (this.capabilities.supportsBold) {
      this.buffer.push(...(enabled ? Commands.BOLD_ON : Commands.BOLD_OFF));
    }
    return this;
  }

  /**
   * Enable/disable underline
   */
  underline(enabled = true): this {
    if (this.capabilities.supportsUnderline) {
      this.buffer.push(...(enabled ? Commands.UNDERLINE_ON : Commands.UNDERLINE_OFF));
    }
    return this;
  }

  /**
   * Enable/disable inverse (white on black) text
   */
  inverse(enabled = true): this {
    this.buffer.push(...(enabled ? Commands.INVERSE_ON : Commands.INVERSE_OFF));
    return this;
  }

  /**
   * Select font (A, B, or C)
   */
  font(fontType: 'A' | 'B' | 'C'): this {
    switch (fontType) {
      case 'A':
        this.buffer.push(...Commands.FONT_A);
        break;
      case 'B':
        this.buffer.push(...Commands.FONT_B);
        break;
      case 'C':
        this.buffer.push(...Commands.FONT_C);
        break;
    }
    return this;
  }

  /**
   * Set line spacing
   */
  lineSpacing(dots?: number): this {
    if (dots === undefined) {
      this.buffer.push(...Commands.LINE_SPACING_DEFAULT);
    } else {
      this.buffer.push(...Commands.LINE_SPACING_SET, dots);
    }
    return this;
  }

  /**
   * Print a horizontal line/separator
   */
  separator(char = '-', width?: number): this {
    const lineWidth = width || this.capabilities.maxWidth;
    this.line(char.repeat(lineWidth));
    return this;
  }

  /**
   * Print a dashed separator
   */
  dashedLine(width?: number): this {
    return this.separator('-', width);
  }

  /**
   * Print a double line separator
   */
  doubleLine(width?: number): this {
    return this.separator('=', width);
  }

  /**
   * Print a two-column line (left and right aligned)
   */
  columns(left: string, right: string, width?: number, style?: TextStyle): this {
    const lineWidth = width || this.capabilities.maxWidth;
    const spacing = lineWidth - left.length - right.length;
    
    if (spacing > 0) {
      const fullLine = left + ' '.repeat(spacing) + right;
      this.line(fullLine, style);
    } else {
      // If text is too long, truncate left side
      const truncated = left.substring(0, lineWidth - right.length - 1);
      this.line(truncated + ' ' + right, style);
    }
    
    return this;
  }

  /**
   * Print a three-column line
   */
  threeColumns(left: string, center: string, right: string, width?: number): this {
    const lineWidth = width || this.capabilities.maxWidth;
    const leftWidth = Math.floor(lineWidth / 3);
    const rightWidth = Math.floor(lineWidth / 3);
    const centerWidth = lineWidth - leftWidth - rightWidth;

    const paddedLeft = left.padEnd(leftWidth).substring(0, leftWidth);
    const paddedCenter = center.substring(0, centerWidth).padStart(Math.floor((centerWidth + center.length) / 2)).padEnd(centerWidth);
    const paddedRight = right.padStart(rightWidth).substring(0, rightWidth);

    this.line(paddedLeft + paddedCenter + paddedRight);
    return this;
  }

  /**
   * Print text wrapped to fit within line width
   */
  textWrapped(content: string, style?: TextStyle): this {
    const maxWidth = this.capabilities.maxWidth;
    const words = content.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) {
          this.line(currentLine, style);
        }
        currentLine = word;
      }
    }

    if (currentLine) {
      this.line(currentLine, style);
    }

    return this;
  }

  /**
   * Print a barcode
   */
  barcode(data: string, options: BarcodeOptions): this {
    if (!this.capabilities.supportsBarcode) {
      return this;
    }

    // Set barcode height (default 162 dots)
    const height = options.height || 162;
    this.buffer.push(...Commands.BARCODE_HEIGHT, height);

    // Set barcode width (2-6, default 3)
    const width = Math.min(6, Math.max(2, options.width || 3));
    this.buffer.push(...Commands.BARCODE_WIDTH, width);

    // Set text position (0=none, 1=above, 2=below, 3=both)
    let textPos = 0;
    switch (options.position) {
      case 'above': textPos = 1; break;
      case 'below': textPos = 2; break;
      case 'both': textPos = 3; break;
    }
    this.buffer.push(...Commands.BARCODE_TEXT_POSITION, textPos);

    // Print barcode with type m and data (format: GS k m d1...dk NUL)
    this.buffer.push(...Commands.BARCODE_PRINT, options.type);
    this.buffer.push(...Buffer.from(data, 'ascii'));
    this.buffer.push(NUL);

    return this;
  }

  /**
   * Print a QR code
   */
  qrCode(data: string, options?: QRCodeOptions): this {
    if (!this.capabilities.supportsQRCode) {
      return this;
    }

    const moduleSize = options?.moduleSize || 4;
    const errorCorrection = options?.errorCorrection || QRErrorCorrection.M;
    const dataBytes = Buffer.from(data, 'utf8');
    const dataLen = dataBytes.length + 3;
    const pL = dataLen % 256;
    const pH = Math.floor(dataLen / 256);

    // Set QR Code model (Model 2)
    this.buffer.push(...Commands.QR_MODEL, 0x32, 0x00);

    // Set QR Code size (module size)
    this.buffer.push(...Commands.QR_SIZE, moduleSize);

    // Set error correction level
    this.buffer.push(...Commands.QR_ERROR, errorCorrection);

    // Store QR Code data
    this.buffer.push(GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30);
    this.buffer.push(...Array.from(dataBytes));

    // Print QR Code
    this.buffer.push(...Commands.QR_PRINT);

    return this;
  }

  /**
   * Cut paper
   */
  cut(partial = false): this {
    if (!this.capabilities.supportsCut) {
      return this;
    }

    if (partial && this.capabilities.supportsPartialCut) {
      this.buffer.push(...Commands.CUT_PARTIAL);
    } else {
      this.buffer.push(...Commands.CUT_FULL);
    }

    return this;
  }

  /**
   * Feed paper and cut
   */
  feedAndCut(lines = 3): this {
    this.feed(lines);
    this.cut();
    return this;
  }

  /**
   * Open cash drawer
   */
  openCashDrawer(pin: 2 | 5 = 2): this {
    if (!this.capabilities.supportsCashDrawer) {
      return this;
    }

    if (pin === 5) {
      this.buffer.push(...Commands.CASH_DRAWER_PIN5);
    } else {
      this.buffer.push(...Commands.CASH_DRAWER_PIN2);
    }

    return this;
  }

  /**
   * Apply text style settings
   */
  private applyStyle(style: TextStyle): void {
    if (style.align !== undefined) {
      this.align(style.align);
    }
    if (style.fontSize !== undefined) {
      this.fontSize(style.fontSize);
    }
    if (style.bold) {
      this.bold(true);
    }
    if (style.underline) {
      this.underline(true);
    }
    if (style.inverse) {
      this.inverse(true);
    }
  }

  /**
   * Reset text style to defaults  
   */
  private resetStyle(): void {
    this.fontSize(FontSize.NORMAL);
    this.bold(false);
    this.underline(false);
    this.inverse(false);
  }

  /**
   * Reset all formatting to defaults
   */
  reset(): this {
    this.align(TextAlign.LEFT);
    this.fontSize(FontSize.NORMAL);
    this.bold(false);
    this.underline(false);
    this.inverse(false);
    this.lineSpacing();
    return this;
  }

  /**
   * Build and return the command buffer
   */
  build(): Buffer {
    return Buffer.from(this.buffer);
  }

  /**
   * Get the current buffer length
   */
  get length(): number {
    return this.buffer.length;
  }

  /**
   * Clear the command buffer
   */
  clear(): this {
    this.buffer = [];
    return this;
  }

  /**
   * Create a new builder instance with same capabilities
   */
  clone(): EscPosBuilder {
    return new EscPosBuilder(this.capabilities);
  }

  /**
   * Static helper to create a builder and initialize printer
   */
  static create(capabilities?: Partial<PrinterCapabilities>): EscPosBuilder {
    return new EscPosBuilder(capabilities).init();
  }
}

/**
 * Utility functions for common print tasks
 */
export const EscPosUtils = {
  /**
   * Format currency amount
   */
  formatCurrency(amount: number, decimals = 0): string {
    return `${amount.toFixed(decimals)}`;
  },

  /**
   * Format date
   */
  formatDate(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleDateString();
  },

  /**
   * Format time
   */
  formatTime(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleTimeString();
  },

  /**
   * Format date and time
   */
  formatDateTime(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
  },

  /**
   * Truncate string to max length
   */
  truncate(str: string, maxLength: number, suffix = '...'): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - suffix.length) + suffix;
  },

  /**
   * Pad string to width (left, right, or center)
   */
  pad(str: string, width: number, align: 'left' | 'right' | 'center' = 'left', char = ' '): string {
    if (str.length >= width) return str.substring(0, width);
    const padding = width - str.length;
    
    switch (align) {
      case 'left':
        return str + char.repeat(padding);
      case 'right':
        return char.repeat(padding) + str;
      case 'center':
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        return char.repeat(leftPad) + str + char.repeat(rightPad);
    }
  },

  /**
   * Create request status command for printer status
   */
  getStatusCommand(): Buffer {
    return Buffer.from(Commands.STATUS_PAPER);
  },

  /**
   * Parse printer status response
   */
  parseStatus(response: number): {
    paperPresent: boolean;
    coverOpen: boolean;
    paperNearEnd: boolean;
    paperEnd: boolean;
  } {
    return {
      paperPresent: (response & 0x04) === 0,
      coverOpen: (response & 0x08) !== 0,
      paperNearEnd: (response & 0x0C) !== 0,
      paperEnd: (response & 0x60) !== 0,
    };
  }
};

export default EscPosBuilder;
