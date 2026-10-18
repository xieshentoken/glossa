import type { Effort, ProviderConfig } from '../../shared/types';
import { AnthropicProvider } from './anthropic';
import { FakeProvider } from './fake';
import { OpenAICompatProvider } from './openai';
import { ResponsesProvider } from './responses';
import { GeminiProvider } from './gemini';

export interface StreamRequest {
  system: { text: string; cache?: boolean }[];
  user: string;
  model: string;
  effort: Effort;
  maxTokens: number;
  signal: AbortSignal;
  onText: (delta: string) => void;
}

/** How a stream ended when it did end normally. */
export type FinishKind = 'complete' | 'length';

export interface StreamResult {
  text: string;
  finish: FinishKind;
  /** Prompt-cache statistics when the provider reports them. */
  cacheReadTokens?: number;
}

/**
 * A stream that did not end normally. `partialText` is whatever arrived first;
 * it may be shown, but never cached as a complete answer.
 */
export class StreamError extends Error {
  constructor(
    readonly kind: 'interrupted' | 'server' | 'parse' | 'refusal',
    message: string,
    readonly partialText = '',
  ) {
    super(message);
    this.name = 'StreamError';
  }
}

export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError'));
}

export interface Provider {
  stream(req: StreamRequest): Promise<StreamResult>;
}

export function createProvider(cfg: ProviderConfig, apiKey: string | undefined): Provider {
  if (cfg.presetId === 'opencode-go') throw new Error('OpenCode Go reader use has not been confirmed. This preset is not enabled.');
  if (cfg.selection && !apiKey) throw new Error(`The API key for "${cfg.label}" is unavailable. Enter a key under Model connections before using it.`);
  switch (cfg.kind) {
    case 'anthropic':
      return new AnthropicProvider(cfg, apiKey);
    case 'openai':
      return new OpenAICompatProvider(cfg, apiKey);
    case 'responses':
      return new ResponsesProvider(cfg, apiKey);
    case 'gemini':
      return new GeminiProvider(cfg, apiKey);
    case 'fake':
      return new FakeProvider();
  }
}
