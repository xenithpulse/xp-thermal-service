#!/usr/bin/env node
/**
 * Draws the Thermal Bridge icon and writes assets/icon.ico (16, 32, 48, 256)
 * and assets/icon.png (256). No image libraries: each size is rendered from
 * signed-distance shapes, so every size is drawn crisp rather than scaled.
 *
 * The glyph: a receipt hanging from a bridge arch, in the XenithPulse palette
 * (the pulse mark's emerald and ink, as Pulsar POS's installer uses them): an
 * emerald arch, a chalk receipt, on an ink tile with a faint emerald rim.
 * The same geometry is used for the inline SVG logo in the dashboard
 * (src/dashboard/dashboard.html) and drawn by the installer (installer/Setup.cs).
 *
 *   node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TILE = [9, 14, 12]; // XenithPulse ink, #090e0c
const ARCH = [52, 211, 153]; // XenithPulse emerald, #34d399
const SLIP = [233, 240, 237]; // chalk, #e9f0ed
const RIM = 0.18; // emerald rim opacity, as on the XenithPulse mark tile

// ── Signed distance functions, in a 256-unit box, y down ─────────────────────
const sdRoundBox = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const sdSegment = (x, y, ax, ay, bx, by, r) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * h, py - dy * h) - r;
};

const sdPolygon = (x, y, pts) => {
  let d = Infinity;
  let sign = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j];
    const [bx, by] = pts[i];
    d = Math.min(d, sdSegment(x, y, ax, ay, bx, by, 0));
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) sign = -sign;
  }
  return sign * d; // negative inside
};

// The arch: part of a circle, stroked, with round ends.
const ARC = { cx: 128, cy: 160, r: 104, half: 9, endY: 112 };
const arcEnd = Math.sqrt(ARC.r ** 2 - (ARC.cy - ARC.endY) ** 2);
const sdArc = (x, y) => {
  if (y <= ARC.endY) return Math.abs(Math.hypot(x - ARC.cx, y - ARC.cy) - ARC.r) - ARC.half;
  return Math.min(
    Math.hypot(x - (ARC.cx - arcEnd), y - ARC.endY),
    Math.hypot(x - (ARC.cx + arcEnd), y - ARC.endY)
  ) - ARC.half;
};

// The receipt: a slip with a torn (zigzag) bottom edge.
const L = 84, R = 172, TOP = 98, TEETH = 4, TOOTH = 14, BOTTOM = 214;
const receipt = [[L, TOP], [R, TOP], [R, BOTTOM]];
for (let i = 1; i <= TEETH * 2; i++) {
  receipt.push([R - (i * (R - L)) / (TEETH * 2), i % 2 ? BOTTOM - TOOTH : BOTTOM]);
}

/** Distances to the receipt and to the arch with its hanger, drawn in different colours. */
function glyphDistances(x, y, boost) {
  const slip = sdPolygon(x, y, receipt) - 2;
  // Printed lines, cut out of the slip. Dropped at small sizes, where they
  // would only smear the receipt into a grey block.
  let body = slip;
  if (boost < 1.5) {
    const line = Math.min(
      sdSegment(x, y, 102, 126, 154, 126, 5),
      sdSegment(x, y, 102, 150, 154, 150, 5),
      sdSegment(x, y, 102, 174, 136, 174, 5)
    );
    body = Math.max(slip, -line);
  }
  // The hanger joining the arch to the receipt.
  const hanger = sdSegment(x, y, 128, ARC.cy - ARC.r, 128, TOP, 6 * boost);
  const arch = sdArc(x, y) - ARC.half * (boost - 1);
  return { body, arch: Math.min(hanger, arch) };
}

/** RGBA pixels, top row first. */
function render(size) {
  const scale = size / 256;
  // Thicken strokes at tiny sizes so they survive at 1-2 pixels.
  const boost = size <= 16 ? 1.6 : size <= 32 ? 1.3 : 1;
  const px = Buffer.alloc(size * size * 4);
  const cover = (d) => Math.max(0, Math.min(1, 0.5 - d * scale));
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / scale;
      const y = (j + 0.5) / scale;
      const box = sdRoundBox(x, y, 128, 128, 124, 124, 52);
      const tile = cover(box);
      // A hairline rim, only where there are pixels enough to show it.
      const rim = size >= 48 ? cover(Math.abs(box + 3) - 3 / Math.max(1, scale * 4)) * RIM : 0;
      const g = glyphDistances(x, y, boost);
      const arch = cover(g.arch);
      const slip = cover(g.body);
      const o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) {
        let v = TILE[c] * (1 - rim) + ARCH[c] * rim;
        v = v * (1 - arch) + ARCH[c] * arch;
        v = v * (1 - slip) + SLIP[c] * slip;
        px[o + c] = Math.round(v);
      }
      px[o + 3] = Math.round(tile * 255);
    }
  }
  return px;
}

// ── Encoders ─────────────────────────────────────────────────────────────────
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** A 32-bit DIB frame, the most widely readable ICO format at small sizes. */
function dib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour + mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const maskRow = Math.ceil(size / 32) * 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4; // bottom-up
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  header.writeUInt32LE(pixels.length + maskRow * size, 20);
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico(frames) {
  const head = Buffer.alloc(6 + frames.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.data)]);
}

const frames = [16, 32, 48, 256].map((size) => {
  const rgba = render(size);
  return { size, rgba, data: size >= 256 ? png(size, rgba) : dib(size, rgba) };
});

mkdirSync(join(root, 'assets'), { recursive: true });
writeFileSync(join(root, 'assets', 'icon.ico'), ico(frames));
writeFileSync(join(root, 'assets', 'icon.png'), png(256, frames[3].rgba));
// Previews of the small sizes, for checking legibility by eye.
if (process.argv.includes('--previews')) {
  for (const f of frames.slice(0, 3)) writeFileSync(join(root, 'assets', `icon-${f.size}.png`), png(f.size, f.rgba));
}
console.log('Wrote assets/icon.ico (16, 32, 48, 256) and assets/icon.png');
