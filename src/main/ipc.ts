// IPC handlers. Every argument is checked at runtime (validate.ts) before use,
// and only the app's own window may call.

import os from 'node:os';
import path from 'node:path';
import { app, dialog, ipcMain, shell, type BrowserWindow, type WebContents } from 'electron';
import { ConnectionService } from './connections';
import { connectionRequestId, connectionSave, connectionTest } from './connection-validation';
import { IPC } from '../shared/api';
import type { DocInfo } from '../shared/types';
import { CODE_EXTS, DocumentService, FILE_KINDS } from './documents';
import { probeHarness } from './harness-probe';
import { errorMessage, type JobManager } from './jobs';
import { MAX_CAPTURE_SIDE } from './captures';
import { createProvider } from './providers';
import { authorizeSettingsPatch, type GrantConfirm } from './settings-policy';
import type { SkillRegistry } from './skills';
import type { Store } from './store';
import { str, vAbsPath, vCaptureId, vCaptureRect, vDocId, vJobId, vJobRequest, vModel, vParsedSkill, vProviderId, vSettingsPatch, vSkillName, vTermCards, vUrl } from './validate';

export interface IpcDeps {
  win: () => BrowserWindow | null;
  store: Store;
  skills: SkillRegistry;
  docs: DocumentService;
  jobs: JobManager;
  confirmGrant: GrantConfirm;
  webviewPreload: string;
}

export function registerIpc(d: IpcDeps): void {
  const { store, skills, docs, jobs } = d;
  const isFromApp = (sender: WebContents) => {
    const w = d.win();
    return !!w && sender.id === w.webContents.id;
  };
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (e, ...args) => {
      if (!isFromApp(e.sender)) throw new Error('Unauthorized');
      return fn(...args);
    });
  };
  const skillList = () => skills.list(store.getSettings());
  const connections = new ConnectionService(store);
  app.once('before-quit', () => connections.dispose());
  handle(IPC.connectionsTest, (req) => connections.test(connectionTest(req)));
  handle(IPC.connectionsSave, (req) => connections.save(connectionSave(req)));
  handle(IPC.connectionsCancel, (requestId, ticket) => connections.cancel(connectionRequestId(requestId), ticket === undefined ? undefined : connectionRequestId(ticket)));
  handle(IPC.connectionsRemove, (id) => store.removeConnection(vProviderId(id)));

  handle(IPC.settingsGet, () => store.getSettings());
  handle(IPC.settingsSet, async (raw) => {
    const patch = await authorizeSettingsPatch(store.getSettings(), vSettingsPatch(raw), d.confirmGrant);
    return store.setSettings(patch);
  });
  // Output folders are only ever set from this dialog (see assertOutputDirs).
  handle(IPC.settingsChooseOutputDir, async (skill) => {
    const name = skill === undefined || skill === null ? undefined : vSkillName(skill);
    const w = d.win();
    const cur = store.getSettings();
    const r = w
      ? await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'], title: 'Choose where results are saved', defaultPath: (name && cur.skillOverrides[name]?.outputDir) || cur.outputDir || app.getPath('documents') })
      : { canceled: true, filePaths: [] };
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = path.resolve(r.filePaths[0]);
    if (!name) return store.setSettings({ outputDir: dir });
    return store.setSettings({ skillOverrides: { ...cur.skillOverrides, [name]: { ...cur.skillOverrides[name], outputDir: dir } } });
  });
  handle(IPC.agentForgetTrust, () => store.setSettings({ agentTrust: {} }));
  handle(IPC.agentIsolation, () => jobs.isolation());
  handle(IPC.harnessProbe, async (id) => {
    const h = store.getSettings().harnesses.find((x) => x.id === str(id, 'harness id', 40));
    if (!h) throw new Error('Unknown harness');
    return probeHarness(h, os.tmpdir());
  });

  handle(IPC.keysStatus, () => store.keyStatus());
  handle(IPC.keysSet, (id, key, mode) => {
    const k = key === null ? null : str(key, 'key', 4096).trim() || null;
    store.setKey(vProviderId(id), k, mode === 'session' ? 'session' : 'persist');
    return store.keyStatus();
  });
  handle(IPC.keysRemovePlaintext, () => {
    store.keys.removeLegacyPlaintext();
    return store.keyStatus();
  });
  handle(IPC.keysTest, async (id, model) => {
    // A real (small) request, only when the user clicks "Test".
    const cfg = store.getSettings().providers.find((p) => p.id === vProviderId(id));
    if (!cfg) return { ok: false, message: 'Unknown provider' };
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30_000).unref();
      const r = await createProvider(cfg, store.getKey(cfg.id)).stream({
        system: [{ text: 'You are a connectivity check.' }],
        user: 'Reply with the single word OK.',
        model: vModel(model),
        effort: 'low',
        maxTokens: 512,
        signal: ac.signal,
        onText: () => {},
      });
      return { ok: true, message: r.text.trim().slice(0, 80) || 'OK' };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  });

  handle(IPC.skillsList, skillList);
  handle(IPC.skillsRead, (name) => skills.read(vSkillName(name), store.getSettings()));
  handle(IPC.skillsSave, (p, previousName) => {
    skills.save(vParsedSkill(p), previousName === undefined || previousName === null ? undefined : vSkillName(previousName));
    return skillList();
  });
  handle(IPC.skillsRemove, (name) => {
    skills.remove(vSkillName(name));
    return skillList();
  });
  handle(IPC.skillsImport, async () => {
    const w = d.win();
    const r = w ? await dialog.showOpenDialog(w, { properties: ['openDirectory'], title: 'Choose a skill folder (with SKILL.md)' }) : { canceled: true, filePaths: [] };
    if (r.canceled || !r.filePaths[0]) return null;
    skills.importFolder(r.filePaths[0], true);
    return skillList();
  });
  handle(IPC.skillsInstall, async (name) => {
    await skills.installKnown(vSkillName(name));
    return skillList();
  });

  const remember = (info: DocInfo) => {
    store.touchDoc(info);
    return info;
  };
  handle(IPC.docsOpenFiles, async () => {
    const w = d.win();
    if (!w) return [];
    const r = await dialog.showOpenDialog(w, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All supported files', extensions: Object.keys(FILE_KINDS).map((e) => e.slice(1)) },
        { name: 'Documents', extensions: ['pdf', 'docx', 'md', 'markdown', 'txt', 'html', 'htm'] },
        { name: 'Source code and data', extensions: [...CODE_EXTS, 'html', 'htm'] },
      ],
    });
    if (r.canceled) return [];
    const out: DocInfo[] = [];
    for (const f of r.filePaths) out.push(remember(await docs.describeFile(f)));
    return out;
  });
  // Drag and drop: the user chose the file; only supported document types are opened.
  handle(IPC.docsOpenPath, async (file) => remember(await docs.describeFile(path.resolve(vAbsPath(file)))));
  handle(IPC.docsOpenUrl, (url) => remember(docs.describeUrl(vUrl(url))));
  handle(IPC.docsReopen, async (raw) => {
    const info = raw as DocInfo;
    if (!info || typeof info !== 'object') throw new Error('Invalid document');
    if (info.kind === 'web') return remember(docs.describeUrl(vUrl(info.source)));
    return remember(await docs.describeFile(vAbsPath(info.source)));
  });
  handle(IPC.docsLoad, (id) => docs.load(vDocId(id)));
  // Only the app's own window is captured, and only what it shows: the reader dragged over this area.
  handle(IPC.captureArea, async (raw) => {
    const w = d.win();
    if (!w) throw new Error('No window');
    const r = vCaptureRect(raw);
    const [cw, ch] = w.getContentSize();
    const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(Math.min(r.width, cw - r.x)), height: Math.round(Math.min(r.height, ch - r.y)) };
    if (rect.width < 4 || rect.height < 4) throw new Error('The area is too small.');
    let img = await w.webContents.capturePage(rect);
    const { width, height } = img.getSize();
    if (Math.max(width, height) > MAX_CAPTURE_SIDE) img = img.resize(width >= height ? { width: MAX_CAPTURE_SIDE, quality: 'best' } : { height: MAX_CAPTURE_SIDE, quality: 'best' });
    const size = img.getSize();
    return { id: store.captures.save(img.toPNG()), w: size.width, h: size.height };
  });
  handle(IPC.capturePicture, (id) => store.captures.dataUrl(vCaptureId(id)));
  handle(IPC.docsSetText, (id, text, title) => {
    const docId = vDocId(id);
    docs.setText(docId, str(text, 'text', 5_000_000));
    const info = docs.info(docId);
    const t = title === undefined || title === null ? undefined : str(title, 'title', 1000);
    if (info && t && t !== info.title) store.touchDoc({ ...info, title: t });
  });
  handle(IPC.docsClose, (id) => docs.release(vDocId(id)));
  handle(IPC.docsRecord, (id) => store.getDoc(vDocId(id)));
  handle(IPC.docsSaveCards, (id, cards) => store.saveCards(vDocId(id), vTermCards(cards)));
  handle(IPC.docsRecent, () => store.recentDocs());

  handle(IPC.jobsStart, (raw) => jobs.start(vJobRequest(raw)));
  handle(IPC.jobsCancel, (id) => jobs.cancel(vJobId(id)));
  handle(IPC.jobsGet, (id) => jobs.get(vJobId(id)));
  handle(IPC.jobsOutputText, (id) => jobs.outputText(vJobId(id)));
  handle(IPC.jobsShowSaved, (id) => {
    const p = jobs.savedCopy(vJobId(id));
    if (p) shell.showItemInFolder(p);
    return !!p;
  });

  handle(IPC.appWebviewPreload, () => `file://${d.webviewPreload}`);
  handle(IPC.appOpenExternal, async (url) => {
    const u = vUrl(url);
    if (/^https?:\/\//.test(u)) await shell.openExternal(u);
  });
}
