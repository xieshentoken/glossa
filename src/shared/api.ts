// The API the preload script exposes to the renderer as `window.glossa`.

import type { ParsedSkill } from './skills';
import type { ConnectionsApi } from './connections';
import type { UsageStatus, CardCapture, DocInfo, DocRecord, JobRequest, JobState, OutputKind, Settings, SkillInfo, TermCard, ViewTheme } from './types';

export type LoadedDoc =
  | { kind: 'pdf'; data: Uint8Array }
  | { kind: 'html'; html: string; text?: string }
  | { kind: 'code'; text: string }
  | { kind: 'web'; url: string };

export interface KeyStatus {
  keys: Record<string, 'stored' | 'session' | 'plaintext'>;
  /** Keys can be saved with real OS protection. */
  persistent: boolean;
  reason?: string;
  /** Providers whose key an older version stored unencrypted. */
  legacyPlaintext: string[];
}

export interface IsolationInfo {
  isolated: boolean;
  mode: string;
  detail: string;
  toolsFound: string[];
}

export interface HarnessProbeInfo {
  status: 'missing' | 'ok' | 'flags-missing' | 'error';
  binary: string;
  version?: string;
  missingFlags: string[];
  detail?: string;
}

export interface GlossaApi {
  connections: ConnectionsApi;
  settings: {
    get(): Promise<Settings>;
    /** Widening data or agent permissions shows a confirmation in the main process; it rejects if declined. */
    set(patch: Partial<Settings>): Promise<Settings>;
    /** Folder dialog for where results are saved (all skills, or one skill); null when cancelled. */
    chooseOutputDir(skill?: string): Promise<Settings | null>;
  };
  agent: {
    isolation(): Promise<IsolationInfo>;
    forgetTrust(): Promise<Settings>;
    probe(harnessId: string): Promise<HarnessProbeInfo>;
  };
  keys: {
    status(): Promise<KeyStatus>;
    set(providerId: string, key: string | null, mode?: 'persist' | 'session'): Promise<KeyStatus>;
    removePlaintext(): Promise<KeyStatus>;
    test(providerId: string, model: string): Promise<{ ok: boolean; message: string }>;
  };
  skills: {
    list(): Promise<SkillInfo[]>;
    read(name: string): Promise<{ parsed: ParsedSkill; source: SkillInfo['source'] }>;
    save(p: ParsedSkill, previousName?: string): Promise<SkillInfo[]>;
    remove(name: string): Promise<SkillInfo[]>;
    importFolder(): Promise<SkillInfo[] | null>;
    installKnown(name: string): Promise<SkillInfo[]>;
  };
  usage: {
    /** What each connection used in its current period, with its limit. */
    status(): Promise<UsageStatus[]>;
  };
  capture: {
    /** Takes a picture of this rectangle of the window (CSS pixels): the area the reader dragged over. */
    area(rect: { x: number; y: number; width: number; height: number }): Promise<Omit<CardCapture, 'send'>>;
    /** A stored picture as a data URL, for the card; undefined when it is gone. */
    picture(id: string): Promise<string | undefined>;
  };
  docs: {
    openFiles(): Promise<DocInfo[]>;
    openPath(file: string): Promise<DocInfo>;
    openUrl(url: string): Promise<DocInfo>;
    reopen(info: DocInfo): Promise<DocInfo>;
    load(docId: string): Promise<LoadedDoc>;
    setText(docId: string, text: string, title?: string): Promise<void>;
    close(docId: string): Promise<void>;
    record(docId: string): Promise<DocRecord | undefined>;
    saveCards(docId: string, cards: TermCard[]): Promise<void>;
    recent(): Promise<DocInfo[]>;
  };
  jobs: {
    start(req: JobRequest): Promise<JobState>;
    cancel(id: string): Promise<void>;
    get(id: string): Promise<JobState | undefined>;
    /** A finished result as text, for the card's plain view (HTML results as their source). */
    outputText(id: string): Promise<{ output: OutputKind; text: string } | undefined>;
    /** Shows the saved copy of a result in the file manager; false when it is gone. */
    showSaved(id: string): Promise<boolean>;
    /** Saves the result as an HTML page where the user chooses; the path written, or null when cancelled. */
    exportHtml(id: string, theme: ViewTheme): Promise<string | null>;
    onEvent(cb: (job: JobState) => void): () => void;
  };
  app: {
    platform: string;
    /** Absolute path of a dropped file. */
    pathForFile(file: File): string;
    webviewPreload(): Promise<string>;
    openExternal(url: string): Promise<void>;
    onOpenInTab(cb: (url: string) => void): () => void;
    /** Ctrl/Cmd + = − 0: zoom the active reading panel (not the whole window). */
    onZoomKey(cb: (dir: 'in' | 'out' | 'reset') => void): () => void;
  };
}

export const IPC = {
  connectionsTest: 'connections:test',
  connectionsSave: 'connections:save',
  connectionsCancel: 'connections:cancel',
  connectionsRemove: 'connections:remove',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChooseOutputDir: 'settings:chooseOutputDir',
  keysStatus: 'keys:status',
  keysSet: 'keys:set',
  keysTest: 'keys:test',
  keysRemovePlaintext: 'keys:removePlaintext',
  agentIsolation: 'agent:isolation',
  agentForgetTrust: 'agent:forgetTrust',
  harnessProbe: 'agent:probe',
  docsClose: 'docs:close',
  captureArea: 'capture:area',
  usageStatus: 'usage:status',
  capturePicture: 'capture:picture',
  skillsList: 'skills:list',
  skillsRead: 'skills:read',
  skillsSave: 'skills:save',
  skillsRemove: 'skills:remove',
  skillsImport: 'skills:import',
  skillsInstall: 'skills:install',
  docsOpenFiles: 'docs:openFiles',
  docsOpenPath: 'docs:openPath',
  docsOpenUrl: 'docs:openUrl',
  docsReopen: 'docs:reopen',
  docsLoad: 'docs:load',
  docsSetText: 'docs:setText',
  docsRecord: 'docs:record',
  docsSaveCards: 'docs:saveCards',
  docsRecent: 'docs:recent',
  jobsStart: 'jobs:start',
  jobsCancel: 'jobs:cancel',
  jobsGet: 'jobs:get',
  jobsOutputText: 'jobs:outputText',
  jobsShowSaved: 'jobs:showSaved',
  jobsExportHtml: 'jobs:exportHtml',
  jobsEvent: 'jobs:event',
  appWebviewPreload: 'app:webviewPreload',
  appOpenExternal: 'app:openExternal',
  appOpenInTab: 'app:openInTab',
  appZoomKey: 'app:zoomKey',
} as const;
