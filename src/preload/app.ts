import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type GlossaApi } from '../shared/api';
import type { JobState } from '../shared/types';

const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

const api: GlossaApi = {
  connections: {
    test: (req) => invoke(IPC.connectionsTest, req),
    save: (req) => invoke(IPC.connectionsSave, req),
    cancel: (requestId, ticket) => invoke(IPC.connectionsCancel, requestId, ticket),
    remove: (id) => invoke(IPC.connectionsRemove, id),
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch),
    chooseOutputDir: (skill) => invoke(IPC.settingsChooseOutputDir, skill),
  },
  agent: {
    isolation: () => invoke(IPC.agentIsolation),
    forgetTrust: () => invoke(IPC.agentForgetTrust),
    probe: (id) => invoke(IPC.harnessProbe, id),
  },
  keys: {
    status: () => invoke(IPC.keysStatus),
    set: (id, key, mode) => invoke(IPC.keysSet, id, key, mode),
    removePlaintext: () => invoke(IPC.keysRemovePlaintext),
    test: (id, model) => invoke(IPC.keysTest, id, model),
  },
  skills: {
    list: () => invoke(IPC.skillsList),
    read: (name) => invoke(IPC.skillsRead, name),
    save: (p, prev) => invoke(IPC.skillsSave, p, prev),
    remove: (name) => invoke(IPC.skillsRemove, name),
    importFolder: () => invoke(IPC.skillsImport),
    installKnown: (name) => invoke(IPC.skillsInstall, name),
  },
  usage: {
    status: () => invoke(IPC.usageStatus),
  },
  capture: {
    area: (rect) => invoke(IPC.captureArea, rect),
    picture: (id) => invoke(IPC.capturePicture, id),
  },
  docs: {
    openFiles: () => invoke(IPC.docsOpenFiles),
    openPath: (file) => invoke(IPC.docsOpenPath, file),
    openUrl: (url) => invoke(IPC.docsOpenUrl, url),
    reopen: (info) => invoke(IPC.docsReopen, info),
    load: (id) => invoke(IPC.docsLoad, id),
    setText: (id, text, title) => invoke(IPC.docsSetText, id, text, title),
    close: (id) => invoke(IPC.docsClose, id),
    record: (id) => invoke(IPC.docsRecord, id),
    saveCards: (id, cards) => invoke(IPC.docsSaveCards, id, cards),
    recent: () => invoke(IPC.docsRecent),
  },
  jobs: {
    start: (req) => invoke(IPC.jobsStart, req),
    cancel: (id) => invoke(IPC.jobsCancel, id),
    get: (id) => invoke(IPC.jobsGet, id),
    outputText: (id) => invoke(IPC.jobsOutputText, id),
    showSaved: (id) => invoke(IPC.jobsShowSaved, id),
    exportHtml: (id, theme) => invoke(IPC.jobsExportHtml, id, theme),
    onEvent: (cb) => {
      const l = (_e: unknown, job: JobState) => cb(job);
      ipcRenderer.on(IPC.jobsEvent, l);
      return () => ipcRenderer.removeListener(IPC.jobsEvent, l);
    },
  },
  app: {
    platform: process.platform,
    pathForFile: (file) => webUtils.getPathForFile(file),
    webviewPreload: () => invoke(IPC.appWebviewPreload),
    openExternal: (url) => invoke(IPC.appOpenExternal, url),
    onOpenInTab: (cb) => {
      const l = (_e: unknown, url: string) => cb(url);
      ipcRenderer.on(IPC.appOpenInTab, l);
      return () => ipcRenderer.removeListener(IPC.appOpenInTab, l);
    },
    onZoomKey: (cb) => {
      const l = (_e: unknown, dir: 'in' | 'out' | 'reset') => cb(dir);
      ipcRenderer.on(IPC.appZoomKey, l);
      return () => ipcRenderer.removeListener(IPC.appZoomKey, l);
    },
  },
};

contextBridge.exposeInMainWorld('glossa', api);
