import { EFFORTS, type Effort, type ModelInfo, type ProviderConfig } from '../../shared/types';
import { documentedModel } from '../../shared/model-catalog';
import { inferPreset, presetFor } from '../../shared/provider-presets';

export interface DiscoveryResult { models: ModelInfo[]; source: 'api' | 'documented' | 'manual' }
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const modelId = /^[\w.:/@+-]{1,200}$/;
const validLevels = (v: unknown): Effort[] | undefined => Array.isArray(v) ? [...new Set(v.filter((e): e is Effort => typeof e === 'string' && e !== 'default' && EFFORTS.includes(e as Effort)))] : undefined;

export function parseModel(cfg: ProviderConfig, value: unknown): ModelInfo | undefined {
  const m = record(value);
  const rawId = cfg.kind === 'gemini' ? m.name : m.id;
  if (typeof rawId !== 'string') return;
  const id = cfg.kind === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
  if (!modelId.test(id) || m.lifecycle === 'retired') return;
  if (Array.isArray(m.output_modalities) && !m.output_modalities.includes('text')) return;
  if (cfg.kind === 'gemini' && (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent'))) return;
  if (cfg.kind !== 'gemini' && /(?:embedding|whisper|tts|realtime|dall-e|sora|moderation|gpt-image|grok-imagine)/i.test(id)) return;
  const preset = inferPreset(cfg);
  const info = documentedModel(preset, id);
  const cap = record(m.capabilities);
  const effort = record(cap.effort);
  let levels = validLevels(record(m.effort).supported_levels) ?? validLevels(cap.reasoning_effort) ?? validLevels(m.supported_reasoning_efforts);
  if (Object.keys(effort).length) {
    levels = EFFORTS.filter((e) => e !== 'default' && record(effort[e]).supported === true);
  }
  if (effort.supported === false || m.thinking === false) levels = [];
  if (levels !== undefined) {
    info.efforts = preset === 'deepseek' && levels.length ? ['none', ...levels.filter((e) => e !== 'none')] : levels;
    info.effortSource = 'api';
  }
  const label = m.display_name ?? m.displayName ?? m.name;
  if (typeof label === 'string' && label.length <= 200) info.label = label;
  const limit = m.max_output_tokens ?? m.max_tokens ?? m.outputTokenLimit;
  if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= 10_000_000) info.maxOutputTokens = limit;
  return info;
}

/** Bounded JSON reads: model catalogs are untrusted provider responses. */
async function catalogJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.body) throw new Error('The model catalog response was empty.');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw new Error('The model catalog exceeded the 2 MB limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = Buffer.concat(chunks).toString('utf8');
  try { return record(JSON.parse(data)); } catch { throw new Error('The provider did not return a JSON model catalog. Check the API base URL.'); }
}

export async function discoverModels(cfg: ProviderConfig, key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<DiscoveryResult> {
  const preset = presetFor(inferPreset(cfg));
  if (preset.blocked) throw new Error('OpenCode Go is pending confirmation for reader use. No key has been sent.');
  const base = (cfg.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  const suffix = cfg.kind === 'anthropic' ? '/v1/models' : cfg.presetId === 'grok' ? '/language-models' : '/models';
  const models = new Map<string, ModelInfo>();
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL(base + suffix);
    if (cursor) url.searchParams.set(cfg.kind === 'gemini' ? 'pageToken' : 'after_id', cursor);
    if (cfg.kind === 'anthropic') url.searchParams.set('limit', '1000');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (cfg.kind === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
    else if (cfg.kind === 'gemini') headers['x-goog-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
    const res = await fetchImpl(url.toString(), { headers, signal, redirect: 'error' });
    if (!res.ok) {
      if (page === 0 && [404, 405, 501].includes(res.status)) {
        await res.body?.cancel();
        return { models: (preset.candidates ?? []).map((id) => documentedModel(preset.id, id)), source: preset.candidates?.length ? 'documented' : 'manual' };
      }
      await res.body?.cancel();
      throw new Error(`Model discovery HTTP ${res.status}. ${res.status === 401 || res.status === 403 ? 'Check this API key and its permissions.' : res.status === 429 ? 'The provider is rate limited; try again later.' : 'Check the API address, account quota and provider status.'}`);
    }
    const body = await catalogJson(res);
    const list = body.data ?? body.models;
    if (!Array.isArray(list)) throw new Error('The response has no model list. Check the endpoint and protocol.');
    for (const raw of list) { const m = parseModel(cfg, raw); if (m) models.set(m.id, m); }
    if (models.size > 1000) throw new Error('The provider returned more than 1000 models. Narrow the catalog at the provider.');
    const next = cfg.kind === 'gemini' ? body.nextPageToken : body.has_more ? body.last_id : undefined;
    if (!next) return { models: [...models.values()].sort((a, b) => a.label.localeCompare(b.label)), source: 'api' };
    if (typeof next !== 'string' || next.length > 1000 || next === cursor) throw new Error('Invalid model catalog pagination.');
    cursor = next;
  }
  throw new Error('The model catalog exceeded the pagination limit.');
}
