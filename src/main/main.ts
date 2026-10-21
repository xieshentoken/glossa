import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme, protocol, safeStorage, session, utilityProcess } from 'electron';
import { IPC } from '../shared/api';
import { cardJobIds, cardPictureIds } from '../shared/cards';
import { UI_LANGS, type Settings, type Theme, type UiLang } from '../shared/types';
import { agentApprovalDialog, grantDialog } from './dialogs';
import { DocumentService } from './documents';
import { readFileSafe } from './fs-safe';
import { registerIpc } from './ipc';
import { JobManager } from './jobs';
import { mimeFor } from './output';
import { runPi, type SpawnWorker } from './runners/pi';
import { serveOutput } from './output-protocol';
import { WebPdfs } from './web-pdf';
import { cleanJobs } from './retention';
import { electronBackend } from './secrets';
import { SkillRegistry } from './skills';
import { Store } from './store';
import { lockDownSession, WEB_PARTITION, webNavigationAllowed } from './web-security';

if (process.env.GLOSSA_USER_DATA) app.setPath('userData', path.resolve(process.env.GLOSSA_USER_DATA));

protocol.registerSchemesAsPrivileged([
  { scheme: 'glossa', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'glossa-out', privileges: { standard: true, secure: true } },
]);

const APP_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; " +
  "frame-src glossa-out:; object-src 'none'; base-uri 'none'";

const rootDir = app.getAppPath();
const rendererDir = path.join(rootDir, 'dist', 'renderer');
const webviewPreload = path.join(rootDir, 'dist', 'preload', 'webview.js');
const piWorker = path.join(rootDir, 'dist', 'main', 'pi-worker.mjs');
const katexDir = path.join(rootDir, 'dist', 'katex');
const appIcon = path.join(rootDir, 'build', 'icon.png');

/** The built-in Pi agent runs each job in its own Electron utility process. */
const spawnPi: SpawnWorker = (env) => {
  const child = utilityProcess.fork(piWorker, [], { env, serviceName: 'Glossa Pi agent', stdio: 'inherit' });
  return {
    onSpawn: (cb) => child.once('spawn', () => cb(child.pid)),
    send: (m) => child.postMessage(m),
    onMessage: (cb) => child.on('message', cb),
    onExit: (cb) => child.on('exit', cb),
    kill: () => void child.kill(),
  };
};

let win: BrowserWindow | null = null;

// The theme lives in nativeTheme: CSS (prefers-color-scheme), native dialogs and
// scrollbars follow it from the first paint. 'system' follows the OS.
const WINDOW_BG: Record<Theme | 'paper', string> = { dark: '#141518', light: '#f5f5f7', paper: '#ece5d8' };
/** Paper is a light theme to the system (dialogs, scrollbars, prefers-color-scheme). */
const windowBg = () => WINDOW_BG[store?.getSettings().theme === 'paper' ? 'paper' : shownTheme()];
const shownTheme = (): Theme => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
function applyTheme(s: Settings): void {
  const source = s.theme === 'paper' ? 'light' : s.theme;
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg());
}
nativeTheme.on('updated', () => {
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg());
});
let store: Store;
let skills: SkillRegistry;
let docs: DocumentService;
let webPdfs: WebPdfs;
let jobs: JobManager;

function osLang(): UiLang {
  const l = app.getLocale().slice(0, 2) as UiLang;
  return UI_LANGS.includes(l) ? l : 'en';
}

function registerProtocols(): void {
  protocol.handle('glossa', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'app') return new Response('Not found', { status: 404 });
    const rel = u.pathname === '/' ? 'index.html' : u.pathname;
    try {
      const body = readFileSafe(rendererDir, rel, { maxBytes: 64 * 1024 * 1024 });
      return new Response(new Uint8Array(body), {
        headers: { 'content-type': mimeFor(rel), 'content-security-policy': APP_CSP, 'x-content-type-options': 'nosniff' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  protocol.handle('glossa-out', (req) => serveOutput(req.url, jobs, store.getSettings(), shownTheme(), katexDir));
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function hardenContents(): void {
  // A PDF link clicked on a page opens in a new tab, in the PDF reader.
  lockDownSession(session.fromPartition(WEB_PARTITION), undefined, (url) => {
    webPdfs.remember(url);
    sendToRenderer(IPC.appOpenInTab, url);
  });
  // The app's own pages need no browser permissions either.
  lockDownSession(session.defaultSession);
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev, prefs, params) => {
      delete (prefs as { preloadURL?: string }).preloadURL;
      prefs.preload = webviewPreload;
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      prefs.webSecurity = true;
      // Remote pages always use the locked-down partition.
      params.partition = WEB_PARTITION;
      if (!webNavigationAllowed(params.src)) ev.preventDefault();
    });
    if (contents.getType() === 'webview') {
      contents.setWindowOpenHandler(({ url }) => {
        if (webNavigationAllowed(url)) sendToRenderer(IPC.appOpenInTab, url);
        return { action: 'deny' };
      });
      contents.on('will-navigate', (ev, url) => {
        if (!webNavigationAllowed(url)) ev.preventDefault();
      });
      contents.on('will-redirect', (ev, url) => {
        if (!webNavigationAllowed(url)) ev.preventDefault();
      });
    } else {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (ev, url) => {
        if (!url.startsWith('glossa://app/')) ev.preventDefault();
      });
      contents.on('will-frame-navigate', (ev) => {
        if (!ev.isMainFrame && !ev.url.startsWith('glossa-out://') && ev.url !== 'about:blank') ev.preventDefault();
      });
    }
  });
}

/** Remove app-owned job folders nobody needs any more (not referenced by a card or the cache). */
function cleanUp(): void {
  try {
    const keep = new Set<string>([...jobs.cache.referenced(), ...jobs.liveIds()]);
    for (const d of store.recentDocs(10_000)) for (const id of cardJobIds(store.getDoc(d.docId))) keep.add(id);
    // Shared results of kept jobs stay too.
    for (const id of [...keep]) {
      const j = jobs.get(id);
      if (j?.resultOf) keep.add(j.resultOf);
    }
    cleanJobs({ jobsDir: store.jobsDir, keep, maxAgeDays: 60, maxUnreferenced: 300 });
    jobs.cache.prune((id) => fs.existsSync(path.join(store.jobsDir, id)));
    const pictures = new Set<string>();
    for (const d of store.recentDocs(10_000)) for (const id of cardPictureIds(store.getDoc(d.docId))) pictures.add(id);
    store.captures.prune(pictures);
  } catch (err) {
    console.warn('Cleanup skipped:', (err as Error).message);
  }
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'Glossa',
    // The packaged macOS app uses build/icon.icns; elsewhere (and when run from source) the window carries the logo.
    ...(process.platform === 'darwin' ? {} : { icon: appIcon }),
    backgroundColor: windowBg(),
    show: !process.env.GLOSSA_SMOKE,
    webPreferences: {
      preload: path.join(rootDir, 'dist', 'preload', 'app.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  win.on('closed', () => (win = null));
  // Zoom belongs to the reading panels: the window itself never pinch-zooms, and the
  // zoom shortcuts (which the default menu would apply to the whole window) go to the active panel.
  void win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const dir = input.key === '=' || input.key === '+' ? 'in' : input.key === '-' || input.key === '_' ? 'out' : input.key === '0' ? 'reset' : null;
    if (!dir) return;
    e.preventDefault();
    sendToRenderer(IPC.appZoomKey, dir);
  });
  await win.loadURL('glossa://app/index.html');
  if (process.env.GLOSSA_SMOKE) {
    const { runSmoke } = await import('./smoke');
    const code = await runSmoke(win, { store, jobs, skills, docs }).catch((err) => {
      console.error('SMOKE FAILED', err);
      return 1;
    });
    // As a normal quit does (before-quit), which app.exit skips.
    jobs.shutdown();
    app.exit(code);
  }
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'), electronBackend(safeStorage), osLang());
  applyTheme(store.getSettings());
  store.onSettings = applyTheme;
  if (!fs.existsSync(store.settingsFile)) store.setSettings({});
  const migration = store.keys.migrateLegacy();
  if ('skipped' in migration) console.warn(`Legacy plain-text keys left in place: ${migration.skipped}`);
  skills = new SkillRegistry(path.join(rootDir, 'builtin-skills'), store.skillsDir);
  docs = new DocumentService();
  webPdfs = new WebPdfs(path.join(app.getPath('userData'), 'web-pdfs'), (u) => session.fromPartition(WEB_PARTITION).fetch(u));
  jobs = new JobManager({
    store,
    skills: () => skills.list(store.getSettings()),
    skillHash: (s) => skills.contentHash(s),
    docText: (id) => docs.text(id),
    emit: (state) => sendToRenderer(IPC.jobsEvent, state),
    piRunner: (o) => runPi({ ...o, spawn: spawnPi, nodeShim: process.execPath }),
    theme: shownTheme,
    approveAgent: agentApprovalDialog(() => win, () => store.getSettings()),
    confirmAgents: () => grantDialog(() => win)('agents', store.getSettings()),
  });
  registerProtocols();
  hardenContents();
  registerIpc({ win: () => win, store, skills, docs, jobs, confirmGrant: grantDialog(() => win), webviewPreload, katexDir, webPdfs });
  cleanUp();
  // Run from source on macOS, the Dock would show Electron's icon.
  if (process.platform === 'darwin' && !app.isPackaged && fs.existsSync(appIcon)) app.dock?.setIcon(appIcon);
  await createWindow();
  app.on('activate', () => {
    if (!win) void createWindow();
  });
});

app.on('before-quit', () => jobs?.shutdown());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
