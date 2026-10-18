import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeUrl, DocumentService } from '../src/main/documents';
import { resolveAgent, resolveDirect } from '../src/main/jobs';
import { markdownPage } from '../src/main/output';
import { resolveInside } from '../src/main/fs-safe';
import { AnthropicProvider } from '../src/main/providers/anthropic';
import { OpenAICompatProvider } from '../src/main/providers/openai';
import { parseClaudeStreamJson } from '../src/main/runners/stream-parsers';
import { Store } from '../src/main/store';
import type { Settings } from '../src/shared/types';
import { box, req, settle, setup } from './helpers';


let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glossa-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.FAKE_AGENT_MODE;
});

describe('Store', () => {
  it('persists settings, encrypted keys and cards', () => {
    const store = new Store(tmp, box);
    store.setSettings({ hotkey: 'Ctrl+E' });
    store.setKey('anthropic', 'sk-secret');
    const raw = fs.readFileSync(store.secretsFile, 'utf8');
    expect(raw).not.toContain('sk-secret');
    const again = new Store(tmp, box);
    expect(again.getSettings().hotkey).toBe('Ctrl+E');
    expect(again.getKey('anthropic')).toBe('sk-secret');
    expect(again.keyStatus().keys).toEqual({ anthropic: 'stored' });
    again.setKey('anthropic', null);
    expect(again.getKey('anthropic')).toBeUndefined();

    const docId = 'a'.repeat(64);
    again.touchDoc({ docId, kind: 'pdf', title: 'T', source: '/x.pdf', openedAt: 1 });
    again.saveCards(docId, []);
    expect(again.recentDocs()[0].docId).toBe(docId);
    expect(() => again.getDoc('../../etc/passwd')).toThrow();
  });
});

const setupH = (settings: Partial<Settings> = {}) => setup(tmp, settings);

describe('SkillRegistry', () => {
  it('lists built-ins and user skills with overrides applied', () => {
    const { registry, store } = setupH({ skillOverrides: { eli5: { enabled: false, order: 9 } } });
    const list = registry.list(store.getSettings());
    expect(list.map((s) => s.name)).toEqual(['quick-gloss', 'anatomy', 'fake-figure', 'eli5']);
    // Anatomy ships unmodified; Glossa's preset supplies how it runs.
    expect(list.find((s) => s.name === 'anatomy')).toMatchObject({ source: 'builtin', runner: 'agent', output: 'html', preset: 'anatomy', timeoutMinutes: 75 });
    expect(list.find((s) => s.name === 'eli5')!.enabled).toBe(false);
    expect(list.find((s) => s.name === 'fake-figure')).toMatchObject({ runner: 'agent', output: 'html', source: 'user' });
  });
  it('saves, renames and deletes user skills', () => {
    const { registry, store } = setupH();
    registry.save({ name: 'analogy', description: 'An analogy.', body: 'Use one analogy.', glossa: { label: { en: 'Analogy' } } });
    registry.save({ name: 'analogies', description: 'An analogy.', body: 'B', glossa: {} }, 'analogy');
    const names = registry.list(store.getSettings()).map((s) => s.name);
    expect(names).toContain('analogies');
    expect(names).not.toContain('analogy');
    registry.remove('analogies');
    expect(() => registry.remove('eli5')).toThrow(/Only user skills/);
  });
});

describe('JobManager', () => {
  it('runs a direct skill, writes the result and caches it', async () => {
    const { jobs, events } = setupH();
    const j = await jobs.start(req('eli5'));
    const done = await settle(jobs, j.id);
    expect(done.status).toBe('done');
    expect(done.engineLabel).toContain('fake · high');
    const out = fs.readFileSync(jobs.outputFile(j.id)!, 'utf8');
    expect(out).toContain('Reynolds number');
    expect(out).toContain('French (fr)');
    expect(events.some((e) => e.text && e.status === 'running')).toBe(true);
    const again = await jobs.start(req('eli5'));
    expect(again).toMatchObject({ cached: true, resultOf: j.id });
    expect((await jobs.start(req('eli5', { force: true }))).id).not.toBe(j.id);
  });

  it('uses the quick engine for the quick skill and honours per-request overrides', () => {
    const { store, registry } = setupH();
    const s = store.getSettings();
    const quick = registry.list(s).find((x) => x.name === 'quick-gloss')!;
    expect(resolveDirect(s, quick).effort).toBe('low');
    expect(resolveDirect(s, quick, { effort: 'max', model: '' }).effort).toBe('max');
    expect(resolveDirect(s, quick, { model: '' }).model).toBe('fake');
    const fig = registry.list(s).find((x) => x.name === 'fake-figure')!;
    expect(resolveAgent(s, { ...fig, timeoutMinutes: 75 }).timeoutMinutes).toBe(75);
  });

  it('runs an agent skill through the harness and serves its HTML', async () => {
    const { jobs } = setupH();
    const j = await jobs.start(req('fake-figure'));
    expect(j.status).toBe('queued');
    const done = await settle(jobs, j.id);
    expect(done.error).toBeUndefined();
    expect(done).toMatchObject({ status: 'done', output: 'html', costUsd: 0.0123 });
    const work = path.join(jobs.jobDir(j.id), 'work');
    expect(fs.readFileSync(path.join(work, 'output', 'index.html'), 'utf8')).toContain('Reynolds number');
    expect(fs.existsSync(path.join(work, '.claude', 'skills', 'fake-figure', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(work, 'context.md'), 'utf8')).toContain('untrusted');
    // Metadata and the log live outside the agent's working directory.
    expect(fs.existsSync(path.join(work, 'job.json'))).toBe(false);
    expect(fs.readFileSync(path.join(jobs.jobDir(j.id), 'harness.log'), 'utf8')).toContain('"subtype":"init","model":"m1"');
  });

  it('reports agent failures and missing harness binaries', async () => {
    const { jobs, store } = setupH();
    process.env.FAKE_AGENT_MODE = 'fail';
    const a = await settle(jobs, (await jobs.start(req('fake-figure'))).id);
    expect(a.status).toBe('error');
    expect(a.error).toContain('it broke');
    store.setSettings({ harnesses: [{ ...store.getSettings().harnesses[0], command: 'definitely-not-installed-xyz' }] });
    const b = await settle(jobs, (await jobs.start(req('fake-figure', { force: true }))).id);
    expect(b.error).toMatch(/Harness command not found/);
  });

  it('cancels a running agent and runs queued ones in order', async () => {
    const { jobs } = setupH();
    process.env.FAKE_AGENT_MODE = 'hang';
    const first = await jobs.start(req('fake-figure'));
    const second = await jobs.start(req('fake-figure', { force: true, context: { ...req('x').context, term: 'other' } }));
    await new Promise((r) => setTimeout(r, 400));
    expect(jobs.get(second.id)!.status).toBe('queued');
    jobs.cancel(second.id);
    expect((await settle(jobs, second.id)).status).toBe('cancelled');
    jobs.cancel(first.id);
    expect((await settle(jobs, first.id)).status).toBe('cancelled');
  });

  it('marks jobs interrupted when loaded after a restart, and never resumes them', () => {
    const { jobs } = setupH();
    const id = 'abcdef12-0000';
    fs.mkdirSync(jobs.jobDir(id), { recursive: true });
    fs.writeFileSync(path.join(jobs.jobDir(id), 'job.json'), JSON.stringify({ id, status: 'running' }));
    const fresh = setupH().jobs;
    expect(fresh.get(id)).toMatchObject({ status: 'error' });
    expect(() => fresh.jobDir('../evil')).toThrow();
  });
});

describe('stream-json parser', () => {
  it('turns Claude Code events into progress and results', () => {
    expect(parseClaudeStreamJson('{"type":"system","subtype":"init","model":"claude-opus-5-5"}').progress).toBe('Started (claude-opus-5-5)');
    expect(
      parseClaudeStreamJson(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node build.mjs --audit' } }] } })).progress,
    ).toBe('$ node build.mjs --audit');
    expect(parseClaudeStreamJson('{"type":"result","subtype":"success","result":"ok","total_cost_usd":1.5}')).toMatchObject({ result: 'ok', costUsd: 1.5, isError: false });
    expect(parseClaudeStreamJson('{"type":"result","subtype":"error_max_budget_usd"}').isError).toBe(true);
    expect(parseClaudeStreamJson('not json')).toEqual({});
  });
});

function sse(lines: object[]): Response {
  const body = lines.map((l) => `event: ${(l as { type: string }).type}\ndata: ${JSON.stringify(l)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('providers', () => {
  const anthropicStream = (text: string) =>
    sse([
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 4000 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);

  it('Anthropic: caches the document block, sends effort and adaptive thinking, opts into fallbacks', async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const fetchMock = async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init!.body)), headers: new Headers(init!.headers) });
      return anthropicStream('Hallo');
    };
    const p = new AnthropicProvider({ id: 'a', kind: 'anthropic', label: 'A' }, 'sk-test', { fetch: fetchMock as typeof fetch, maxRetries: 0 });
    let streamed = '';
    const run = (model: string) =>
      p.stream({
        system: [{ text: 'base' }, { text: 'DOC', cache: true }, { text: 'skill' }],
        user: 'Term: x',
        model,
        effort: 'low',
        maxTokens: 1000,
        signal: new AbortController().signal,
        onText: (d) => (streamed += d),
      });
    const r = await run('claude-opus-5-5');
    expect(r).toEqual({ text: 'Hallo', finish: 'complete', cacheReadTokens: 4000 });
    expect(streamed).toBe('Hallo');
    const b = calls[0].body as { system: { cache_control?: object }[]; output_config: object; thinking: object; fallbacks: string };
    expect(b.system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(b.system[0].cache_control).toBeUndefined();
    expect(b.output_config).toEqual({ effort: 'low' });
    expect(b.thinking).toEqual({ type: 'adaptive' });
    expect(b.fallbacks).toBe('default');
    expect(calls[0].headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');

    await run('claude-haiku-5-5');
    expect(calls[1].body.fallbacks).toBeUndefined();
    expect(calls[1].headers.get('anthropic-beta')).toBeNull();
    await run('claude-haiku-4-5');
    expect(calls[2].body.output_config).toBeUndefined();
    expect(calls[2].body.thinking).toBeUndefined();
  });

  it('OpenAI-compatible: parses SSE and sends reasoning_effort only when enabled', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      const chunks = ['Hel', 'lo'].map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('');
      return new Response(chunks + 'data: [DONE]\n\n', { status: 200 });
    };
    const mk = (send: boolean) => new OpenAICompatProvider({ id: 'o', kind: 'openai', label: 'O', baseUrl: 'http://x/v1/', sendReasoningEffort: send }, 'k', fetchMock as typeof fetch);
    const args = { system: [{ text: 's' }], user: 'u', model: 'm', effort: 'max' as const, maxTokens: 10, signal: new AbortController().signal, onText: () => {} };
    expect((await mk(true).stream(args)).text).toBe('Hello');
    expect(bodies[0].reasoning_effort).toBe('max');
    await mk(false).stream(args);
    expect(bodies[1].reasoning_effort).toBeUndefined();
    const failing = new OpenAICompatProvider({ id: 'o', kind: 'openai', label: 'O' }, 'k', (async () => new Response('bad key', { status: 401 })) as typeof fetch);
    await expect(failing.stream(args)).rejects.toThrow(/HTTP 401: bad key/);
  });
});

describe('documents & output', () => {
  it('normalizes URLs and rejects other schemes', () => {
    expect(normalizeUrl('example.com/a#frag')).toBe('https://example.com/a');
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow();
  });
  it('only loads documents that were opened', async () => {
    const docs = new DocumentService();
    await expect(docs.load('c'.repeat(64))).rejects.toThrow(/not opened/);
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'One <b>\n\nTwo');
    const info = await docs.describeFile(f);
    expect(info.kind).toBe('text');
    const loaded = await docs.load(info.docId);
    expect(loaded).toMatchObject({ kind: 'html', html: '<p>One &lt;b&gt;</p>\n<p>Two</p>' });
    await expect(docs.describeFile(path.join(tmp, 'x.exe'))).rejects.toThrow(/Unsupported/);
  });
  it('keeps output paths inside the job folder', () => {
    expect(resolveInside('/jobs/a/output', '/index.html')).toBe('/jobs/a/output/index.html');
    expect(() => resolveInside('/jobs/a/output', '/../../secrets.json')).toThrow();
    expect(() => resolveInside('/jobs/a/output', '%2e%2e/%2e%2e/x')).toThrow();
  });
  it('renders Markdown results with a no-script CSP', async () => {
    const html = await markdownPage('**Hi** <script>alert(1)</script>', { theme: 'light', lang: 'zh', title: 'T' });
    expect(html).toContain('<strong>Hi</strong>');
    expect(html).toContain(`default-src 'none'`);
    expect(html).not.toContain(`script-src 'unsafe-inline'`);
  });
});
