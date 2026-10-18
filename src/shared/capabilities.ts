// Which generation settings each provider actually sends, so the UI can show
// what takes effect instead of silently ignoring a field.

import type { ProviderConfig } from './types';
import { modelInfo } from './model-catalog';

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens' | 'none';

export function openAiMaxTokensField(cfg: ProviderConfig): MaxTokensField {
  if (cfg.maxTokensField) return cfg.maxTokensField;
  // OpenAI's own endpoint uses max_completion_tokens (max_tokens is rejected by its reasoning models);
  // most other compatible servers only know max_tokens.
  return /^https:\/\/api\.openai\.com\//.test(cfg.baseUrl || 'https://api.openai.com/v1') ? 'max_completion_tokens' : 'max_tokens';
}

export interface ParamSupport {
  maxTokens: string | null;
  effort: string | null;
  temperature: null;
}

/** null = not sent for this provider. Strings name the wire field. */
export function paramSupport(cfg: ProviderConfig, model: string): ParamSupport {
  switch (cfg.kind) {
    case 'anthropic': {
      const legacy = isLegacyClaude(model);
      return { maxTokens: 'max_tokens', effort: legacy ? null : 'output_config.effort', temperature: null };
    }
    case 'openai': {
      const f = openAiMaxTokensField(cfg);
      const m = modelInfo(cfg, model);
      return { maxTokens: f === 'none' ? null : f, effort: cfg.selection && m.thinking === 'toggle' ? 'thinking.type' : cfg.sendReasoningEffort || (cfg.selection && m.efforts.length > 0) ? 'reasoning_effort' : null, temperature: null };
    }
    case 'responses':
      return { maxTokens: 'max_output_tokens', effort: modelInfo(cfg, model).efforts.length ? 'reasoning.effort' : null, temperature: null };
    case 'gemini':
      return { maxTokens: 'maxOutputTokens', effort: modelInfo(cfg, model).efforts.length ? 'thinkingConfig.thinkingLevel' : null, temperature: null };
    case 'fake':
      return { maxTokens: null, effort: null, temperature: null };
  }
}

/** Older Claude models that take neither `effort` nor adaptive thinking. */
export function isLegacyClaude(model: string): boolean {
  return /^claude-(3|instant|2|haiku-4|sonnet-4-5|sonnet-4-0|sonnet-4-2|opus-4-0|opus-4-1|opus-4-2|sonnet-4$|opus-4$)/.test(model);
}
