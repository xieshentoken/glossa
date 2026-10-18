// P0-7: key storage without plain-text fallback; default-deny web permissions.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { electronBackend, KeyStorageUnavailable, KeyStore, type KeyBackend } from '../src/main/secrets';
import { lockDownSession, webNavigationAllowed, type SessionLike } from '../src/main/web-security';
import { tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const working: KeyBackend = {
  protection: () => ({ ok: true }),
  encrypt: (s) => Buffer.from(s).toString('base64').split('').reverse().join(''),
  decrypt: (s) => Buffer.from(s.split('').reverse().join(''), 'base64').toString(),
};
const unavailable: KeyBackend = { ...working, protection: () => ({ ok: false, reason: 'no keychain' }) };
const KEY = 'sk-synthetic-test-only-00000000000000000000';
const onDisk = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

describe('KeyStore', () => {
  it('without protection, refuses to persist and writes nothing', () => {
    const f = path.join(dir, 'secrets.json');
    const ks = new KeyStore(f, unavailable);
    expect(() => ks.set('anthropic', KEY, 'persist')).toThrow(KeyStorageUnavailable);
    expect(onDisk(f)).not.toContain(KEY);
  });

  it('session keys work for requests and are gone after a restart', () => {
    const f = path.join(dir, 'secrets.json');
    const ks = new KeyStore(f, unavailable);
    ks.set('anthropic', KEY, 'session');
    expect(ks.get('anthropic')).toBe(KEY);
    expect(ks.status().keys).toEqual({ anthropic: 'session' });
    expect(onDisk(f)).not.toContain(KEY);
    expect(new KeyStore(f, unavailable).get('anthropic')).toBeUndefined();
  });

  it('with protection, stores encrypted', () => {
    const f = path.join(dir, 'secrets.json');
    new KeyStore(f, working).set('anthropic', KEY);
    expect(onDisk(f)).not.toContain(KEY);
    expect(new KeyStore(f, working).get('anthropic')).toBe(KEY);
  });

  it('migrates legacy plain text only after the encrypted copy verifies', () => {
    const f = path.join(dir, 'secrets.json');
    fs.writeFileSync(f, JSON.stringify({ anthropic: { v: KEY, enc: false } }));
    const ks = new KeyStore(f, working);
    expect(ks.status().legacyPlaintext).toEqual(['anthropic']);
    expect(ks.migrateLegacy()).toEqual({ migrated: ['anthropic'] });
    expect(onDisk(f)).not.toContain(KEY);
    expect(new KeyStore(f, working).get('anthropic')).toBe(KEY);
  });

  it('a failed migration keeps the old file (no loss) and adds no plain text', () => {
    const f = path.join(dir, 'secrets.json');
    const before = JSON.stringify({ anthropic: { v: KEY, enc: false } });
    fs.writeFileSync(f, before);
    const broken: KeyBackend = { ...working, decrypt: () => 'garbage' };
    expect(new KeyStore(f, broken).migrateLegacy()).toMatchObject({ migrated: [], skipped: 'verification failed' });
    expect(onDisk(f)).toBe(before);
    expect(new KeyStore(f, unavailable).migrateLegacy()).toMatchObject({ migrated: [], skipped: 'no keychain' });
    expect(onDisk(f)).toBe(before);
    expect(fs.existsSync(`${f}.migrate`)).toBe(false);
  });

  it('removing legacy plain text is an explicit action', () => {
    const f = path.join(dir, 'secrets.json');
    fs.writeFileSync(f, JSON.stringify({ a: { v: KEY, enc: false }, b: { v: 'x', enc: true } }));
    expect(new KeyStore(f, unavailable).removeLegacyPlaintext()).toEqual(['a']);
    expect(onDisk(f)).not.toContain(KEY);
  });

  it("treats Linux 'basic_text' as no protection", () => {
    const ss = (backend: string) => ({ isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString(), getSelectedStorageBackend: () => backend });
    expect(electronBackend(ss('basic_text'), 'linux').protection().ok).toBe(false);
    expect(electronBackend(ss('gnome_libsecret'), 'linux').protection().ok).toBe(true);
    expect(electronBackend(ss('unknown'), 'darwin').protection().ok).toBe(true);
    expect(electronBackend({ ...ss('x'), isEncryptionAvailable: () => false }, 'darwin').protection().ok).toBe(false);
  });
});

describe('web session policy', () => {
  it('denies every permission request and check, devices, screen capture and downloads', () => {
    const h: Record<string, (...a: never[]) => unknown> = {};
    const ses: SessionLike = {
      setPermissionRequestHandler: (f) => void (h.req = f as never),
      setPermissionCheckHandler: (f) => void (h.check = f as never),
      setDevicePermissionHandler: (f) => void (h.device = f as never),
      setDisplayMediaRequestHandler: (f) => void (h.display = f as never),
      on: (_e, f) => void (h.download = f as never),
    };
    lockDownSession(ses);
    for (const p of ['geolocation', 'media', 'notifications', 'clipboard-read', 'midi', 'openExternal', 'fullscreen']) {
      let answer: boolean | undefined;
      (h.req as (wc: unknown, p: string, cb: (ok: boolean) => void) => void)(null, p, (ok) => (answer = ok));
      expect(answer).toBe(false);
      expect((h.check as (wc: unknown, p: string) => boolean)(null, p)).toBe(false);
    }
    expect((h.device as () => boolean)()).toBe(false);
    let cancelled = false;
    (h.download as (e: { preventDefault(): void }, i: { cancel(): void }) => void)({ preventDefault() {} }, { cancel: () => (cancelled = true) });
    expect(cancelled).toBe(true);
  });
  it('only http(s) navigations', () => {
    expect(webNavigationAllowed('https://example.com')).toBe(true);
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'glossa://app/', 'data:text/html,x', 'chrome://gpu']) expect(webNavigationAllowed(u)).toBe(false);
  });
});
