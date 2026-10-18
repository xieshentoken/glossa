// Builds main + preloads with esbuild and the renderer with Vite.
// Usage: node scripts/build.mjs [--dev]   (--dev: no minify, keep sourcemaps)

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const out = path.join(root, 'dist');

rmSync(out, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'warning',
  absWorkingDir: root,
};

await Promise.all([
  esbuild({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' }),
  esbuild({ ...common, entryPoints: ['src/preload/app.ts'], outfile: 'dist/preload/app.js', platform: 'browser' }),
  esbuild({ ...common, entryPoints: ['src/preload/webview.ts'], outfile: 'dist/preload/webview.js', platform: 'browser' }),
  // The Pi SDK is ESM and reads files from its own package, so it is loaded from node_modules, not bundled.
  esbuild({ ...common, entryPoints: ['src/worker/pi-worker.mts'], outfile: 'dist/main/pi-worker.mjs', format: 'esm', external: ['@earendil-works/*'] }),
]);

await vite({ configFile: path.join(root, 'vite.config.mts'), logLevel: 'warn', build: { minify: !dev, sourcemap: dev } });

// pdf.js assets: CJK character maps, standard fonts, image decoders.
const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist');
const dest = path.join(out, 'renderer', 'pdfjs');
mkdirSync(dest, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) cpSync(path.join(pdfjs, dir), path.join(dest, dir), { recursive: true });

console.log(`Built ${dev ? '(dev)' : ''} → dist/`);
