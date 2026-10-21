// Runs the app headlessly against fixtures and exits non-zero on failure.
// Requires a prior `npm run build`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf, makePdfPages } from '../test/fixtures/make-pdf.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'glossa-smoke-'));
const fixtures = path.join(work, 'fixtures');
fs.cpSync(path.join(root, 'test', 'fixtures'), fixtures, { recursive: true });
fs.writeFileSync(
  path.join(fixtures, 'sample.pdf'),
  makePdf([
    'Laminar and turbulent flow',
    'The Reynolds number compares inertial and viscous forces in a flow.',
    'Above a critical value the boundary layer becomes turbulent.',
  ]),
);

// Served from the fixture web host: a typed .pdf address and a PDF link on a page.
fs.writeFileSync(path.join(fixtures, 'web.pdf'), makePdf(['Boundary layers', 'Near a wall, viscosity slows the flow to rest.']));
fs.writeFileSync(path.join(fixtures, 'web2.pdf'), makePdf(['Drag', 'Form drag grows with the wake behind a body.']));
fs.writeFileSync(
  path.join(fixtures, 'long.pdf'),
  makePdfPages(Array.from({ length: 80 }, (_, i) => [`Page ${i + 1}`, 'Viscosity resists the relative motion of fluid layers.'])),
);

const env = {
  ...process.env,
  GLOSSA_SMOKE: '1',
  GLOSSA_SMOKE_DIR: fixtures,
  GLOSSA_SMOKE_SHOTS: process.env.GLOSSA_SMOKE_SHOTS ?? path.join(work, 'shots'),
  GLOSSA_USER_DATA: path.join(work, 'userData'),
  GLOSSA_FAKE_DELAY_MS: '5',
};
// Local copies of missing system libraries on bare CI machines (see README).
const devlibs = path.join(root, '.devlibs');
if (fs.existsSync(devlibs)) env.LD_LIBRARY_PATH = [devlibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

// GLOSSA_SMOKE_APP: a packaged app's executable (scripts/package.mjs) instead of the source tree.
const packaged = process.env.GLOSSA_SMOKE_APP;
const electron = packaged || path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const args = packaged ? [] : ['.'];
if (process.platform === 'linux' && !process.env.DISPLAY) args.push('--ozone-platform=headless', '--disable-gpu');
if (process.env.GLOSSA_NO_SANDBOX) args.push('--no-sandbox');
// The fixture server is local; never send it through a configured proxy.
args.push('--proxy-bypass-list=127.0.0.1;localhost;<local>');

function launch(phase) {
  return new Promise((resolve) => {
    const child = spawn(electron, args, { cwd: root, env: { ...env, GLOSSA_SMOKE_PHASE: String(phase) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      console.error('smoke: timeout');
      child.kill('SIGKILL');
    }, 120_000);
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (/SMOKE FAILED|\[smoke\]|Uncaught|TypeError|ReferenceError/.test(line) || (/Error/.test(line) && !/dbus|gpu|viz|angle|egl|gl_/i.test(line))) {
          process.stderr.write(line + '\n');
        }
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

let code = await launch(1);
if (code === 0) {
  // Between launches: delete the agent result, as if it were lost.
  const state = JSON.parse(fs.readFileSync(path.join(env.GLOSSA_USER_DATA, 'smoke-state.json'), 'utf8'));
  fs.rmSync(path.join(env.GLOSSA_USER_DATA, 'jobs', state.agent, 'work', 'output', 'index.html'));
  code = await launch(2);
}
console.log(`smoke: exit ${code} (work dir ${work})`);
process.exit(code);
