// JSON-file persistence under the app's data folder. No Electron imports, so it
// can be unit-tested; secret encryption is injected.

import fs from 'node:fs';
import path from 'node:path';
import { mergeSettings } from '../shared/defaults';
import type { DocInfo, DocRecord, ProviderConfig, Settings, TermCard, UiLang } from '../shared/types';
import { CaptureStore } from './captures';
import { KeyStore, type KeyBackend, type KeyStatus } from './secrets';


export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const DOC_ID_RE = /^[a-f0-9]{16,64}$/;

export class Store {
  readonly settingsFile: string;
  readonly secretsFile: string;
  readonly docsDir: string;
  readonly jobsDir: string;
  readonly skillsDir: string;
  readonly cacheFile: string;
  readonly keys: KeyStore;
  /** Pictures of captured areas. */
  readonly captures: CaptureStore;
  private settings: Settings;
  /** Called after every settings change (the app applies the theme here). */
  onSettings?: (s: Settings) => void;

  constructor(
    readonly dir: string,
    backend: KeyBackend,
    uiLang: UiLang = 'en',
  ) {
    this.settingsFile = path.join(dir, 'settings.json');
    this.secretsFile = path.join(dir, 'secrets.json');
    this.docsDir = path.join(dir, 'docs');
    this.jobsDir = path.join(dir, 'jobs');
    this.skillsDir = path.join(dir, 'skills');
    this.cacheFile = path.join(dir, 'cache.json');
    for (const d of [dir, this.docsDir, this.jobsDir, this.skillsDir]) fs.mkdirSync(d, { recursive: true });
    this.keys = new KeyStore(this.secretsFile, backend);
    this.captures = new CaptureStore(path.join(dir, 'captures'));
    this.settings = mergeSettings(readJson<Partial<Settings> | undefined>(this.settingsFile, undefined), uiLang);
  }

  getSettings(): Settings {
    return this.settings;
  }

  setSettings(patch: Partial<Settings>): Settings {
    const next = mergeSettings({ ...this.settings, ...patch }, this.settings.uiLang);
    writeJson(this.settingsFile, next);
    this.settings = next;
    this.onSettings?.(next);
    return this.settings;
  }

  saveConnection(cfg: ProviderConfig, key: string, mode: 'persist' | 'session', useFor: 'none' | 'quick' | 'direct' | 'both'): Settings {
    if (!cfg.selection) throw new Error('A tested model selection is required.');
    const providers = this.settings.providers.filter((p) => p.id !== cfg.id);
    if (providers.length >= 20) throw new Error('At most 20 connections can be saved.');
    const defaults = { ...this.settings.defaults };
    for (const name of ['quick', 'direct'] as const) {
      if (useFor === 'both' || useFor === name || defaults[name].providerId === cfg.id) {
        const limit = cfg.models?.find((m) => m.id === cfg.selection!.model)?.maxOutputTokens;
        defaults[name] = { ...defaults[name], providerId: cfg.id, ...cfg.selection, maxTokens: Math.min(defaults[name].maxTokens, limit ?? defaults[name].maxTokens) };
      }
    }
    return this.keys.transaction(() => {
      this.setKey(cfg.id, key, mode);
      return this.setSettings({ providers: [...providers, cfg], defaults });
    });
  }

  removeConnection(id: string): Settings {
    if (['anthropic', 'openai', 'ollama', 'demo'].includes(id)) throw new Error('Built-in legacy configurations can be edited or have their key cleared.');
    if (this.settings.defaults.quick.providerId === id || this.settings.defaults.direct.providerId === id ||
        this.settings.harnesses.some((h) => h.keyFromProvider === id) ||
        Object.values(this.settings.skillOverrides).some((s) => s.direct?.providerId === id)) {
      throw new Error('This connection is in use. Choose another connection in Models & effort, skills or agent harnesses before removing it.');
    }
    return this.keys.transaction(() => {
      this.setKey(id, null);
      return this.setSettings({ providers: this.settings.providers.filter((p) => p.id !== id) });
    });
  }

  // --- secrets (see secrets.ts) ----------------------------------------------

  getKey(providerId: string): string | undefined {
    return this.keys.get(providerId);
  }

  setKey(providerId: string, key: string | null, mode: 'persist' | 'session' = 'persist'): void {
    this.keys.set(providerId, key, mode);
  }

  keyStatus(): KeyStatus {
    return this.keys.status();
  }

  // --- documents -----------------------------------------------------------

  private docFile(docId: string): string {
    if (!DOC_ID_RE.test(docId)) throw new Error('Invalid document id');
    return path.join(this.docsDir, `${docId}.json`);
  }

  getDoc(docId: string): DocRecord | undefined {
    return readJson<DocRecord | undefined>(this.docFile(docId), undefined);
  }

  touchDoc(info: DocInfo): DocRecord {
    const rec = this.getDoc(info.docId);
    const next: DocRecord = { ...(rec ?? { termCards: [] }), ...info, openedAt: Date.now() };
    writeJson(this.docFile(info.docId), next);
    return next;
  }

  /** Writes cards in the current form; cards saved by older versions are dropped then. */
  saveCards(docId: string, cards: TermCard[]): void {
    const rec = this.getDoc(docId);
    if (!rec) throw new Error('Unknown document');
    const { cards: _legacy, ...rest } = rec;
    writeJson(this.docFile(docId), { ...rest, termCards: cards });
  }

  recentDocs(limit = 20): DocInfo[] {
    const out: DocInfo[] = [];
    for (const f of fs.readdirSync(this.docsDir)) {
      if (!f.endsWith('.json')) continue;
      const rec = readJson<DocRecord | undefined>(path.join(this.docsDir, f), undefined);
      if (rec) out.push({ docId: rec.docId, kind: rec.kind, title: rec.title, source: rec.source, openedAt: rec.openedAt });
    }
    return out.sort((a, b) => b.openedAt - a.openedAt).slice(0, limit);
  }

  // --- agent trust (main process only) -------------------------------------

  setTrust(skill: string, token: string): void {
    this.setSettings({ agentTrust: { ...this.settings.agentTrust, [skill]: token } });
  }
}
