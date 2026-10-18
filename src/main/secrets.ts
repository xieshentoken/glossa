// API keys. Persisted only when the OS offers real protection; otherwise kept
// for this session in memory. Plain text is never written by this version.

import fs from 'node:fs';
import type { KeyStatus } from '../shared/api';
import { readJson, writeJson } from './store';

export type { KeyStatus };

export interface KeyBackend {
  /** ok=false when there is no real protection (no keychain, or Linux "basic_text"). */
  protection(): { ok: boolean; reason?: string };
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export class KeyStorageUnavailable extends Error {
  constructor(reason: string) {
    super(`Keys cannot be saved securely on this system (${reason}). Use "this session only" instead.`);
    this.name = 'KeyStorageUnavailable';
  }
}

type Entry = { v: string; enc: boolean };


export class KeyStore {
  private session = new Map<string, string>();

  constructor(
    readonly file: string,
    private backend: KeyBackend,
  ) {}

  private entries(): Record<string, Entry> {
    return readJson<Record<string, Entry>>(this.file, {});
  }

  private write(all: Record<string, Entry>): void {
    writeJson(this.file, all);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // not supported on this file system
    }
  }

  get(id: string): string | undefined {
    const s = this.session.get(id);
    if (s) return s;
    const e = this.entries()[id];
    if (!e) return undefined;
    if (!e.enc) return e.v; // legacy plaintext, still on disk until the user removes or migrates it
    try {
      return this.backend.decrypt(e.v);
    } catch {
      return undefined;
    }
  }

  /** Roll back a failed connection save, including session-only replacements. */
  transaction<T>(commit: () => T): T {
    const before = fs.existsSync(this.file) ? fs.readFileSync(this.file) : undefined;
    const session = new Map(this.session);
    try { return commit(); } catch (error) {
      this.session = session;
      try {
        if (before) { fs.writeFileSync(this.file, before, { mode: 0o600 }); }
        else if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Connection save failed and key rollback failed.');
      }
      throw error;
    }
  }

  /** mode 'persist' needs real protection; it never falls back to plain text. */
  set(id: string, key: string | null, mode: 'persist' | 'session' = 'persist'): void {
    const all = this.entries();
    if (!key) {
      this.session.delete(id);
      if (id in all) {
        delete all[id];
        this.write(all);
      }
      return;
    }
    if (mode === 'session') {
      this.session.set(id, key);
      if (all[id] && !all[id].enc) {
        // Replacing a legacy plaintext key: drop the old copy from disk.
        delete all[id];
        this.write(all);
      }
      return;
    }
    const p = this.backend.protection();
    if (!p.ok) throw new KeyStorageUnavailable(p.reason ?? 'no keychain');
    all[id] = { v: this.backend.encrypt(key), enc: true };
    this.write(all);
    this.session.delete(id);
  }

  status(): KeyStatus {
    const all = this.entries();
    const keys: KeyStatus['keys'] = {};
    for (const [id, e] of Object.entries(all)) keys[id] = e.enc ? 'stored' : 'plaintext';
    for (const id of this.session.keys()) keys[id] = 'session';
    const p = this.backend.protection();
    return { keys, persistent: p.ok, reason: p.reason, legacyPlaintext: Object.entries(all).filter(([, e]) => !e.enc).map(([id]) => id) };
  }

  /**
   * Encrypt keys an older version stored as plain text. The encrypted copy is
   * written and read back first; only then is the plain-text file replaced. If
   * protection is unavailable nothing changes (no loss, no new plain text).
   */
  migrateLegacy(): { migrated: string[]; skipped: string } | { migrated: string[] } {
    const all = this.entries();
    const legacy = Object.entries(all).filter(([, e]) => !e.enc);
    if (!legacy.length) return { migrated: [] };
    const p = this.backend.protection();
    if (!p.ok) return { migrated: [], skipped: p.reason ?? 'no keychain' };
    const next: Record<string, Entry> = { ...all };
    for (const [id, e] of legacy) {
      const enc = this.backend.encrypt(e.v);
      if (this.backend.decrypt(enc) !== e.v) return { migrated: [], skipped: 'verification failed' };
      next[id] = { v: enc, enc: true };
    }
    const tmp = `${this.file}.migrate`;
    writeJson(tmp, next);
    const back = readJson<Record<string, Entry>>(tmp, {});
    for (const [id, e] of legacy) {
      if (!back[id]?.enc || this.backend.decrypt(back[id].v) !== e.v) {
        fs.rmSync(tmp, { force: true });
        return { migrated: [], skipped: 'verification failed' };
      }
    }
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // not supported
    }
    return { migrated: legacy.map(([id]) => id) };
  }

  /** Explicit user action: delete plain-text keys left by an older version. */
  removeLegacyPlaintext(): string[] {
    const all = this.entries();
    const ids = Object.entries(all).filter(([, e]) => !e.enc).map(([id]) => id);
    for (const id of ids) delete all[id];
    if (ids.length) this.write(all);
    return ids;
  }
}

/** Electron safeStorage adapter. On Linux "basic_text" is an obfuscation with a fixed key, not protection. */
export function electronBackend(safeStorage: {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  getSelectedStorageBackend?: () => string;
}, platform = process.platform): KeyBackend {
  return {
    protection() {
      if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: 'no system keychain available' };
      if (platform === 'linux') {
        const b = safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
        if (b === 'basic_text' || b === 'unknown') return { ok: false, reason: `Linux secret service not available (backend: ${b})` };
      }
      return { ok: true };
    },
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
  };
}
