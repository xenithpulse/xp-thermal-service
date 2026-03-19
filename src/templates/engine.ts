/**
 * Template Engine
 * Renders print templates to ESC/POS commands
 * 
 * Templates are organized in dedicated files for better maintainability:
 * - receipt-template.ts  - Customer receipts
 * - kot-template.ts      - Kitchen order tickets
 * - invoice-template.ts  - Business invoices
 * - test-template.ts     - Printer test page
 * - raw-template.ts      - Raw ESC/POS passthrough
 */

import {
  TemplateType,
  PrinterCapabilities,
  PrintServiceError,
  ErrorCodes
} from '../types';

// Import dedicated template classes
import { ReceiptTemplate } from './receipt-template';
import { KOTTemplate } from './kot-template';
import { InvoiceTemplate } from './invoice-template';
import { TestTemplate } from './test-template';
import { RawTemplate } from './raw-template';

export interface TemplateRenderer {
  render(payload: Record<string, unknown>, capabilities: PrinterCapabilities): Buffer;
  validate(payload: Record<string, unknown>): boolean;
}

export class TemplateEngine {
  private renderers: Map<TemplateType, TemplateRenderer> = new Map();

  constructor() {
    // Register default renderers from dedicated template files
    this.registerRenderer(TemplateType.RECEIPT, new ReceiptTemplate());
    this.registerRenderer(TemplateType.KOT, new KOTTemplate());
    this.registerRenderer(TemplateType.INVOICE, new InvoiceTemplate());
    this.registerRenderer(TemplateType.TEST, new TestTemplate());
    this.registerRenderer(TemplateType.RAW, new RawTemplate());
  }

  /**
   * Register a custom template renderer
   */
  registerRenderer(type: TemplateType, renderer: TemplateRenderer): void {
    this.renderers.set(type, renderer);
  }

  /**
   * Render a template
   */
  render(
    type: TemplateType,
    payload: Record<string, unknown>,
    capabilities: PrinterCapabilities
  ): Buffer {
    const renderer = this.renderers.get(type);
    
    if (!renderer) {
      throw new PrintServiceError(
        `Unknown template type: ${type}`,
        ErrorCodes.JOB_INVALID_PAYLOAD,
        400
      );
    }

    if (!renderer.validate(payload)) {
      throw new PrintServiceError(
        `Invalid payload for template: ${type}`,
        ErrorCodes.JOB_INVALID_PAYLOAD,
        400
      );
    }

    return renderer.render(payload, capabilities);
  }

  /**
   * Validate a payload for a template type
   */
  validate(type: TemplateType, payload: Record<string, unknown>): boolean {
    const renderer = this.renderers.get(type);
    return renderer ? renderer.validate(payload) : false;
  }
}

// Re-export template classes for external use
export { ReceiptTemplate } from './receipt-template';
export { KOTTemplate } from './kot-template';
export { InvoiceTemplate } from './invoice-template';
export { TestTemplate } from './test-template';
export { RawTemplate } from './raw-template';
export { LayoutCalculator, PAPER_WIDTHS } from './layout-utils';

export default TemplateEngine;
