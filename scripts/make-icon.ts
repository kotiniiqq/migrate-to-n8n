/** Draw mcpb/icon.png (256×256): two workflow nodes joined by an arrow, on a dark rounded square.
 *  A tiny PNG writer, no dependencies.
 *
 *   npx tsx scripts/make-icon.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const S = 256;
type RGB = [number, number, number];
const BG: RGB = [27, 24, 41];
const FROM: RGB = [139, 92, 246];
const TO: RGB = [234, 75, 113];
const LINE: RGB = [226, 224, 240];

const px = new Float32Array(S * S * 4);

/** Blend a colour into a pixel with coverage `a` (0..1). */
function paint(x: number, y: number, c: RGB, a: number): void {
  if (a <= 0) return;
  const i = (y * S + x) * 4;
  const k = Math.min(1, a);
  for (let j = 0; j < 3; j++) px[i + j] = px[i + j] * (1 - k) + c[j] * k;
  px[i + 3] = Math.max(px[i + 3], k);
}

/** Coverage from a signed distance (negative = inside), one pixel of anti-aliasing. */
const cover = (d: number) => Math.max(0, Math.min(1, 0.5 - d));

function shape(dist: (x: number, y: number) => number, c: RGB): void {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) paint(x, y, c, cover(dist(x + 0.5, y + 0.5)));
}

const roundRect = (cx: number, cy: number, hw: number, hh: number, r: number) => (x: number, y: number) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const segment = (ax: number, ay: number, bx: number, by: number, w: number) => (x: number, y: number) => {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) - w;
};

shape(roundRect(128, 128, 128, 128, 56), BG);
shape(roundRect(70, 128, 36, 36, 12), FROM);
shape(roundRect(186, 128, 36, 36, 12), TO);
shape(segment(112, 128, 140, 128, 5), LINE);
shape(segment(130, 116, 142, 128, 5), LINE);
shape(segment(130, 140, 142, 128, 5), LINE);
// small "ports" on the node edges, like in a workflow editor
shape((x, y) => Math.hypot(x - 106, y - 128) - 6, LINE);
shape((x, y) => Math.hypot(x - 150, y - 128) - 6, LINE);

function png(): Buffer {
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const o = y * (S * 4 + 1) + 1 + x * 4;
      for (let j = 0; j < 3; j++) raw[o + j] = Math.round(px[i + j]);
      raw[o + 3] = Math.round(px[i + 3] * 255);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('mcpb', { recursive: true });
writeFileSync('mcpb/icon.png', png());
console.log('mcpb/icon.png');
