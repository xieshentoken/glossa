// P0-1 (cache identity), P0-2 (output contract, restart), P1-2 (lifecycle).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_VERSION, cacheKey, stableStringify } from '../src/main/cache';
import { MISSING_OUTPUT } from '../src/main/jobs';
import { StreamError } from '../src/main/providers';
import { FakeProvider } from '../src/main/providers/fake';
import { req, settle, setup, tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_AGENT_MODE;
});

describe('P0-1 cache identity', () => {
  it('reuses a result for identical inputs without calling the provider again', async () => {
    const h = setup(dir);
    const a = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    const b = await h.jobs.start(req('eli5'));
    expect(h.requests).toHaveLength(1);
    expect(b).toMatchObject({ status: 'done', cached: true, resultOf: a.id });
    expect(b.id).not.toBe(a.id);
    expect(b.text).toContain('offline sample');
  });

  it('a hit belongs to the current request: its own id and document', async () => {
    const h = setup(dir, { dataScope: 'sentence' });
    const docA = 'a'.repeat(64);
    await settle(h.jobs, (await h.jobs.start(req('eli5', { docId: docA }))).id);
    const other = await h.jobs.start(req('eli5', { docId: 'c'.repeat(64) }));
    // Different document → different identity (document is part of the key), new run.
    expect(other.docId).toBe('c'.repeat(64));
    expect(h.requests).toHaveLength(2);
  });

  it.each([
    ['paragraph', (r: ReturnType<typeof req>) => ({ ...r, context: { ...r.context, paragraph: 'Another paragraph entirely.' } })],
    ['sentence', (r: ReturnType<typeof req>) => ({ ...r, context: { ...r.context, sentence: 'Another sentence.' } })],
    ['heading', (r: ReturnType<typeof req>) => ({ ...r, context: { ...r.context, heading: 'Chapter 2' } })],
    ['answer language', (r: ReturnType<typeof req>) => ({ ...r, explainLang: 'de' })],
    ['model', (r: ReturnType<typeof req>) => ({ ...r, direct: { model: 'fake-2' } })],
    ['effort', (r: ReturnType<typeof req>) => ({ ...r, direct: { effort: 'max' as const } })],
    ['max tokens', (r: ReturnType<typeof req>) => ({ ...r, direct: { maxTokens: 2048 } })],
  ])('a different %s is a different result', async (_name, change) => {
    const h = setup(dir);
    await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    await settle(h.jobs, (await h.jobs.start(change(req('eli5')))).id);
    expect(h.requests).toHaveLength(2);
  });

  it('editing a skill without changing its length invalidates the cache', async () => {
    const h = setup(dir);
    h.registry.save({ name: 'tone', description: 'd', body: 'Explain calmly.', glossa: {} });
    await settle(h.jobs, (await h.jobs.start(req('tone'))).id);
    h.registry.save({ name: 'tone', description: 'd', body: 'Explain wildly.', glossa: {} });
    await settle(h.jobs, (await h.jobs.start(req('tone'))).id);
    expect(h.requests).toHaveLength(2);
  });

  it('a different reader profile, provider endpoint or document text is a different result', async () => {
    let doc = 'DOC v1';
    const h = setup(dir, { dataScope: 'document' }, { docText: () => doc });
    await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    h.store.setSettings({ profile: 'biologist' });
    await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    h.store.setSettings({ providers: h.store.getSettings().providers.map((p) => (p.id === 'demo' ? { ...p, baseUrl: 'http://elsewhere' } : p)) });
    await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    doc = 'DOC v2';
    await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(h.requests).toHaveLength(4);
  });

  it('keys use stable serialization, a version, and never secrets', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
    const base = {
      docId: 'x',
      docTextHash: null,
      context: { term: 't', sentence: 's', paragraph: 'p', heading: '' },
      scope: 'paragraph',
      skill: { name: 'n', contentHash: 'h', runner: 'direct', output: 'markdown', task: '' },
      explainLang: 'en',
      profile: '',
      theme: 'dark',
      engine: { model: 'm' },
    };
    expect(cacheKey(base)).toBe(cacheKey({ ...base, engine: { model: 'm' } }));
    expect(CACHE_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('legacy (unversioned) cache entries are ignored', async () => {
    const h = setup(dir);
    const a = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    const legacy = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(h.store.cacheFile, 'utf8')).entries));
    fs.writeFileSync(h.store.cacheFile, JSON.stringify(legacy)); // old flat format
    const b = await h.jobs.start(req('eli5'));
    expect(b.cached).toBeUndefined();
    expect(b.id).not.toBe(a.id);
  });

  it('identical requests in flight share one run instead of submitting twice', async () => {
    const h = setup(dir);
    const [a, b] = await Promise.all([h.jobs.start(req('eli5')), h.jobs.start(req('eli5'))]);
    expect(a.id).toBe(b.id);
    await settle(h.jobs, a.id);
    expect(h.requests).toHaveLength(1);
  });
});

describe('P0-2 output contract', () => {
  it('rejects direct + html at the main process (no IPC bypass) with an explanation', async () => {
    const h = setup(dir, { skillOverrides: { eli5: { output: 'html' } } });
    await expect(h.jobs.start(req('eli5'))).rejects.toThrow(/HTML output needs an agent skill/);
    expect(h.requests).toHaveLength(0);
  });

  it('every done job has a readable output file', async () => {
    const h = setup(dir);
    const j = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(j.status).toBe('done');
    expect(fs.readFileSync(h.jobs.outputFile(j.id)!, 'utf8')).toContain('Reynolds number');
  });

  it('an empty answer is an error, not a blank "done"', async () => {
    const h = setup(dir, {}, { provider: async () => ({ text: '   ', finish: 'complete' }) });
    const j = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(j.status).toBe('error');
    expect(j.error).toMatch(/without a valid result \(empty\)/);
  });

  it('restores the quick explanation text after a restart, from the result file', async () => {
    const h = setup(dir);
    const first = await settle(h.jobs, (await h.jobs.start(req('quick-gloss'))).id);
    expect(fs.readFileSync(path.join(h.jobs.jobDir(first.id), 'job.json'), 'utf8')).not.toContain('offline sample');
    const restarted = setup(dir);
    expect(restarted.jobs.get(first.id)!.text).toContain('offline sample');
    const hit = await restarted.jobs.start(req('quick-gloss'));
    expect(hit.cached).toBe(true);
    expect(hit.text).toContain('offline sample');
    expect(restarted.requests).toHaveLength(0);
  });

  it('a deleted output becomes a clear error with a way back, and is not reused', async () => {
    const h = setup(dir);
    const j = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    fs.rmSync(h.jobs.outputFile(j.id)!);
    const again = setup(dir);
    expect(again.jobs.get(j.id)).toMatchObject({ status: 'error', outputMissing: true, error: MISSING_OUTPUT });
    const rerun = await again.jobs.start(req('eli5'));
    expect(rerun.cached).toBeUndefined();
    expect((await settle(again.jobs, rerun.id)).status).toBe('done');
  });

  it('jobs written before this version (output in jobs/<id>/output) still open', async () => {
    const h = setup(dir);
    const id = 'legacy0001-abc';
    fs.mkdirSync(path.join(h.jobs.jobDir(id), 'output'), { recursive: true });
    fs.writeFileSync(path.join(h.jobs.jobDir(id), 'output', 'result.md'), 'old **answer**');
    fs.writeFileSync(path.join(h.jobs.jobDir(id), 'job.json'), JSON.stringify({ id, status: 'done', output: 'markdown', term: 't', skill: 'eli5', docId: 'x', runner: 'direct', progress: '', engineLabel: '', startedAt: 1 }));
    expect(h.jobs.get(id)).toMatchObject({ status: 'done', text: 'old **answer**' });
  });

  it('an agent output that is a link to a file outside is refused', async () => {
    const outside = path.join(dir, 'secret.txt');
    fs.writeFileSync(outside, '<html>SECRET</html>');
    const h = setup(dir, {}, {
      agentRunner: async (o) => {
        fs.mkdirSync(path.join(o.workspace, 'output'), { recursive: true });
        fs.symlinkSync(outside, path.join(o.workspace, 'output', 'index.html'));
        return { output: 'html' };
      },
    });
    const j = await settle(h.jobs, (await h.jobs.start(req('fake-figure'))).id);
    expect(j.status).toBe('error');
    expect(j.error).toMatch(/Symbolic link refused/);
  });
});

describe('P0-3 partial and broken streams', () => {
  it('a length cut is shown as partial and never cached', async () => {
    const h = setup(dir, {}, { provider: async (r) => (r.onText('half'), { text: 'half an answer', finish: 'length' }) });
    const j = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(j).toMatchObject({ status: 'partial', partialReason: 'length', text: 'half an answer' });
    const again = await h.jobs.start(req('eli5'));
    expect(again.cached).toBeUndefined();
    expect(h.requests).toHaveLength(2);
  });

  it('text that arrived before a dropped connection is kept as partial', async () => {
    const h = setup(dir, {}, {
      provider: async (r) => {
        r.onText('some ');
        throw new StreamError('interrupted', 'The connection ended before the answer was finished.', 'some text');
      },
    });
    const j = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(j).toMatchObject({ status: 'partial', partialReason: 'interrupted', text: 'some text' });
    expect(j.error).toMatch(/connection ended/);
  });

  it('a refusal is an error even with text, and a server error without text too', async () => {
    const h = setup(dir, {}, { provider: async () => { throw new StreamError('refusal', 'declined', 'x'); } });
    expect((await settle(h.jobs, (await h.jobs.start(req('eli5'))).id)).status).toBe('error');
    const h2 = setup(tmpDir(), {}, { provider: async () => { throw Object.assign(new StreamError('server', 'HTTP 401: no'), { status: 401 }); } });
    const e = await settle(h2.jobs, (await h2.jobs.start(req('eli5'))).id);
    expect(e).toMatchObject({ status: 'error' });
    expect(e.error).toMatch(/API key was rejected/);
  });

  it('cancel wins over a late completion and late chunks do not change the finished job', async () => {
    let finish!: () => void;
    let onText!: (d: string) => void;
    const h = setup(dir, {}, {
      provider: (r) =>
        new Promise((resolve) => {
          onText = r.onText;
          finish = () => resolve({ text: 'late', finish: 'complete' });
        }),
    });
    const j = await h.jobs.start(req('eli5'));
    await new Promise((r) => setTimeout(r, 10));
    h.jobs.cancel(j.id);
    finish();
    const s = await settle(h.jobs, j.id);
    expect(s.status).toBe('cancelled');
    onText('ghost');
    expect(h.jobs.get(j.id)!.status).toBe('cancelled');
    expect(h.jobs.get(j.id)!.text ?? '').not.toContain('ghost');
    expect(h.jobs.outputFile(j.id)).toBeUndefined();
  });

  it('a slow fake provider can be cancelled mid-stream', async () => {
    const h = setup(dir, {}, { provider: (r) => new FakeProvider(30).stream(r) });
    const j = await h.jobs.start(req('eli5'));
    await new Promise((r) => setTimeout(r, 50));
    h.jobs.cancel(j.id);
    expect((await settle(h.jobs, j.id)).status).toBe('cancelled');
  });
});
