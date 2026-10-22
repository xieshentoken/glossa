// The built-in Pi worker, run for real (Pi SDK in a Node child process) with
// Glossa's offline demo model and a synthetic localhost API. No external model calls.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { piModelSpec } from '../src/main/pi-model';
import { forkSpawner, runPi, workerEnv, type PiRunner, type PiTask } from '../src/main/runners/pi';
import { readOutputText } from '../src/main/output-contract';
import type { ProviderConfig } from '../src/shared/types';
import { req, ROOT, settle, setup, tmpDir } from './helpers';

const spawn = forkSpawner(path.join(ROOT, 'src', 'worker', 'pi-worker.mts'));
let dir: string;
beforeEach(() => {
  dir = tmpDir('glossa-pi-');
  fs.mkdirSync(path.join(dir, 'work', 'output'), { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const task = (over: Partial<PiTask> = {}): PiTask => ({
  workspace: path.join(dir, 'work'),
  agentDir: path.join(dir, 'pi'),
  mode: 'answer',
  appendSystem: ['You are Glossa.'],
  prompt: 'Term: Reynolds number',
  outputFile: 'output/result.md',
  model: piModelSpec({ id: 'demo', kind: 'fake', label: 'Demo' }, 'fake', 'default', 1000),
  budgetUsd: 0,
  demo: { skill: 'eli5', term: 'Reynolds number', lang: 'English', model: 'fake', effort: 'default', output: 'markdown' },
  ...over,
});

describe('Pi worker', () => {
  it('sends API-discovered effort through the real worker and omits provider-default effort', async () => {
    const calls: Record<string, unknown>[] = [];
    const server = http.createServer(async (req, res) => {
      if (req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer synthetic-test-credential') {
        res.writeHead(401); res.end('Unexpected fixture request'); return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.push(JSON.parse(body));
      res.setHeader('content-type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const cfg: ProviderConfig = {
        id: 'verified', kind: 'openai', label: 'Local fixture', presetId: 'custom',
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['low', 'high'], effortSource: 'api' }],
        selection: { model: 'fixture-model', effort: 'high' },
      };
      for (const effort of ['high', 'default'] as const) {
        const result = await runPi({
          task: task({ model: piModelSpec(cfg, 'fixture-model', effort, 1000), apiKey: 'synthetic-test-credential', demo: undefined }),
          timeoutMinutes: 1, signal: new AbortController().signal, onText: () => {}, onProgress: () => {}, spawn,
        });
        expect(result).toMatchObject({ stop: 'complete', text: 'OK' });
      }
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ model: 'fixture-model', reasoning_effort: 'high' });
      expect(calls[1]).toMatchObject({ model: 'fixture-model' });
      expect(calls[1]).not.toHaveProperty('reasoning_effort');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);

  it('answers in its final message and streams the text', async () => {
    const texts: string[] = [];
    const r = await runPi({ task: task(), timeoutMinutes: 1, signal: new AbortController().signal, onText: (t) => texts.push(t), onProgress: () => {}, spawn });
    expect(r).toMatchObject({ stop: 'complete', text: '**Reynolds number** — offline sample explanation (eli5, English, fake, effort default).' });
    expect(texts.at(-1)).toBe(r.text);
    // Nothing of the user's own Pi setup was used or created.
    expect(fs.existsSync(path.join(dir, 'pi', 'auth.json'))).toBe(false);
  }, 30000);

  it('works in the job folder with tools and writes the result file', async () => {
    const progress: string[] = [];
    fs.mkdirSync(path.join(dir, 'work', '.pi', 'skills', 'fig'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'work', '.pi', 'skills', 'fig', 'SKILL.md'), '---\nname: fig\ndescription: A figure.\n---\n\nDraw.\n');
    const r = await runPi({
      task: task({ mode: 'workspace', outputFile: 'output/index.html', skillsDir: path.join(dir, 'work', '.pi', 'skills'), demo: { skill: 'fig', term: '<b>', lang: 'English', model: 'fake', effort: 'low', output: 'html' } }),
      timeoutMinutes: 1,
      signal: new AbortController().signal,
      onText: () => {},
      onProgress: (l) => progress.push(l),
      spawn,
    });
    expect(r.stop).toBe('complete');
    expect(progress).toEqual(['write output/index.html']);
    const html = fs.readFileSync(path.join(dir, 'work', 'output', 'index.html'), 'utf8');
    expect(html).toContain('<h1>&lt;b&gt;</h1>');
    expect(fs.readFileSync(path.join(dir, 'pi.log'), 'utf8')).toBe('write output/index.html\n');
  }, 30000);

  it('keeps keys out of the environment and offers Electron as node only when asked', () => {
    const env = workerEnv({ task: task({ apiKey: 'sk-secret-123' }), parentEnv: { PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-env', PI_CODING_AGENT_DIR: '/home/u/.pi' }, nodeShim: '/opt/Electron' });
    expect(Object.values(env).join('\n')).not.toMatch(/sk-/);
    expect(env).toMatchObject({ PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: path.join(dir, 'pi'), HOME: '/h' });
    expect(env.PATH).toBe(`/usr/bin${path.delimiter}${path.join(dir, 'work', '.glossa-bin')}`);
    expect(fs.readFileSync(path.join(dir, 'work', '.glossa-bin', 'node'), 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1 exec "/opt/Electron" "$@"');
    expect(workerEnv({ task: task(), parentEnv: { PATH: '/usr/bin' } }).PATH).toBe('/usr/bin');
  });

  it('stops on cancel and reports it as cancelled', async () => {
    const ac = new AbortController();
    // A real endpoint that never answers: the worker must still stop.
    const model = piModelSpec({ id: 'x', kind: 'openai', label: 'Nowhere', baseUrl: 'http://10.255.255.1:9/v1', selection: { model: 'm', effort: 'default' } }, 'm', 'default', 100);
    const p = runPi({ task: task({ model, apiKey: 'sk-test-000000', demo: undefined }), timeoutMinutes: 1, signal: ac.signal, onText: () => {}, onProgress: () => {}, spawn });
    setTimeout(() => ac.abort(), 1500);
    const t0 = Date.now();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 30000);

  it('reports a provider error with the key redacted', async () => {
    const model = piModelSpec({ id: 'x', kind: 'openai', label: 'Closed', baseUrl: 'http://127.0.0.1:1/v1', selection: { model: 'm', effort: 'default' } }, 'm', 'default', 100);
    const r = await runPi({ task: task({ model, apiKey: 'sk-test-redact-me', demo: undefined }), timeoutMinutes: 1, signal: new AbortController().signal, onText: () => {}, onProgress: () => {}, spawn }).catch((e: Error) => ({ stop: 'thrown', error: e.message }));
    expect(['error', 'thrown']).toContain(r.stop);
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain('sk-test-redact-me');
  }, 60000);
});

describe('connection → Pi model', () => {
  const anthropic: ProviderConfig = { id: 'a', kind: 'anthropic', label: 'Anthropic', presetId: 'anthropic', selection: { model: 'claude-opus-4-6', effort: 'high' } };
  it('uses the official address, the tested efforts and the catalog only for prices', () => {
    expect(piModelSpec(anthropic, 'claude-opus-4-6', 'high', 4000)).toEqual({
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      id: 'claude-opus-4-6',
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: 'max' },
      maxTokens: 4000,
      catalog: { provider: 'anthropic', id: 'claude-opus-4-6' },
      thinkingLevel: 'high',
    });
  });
  it("sends no thinking parameter for 'default' and refuses what the model does not support", () => {
    expect(piModelSpec(anthropic, 'claude-opus-4-6', 'default', 4000)).toMatchObject({ reasoning: false });
    expect(piModelSpec(anthropic, 'claude-opus-4-6', 'default', 4000).thinkingLevel).toBeUndefined();
    expect(() => piModelSpec(anthropic, 'claude-opus-4-6', 'xhigh', 4000)).toThrow(/not supported/);
    expect(() => piModelSpec(anthropic, 'claude-opus-4-6', 'ultra', 4000)).toThrow(/ultra/);
  });
  it('keeps OpenAI-compatible options, relays have no catalog entry, OpenCode Go stays blocked', () => {
    const relay: ProviderConfig = { id: 'r', kind: 'openai', label: 'Relay', presetId: 'custom', baseUrl: 'https://relay.example/v1/', sendReasoningEffort: true, maxTokensField: 'max_tokens' };
    expect(piModelSpec(relay, 'm', 'default', 100)).toEqual({ api: 'openai-completions', baseUrl: 'https://relay.example/v1', id: 'm', reasoning: false, compat: { supportsReasoningEffort: true, maxTokensField: 'max_tokens' }, maxTokens: 100 });
    expect(() => piModelSpec({ ...relay, presetId: 'opencode-go' }, 'm', 'default', 100)).toThrow(/OpenCode Go/);
    expect(piModelSpec({ id: 'demo', kind: 'fake', label: 'Demo' }, 'fake', 'low', 10)).toMatchObject({ demo: true });
  });
});

describe('jobs on the real Pi worker (offline demo model)', () => {
  const settings = {
    agentConcurrency: 2,
    defaults: {
      quick: { providerId: 'demo', model: 'fake', effort: 'low' as const, maxTokens: 1000 },
      direct: { providerId: 'demo', model: 'fake', effort: 'high' as const, maxTokens: 1000 },
      agent: { harnessId: 'pi', providerId: 'demo', model: '', effort: 'default' as const, budgetUsd: 0, timeoutMinutes: 1 },
    },
  };
  const real: { piRunner: PiRunner } = { piRunner: (o) => runPi({ ...o, spawn }) };

  it('answers a built-in skill and a skill that works in its job folder', async () => {
    const h = setup(dir, settings, real);
    h.approve.decision = { approved: true, remember: false };
    const [a, b] = await Promise.all([h.jobs.start(req('eli5')), h.jobs.start(req('fake-figure'))]);
    const [ja, jb] = [await settle(h.jobs, a.id, 30000), await settle(h.jobs, b.id, 30000)];
    expect(ja).toMatchObject({ status: 'done', engineLabel: 'Pi · Offline demo (no AI) · fake · high' });
    expect(readOutputText(path.join(h.jobs.jobDir(a.id), 'work'), 'markdown')).toBe('**Reynolds number** — offline sample explanation (eli5, French (fr), fake, effort high).');
    expect(jb).toMatchObject({ status: 'done', output: 'html' });
    expect(fs.readFileSync(h.jobs.outputFile(b.id)!, 'utf8')).toContain('<h1>Reynolds number</h1>');
    // The skill was copied for Pi, the context written, and Pi's config kept in the job folder.
    expect(fs.existsSync(path.join(h.jobs.jobDir(b.id), 'work', '.pi', 'skills', 'fake-figure', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(h.jobs.jobDir(b.id), 'work', 'context.md'), 'utf8')).toContain('Term: Reynolds number');
  }, 60000);

  it('runs two at a time; the third waits, and cancelling one lets the queue move on', async () => {
    const slow: { piRunner: PiRunner } = { piRunner: (o) => new Promise<never>((_, reject) => o.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })))) };
    const h = setup(dir, settings, slow);
    const jobs = [];
    for (const t of ['alpha', 'beta', 'gamma']) jobs.push(await h.jobs.start(req('eli5', { context: { ...req('eli5').context, term: t } })));
    await new Promise((r) => setTimeout(r, 50));
    expect(jobs.map((j) => h.jobs.get(j.id)!.status)).toEqual(['running', 'running', 'queued']);
    h.jobs.cancel(jobs[0].id);
    await new Promise((r) => setTimeout(r, 50));
    expect(jobs.map((j) => h.jobs.get(j.id)!.status)).toEqual(['cancelled', 'running', 'running']);
    // Quitting marks what is unfinished as interrupted; nothing resumes on the next start.
    h.jobs.shutdown();
    await new Promise((r) => setTimeout(r, 50));
    expect(jobs.map((j) => h.jobs.get(j.id)!.status)).toEqual(['cancelled', 'error', 'error']);
    expect(h.jobs.get(jobs[1].id)).toMatchObject({ interrupted: true, error: expect.stringMatching(/Interrupted/) });
    const again = setup(dir, settings, slow);
    expect(again.jobs.get(jobs[2].id)).toMatchObject({ status: 'error', interrupted: true });
  });

  it('a job still marked running on disk (the app crashed) loads as interrupted', () => {
    const h = setup(dir, settings);
    const id = 'mzz0crash-0123456789';
    fs.mkdirSync(h.jobs.jobDir(id), { recursive: true });
    fs.writeFileSync(path.join(h.jobs.jobDir(id), 'job.json'), JSON.stringify({ id, docId: 'b'.repeat(64), skill: 'eli5', term: 't', runner: 'direct', output: 'markdown', status: 'running', progress: '', engineLabel: 'Pi', startedAt: 1 }));
    expect(h.jobs.get(id)).toMatchObject({ status: 'error', interrupted: true });
  });
});
