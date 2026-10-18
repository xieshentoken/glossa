// A Glossa model connection as a Pi model. Glossa's own connection data (API
// type, address, the model's efforts from the connection test) decides what is
// sent; Pi's catalog is only asked for prices and the context window.

import { modelInfo } from '../shared/model-catalog';
import { inferPreset, presetFor } from '../shared/provider-presets';
import type { Effort, ProviderConfig, ProviderPresetId } from '../shared/types';
import type { PiApi, PiModelSpec, PiThinkingLevel } from '../worker/pi-worker.mjs';
import { JobRejected } from './job-plan';

const API: Record<Exclude<ProviderConfig['kind'], 'fake'>, PiApi> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  responses: 'openai-responses',
  gemini: 'google-generative-ai',
};

/** Pi's catalog provider for first-party endpoints. */
const CATALOG: Partial<Record<ProviderPresetId, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  deepseek: 'deepseek',
  zai: 'zai',
  grok: 'xai',
  kimi: 'moonshotai',
};

const LEVELS: Exclude<PiThinkingLevel, 'off'>[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function piModelSpec(cfg: ProviderConfig, model: string, effort: Effort, maxTokens: number): PiModelSpec {
  if (cfg.kind === 'fake') return { demo: true, api: 'openai-completions', baseUrl: '', id: model || 'fake', reasoning: false, maxTokens };
  const presetId = inferPreset(cfg);
  if (presetId === 'opencode-go') throw new JobRejected('OpenCode Go reader use has not been confirmed. This preset is not enabled.');
  if (effort === 'ultra') throw new JobRejected('Pi has no "ultra" effort. Choose another effort for this skill.');
  const official = presetId === 'custom' ? '' : presetFor(presetId).baseUrl;
  const baseUrl = (cfg.baseUrl || official || (cfg.kind === 'anthropic' ? 'https://api.anthropic.com' : '')).replace(/\/+$/, '');
  if (!baseUrl) throw new JobRejected(`The connection "${cfg.label}" has no address.`);
  const info = modelInfo(cfg, model);
  const efforts = info.efforts;
  const thinkingLevelMap: Partial<Record<PiThinkingLevel, string | null>> = {};
  for (const l of LEVELS) thinkingLevelMap[l] = efforts.includes(l) ? l : null;
  // 'default' sends no thinking parameter at all, as Glossa's own requests did.
  const reasoning = effort !== 'default' && efforts.some((e) => e !== 'none');
  const thinkingLevel: PiThinkingLevel | undefined = effort === 'default' ? undefined : effort === 'none' ? 'off' : effort;
  if (thinkingLevel && thinkingLevel !== 'off' && !efforts.includes(effort)) {
    throw new JobRejected(`Effort "${effort}" is not supported for ${model}. Choose the provider default or test the connection again.`);
  }
  const compat =
    cfg.kind === 'openai'
      ? {
          supportsReasoningEffort: !!cfg.sendReasoningEffort || !!(cfg.selection && info.thinking !== 'toggle' && efforts.length),
          ...(cfg.maxTokensField && cfg.maxTokensField !== 'none' ? { maxTokensField: cfg.maxTokensField } : {}),
        }
      : undefined;
  const catalogProvider = CATALOG[presetId];
  return {
    api: API[cfg.kind],
    baseUrl,
    id: model,
    reasoning,
    ...(reasoning ? { thinkingLevelMap } : {}),
    ...(compat ? { compat } : {}),
    maxTokens,
    ...(catalogProvider && baseUrl === official.replace(/\/+$/, '') ? { catalog: { provider: catalogProvider, id: model } } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
