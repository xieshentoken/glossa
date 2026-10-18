import type { ProviderConfig, ProviderKind, ProviderPresetId } from './types';

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  kind: Exclude<ProviderKind, 'fake'>;
  baseUrl: string;
  docs: string;
  candidates?: string[];
  blocked?: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', docs: 'https://platform.claude.com/docs/en/api/models/list' },
  { id: 'openai', label: 'OpenAI', kind: 'responses', baseUrl: 'https://api.openai.com/v1', docs: 'https://developers.openai.com/api/docs/guides/reasoning' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com', docs: 'https://api-docs.deepseek.com/api/list-models/' },
  { id: 'glm-cn', label: 'GLM · 智谱国内', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', docs: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction', candidates: ['glm-5.3', 'glm-5.2', 'glm-4.7', 'glm-4.5'] },
  { id: 'zai', label: 'GLM · Z.AI', kind: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', docs: 'https://docs.z.ai/api-reference/llm/chat-completion', candidates: ['glm-5.3', 'glm-5.2', 'glm-4.7', 'glm-4.5'] },
  { id: 'kimi', label: 'Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1', docs: 'https://platform.moonshot.cn/docs/api/models' },
  { id: 'opencode-go', label: 'OpenCode Go', kind: 'openai', baseUrl: 'https://opencode.ai/inference/go/openai/v1', docs: 'https://opencode.ai/docs/go/#where-can-i-use-it', blocked: true },
  { id: 'grok', label: 'grok · xAI', kind: 'responses', baseUrl: 'https://api.x.ai/v1', docs: 'https://docs.x.ai/developers/rest-api-reference/inference/models' },
  { id: 'gemini', label: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', docs: 'https://ai.google.dev/api/models' },
  { id: 'custom', label: 'Custom', kind: 'openai', baseUrl: '', docs: '' },
];

export function presetFor(id: ProviderPresetId): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error('Unknown provider preset');
  return preset;
}

/** Never infer provider capabilities from the model name on an arbitrary relay. */
export function inferPreset(cfg: ProviderConfig): ProviderPresetId {
  if (cfg.presetId) return cfg.presetId;
  const base = (cfg.baseUrl || (cfg.kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  return PROVIDER_PRESETS.find((p) => p.id !== 'custom' && p.baseUrl === base)?.id ?? 'custom';
}

/** Accept a base URL or a pasted endpoint; do not guess or contact another host. */
export function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error('Use an http(s) base URL without credentials, query parameters or fragments.');
  }
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages|models)$/, '');
  return u.toString().replace(/\/+$/, '');
}
