// P0-3: request parameters and stream termination, per provider.
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/main/providers/anthropic';
import { StreamError, type StreamRequest } from '../src/main/providers';
import { OpenAICompatProvider } from '../src/main/providers/openai';
import { sseEvents } from '../src/main/providers/sse';
import { paramSupport } from '../src/shared/capabilities';
import type { ProviderConfig } from '../src/shared/types';

const enc = new TextEncoder();
function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      c.close();
    },
  });
}
const ev = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (t: string, finish: string | null = null) => ev({ choices: [{ delta: { content: t }, finish_reason: finish }] });

function openai(cfg: Partial<ProviderConfig>, respond: (body: Record<string, unknown>, signal?: AbortSignal) => Response | Promise<Response>) {
  const bodies: Record<string, unknown>[] = [];
  const p = new OpenAICompatProvider({ id: 'o', kind: 'openai', label: 'O', ...cfg }, 'k', (async (_u: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init!.body));
    bodies.push(b);
    return respond(b, init!.signal ?? undefined);
  }) as typeof fetch);
  return { p, bodies };
}
const args = (o: Partial<StreamRequest> = {}): StreamRequest => ({
  system: [{ text: 's' }],
  user: 'u',
  model: 'm',
  effort: 'max',
  maxTokens: 321,
  signal: new AbortController().signal,
  onText: () => {},
  ...o,
});

describe('OpenAI-compatible request body', () => {
  it('sends exactly one length field, chosen per endpoint', async () => {
    const official = openai({ baseUrl: 'https://api.openai.com/v1' }, () => new Response(delta('a', 'stop')));
    await official.p.stream(args());
    expect(official.bodies[0]).toMatchObject({ max_completion_tokens: 321 });
    expect(official.bodies[0]).not.toHaveProperty('max_tokens');

    const local = openai({ baseUrl: 'http://localhost:11434/v1' }, () => new Response(delta('a', 'stop')));
    await local.p.stream(args());
    expect(local.bodies[0]).toMatchObject({ max_tokens: 321 });
    expect(local.bodies[0]).not.toHaveProperty('max_completion_tokens');

    const none = openai({ baseUrl: 'http://x/v1', maxTokensField: 'none' }, () => new Response(delta('a', 'stop')));
    await none.p.stream(args());
    expect(none.bodies[0]).not.toHaveProperty('max_tokens');
    expect(none.bodies[0]).not.toHaveProperty('max_completion_tokens');
  });

  it('reports which parameters take effect', () => {
    expect(paramSupport({ id: 'o', kind: 'openai', label: '', baseUrl: 'http://x/v1' }, 'm')).toEqual({ maxTokens: 'max_tokens', effort: null, temperature: null });
    expect(paramSupport({ id: 'o', kind: 'openai', label: '', sendReasoningEffort: true }, 'm').effort).toBe('reasoning_effort');
    expect(paramSupport({ id: 'a', kind: 'anthropic', label: '' }, 'claude-haiku-4-5').effort).toBeNull();
    expect(paramSupport({ id: 'a', kind: 'anthropic', label: '' }, 'claude-opus-5-5').effort).toBe('output_config.effort');
  });
});

describe('OpenAI-compatible stream endings', () => {
  it('complete with [DONE]', async () => {
    const { p } = openai({}, () => new Response(delta('Hel') + delta('lo') + 'data: [DONE]\n\n'));
    expect(await p.stream(args())).toEqual({ text: 'Hello', finish: 'complete' });
  });
  it('complete with finish_reason and no [DONE] (some servers)', async () => {
    const { p } = openai({}, () => new Response(delta('Hi', 'stop')));
    expect((await p.stream(args())).finish).toBe('complete');
  });
  it('length cut', async () => {
    const { p } = openai({}, () => new Response(delta('Hi', 'length') + 'data: [DONE]\n\n'));
    expect(await p.stream(args())).toEqual({ text: 'Hi', finish: 'length' });
  });
  it('EOF without any termination is an interruption that keeps the partial text', async () => {
    const { p } = openai({}, () => new Response(delta('half')));
    const err = await p.stream(args()).catch((e) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect(err).toMatchObject({ kind: 'interrupted', partialText: 'half' });
  });
  it('HTTP error', async () => {
    const { p } = openai({}, () => new Response('bad key', { status: 401 }));
    await expect(p.stream(args())).rejects.toMatchObject({ kind: 'server', status: 401, message: 'HTTP 401: bad key' });
  });
  it('malformed event data', async () => {
    const { p } = openai({}, () => new Response(delta('a') + 'data: {not json\n\n'));
    await expect(p.stream(args())).rejects.toMatchObject({ kind: 'parse', partialText: 'a' });
  });
  it('error object inside the stream', async () => {
    const { p } = openai({}, () => new Response(delta('a') + ev({ error: { message: 'overloaded' } })));
    await expect(p.stream(args())).rejects.toMatchObject({ kind: 'server', message: 'overloaded' });
  });
  it('content filter is a refusal', async () => {
    const { p } = openai({}, () => new Response(delta('x', 'content_filter')));
    await expect(p.stream(args())).rejects.toMatchObject({ kind: 'refusal' });
  });
  it('abort mid-stream rejects as an abort, not as success', async () => {
    const ac = new AbortController();
    const { p } = openai({}, (_b, signal) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(delta('a')));
          signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      });
      return new Response(body);
    });
    const run = p.stream(args({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 20);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('SSE parsing', () => {
  it('handles UTF-8 split across chunks, CRLF split across chunks, comments and multi-line data', async () => {
    const bytes = enc.encode('data: 对流\r\n\r\n');
    const cut = 8; // inside the first CJK character
    const events = [];
    for await (const e of sseEvents(streamOf([bytes.slice(0, cut), bytes.slice(cut, bytes.length - 3), bytes.slice(bytes.length - 3, bytes.length - 1), bytes.slice(bytes.length - 1), ': ping\n\n', 'event: x\ndata: a\ndata: b\n\n', 'data: tail']))) events.push(e);
    expect(events).toEqual([{ event: undefined, data: '对流' }, { event: 'x', data: 'a\nb' }, { event: undefined, data: 'tail' }]);
  });
});

describe('Anthropic stop reasons', () => {
  const sseResponse = (stop: string, text = 'Hallo') =>
    new Response(
      [
        { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]
        .map((l) => `event: ${l.type}\ndata: ${JSON.stringify(l)}\n\n`)
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const mk = (res: () => Response) =>
    new AnthropicProvider({ id: 'a', kind: 'anthropic', label: 'A' }, 'sk', { fetch: (async () => res()) as typeof fetch });

  it('end_turn → complete; max_tokens → length; refusal → error', async () => {
    expect((await mk(() => sseResponse('end_turn')).stream(args({ model: 'claude-haiku-5-5' }))).finish).toBe('complete');
    expect(await mk(() => sseResponse('max_tokens')).stream(args({ model: 'claude-haiku-5-5' }))).toMatchObject({ finish: 'length', text: 'Hallo' });
    await expect(mk(() => sseResponse('refusal')).stream(args({ model: 'claude-haiku-5-5' }))).rejects.toMatchObject({ kind: 'refusal' });
  });

  it('does not retry automatically (a retried request could be billed twice)', async () => {
    let calls = 0;
    const p = new AnthropicProvider({ id: 'a', kind: 'anthropic', label: 'A' }, 'sk', {
      fetch: (async () => (calls++, new Response('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}', { status: 529 }))) as typeof fetch,
    });
    await expect(p.stream(args({ model: 'claude-haiku-5-5' }))).rejects.toMatchObject({ kind: 'server', status: 529 });
    expect(calls).toBe(1);
  });
});
