#!/usr/bin/env node
// Pure Node.js PNG icon generator — no native dependencies.
// Produces the Journey Trace logo at 16, 32, 48, and 128 px.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ─── CRC32 ────────────────────────────────────────────────────────────────────

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── PNG writer ───────────────────────────────────────────────────────────────

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(Buffer.concat([t, d])));
  return Buffer.concat([len, t, d, crcVal]);
}

function encodePng(pixels, width, height) {
  // pixels: Uint8Array, RGBA row-major
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);  // bit depth
  ihdr.writeUInt8(6, 9);  // RGBA
  // compression, filter, interlace stay 0

  // Filtered scanlines
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // None filter
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * (1 + width * 4) + 1 + x * 4;
      raw[d] = pixels[s]; raw[d+1] = pixels[s+1];
      raw[d+2] = pixels[s+2]; raw[d+3] = pixels[s+3];
    }
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── 2D drawing primitives ────────────────────────────────────────────────────

function makeCanvas(size) {
  const pixels = new Uint8Array(size * size * 4); // starts transparent
  return pixels;
}

function blend(pixels, size, x, y, r, g, b, alpha) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 4;
  const a = alpha / 255;
  const ia = 1 - a * (pixels[i+3] / 255 > 0 ? 1 : 0);
  pixels[i]   = Math.round(pixels[i]   * (1 - a) + r * a);
  pixels[i+1] = Math.round(pixels[i+1] * (1 - a) + g * a);
  pixels[i+2] = Math.round(pixels[i+2] * (1 - a) + b * a);
  pixels[i+3] = Math.min(255, pixels[i+3] + Math.round(alpha * (1 - pixels[i+3] / 255)));
}

function fillCircle(pixels, size, cx, cy, r, rgb) {
  const [R, G, B] = rgb;
  const ri = Math.ceil(r + 1);
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      const d = Math.sqrt(dx*dx + dy*dy);
      if (d < r - 0.5) {
        blend(pixels, size, cx+dx, cy+dy, R, G, B, 255);
      } else if (d < r + 0.5) {
        blend(pixels, size, cx+dx, cy+dy, R, G, B, Math.round((r + 0.5 - d) * 255));
      }
    }
  }
}

// Cubic bezier point
function bz(t, p0, p1, p2, p3) {
  const m = 1 - t;
  return m**3*p0 + 3*m**2*t*p1 + 3*m*t**2*p2 + t**3*p3;
}

// ─── Icon renderer ────────────────────────────────────────────────────────────
// Design: dark navy disc → blue bezier path with waypoint dots → red record dot

const NAVY  = [15, 23, 42];
const BLUE  = [59, 130, 246];
const LBLUE = [147, 197, 253];
const RED   = [239, 68, 68];
const WHITE = [255, 255, 255];

function renderIcon(size) {
  const px = makeCanvas(size);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.46;

  // 1. Navy background disc
  fillCircle(px, size, cx, cy, R, NAVY);

  // Bezier control points (normalised to [0,1] within the disc)
  // The path goes: left-centre → curves up → curves down → right-centre
  const [ax, ay] = [0.22, 0.50];
  const [bx, by] = [0.38, 0.25];
  const [ccx, ccy] = [0.62, 0.75];
  const [dx, dy] = [0.78, 0.50];

  const pathR   = Math.max(1.2, size * 0.055);
  const dotR    = Math.max(1.5, size * 0.08);
  const steps   = Math.max(40, size * 3);

  // 2. Blue bezier path (dense circle stamps along the curve)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bpx = bz(t, ax, bx, ccx, dx) * size;
    const bpy = bz(t, ay, by, ccy, dy) * size;
    const dist = Math.sqrt((bpx - cx)**2 + (bpy - cy)**2);
    if (dist < R * 0.88) fillCircle(px, size, bpx, bpy, pathR, BLUE);
  }

  // 3. Waypoint dots (light blue) — start, 1/3, 2/3, end
  const waypoints = [0, 0.33, 0.67, 1];
  for (const t of waypoints) {
    const wpx = bz(t, ax, bx, ccx, dx) * size;
    const wpy = bz(t, ay, by, ccy, dy) * size;
    const dist = Math.sqrt((wpx - cx)**2 + (wpy - cy)**2);
    if (dist < R * 0.88) fillCircle(px, size, wpx, wpy, dotR, LBLUE);
  }

  // 4. Red recording dot — top-right quadrant
  const rdotR  = Math.max(2, size * 0.13);
  const rdotCx = cx + R * 0.52;
  const rdotCy = cy - R * 0.52;
  fillCircle(px, size, rdotCx, rdotCy, rdotR, RED);

  // 5. White ring around red dot (only at larger sizes)
  if (size >= 48) {
    const ringR = rdotR + Math.max(1, size * 0.025);
    // Draw ring by stamping white then re-stamping red inside
    fillCircle(px, size, rdotCx, rdotCy, ringR, WHITE);
    fillCircle(px, size, rdotCx, rdotCy, rdotR, RED);
  }

  return px;
}

// ─── Generate and save ────────────────────────────────────────────────────────

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const pixels = renderIcon(size);
  const png = encodePng(pixels, size, size);
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`  ✓ icon-${size}.png  (${png.length} bytes)`);
}

console.log('\nIcons written to public/icons/');
