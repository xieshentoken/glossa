import Anthropic from '@anthropic-ai/sdk';
import { isLegacyClaude } from '../../shared/capabilities';
import { checkEffort } from '../../shared/model-catalog';
import type { ProviderConfig } from '../../shared/types';
import { isAbort, StreamError, type FinishKind, type Provider, type StreamRequest, type StreamResult } from './index';

export { isLegacyClaude };

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

function finishOf(stop: string | null): FinishKind | StreamError {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'complete';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return new StreamError('refusal', 'The model declined to answer this request.');
    default:
      return new StreamError('interrupted', `The answer stopped early (${stop ?? 'no stop reason'}).`);
  }
}

export class AnthropicProvider implements Provider {
  private client: Anthropic;

  constructor(
    private cfg: ProviderConfig,
    apiKey: string | undefined,
    clientOptions: ConstructorParameters<typeof Anthropic>[0] = {},
  ) {
    // Without a stored key the SDK falls back to ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN.
    // No automatic retries: a retried request can be billed twice.
    this.client = new Anthropic({ ...(apiKey ? { apiKey } : {}), baseURL: cfg.baseUrl || undefined, maxRetries: 0,
      fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }), ...clientOptions });
  }

  private params(req: Pick<StreamRequest, 'system' | 'model' | 'effort'>) {
    const legacy = isLegacyClaude(req.model);
    checkEffort(this.cfg, req.model, req.effort);
    const effort = req.effort;
    if (!legacy && !['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`Unsupported Anthropic effort: ${effort}`);
    const sent = effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max' ? effort : undefined;
    return {
      model: req.model,
      system: req.system.map((p) => ({
        type: 'text' as const,
        text: p.text,
        ...(p.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      })),
      ...(legacy || !sent ? {} : {
        output_config: { effort: sent },
        ...(/claude-(?:opus|sonnet|haiku)-(?:[5-9]|4-6)/.test(req.model) ? { thinking: { type: 'adaptive' as const } } : {}),
      }),
    };
  }

  async stream(req: StreamRequest): Promise<StreamResult> {
    const base = {
      ...this.params(req),
      max_tokens: req.maxTokens,
      messages: [{ role: 'user' as const, content: req.user }],
    };
    const official = !this.cfg.baseUrl || this.cfg.baseUrl.replace(/\/+$/, '') === 'https://api.anthropic.com';
    const useFallback = this.cfg.serverFallback !== false && official && FALLBACK_MODELS.has(req.model);
    let streamed = '';
    const onText = (delta: string) => {
      streamed += delta;
      req.onText(delta);
    };
    let msg;
    try {
      msg = useFallback
        ? await this.client.beta.messages
            .stream({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal: req.signal })
            .on('text', onText)
            .finalMessage()
        : await this.client.messages.stream(base, { signal: req.signal }).on('text', onText).finalMessage();
    } catch (err) {
      if (isAbort(err, req.signal)) throw err;
      const status = (err as { status?: number }).status;
      throw Object.assign(new StreamError(status ? 'server' : 'interrupted', (err as Error).message, streamed), { status });
    }
    let text = '';
    for (const b of msg.content) if (b.type === 'text') text += b.text;
    const finish = finishOf(msg.stop_reason);
    if (finish instanceof StreamError) throw new StreamError(finish.kind, finish.message, text);
    return { text, finish, cacheReadTokens: msg.usage.cache_read_input_tokens ?? undefined };
  }
}
