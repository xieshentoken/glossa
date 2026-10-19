import { describe, it, expect } from 'vitest';
import { discoverModels, parseModel } from '../src/main/providers/discovery';
import { ResponsesProvider } from '../src/main/providers/responses';
import { GeminiProvider } from '../src/main/providers/gemini';
import { OpenAICompatProvider } from '../src/main/providers/openai';
import type { Effort, ProviderConfig } from '../src/shared/types';
import { modelInfo } from '../src/shared/model-catalog';
import { piModelSpec } from '../src/main/pi-model';
import type { StreamRequest } from '../src/main/providers';

const base: ProviderConfig = { id: 'work', kind: 'openai', label: 'Work', baseUrl: 'https://example.test/v1', presetId: 'custom' };
const signal = () => new AbortController().signal;
const event = (v: object) => `data: ${JSON.stringify(v)}\n\n`;
function responder(text: string) { const bodies: Record<string, unknown>[] = []; const urls: string[] = []; return { bodies, urls, fetch: (async (url, init) => { urls.push(String(url)); if (init?.body) bodies.push(JSON.parse(String(init.body))); return new Response(text); }) as typeof fetch }; }
const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({ model: 'm', effort: 'default', maxTokens: 1024, system: [{ text: 's' }], user: 'u', signal: signal(), onText: () => {}, ...over });

describe('model discovery', () => {
  it('uses the documented per-model Anthropic effort flags over fallback guesses', () => {
    const m = parseModel({ ...base, kind: 'anthropic', presetId: 'anthropic' }, { id: 'claude-opus-5-5', capabilities: { effort: { supported: true, low: { supported: true }, max: { supported: false } } } });
    expect(m).toMatchObject({ efforts: ['low'], effortSource: 'api' });
  });
  it('reads the Models API layout as documented (capabilities.effort.<level>.supported)', () => {
    const anth = { ...base, kind: 'anthropic' as const, presetId: 'anthropic' as const };
    const all = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } };
    expect(parseModel(anth, { id: 'claude-opus-5-5', max_tokens: 128000, capabilities: { effort: all } })).toMatchObject({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortSource: 'api', maxOutputTokens: 128000 });
    expect(parseModel(anth, { id: 'claude-x', capabilities: { effort: { ...all, supported: false } } })).toMatchObject({ efforts: [], effortSource: 'api' });
  });
  it('falls back to the documented levels when an endpoint reports no capabilities (null, proxies)', () => {
    const anth = { ...base, kind: 'anthropic' as const, presetId: 'anthropic' as const };
    const five = ['low', 'medium', 'high', 'xhigh', 'max'];
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5']) {
      expect(parseModel(anth, { id, capabilities: null }), id).toMatchObject({ efforts: five, effortSource: 'documented' });
    }
    expect(parseModel(anth, { id: 'claude-opus-4-6' })).toMatchObject({ efforts: ['low', 'medium', 'high', 'max'], effortSource: 'documented' });
    expect(parseModel(anth, { id: 'claude-opus-4-5' })).toMatchObject({ efforts: ['low', 'medium', 'high'], effortSource: 'documented' });
    // These reject effort: known, with no levels.
    expect(parseModel(anth, { id: 'claude-haiku-4-5' })).toMatchObject({ efforts: [], effortSource: 'documented' });
    expect(parseModel(anth, { id: 'claude-future-9' })).toMatchObject({ efforts: [], effortSource: 'unknown' });
  });
  it('a connection saved while its model was unknown uses what is documented now; levels the API reported stay', () => {
    const cfg = { ...base, kind: 'anthropic' as const, presetId: 'anthropic' as const, selection: { model: 'claude-opus-5-5', effort: 'default' as const } };
    const saved = (efforts: Effort[], effortSource: 'api' | 'unknown') => ({ ...cfg, models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts, effortSource }] });
    expect(modelInfo(saved([], 'unknown'), 'claude-opus-5-5')).toMatchObject({ label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortSource: 'documented' });
    expect(modelInfo(saved(['low', 'high'], 'api'), 'claude-opus-5-5')).toMatchObject({ efforts: ['low', 'high'], effortSource: 'api' });
  });
  it('the default setup (Haiku 5.5 at effort low on the built-in connection) is accepted by Pi', () => {
    const builtin = { id: 'anthropic', kind: 'anthropic' as const, label: 'Anthropic (Claude)' };
    expect(piModelSpec(builtin, 'claude-haiku-5-5', 'low', 1024)).toMatchObject({ reasoning: true, thinkingLevel: 'low' });
    expect(() => piModelSpec(builtin, 'claude-haiku-4-5', 'low', 1024)).toThrow(/not supported/);
  });
  it('uses DeepSeek API effort levels and output limits', () => {
    const m = parseModel({ ...base, presetId: 'deepseek' }, { id: 'deepseek-flash', effort: { supported_levels: ['low', 'max'] }, max_output_tokens: 12345 });
    expect(m).toMatchObject({ efforts: ['none', 'low', 'max'], maxOutputTokens: 12345, effortSource: 'api' });
  });
  it('does not show unsupported Gemini thinking levels or embedding models', () => {
    const c = { ...base, presetId: 'gemini', kind: 'gemini' } as ProviderConfig;
    expect(parseModel(c, { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'], thinking: false })).toMatchObject({ efforts: [] });
    expect(parseModel(c, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] })).toBeUndefined();
  });
  it('follows same-host pagination and preserves authentication headers', async () => {
    const urls: string[] = [];
    const f = (async (url, init) => {
      urls.push(String(url)); expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('key');
      expect(init?.redirect).toBe('error');
      return Response.json({ models: [{ name: `models/m${urls.length}`, supportedGenerationMethods: ['generateContent'] }], ...(urls.length === 1 ? { nextPageToken: 'next' } : {}) });
    }) as typeof fetch;
    const r = await discoverModels({ ...base, kind: 'gemini', presetId: 'gemini' }, 'key', signal(), f);
    expect(r.models.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(urls[1]).toBe('https://example.test/v1/models?pageToken=next');
  });
  it('does not treat a wrong key, rate limit, malformed JSON or schema as a successful connection', async () => {
    for (const response of [new Response('x', { status: 401 }), new Response('x', { status: 429 }), new Response('<html>'), Response.json({ error: 'wrong path' })]) {
      await expect(discoverModels(base, 'k', signal(), (async () => response) as typeof fetch)).rejects.toThrow();
    }
  });
  it('marks a documented candidate fallback separately from a discovered catalog', async () => {
    const result = await discoverModels({ ...base, presetId: 'glm-cn' }, 'k', signal(), (async () => new Response('', { status: 404 })) as typeof fetch);
    expect(result.source).toBe('documented');
    expect(result.models.length).toBeGreaterThan(0);
  });
});

describe('protocol streaming and actual parameters', () => {
  it('preserves xhigh/max without silent downgrading in Chat Completions', async () => {
    const f = responder(event({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }));
    const p = new OpenAICompatProvider({ ...base, sendReasoningEffort: true }, 'k', f.fetch);
    await p.stream(req({ effort: 'max' }));
    expect(f.bodies[0]).toHaveProperty('reasoning_effort', 'max');
    await p.stream(req()); expect(f.bodies[1]).not.toHaveProperty('reasoning_effort');
  });
  it('maps GLM thinking toggle separately from effort', async () => {
    const f = responder(event({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }));
    const p = new OpenAICompatProvider({ ...base, presetId: 'glm-cn', selection: { model: 'glm-5.3', effort: 'none' } }, 'k', f.fetch);
    await p.stream(req({ model: 'glm-5.3', effort: 'none' }));
    expect(f.bodies[0]).toHaveProperty('thinking', { type: 'disabled' });
    expect(f.bodies[0]).not.toHaveProperty('reasoning_effort');
  });
  it('sends Responses fields, disables storage, reads deltas and requires a completed event', async () => {
    const f = responder(event({ type: 'response.output_text.delta', delta: 'OK' }) + event({ type: 'response.completed', response: { status: 'completed' } }));
    const p = new ResponsesProvider({ ...base, kind: 'responses' }, 'k', f.fetch);
    expect(await p.stream(req({ effort: 'xhigh' }))).toMatchObject({ text: 'OK', finish: 'complete' });
    expect(f.bodies[0]).toMatchObject({ store: false, max_output_tokens: 1024, reasoning: { effort: 'xhigh' } });
    expect(f.urls[0]).toBe('https://example.test/v1/responses');
    const cut = new ResponsesProvider({ ...base, kind: 'responses' }, 'k', responder(event({ type: 'response.output_text.delta', delta: 'half' })).fetch);
    await expect(cut.stream(req())).rejects.toMatchObject({ kind: 'interrupted', partialText: 'half' });
  });
  it('does not cache a Responses length stop as complete', async () => {
    const f = responder(event({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }));
    expect(await new ResponsesProvider({ ...base, kind: 'responses' }, 'k', f.fetch).stream(req())).toMatchObject({ finish: 'length' });
  });
  it('reads native Gemini text, excludes thought parts and sends thinkingLevel', async () => {
    const f = responder(event({ candidates: [{ content: { parts: [{ thought: true, text: 'private thought' }, { text: 'OK' }] }, finishReason: 'STOP' }] }));
    const p = new GeminiProvider({ ...base, kind: 'gemini' }, 'k', f.fetch);
    expect(await p.stream(req({ effort: 'high' }))).toMatchObject({ text: 'OK', finish: 'complete' });
    expect(f.bodies[0]).toHaveProperty('generationConfig.thinkingConfig.thinkingLevel', 'HIGH');
    expect(f.urls[0]).toContain('/models/m:streamGenerateContent?alt=sse');
  });
  it('keeps Gemini EOF, safety and token-limit endings distinct', async () => {
    for (const [payload, kind] of [[{ candidates: [{ content: { parts: [{ text: 'half' }] } }] }, 'interrupted'], [{ promptFeedback: { blockReason: 'SAFETY' } }, 'refusal']] as const) {
      const p = new GeminiProvider({ ...base, kind: 'gemini' }, 'k', responder(event(payload)).fetch);
      await expect(p.stream(req())).rejects.toMatchObject({ kind });
    }
    const p = new GeminiProvider({ ...base, kind: 'gemini' }, 'k', responder(event({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).fetch);
    expect((await p.stream(req())).finish).toBe('length');
  });
});
