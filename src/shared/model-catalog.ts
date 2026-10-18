// Fallbacks only for documented first-party model IDs. API capabilities take priority.
// Sources are the documentation URLs on provider-presets.ts; reviewed 2026-10-17.
import type { Effort, ModelInfo, ProviderConfig, ProviderPresetId } from './types';
import { inferPreset } from './provider-presets';

export function documentedModel(preset: ProviderPresetId, id: string): ModelInfo {
  let efforts: Effort[] = [];
  let thinking: ModelInfo['thinking'];
  let known = false;
  if (preset === 'openai') {
    if (/^gpt-(6\.1-sol|6-astra)(-\d{4}-\d{2}-\d{2})?$/.test(id)) { efforts = ['low', 'medium', 'high', 'xhigh', 'max']; known = true; }
    else if (/^gpt-5\.[2345](-\d{4}-\d{2}-\d{2})?$/.test(id)) { efforts = ['none', 'low', 'medium', 'high', 'xhigh']; known = true; }
    else if (/^gpt-5\.1(-\d{4}-\d{2}-\d{2})?$/.test(id)) { efforts = ['none', 'low', 'medium', 'high']; known = true; }
    else if (/^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(id)) { efforts = ['minimal', 'low', 'medium', 'high']; known = true; }
    else if (/^o[134](-mini)?(-\d{4}-\d{2}-\d{2})?$/.test(id)) { efforts = ['low', 'medium', 'high']; known = true; }
    else if (/^gpt-(4|3\.5)/.test(id)) known = true;
  } else if (preset === 'anthropic') {
    if (/^claude-opus-4-6(-\d{8})?$/.test(id)) { efforts = ['low', 'medium', 'high', 'max']; known = true; }
    else if (/^claude-(sonnet-4-6|opus-4-5)(-\d{8})?$/.test(id)) { efforts = ['low', 'medium', 'high']; known = true; }
  } else if (preset === 'deepseek' && /^(deepseek-flash|deepseek-v4(-pro|-flash)?)$/.test(id)) {
    efforts = ['none', 'low', 'high', 'max']; thinking = 'effort'; known = true;
  } else if ((preset === 'glm-cn' || preset === 'zai') && /^glm-(4\.[567]|5(\.[123])?)(-flash|-air|-airx)?$/.test(id)) {
    thinking = 'toggle'; efforts = ['none', 'high']; known = true;
  } else if (preset === 'kimi' && id === 'kimi-k2.5') {
    thinking = 'toggle'; efforts = ['none', 'high']; known = true;
  } else if (preset === 'grok') {
    if (/^grok-4\.[67](-latest)?$/.test(id)) { efforts = ['low', 'medium', 'high', 'xhigh']; known = true; }
    else if (/^grok-4\.5(-latest)?$/.test(id)) { efforts = ['low', 'medium', 'high']; known = true; }
  } else if (preset === 'gemini') {
    if (/^gemini-(4-argon|3\.[78]-flash|3\.1-pro-preview)$/.test(id)) { efforts = ['low', 'medium', 'high']; known = true; }
    else if (/^gemini-(3\.[56]-flash|3\.5-flash-lite|3-flash-preview)$/.test(id)) { efforts = ['minimal', 'low', 'medium', 'high']; known = true; }
    else if (id === 'gemini-3-pro-preview') { efforts = ['low', 'high']; known = true; }
  }
  return { id, label: id, efforts, effortSource: known ? 'documented' : 'unknown', ...(thinking ? { thinking } : {}) };
}

export function modelInfo(cfg: ProviderConfig, id: string): ModelInfo {
  return cfg.models?.find((m) => m.id === id) ?? documentedModel(inferPreset(cfg), id);
}

/** Validate in the main process too, so a stale UI cannot send an unsupported value. */
export function checkEffort(cfg: ProviderConfig, model: string, effort: Effort): void {
  if (effort === 'default' || !cfg.selection) return; // legacy settings retain their existing parameter behavior
  if (!modelInfo(cfg, model).efforts.includes(effort)) throw new Error(`Effort "${effort}" is not supported for ${model}. Choose the provider default or test the connection again.`);
}
