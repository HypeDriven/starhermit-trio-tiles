// Bakes materials.js buildGrainTexture (the lacquer roughness grain: per-pixel
// noise around 150 ± 26 from decorStream('grain'), then 18 soft light/dark
// blotches from the same stream) into assets/grain.png: its per-pixel loop
// over ImageData is too slow for the engine's interpreter at load. The
// blotches are composited as canvas would (source-over, a radial falloff from
// radius 1 to r). Run once; the PNG is committed (tests check it is current).
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decorStream } from '../js/rules/rng.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = 256;
export function grainPixels() {
  const rand = decorStream('grain');
  const v = new Float64Array(T * T);
  for (let i = 0; i < T * T; i++) v[i] = 150 + Math.round(rand.range(-26, 26));
  for (let k = 0; k < 18; k++) {
    const x = rand.range(0, T), y = rand.range(0, T), r = rand.range(14, 48);
    const light = rand.range(0, 1) > 0.5;
    const c = light ? 255 : 0;
    for (let py = 0; py < T; py++) for (let px = 0; px < T; px++) {
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      if (d >= r) continue;
      const a = 0.12 * (1 - Math.max(0, d - 1) / (r - 1));
      const i = py * T + px;
      v[i] = v[i] * (1 - a) + c * a;
    }
  }
  return Uint8Array.from(v, (x) => Math.max(0, Math.min(255, Math.round(x))));
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function grainPng() {
  const g = grainPixels();
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(T, 0); ihdr.writeUInt32BE(T, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc(T * (T + 1));
  for (let y = 0; y < T; y++) { raw[y * (T + 1)] = 0; for (let x = 0; x < T; x++) raw[y * (T + 1) + 1 + x] = g[y * T + x]; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(root, 'assets', 'grain.png'), grainPng());
  console.log('wrote assets/grain.png');
}
