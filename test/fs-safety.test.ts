// P0-6: path, link and IPC checks. Everything happens in synthetic temp folders.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTreeSafe, isInsideReal, readFileSafe, resolveInside, UnsafePathError } from '../src/main/fs-safe';
import { serveOutput } from '../src/main/output-protocol';
import { InvalidArgument, vAbsPath, vJobId, vJobRequest, vParsedSkill, vTermCards } from '../src/main/validate';
import { FIXTURES, req, settle, setup, tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, data = 'x') => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
};

describe('resolveInside / isInsideReal', () => {
  it('accepts normal relative paths', () => {
    expect(resolveInside(dir, 'a/b.html')).toBe(path.join(dir, 'a', 'b.html'));
    expect(resolveInside(dir, '/output/index.html')).toBe(path.join(dir, 'output', 'index.html'));
  });
  it.each(['../x', 'a/../../x', '%2e%2e/x', '..%2fx', 'a\\..\\..\\x', 'C:/Windows', 'a\0b', '%E0%A4%A'])('refuses %j', (p) => {
    expect(() => resolveInside(dir, p)).toThrow(UnsafePathError);
  });
  it('is not fooled by folders sharing a prefix', () => {
    fs.mkdirSync(path.join(dir, 'out'));
    fs.mkdirSync(path.join(dir, 'out-evil'));
    expect(isInsideReal(path.join(dir, 'out'), path.join(dir, 'out-evil'))).toBe(false);
    expect(isInsideReal(path.join(dir, 'out'), path.join(dir, 'out'))).toBe(true);
  });
});

describe('readFileSafe', () => {
  it('reads a regular file', () => {
    write('root/output/index.html', '<html></html>');
    expect(readFileSafe(path.join(dir, 'root'), 'output/index.html', { maxBytes: 100 }).toString()).toBe('<html></html>');
  });
  it('refuses a link to a file outside', () => {
    const secret = write('secret.txt', 'SECRET');
    fs.mkdirSync(path.join(dir, 'root/output'), { recursive: true });
    fs.symlinkSync(secret, path.join(dir, 'root/output/index.html'));
    expect(() => readFileSafe(path.join(dir, 'root'), 'output/index.html', { maxBytes: 100 })).toThrow();
  });
  it('refuses a linked folder on the way', () => {
    write('elsewhere/index.html', 'SECRET');
    fs.mkdirSync(path.join(dir, 'root'));
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'root/output'));
    expect(() => readFileSafe(path.join(dir, 'root'), 'output/index.html', { maxBytes: 100 })).toThrow(/Symbolic link/);
  });
  it('refuses hard links and oversize files', () => {
    const secret = write('secret.txt', 'SECRET');
    fs.mkdirSync(path.join(dir, 'root/output'), { recursive: true });
    fs.linkSync(secret, path.join(dir, 'root/output/index.html'));
    expect(() => readFileSafe(path.join(dir, 'root'), 'output/index.html', { maxBytes: 100 })).toThrow(/Hard-linked/);
    write('root/output/big.html', 'x'.repeat(200));
    expect(() => readFileSafe(path.join(dir, 'root'), 'output/big.html', { maxBytes: 100 })).toThrow(/too large/);
  });
});

describe('copyTreeSafe', () => {
  it('fails as a whole on a link and writes nothing', () => {
    write('src/SKILL.md', '---\nname: a\ndescription: b\n---\n');
    write('outside.txt', 'SECRET');
    fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(dir, 'src/notes.txt'));
    expect(() => copyTreeSafe(path.join(dir, 'src'), path.join(dir, 'dest'))).toThrow(/Symbolic link refused: notes.txt/);
    expect(fs.existsSync(path.join(dir, 'dest'))).toBe(false);
  });
  it('fails on hard links', () => {
    write('outside.txt', 'SECRET');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.linkSync(path.join(dir, 'outside.txt'), path.join(dir, 'src/a.txt'));
    expect(() => copyTreeSafe(path.join(dir, 'src'), path.join(dir, 'dest'))).toThrow(/Hard-linked/);
  });
});

describe('skills: import, rename, delete', () => {
  it('refuses a skill folder containing a link', () => {
    const h = setup(dir);
    const src = path.join(dir, 'bad-skill');
    fs.cpSync(path.join(FIXTURES, 'skills', 'fake-figure'), src, { recursive: true });
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'SECRET');
    fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(src, 'leak.txt'));
    expect(() => h.registry.importFolder(src, true)).toThrow(/Symbolic link/);
    // The installed copy is untouched and contains no link.
    expect(fs.existsSync(path.join(h.store.skillsDir, 'fake-figure', 'leak.txt'))).toBe(false);
  });
  it.each(['../../outside', '..', 'a/b', '', 'Upper', '.staging-x'])('refuses previousName %j', (prev) => {
    const h = setup(dir);
    fs.mkdirSync(path.join(dir, 'outside'), { recursive: true });
    expect(() => h.registry.save({ name: 'fine', description: 'd', body: 'b', glossa: {} }, prev)).toThrow();
    expect(fs.existsSync(path.join(dir, 'outside'))).toBe(true);
  });
  it('refuses a missing previous skill and an existing target', () => {
    const h = setup(dir);
    expect(() => h.registry.save({ name: 'fine', description: 'd', body: 'b', glossa: {} }, 'nope')).toThrow();
    h.registry.save({ name: 'one', description: 'd', body: 'b', glossa: {} });
    expect(() => h.registry.save({ name: 'fake-figure', description: 'd', body: 'b', glossa: {} }, 'one')).toThrow(/already exists/);
  });
  it('refuses to delete through a linked skill folder', () => {
    const h = setup(dir);
    const target = path.join(dir, 'precious');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    fs.symlinkSync(target, path.join(h.store.skillsDir, 'linked'));
    expect(() => h.registry.remove('linked')).toThrow();
    expect(() => h.registry.remove('../precious')).toThrow();
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('output protocol', () => {
  it('serves a valid result with its CSP, refuses traversal and unknown jobs', async () => {
    const h = setup(dir);
    const j = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    const s = h.store.getSettings();
    const ok = await serveOutput(`glossa-out://${j.id}/`, h.jobs, s, 'dark');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await ok.text()).toContain('offline sample');
    expect((await serveOutput(`glossa-out://${j.id}/%2e%2e/%2e%2e/job.json`, h.jobs, s, 'dark')).status).toBe(404);
    expect((await serveOutput(`glossa-out://${j.id}/x.png`, h.jobs, s, 'dark')).status).toBe(404); // markdown jobs have no assets
    expect((await serveOutput('glossa-out://nope/', h.jobs, s, 'dark')).status).toBe(404);
    expect((await serveOutput('glossa-out://unknown-job-123/', h.jobs, s, 'dark')).status).toBe(404);
  });
});

describe('IPC validation', () => {
  it('rejects malformed ids, requests, cards, skills and paths', () => {
    expect(() => vJobId('../x')).toThrow(InvalidArgument);
    expect(() => vJobRequest({ ...req('eli5'), skill: '../x' })).toThrow(InvalidArgument);
    expect(() => vJobRequest({ ...req('eli5'), docId: 'short' })).toThrow(InvalidArgument);
    expect(() => vJobRequest({ ...req('eli5'), extra: 1 })).toThrow(/unexpected field extra/);
    expect(() => vJobRequest({ ...req('eli5'), direct: { maxTokens: -5 } })).toThrow(InvalidArgument);
    expect(() => vJobRequest({ ...req('eli5'), context: { ...req('x').context, term: '   ' } })).toThrow(InvalidArgument);
    expect(() => vTermCards([{ id: 'c1', term: 't', context: req('eli5').context, explainLang: 'en', rect: { x: 0, y: 0, w: 1, h: 1 }, window: 'normal', tasks: [{ id: 't1', jobId: 'x', skill: 'eli5', createdAt: 1, request: req('eli5') }], createdAt: 1 }])).toThrow(InvalidArgument);
    expect(() => vParsedSkill({ name: 'a/b', description: 'd', body: '' })).toThrow(InvalidArgument);
    expect(() => vParsedSkill({ name: 'ok', description: 'd', body: '', glossa: { runner: 'shell' } })).toThrow(InvalidArgument);
    expect(() => vAbsPath('relative/file.pdf')).toThrow(InvalidArgument);
    expect(vJobRequest(req('eli5')).skill).toBe('eli5');
  });
});
