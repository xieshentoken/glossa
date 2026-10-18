import type { ProviderConfig } from '../../shared/types';
import { checkEffort } from '../../shared/model-catalog';
import { StreamError, type Provider, type StreamRequest, type StreamResult } from './index';
import { sseEvents } from './sse';

export class ResponsesProvider implements Provider {
  constructor(private cfg: ProviderConfig, private apiKey: string | undefined, private fetchImpl: typeof fetch = fetch) {}

  async stream(req: StreamRequest): Promise<StreamResult> {
    checkEffort(this.cfg, req.model, req.effort);
    const res = await this.fetchImpl(`${(this.cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/responses`, {
      method: 'POST', redirect: 'error', signal: req.signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: req.model, stream: true, store: false,
        instructions: req.system.map((p) => p.text).join('\n\n'), input: req.user,
        max_output_tokens: req.maxTokens,
        ...(req.effort === 'default' ? {} : { reasoning: { effort: req.effort } }),
      }),
    });
    if (!res.ok || !res.body) throw Object.assign(new StreamError('server', `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`), { status: res.status });
    let text = '';
    for await (const event of sseEvents(res.body)) {
      let e;
      try { e = JSON.parse(event.data); } catch { throw new StreamError('parse', 'Malformed Responses stream event.', text); }
      const type = e.type ?? event.event;
      if (type === 'response.output_text.delta' && typeof e.delta === 'string') { text += e.delta; req.onText(e.delta); }
      if (type === 'error' || type === 'response.failed' || type === 'response.refusal.done') {
        throw new StreamError(type === 'response.refusal.done' ? 'refusal' : 'server', String(e.error?.message ?? e.response?.error?.message ?? e.refusal ?? e.message ?? 'Response failed'), text);
      }
      if (type === 'response.completed' || type === 'response.incomplete') {
        if (!text) {
          for (const item of e.response?.output ?? []) for (const part of item.content ?? []) {
            if (part.type === 'refusal') throw new StreamError('refusal', String(part.refusal ?? 'Response refused'));
            if (part.type === 'output_text' && typeof part.text === 'string') { text += part.text; req.onText(part.text); }
          }
        }
        const reason = e.response?.incomplete_details?.reason;
        if (type === 'response.incomplete' || e.response?.status === 'incomplete') {
          if (reason === 'max_output_tokens') return { text, finish: 'length' };
          throw new StreamError('interrupted', `Incomplete response: ${reason ?? 'unknown reason'}`, text);
        }
        return { text, finish: 'complete', cacheReadTokens: e.response?.usage?.input_tokens_details?.cached_tokens };
      }
    }
    throw new StreamError('interrupted', 'The connection ended before response.completed.', text);
  }
}
