// Any server that speaks the OpenAI chat-completions protocol with SSE streaming:
// OpenAI, DeepSeek, Qwen/DashScope, Mistral, OpenRouter, Ollama, LM Studio …

import type { Effort, ProviderConfig } from '../../shared/types';
import { openAiMaxTokensField } from '../../shared/capabilities';
import { checkEffort, modelInfo } from '../../shared/model-catalog';
import { inferPreset } from '../../shared/provider-presets';
import { StreamError, type Provider, type StreamRequest, type StreamResult } from './index';
import { sseEvents } from './sse';

export function reasoningEffort(e: Effort): Exclude<Effort, 'default'> | undefined {
  return e === 'default' ? undefined : e;
}

export function chatThinking(cfg: ProviderConfig, model: string, effort: Effort): Record<string, unknown> {
  checkEffort(cfg, model, effort);
  if (effort === 'default') return {};
  if (!cfg.selection) return cfg.sendReasoningEffort ? { reasoning_effort: reasoningEffort(effort) } : {};
  const info = modelInfo(cfg, model);
  if (info.thinking === 'toggle') return { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } };
  if (inferPreset(cfg) === 'deepseek' && info.efforts.length) {
    return effort === 'none' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: effort };
  }
  return cfg.sendReasoningEffort || (cfg.selection && info.efforts.length) ? { reasoning_effort: reasoningEffort(effort) } : {};
}

type Chunk = {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  error?: { message?: string } | string;
};

export class OpenAICompatProvider implements Provider {
  constructor(
    private cfg: ProviderConfig,
    private apiKey: string | undefined,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  requestBody(req: Pick<StreamRequest, 'system' | 'user' | 'model' | 'effort' | 'maxTokens'>): Record<string, unknown> {
    const field = openAiMaxTokensField(this.cfg);
    return {
      model: req.model,
      stream: true,
      messages: [
        { role: 'system', content: req.system.map((p) => p.text).join('\n\n') },
        { role: 'user', content: req.user },
      ],
      ...(field !== 'none' ? { [field]: req.maxTokens } : {}),
      ...chatThinking(this.cfg, req.model, req.effort),
    };
  }

  async stream(req: StreamRequest): Promise<StreamResult> {
    const base = (this.cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const res = await this.fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(this.requestBody(req)),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw Object.assign(new StreamError('server', `HTTP ${res.status}: ${detail.slice(0, 400) || res.statusText}`), { status: res.status });
    }
    let text = '';
    let finish: string | undefined;
    let sawDone = false;
    for await (const ev of sseEvents(res.body)) {
      if (ev.data === '[DONE]') {
        sawDone = true;
        break;
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(ev.data) as Chunk;
      } catch {
        throw new StreamError('parse', 'The server sent a malformed stream event.', text);
      }
      if (chunk.error) {
        const msg = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'Provider error');
        throw new StreamError('server', msg, text);
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        req.onText(delta);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
    // A finish_reason or [DONE] ends the answer; a bare EOF means the connection was cut.
    if (!finish && !sawDone) throw new StreamError('interrupted', 'The connection ended before the answer was finished.', text);
    if (finish === 'length') return { text, finish: 'length' };
    if (finish === 'content_filter') throw new StreamError('refusal', 'The provider withheld the answer (content filter).', text);
    return { text, finish: 'complete' };
  }
}
