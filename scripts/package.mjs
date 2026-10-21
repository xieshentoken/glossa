// Packages the built app (run `npm run build` first) as a double-clickable app.
//
//   node scripts/package.mjs                      macOS, Apple silicon (arm64)
//   node scripts/package.mjs --arch x64           macOS, Intel
//   node scripts/package.mjs --platform linux     Linux (used to test the packaged layout)
//
// Output in release/: the app folder and, for macOS, Glossa-<version>-mac-<arch>.tar.gz.
// macOS apps are signed ad hoc when `rcodesign` is found (RCODESIGN or PATH): Apple silicon
// does not run unsigned code. They are not notarized; see README → Packaging.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const platform = arg('platform', 'darwin');
const arch = arg('arch', platform === 'darwin' ? 'arm64' : process.arch);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const out = path.join(root, 'release');

if (!fs.existsSync(path.join(root, 'dist', 'main', 'main.js'))) throw new Error('Run `npm run build` first.');

// Main, preloads and renderer are bundled; only the built-in Pi agent is loaded from
// node_modules at run time (see scripts/build.mjs). Ship that package and what it needs.
function runtimePackages(names) {
  const keep = new Set();
  const visit = (from, name, optional) => {
    for (let dir = from; ; dir = path.dirname(dir)) {
      const cand = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(cand, 'package.json'))) {
        if (keep.has(cand)) return;
        keep.add(cand);
        const pj = JSON.parse(fs.readFileSync(path.join(cand, 'package.json'), 'utf8'));
        for (const d of Object.keys(pj.dependencies ?? {})) visit(cand, d, false);
        for (const d of Object.keys(pj.optionalDependencies ?? {})) visit(cand, d, true);
        return;
      }
      if (dir === root) {
        if (!optional) throw new Error(`${name} (needed by ${path.relative(root, from)}) is not installed`);
        return;
      }
    }
  };
  for (const n of names) visit(root, n, false);
  return [...keep].map((p) => `/${path.relative(root, p).split(path.sep).join('/')}`);
}
const modules = runtimePackages(['@earendil-works/pi-coding-agent']);

const KEEP_FILES = new Set(['/package.json', '/build/icon.png']);
const KEEP_TREES = ['/dist', '/builtin-skills'];
/** true = leave out. Paths are relative to the project, with a leading slash. */
function ignore(p) {
  if (!p || KEEP_FILES.has(p) || p === '/build' || p === '/node_modules') return false;
  if (KEEP_TREES.some((t) => p === t || p.startsWith(`${t}/`))) return false;
  if (p.startsWith('/node_modules/')) return !modules.some((m) => p === m || p.startsWith(`${m}/`) || m.startsWith(`${p}/`));
  return true;
}

const [appDir] = await packager({
  dir: root,
  out,
  name: 'Glossa',
  executableName: platform === 'linux' ? 'glossa' : 'Glossa',
  platform,
  arch,
  electronVersion,
  appVersion: pkg.version,
  appBundleId: 'app.glossa.reader',
  appCategoryType: 'public.app-category.education',
  appCopyright: `© ${new Date().getFullYear()} Glossa`,
  icon: path.join(root, 'build', platform === 'darwin' ? 'icon.icns' : 'icon.png'),
  asar: false,
  prune: false,
  ignore,
  overwrite: true,
  quiet: true,
});
console.log(`Packaged ${path.relative(root, appDir)} (${modules.length} runtime packages)`);

if (platform === 'darwin') {
  const app = path.join(appDir, 'Glossa.app');
  const rcodesign = process.env.RCODESIGN || 'rcodesign';
  try {
    // No key: an ad-hoc signature. Electron's own binaries are ad hoc too, without the hardened runtime.
    execFileSync(rcodesign, ['sign', app], { stdio: ['ignore', 'ignore', 'inherit'] });
    // (`rcodesign verify` misreports ad-hoc signatures, which have no CMS blob.)
    const info = execFileSync(rcodesign, ['print-signature-info', path.join(app, 'Contents', 'MacOS', 'Glossa')], { encoding: 'utf8' });
    if (!/flags: CodeSignatureFlags\(ADHOC\)/.test(info) || !/identifier: app\.glossa\.reader\b/.test(info)) throw new Error('the main executable is not signed as expected');
    console.log('Signed ad hoc');
  } catch (err) {
    console.warn(`NOT SIGNED (${err.code === 'ENOENT' ? 'rcodesign not found' : err.message}). Apple silicon Macs will refuse to open the app.`);
  }
  fs.writeFileSync(
    path.join(appDir, 'How to open Glossa.txt'),
    [
      'Glossa for macOS (not notarized by Apple)',
      '',
      '1. Drag Glossa.app into Applications.',
      '2. Double-click it. macOS says it cannot check the app for malicious software: click Done.',
      '3. Open System Settings → Privacy & Security, scroll down and click "Open Anyway" next to Glossa,',
      '   then confirm with your password. From then on Glossa opens normally.',
      '',
      'Or, in Terminal:  xattr -dr com.apple.quarantine /Applications/Glossa.app',
      '',
    ].join('\n'),
  );
  const archive = path.join(out, `Glossa-${pkg.version}-mac-${arch}.tar.gz`);
  execFileSync('tar', ['-C', appDir, '-czf', archive, 'Glossa.app', 'How to open Glossa.txt']);
  console.log(`Archive ${path.relative(root, archive)} (${Math.round(fs.statSync(archive).size / 1048576)} MB)`);
}
