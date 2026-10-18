// Measures how long hashing a document blocks the event loop: the old
// synchronous read+hash versus the streamed hash now used by DocumentService.
// Synthetic file in a temp folder. Usage: node scripts/bench/open-hash.mjs [MB]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mb = Number(process.argv[2] ?? 200);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossa-bench-'));
const file = path.join(dir, 'synthetic.pdf');
const block = crypto.randomBytes(1024 * 1024);
const fd = fs.openSync(file, 'w');
for (let i = 0; i < mb; i++) fs.writeSync(fd, block);
fs.closeSync(fd);

async function measure(name, fn) {
  let maxLag = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 10);
    last = now;
  }, 10);
  const t0 = performance.now();
  await fn();
  const total = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(timer);
  return { name, totalMs: Math.round(total), maxEventLoopBlockMs: Math.round(maxLag) };
}

const before = await measure('before: readFileSync + sha256', async () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
const after = await measure('after: streamed sha256', async () => {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) h.update(c);
  return h.digest('hex');
});
console.log(JSON.stringify({ fileMB: mb, node: process.version, results: [before, after] }, null, 1));
fs.rmSync(dir, { recursive: true, force: true });
