// The API the preload script exposes to the renderer as `window.glossa`.

import type { ParsedSkill } from './skills';
import type { ConnectionsApi } from './connections';
import type { DocInfo, DocRecord, JobRequest, JobState, Settings, SkillInfo, TermCard } from './types';

export type LoadedDoc =
  | { kind: 'pdf'; data: Uint8Array }
  | { kind: 'html'; html: string; text?: string }
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
    onEvent(cb: (job: JobState) => void): () => void;
  };
  app: {
    platform: string;
    /** Absolute path of a dropped file. */
    pathForFile(file: File): string;
    webviewPreload(): Promise<string>;
    openExternal(url: string): Promise<void>;
    onOpenInTab(cb: (url: string) => void): () => void;
  };
}

export const IPC = {
  connectionsTest: 'connections:test',
  connectionsSave: 'connections:save',
  connectionsCancel: 'connections:cancel',
  connectionsRemove: 'connections:remove',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  keysStatus: 'keys:status',
  keysSet: 'keys:set',
  keysTest: 'keys:test',
  keysRemovePlaintext: 'keys:removePlaintext',
  agentIsolation: 'agent:isolation',
  agentForgetTrust: 'agent:forgetTrust',
  harnessProbe: 'agent:probe',
  docsClose: 'docs:close',
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
  jobsEvent: 'jobs:event',
  appWebviewPreload: 'app:webviewPreload',
  appOpenExternal: 'app:openExternal',
  appOpenInTab: 'app:openInTab',
} as const;
