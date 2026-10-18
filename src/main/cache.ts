// Result cache. A key is the hash of everything that changes the answer; a hit
// points at a finished job whose output is then shared (never its document,
// card or ownership).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { readJson, writeJson } from './store';

/** Bump when the key recipe changes. Entries written under other versions are ignored. */
export const CACHE_VERSION = 2;

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

export interface CacheIdentity {
  docId: string;
  /** Hash of the document text actually sent, or null when it was not sent. */
  docTextHash: string | null;
  context: { term: string; sentence: string; paragraph: string; heading: string };
  scope: string;
  skill: { name: string; contentHash: string; runner: string; output: string; task: string };
  explainLang: string;
  profile: string;
  theme: string;
  /** Engine identity: provider/harness id, endpoint or command, model and generation parameters. No secrets. */
  engine: Record<string, string | number | boolean>;
}

export function cacheKey(id: CacheIdentity): string {
  return sha256(stableStringify({ v: CACHE_VERSION, ...id }));
}

interface CacheFile {
  version: number;
  entries: Record<string, string>;
}

export class ResultCache {
  constructor(private file: string) {}

  private read(): CacheFile {
    const raw = readJson<Partial<CacheFile> | Record<string, string>>(this.file, {});
    if ((raw as CacheFile).version === CACHE_VERSION && typeof (raw as CacheFile).entries === 'object') return raw as CacheFile;
    // Legacy (unversioned) or other versions: keys were built differently, so none can be trusted.
    return { version: CACHE_VERSION, entries: {} };
  }

  get(key: string): string | undefined {
    return this.read().entries[key];
  }

  set(key: string, jobId: string): void {
    const f = this.read();
    f.entries[key] = jobId;
    writeJson(this.file, f);
  }

  delete(key: string): void {
    const f = this.read();
    if (!(key in f.entries)) return;
    delete f.entries[key];
    writeJson(this.file, f);
  }

  /** Drop entries pointing at jobs that no longer exist. */
  prune(exists: (jobId: string) => boolean): number {
    const f = this.read();
    let n = 0;
    for (const [k, id] of Object.entries(f.entries)) {
      if (!exists(id)) {
        delete f.entries[k];
        n++;
      }
    }
    if (n || !fs.existsSync(this.file)) writeJson(this.file, f);
    return n;
  }

  referenced(): Set<string> {
    return new Set(Object.values(this.read().entries));
  }
}
