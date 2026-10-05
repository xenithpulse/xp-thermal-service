/**
 * Tests for the kitchen-ticket template.
 *
 * What is under test is a ticket that is WRONG in a way that still looks right.
 * A crash in the printer path is noticed in a minute, because no paper comes
 * out. A ticket missing a dish, or carrying a round the kitchen already cooked,
 * comes out looking exactly like a ticket, gets hung on the rail, and the food
 * is wrong — and nobody finds out until a guest is holding the plate.
 *
 * Two things make that likely here and are the reason this file exists:
 *
 *   1. This template is a PORT of the POS's kotLayout.ts, so the POS live
 *      preview can show a tenant something this does not print. The assertions
 *      below pin the behaviour the two must share.
 *   2. A restaurant can run an older print service than its POS (they update
 *      separately; one is a Windows service somebody has to restart). So the
 *      legacy no-options path has to keep printing what it always printed.
 *
 * Assertions are made against the decoded text of the ESC/POS buffer: that is
 * what the printer is actually handed, rather than an intermediate the test
 * would be grading itself on.
 */

import { KOTTemplate } from '../src/templates/kot-template';
import { PrinterCapabilities, KOTPayload, KotRenderOptions, KotRenderFields } from '../src/types';

const capabilities: PrinterCapabilities = {
  maxWidth: 48,
  supportsBold: true,
  supportsUnderline: true,
  supportsBarcode: true,
  supportsQRCode: true,
  supportsImage: true,
  supportsCut: true,
  supportsPartialCut: true,
  supportsCashDrawer: true,
  supportsDensity: true,
  codepage: 0,
};

const ALL_FIELDS: KotRenderFields = {
  businessName: true,
  kotNumber: true,
  roundNumber: true,
  orderNumber: true,
  dateTime: true,
  table: true,
  server: true,
  orderMode: true,
  guestCount: true,
  itemModifiers: true,
  itemNotes: true,
  kitchenNotes: true,
  itemCount: true,
  footerText: true,
};

function options(over: Partial<KotRenderOptions> = {}): KotRenderOptions {
  return {
    paperWidth: 40,
    itemPaperWidth: 20,
    title: 'KITCHEN ORDER',
    fontSize: 'normal',
    itemTextSize: 'large',
    markReprint: true,
    paperSaver: true,
    feedLines: 1,
    footerText: '** Kitchen Copy **',
    fields: { ...ALL_FIELDS },
    ...over,
  };
}

function payload(over: Partial<KOTPayload> = {}): KOTPayload {
  return {
    orderNumber: '1042',
    kotNumber: '481319',
    roundNumber: 2,
    storeName: 'Zafar Grill',
    orderTime: '21:14',
    date: '02 Oct',
    tableName: 'T4',
    tableSection: 'Garden',
    serverName: 'Ali',
    orderMode: 'dine_in',
    guestCount: 4,
    items: [
      { name: 'Fresh Lime', quantity: 2, modifiers: ['No sugar'], notes: 'Extra ice' },
      { name: 'Kheer', quantity: 1 },
    ],
    notes: 'Nut allergy on this table.',
    options: options(),
    ...over,
  };
}

/**
 * The printable text the printer receives, with ESC/POS command sequences
 * removed.
 *
 * Walked byte by byte against the command table rather than stripped with a
 * regex. A regex over a binary buffer cannot know how many argument bytes
 * follow a command, so it either leaves arguments behind as stray glyphs or
 * eats the character after a command — which silently turned "2x Fresh Lime"
 * into "Fresh Lime" and "TABLE" into "LE" the first time this was written, and
 * an assertion that grades a mangled string is worse than no assertion.
 *
 * Lengths are the full sequence including arguments. See src/escpos/builder.ts.
 */
const ESC = 0x1b;
const GS = 0x1d;

/** command byte -> total sequence length, for ESC-prefixed commands. */
const ESC_LEN: Record<number, number> = {
  0x40: 2, // ESC @    init
  0x32: 2, // ESC 2    default line spacing
  0x33: 3, // ESC 3 n  set line spacing
  0x64: 3, // ESC d n  feed n lines
  0x4a: 3, // ESC J n  feed n dots
  0x61: 3, // ESC a n  align
  0x45: 3, // ESC E n  bold
  0x4d: 3, // ESC M n  font select
  0x2d: 3, // ESC - n  underline
  0x74: 3, // ESC t n  codepage
  0x52: 3, // ESC R n  charset
  0x21: 3, // ESC ! n  print mode
  0x47: 3, // ESC G n  double strike
  0x70: 5, // ESC p m t1 t2  cash drawer
};

/** command byte -> total sequence length, for GS-prefixed commands. */
const GS_LEN: Record<number, number> = {
  0x21: 3, // GS ! n   character size
  0x42: 3, // GS B n   inverse
  0x7c: 3, // GS | n   density
};

function stripCommands(buf: Buffer): string {
  const out: number[] = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === ESC) {
      const len = ESC_LEN[buf[i + 1]];
      if (len) { i += len; continue; }
      i += 2; // unknown ESC command: skip the pair rather than inking it
      continue;
    }
    if (b === GS) {
      const cmd = buf[i + 1];
      // GS V — cut. Either `GS V m` or `GS V B n`.
      if (cmd === 0x56) { i += buf[i + 2] === 0x42 ? 4 : 3; continue; }
      const len = GS_LEN[cmd];
      if (len) { i += len; continue; }
      i += 2;
      continue;
    }
    out.push(b);
    i++;
  }
  return Buffer.from(out).toString('latin1').replace(/\r/g, '');
}

/** The printable text the printer receives. */
function render(p: KOTPayload): string {
  return stripCommands(raw(p));
}

/** The raw buffer, for assertions about the control codes themselves. */
function raw(p: KOTPayload): Buffer {
  return new KOTTemplate().render(p as unknown as Record<string, unknown>, capabilities);
}

/** The argument byte of the last `ESC d n` (feed) in the buffer. */
function feedArg(buf: Buffer): number | null {
  for (let i = buf.length - 3; i >= 0; i--) {
    if (buf[i] === ESC && buf[i + 1] === 0x64) return buf[i + 2];
  }
  return null;
}

describe('KOT template — what reaches the cook', () => {
  it('prints the dishes, the quantities and the routing', () => {
    const txt = render(payload());
    expect(txt).toContain('2x Fresh Lime');
    expect(txt).toContain('1x Kheer');
    expect(txt).toContain('TABLE T4');
    expect(txt).toContain('KITCHEN ORDER');
  });

  it('announces the round, so a later round is not read as a new order', () => {
    expect(render(payload())).toContain('ROUND 2');
  });

  it('carries modifiers, item notes and the allergy warning', () => {
    const txt = render(payload());
    expect(txt).toContain('No sugar');
    expect(txt).toContain('Extra ice');
    expect(txt).toContain('Nut allergy');
  });

  it('prints no money anywhere — a cook does not need the bill', () => {
    expect(render(payload())).not.toMatch(/\d+\.\d{2}|Rs\.|\$/);
  });

  it('still renders when the order has no table (takeaway routing)', () => {
    const txt = render(payload({ tableName: undefined, tableSection: undefined }));
    // The mode becomes the headline, or a counter ticket gets plated as dine-in.
    expect(txt).toContain('DINE IN');
  });
});

describe('KOT template — field toggles', () => {
  const cases: [keyof KotRenderFields, string][] = [
    ['businessName', 'Zafar Grill'],
    ['roundNumber', 'ROUND 2'],
    ['table', 'TABLE T4'],
    ['server', 'Ali'],
    ['itemModifiers', 'No sugar'],
    ['itemNotes', 'Extra ice'],
    ['kitchenNotes', 'Nut allergy'],
    ['kotNumber', '481319'],
    ['itemCount', 'TOTAL ITEMS'],
    ['footerText', 'Kitchen Copy'],
  ];

  it.each(cases)('%s on: prints "%s"', (field, marker) => {
    const fields = { ...ALL_FIELDS, [field]: true };
    expect(render(payload({ options: options({ fields }) }))).toContain(marker);
  });

  it.each(cases)('%s off: "%s" is gone', (field, marker) => {
    const fields = { ...ALL_FIELDS, [field]: false };
    expect(render(payload({ options: options({ fields }) }))).not.toContain(marker);
  });
});

describe('KOT template — banners', () => {
  it('marks a reprint so the line does not remake it', () => {
    const txt = render(payload({ isReprint: true }));
    expect(txt).toContain('REPRINT');
    expect(txt).toContain('DO NOT REMAKE');
  });

  it('respects the tenant switching the reprint banner off', () => {
    const txt = render(payload({ isReprint: true, options: options({ markReprint: false }) }));
    expect(txt).not.toContain('REPRINT');
  });

  it('does not stamp a first print', () => {
    expect(render(payload({ isReprint: false }))).not.toContain('REPRINT');
  });

  it('a void ticket says do not make it, and outranks a reprint', () => {
    const txt = render(payload({ isVoid: true, isReprint: true }));
    expect(txt).toContain('VOID');
    expect(txt).toContain('DO NOT MAKE');
    expect(txt).not.toContain('DO NOT REMAKE');
  });
});

describe('KOT template — paper economy', () => {
  it('paper saver removes blank lines but no information', () => {
    const items = [
      { name: 'Chicken Karahi', quantity: 1, modifiers: ['Extra spicy'], notes: 'No coriander' },
      { name: 'Garlic Naan', quantity: 3 },
      { name: 'Mutton Pulao', quantity: 2 },
    ];
    const tight = render(payload({ items, options: options({ paperSaver: true }) }));
    const airy = render(payload({ items, options: options({ paperSaver: false }) }));

    const lines = (t: string) => t.split('\n').length;
    expect(lines(tight)).toBeLessThan(lines(airy));

    for (const marker of ['Chicken Karahi', 'Garlic Naan', 'Mutton Pulao', 'Extra spicy', 'No coriander']) {
      expect(tight).toContain(marker);
    }
    // The dividers stay: they separate routing from food, and a ticket without
    // them is harder to read rather than merely denser.
    expect(tight).toContain('---');
  });

  it('paper saver tightens line spacing on the wire', () => {
    // ESC 3 n — set line spacing. Present under paper saver, absent without it.
    const tight = raw(payload({ options: options({ paperSaver: true }) }));
    const airy = raw(payload({ options: options({ paperSaver: false }) }));
    expect(tight.includes(Buffer.from([0x1b, 0x33]))).toBe(true);
    expect(airy.includes(Buffer.from([0x1b, 0x33]))).toBe(false);
  });

  it('compact dish lines use the condensed face even when the ticket does not', () => {
    // ESC M 1 — Font B. The whole point of 'compact': shrink the dish lines, the
    // bulk of the ticket's length, without condensing the routing a runner reads.
    const compact = raw(payload({ options: options({ fontSize: 'normal', itemTextSize: 'compact' }) }));
    const normal = raw(payload({ options: options({ fontSize: 'normal', itemTextSize: 'normal' }) }));
    expect(compact.includes(Buffer.from([0x1b, 0x4d, 0x01]))).toBe(true);
    expect(normal.includes(Buffer.from([0x1b, 0x4d, 0x01]))).toBe(false);
  });

  it('compact dish lines never shrink the table headline', () => {
    // Shrinking the one line that says WHERE the food goes is the wrong trade.
    const txt = render(payload({ options: options({ itemTextSize: 'compact' }) }));
    expect(txt).toContain('TABLE T4');
  });

  it('compact fits more dish text per line than large', () => {
    const dish = 'Chargha Special Full Plate With Extra Raita And Salad';
    const lineCount = (o: Partial<KotRenderOptions>) =>
      render(payload({ items: [{ name: dish, quantity: 1 }], options: options(o) }))
        .split('\n')
        .filter((l) => /Chargha|Raita|Salad|Plate/.test(l)).length;

    const large = lineCount({ paperWidth: 40, itemPaperWidth: 20, itemTextSize: 'large' });
    const compact = lineCount({ paperWidth: 40, itemPaperWidth: 52, itemTextSize: 'compact' });
    expect(compact).toBeLessThan(large);
  });

  it('the condensed font selects Font B on the wire', () => {
    // ESC M 1 — Font B.
    const small = raw(payload({ options: options({ fontSize: 'small' }) }));
    const normal = raw(payload({ options: options({ fontSize: 'normal' }) }));
    expect(small.includes(Buffer.from([0x1b, 0x4d, 0x01]))).toBe(true);
    expect(normal.includes(Buffer.from([0x1b, 0x4d, 0x01]))).toBe(false);
  });

  it('a scaled line in the condensed font switches back to Font A first', () => {
    // Doubling Font B still lands smaller than plain Font A, which would make
    // "large" a downgrade. So a large line must re-select Font A.
    const buf = raw(payload({ options: options({ fontSize: 'small', itemTextSize: 'large' }) }));
    const fontA = buf.indexOf(Buffer.from([0x1b, 0x4d, 0x00]));
    const fontB = buf.indexOf(Buffer.from([0x1b, 0x4d, 0x01]));
    expect(fontB).toBeGreaterThanOrEqual(0);
    // Font A is re-selected after the initial Font B selection.
    expect(fontA).toBeGreaterThan(fontB);
  });

  it('restores the printer afterwards, so the next receipt is unaffected', () => {
    const buf = raw(payload({ options: options({ fontSize: 'small', paperSaver: true }) }));
    const tail = buf.subarray(Math.max(0, buf.length - 40));
    // Font A re-selected and line spacing returned to default (ESC 2) near the end.
    expect(tail.includes(Buffer.from([0x1b, 0x4d, 0x00]))).toBe(true);
    expect(tail.includes(Buffer.from([0x1b, 0x32]))).toBe(true);
  });

  it('honours the configured feed before the cut', () => {
    // `ESC d n` is three bytes whatever n is, so the buffer LENGTH says nothing
    // here — the argument is the whole point.
    expect(feedArg(raw(payload({ options: options({ feedLines: 0 }) })))).toBe(0);
    expect(feedArg(raw(payload({ options: options({ feedLines: 6 }) })))).toBe(6);
  });

  it('clamps an absurd feed rather than unrolling the till', () => {
    expect(feedArg(raw(payload({ options: options({ feedLines: 99 }) })))).toBe(8);
    expect(feedArg(raw(payload({ options: options({ feedLines: -4 }) })))).toBe(0);
  });
});

describe('KOT template — wrapping', () => {
  it('never runs a line off the edge of the paper', () => {
    for (const paperWidth of [32, 40, 52]) {
      const txt = render(
        payload({
          items: [
            {
              name: 'Chargha Special Full Plate With Extra Raita And Salad On The Side',
              quantity: 12,
              modifiers: ['No green chilli whatsoever please'],
              notes: 'Guest is in a hurry, send with the first round if at all possible',
            },
          ],
          options: options({ paperWidth, itemPaperWidth: paperWidth, itemTextSize: 'normal' }),
        }),
      );
      const over = txt
        .split('\n')
        .map((l) => l.replace(/\r/g, ''))
        .filter((l) => l.length > paperWidth);
      expect(over).toEqual([]);
    }
  });

  it('wraps scaled item lines at half width, since they print twice as wide', () => {
    const paperWidth = 40;
    const txt = render(
      payload({
        items: [{ name: 'Chargha Special Full Plate With Extra Raita', quantity: 1 }],
        options: options({ paperWidth, itemPaperWidth: Math.floor(paperWidth / 2), itemTextSize: 'large' }),
      }),
    );
    const itemLines = txt
      .split('\n')
      .map((l) => l.replace(/\r/g, ''))
      .filter((l) => /Chargha|Raita|Plate/.test(l));
    expect(itemLines.length).toBeGreaterThan(0);
    for (const l of itemLines) {
      expect(l.length).toBeLessThanOrEqual(Math.floor(paperWidth / 2));
    }
  });
});

describe('KOT template — an older POS', () => {
  // A POS that predates KotRenderOptions sends no `options`. It must keep
  // printing what it always printed, not silently inherit the new defaults.
  const legacy = payload({ options: undefined, storeName: undefined, kotNumber: undefined });

  it('still prints a usable ticket', () => {
    const txt = render(legacy);
    expect(txt).toContain('KITCHEN ORDER');
    expect(txt).toContain('2x Fresh Lime');
    expect(txt).toContain('TABLE T4');
    expect(txt).toContain('Ali');
  });

  it('does not apply paper saver to a till that never asked for it', () => {
    expect(raw(legacy).includes(Buffer.from([0x1b, 0x33]))).toBe(false);
  });

  it('falls back to the printer width when the POS sent none', () => {
    const txt = render(payload({ options: options({ paperWidth: 0 }) }));
    const longest = Math.max(...txt.split('\n').map((l) => l.replace(/\r/g, '').length));
    expect(longest).toBeLessThanOrEqual(capabilities.maxWidth);
  });
});

describe('KOT template — codepage safety', () => {
  // A thermal printer renders bytes through a CODEPAGE, not UTF-8. An em dash
  // looks perfect in the POS preview and comes out of the printer as a stray
  // accented letter — so the back-office screen says the header is fine while
  // the paper at the pass reads "a ROUND 2 a". This caught exactly that: the
  // round banner and both cancellation banners were written with em dashes.
  //
  // Only the strings the TEMPLATE emits are checked. A tenant who configures a
  // non-ASCII title has made their own choice, and their codepage may handle it.
  const asciiCases: [string, Partial<KOTPayload>][] = [
    ['default', {}],
    ['reprint', { isReprint: true }],
    ['void', { isVoid: true }],
    ['single item', { items: [{ name: 'Kheer', quantity: 1 }] }],
  ];

  it.each(asciiCases)('%s ticket is pure ASCII', (_label, over) => {
    const txt = render(payload(over));
    // charCodeAt, not a string compare: the newline is the one character that
    // is legitimately above the printable range here.
    const bad = [...txt].filter((ch) => ch.charCodeAt(0) > 126 && ch.charCodeAt(0) !== 10);
    expect([...new Set(bad)]).toEqual([]);
  });
});


describe('KOT template — validate', () => {
  it('accepts a ticket with items', () => {
    expect(new KOTTemplate().validate(payload() as unknown as Record<string, unknown>)).toBe(true);
  });

  it('rejects a ticket with nothing to cook', () => {
    const t = new KOTTemplate();
    expect(t.validate(payload({ items: [] }) as unknown as Record<string, unknown>)).toBe(false);
    expect(t.validate({ orderNumber: '1', orderTime: '21:14' })).toBe(false);
    expect(t.validate({})).toBe(false);
  });
});
