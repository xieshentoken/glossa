import type { ProviderConfig } from '../../shared/types';
import { checkEffort } from '../../shared/model-catalog';
import { StreamError, type Provider, type StreamRequest, type StreamResult } from './index';
import { sseEvents } from './sse';

export class GeminiProvider implements Provider {
  constructor(private cfg: ProviderConfig, private apiKey: string | undefined, private fetchImpl: typeof fetch = fetch) {}

  async stream(req: StreamRequest): Promise<StreamResult> {
    checkEffort(this.cfg, req.model, req.effort);
    const model = req.model.replace(/^models\//, '');
    const base = (this.cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const res = await this.fetchImpl(`${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST', redirect: 'error', signal: req.signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(this.apiKey ? { 'x-goog-api-key': this.apiKey } : {}) },
      body: JSON.stringify({
        systemInstruction: { parts: req.system.map((p) => ({ text: p.text })) },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: { maxOutputTokens: req.maxTokens, ...(req.effort === 'default' ? {} : { thinkingConfig: { thinkingLevel: req.effort.toUpperCase() } }) },
      }),
    });
    if (!res.ok || !res.body) throw Object.assign(new StreamError('server', `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`), { status: res.status });
    let text = '';
    let finish: string | undefined;
    let cacheReadTokens: number | undefined;
    for await (const ev of sseEvents(res.body)) {
      let e;
      try { e = JSON.parse(ev.data); } catch { throw new StreamError('parse', 'Malformed Gemini stream event.', text); }
      if (e.error) throw new StreamError('server', String(e.error.message ?? 'Gemini error'), text);
      if (e.promptFeedback?.blockReason) throw new StreamError('refusal', String(e.promptFeedback.blockReason), text);
      const candidate = e.candidates?.[0];
      for (const p of candidate?.content?.parts ?? []) if (!p.thought && typeof p.text === 'string') { text += p.text; req.onText(p.text); }
      if (candidate?.finishReason) finish = candidate.finishReason;
      cacheReadTokens = e.usageMetadata?.cachedContentTokenCount ?? cacheReadTokens;
    }
    if (finish === 'MAX_TOKENS') return { text, finish: 'length', cacheReadTokens };
    if (finish && finish !== 'STOP') throw new StreamError('refusal', `Gemini stopped: ${finish}`, text);
    if (!finish) throw new StreamError('interrupted', 'Gemini stream ended before finishReason.', text);
    return { text, finish: 'complete', cacheReadTokens };
  }
}
