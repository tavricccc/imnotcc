// Draws the app icon: a pixel Clawd with a chat bubble, on cream. Writes the SVG and the PNGs
// (iOS needs PNG) from the same shapes. iOS rounds the home-screen icon itself, so those stay
// square; the desktop app's icon is cut to the same continuous-corner shape here.
//   node scripts/icons.mjs
//   cd desktop && npx tauri icon src-tauri/icons/source.png   (then keep only the files already in icons/)
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = '#f6ede3';
const BODY = '#d97757';
const EYE = '#2b1a14';
const BUBBLE = '#ffffff';
const DOT = '#d97757';
const BLUSH = '#f0a58c';

// Clawd, one character per pixel: C body, K eye, P blush, . empty.
const SPRITE = [
  '..CCCCCCCCCC..',
  '..CCCCCCCCCC..',
  '..CCKCCCCKCC..',
  '..CCKCCCCKCC..',
  'CCCPCCCCCCPCCC',
  'CCCCCCCCCCCCCC',
  '..CCCCCCCCCC..',
  '..CCCCCCCCCC..',
  '..C.C....C.C..',
  '..C.C....C.C..',
];
const UNIT = 26;
const OX = (512 - SPRITE[0].length * UNIT) / 2;
const OY = 196;

// Shapes in 512 units. Later shapes paint over earlier ones.
const shapes = [];
SPRITE.forEach((row, y) => [...row].forEach((ch, x) => {
  if (ch === '.') return;
  shapes.push({ kind: 'rect', x: OX + x * UNIT, y: OY + y * UNIT, w: UNIT, h: UNIT, fill: ch === 'K' ? EYE : ch === 'P' ? BLUSH : BODY });
}));
// The bubble: a rounded box with a tail towards Clawd, three dots inside.
shapes.push({ kind: 'round', x: 296, y: 70, w: 160, h: 100, r: 34, fill: BUBBLE });
shapes.push({ kind: 'tri', pts: [[318, 150], [358, 160], [300, 198]], fill: BUBBLE });
for (const cx of [336, 376, 416]) shapes.push({ kind: 'circle', cx, cy: 120, r: 13, fill: DOT });

function inside(s, x, y) {
  switch (s.kind) {
    case 'rect': return x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h;
    case 'circle': return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r ** 2;
    case 'round': {
      const qx = Math.max(s.x + s.r - x, 0, x - (s.x + s.w - s.r));
      const qy = Math.max(s.y + s.r - y, 0, y - (s.y + s.h - s.r));
      return x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h && qx * qx + qy * qy <= s.r * s.r;
    }
    case 'tri': {
      const [[ax, ay], [bx, by], [cx, cy]] = s.pts;
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
      const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
      const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    }
    default: return false;
  }
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function colourAt(x, y) {
  let c = BG;
  for (const s of shapes) if (inside(s, x, y)) c = s.fill;
  return rgb(c);
}

// iOS's icon outline: a superellipse |x|^5 + |y|^5 <= 1, inset a little like other desktop icons.
const SQUIRCLE_INSET = 0.04;
function inSquircle(x, y) {
  const r = 256 * (1 - 2 * SQUIRCLE_INSET);
  return Math.abs((x - 256) / r) ** 5 + Math.abs((y - 256) / r) ** 5 <= 1;
}

function png(size, squircle = false) {
  const k = 512 / size;
  const N = 4; // supersampling
  const ch = squircle ? 4 : 3;
  const stride = size * ch + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      let hits = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const px = (x + (sx + 0.5) / N) * k, py = (y + (sy + 0.5) / N) * k;
        if (squircle && !inSquircle(px, py)) continue;
        // The artwork shrinks into the inset outline.
        const c = squircle ? colourAt(256 + (px - 256) / (1 - 2 * SQUIRCLE_INSET), 256 + (py - 256) / (1 - 2 * SQUIRCLE_INSET)) : colourAt(px, py);
        for (let i = 0; i < 3; i++) sum[i] += c[i];
        hits++;
      }
      const at = y * stride + 1 + x * ch;
      for (let i = 0; i < 3; i++) raw[at + i] = hits ? Math.round(sum[i] / hits) : 0;
      if (squircle) raw[at + 3] = Math.round((hits / (N * N)) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = squircle ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function svg() {
  const el = shapes.map((s) => {
    if (s.kind === 'rect') return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${s.fill}"/>`;
    if (s.kind === 'circle') return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${s.fill}"/>`;
    if (s.kind === 'round') return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${s.fill}"/>`;
    return `<polygon points="${s.pts.map((p) => p.join(',')).join(' ')}" fill="${s.fill}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" shape-rendering="crispEdges">\n<rect width="512" height="512" fill="${BG}"/>\n${el.join('\n')}\n</svg>\n`;
}

const out = (name) => new URL(`../web/public/${name}`, import.meta.url);
fs.writeFileSync(out('icon.svg'), svg());
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  fs.writeFileSync(out(name), png(size));
  console.log(name, size);
}
fs.writeFileSync(new URL('../desktop/src-tauri/icons/source.png', import.meta.url), png(1024, true));
console.log('desktop source.png', 1024);
