// Builds build/icon.icns (the macOS app icon) from build/icon.png, a 1024×1024
// icon in the macOS shape (see README → Packaging). Needs ImageMagick (`convert`).
// Usage: node scripts/make-icns.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'build', 'icon.png');
const out = path.join(root, 'build', 'icon.icns');

// icns entry types holding PNG data, by pixel size (the @2x types reuse the larger sizes).
const TYPES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32], ['icp6', 64], ['ic12', 64], ['ic07', 128],
  ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic14', 512], ['ic10', 1024],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glossa-icns-'));
try {
  const pngs = new Map();
  for (const size of new Set(TYPES.map(([, s]) => s))) {
    const f = path.join(tmp, `${size}.png`);
    execFileSync('convert', [src, '-resize', `${size}x${size}`, '-depth', '8', '-strip', `PNG32:${f}`]);
    pngs.set(size, fs.readFileSync(f));
  }
  const entries = TYPES.map(([type, size]) => {
    const data = pngs.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(out, Buffer.concat([head, body]));
  console.log(`Wrote ${path.relative(root, out)} (${Math.round((body.length + 8) / 1024)} KB)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
