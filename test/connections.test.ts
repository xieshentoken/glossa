import { describe, it, expect } from 'vitest';
import { mergeSettings } from '../src/shared/defaults';
import { normalizeBaseUrl, inferPreset, PROVIDER_PRESETS } from '../src/shared/provider-presets';
import { checkEffort, documentedModel } from '../src/shared/model-catalog';
import { vProvider } from '../src/main/validate';
import type { ProviderConfig } from '../src/shared/types';
import { selectedDirect } from '../src/shared/engine-selection';

describe('connection contracts and migration', () => {
  it('has separate GLM regions and keeps Go pending', () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual(['anthropic', 'openai', 'deepseek', 'glm-cn', 'zai', 'kimi', 'opencode-go', 'grok', 'gemini', 'custom']);
    expect(PROVIDER_PRESETS.find((p) => p.id === 'opencode-go')?.blocked).toBe(true);
  });
  it('normalizes pasted endpoints without duplicating paths', () => {
    expect(normalizeBaseUrl('https://example.com/v1/chat/completions/')).toBe('https://example.com/v1');
    expect(normalizeBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
    expect(() => normalizeBaseUrl('https://key:secret@example.com/v1')).toThrow();
    expect(() => normalizeBaseUrl('https://example.com/v1?key=secret')).toThrow();
  });
  it('preserves v2 privacy grants, custom endpoints and references', () => {
    const s = mergeSettings({ settingsVersion: 2, dataScope: 'document', agentsEnabled: true, agentTrust: { x: 'hash' }, providers: [{ id: 'openai', kind: 'openai', label: 'Work', baseUrl: 'https://relay.example/v1' }] });
    // v4 clears remembered approvals: they named a harness command (see toV4).
    expect(s).toMatchObject({ settingsVersion: 5, dataScope: 'document', agentsEnabled: true, agentTrust: {} });
    expect(s.providers.find((p) => p.id === 'openai')).toMatchObject({ label: 'Work', baseUrl: 'https://relay.example/v1', presetId: 'custom' });
    expect(inferPreset({ id: 'a', kind: 'anthropic', label: 'A' })).toBe('anthropic');
  });
  it('does not infer effort on a relay from its model name', () => {
    expect(documentedModel('custom', 'gpt-5.4').efforts).toEqual([]);
    const cfg: ProviderConfig = { id: 'work', kind: 'openai', label: 'Work', presetId: 'custom', selection: { model: 'gpt-5.4', effort: 'default' } };
    expect(() => checkEffort(cfg, 'gpt-5.4', 'default')).not.toThrow();
    expect(() => checkEffort(cfg, 'gpt-5.4', 'high')).toThrow();
    expect(documentedModel('openai', 'gpt-5').efforts).toEqual(['minimal', 'low', 'medium', 'high']);
  });
  it('round trips named connections and rejects malformed catalogs', () => {
    const p: ProviderConfig = { id: 'work', kind: 'responses', label: 'Work', presetId: 'openai', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-5.4', label: 'GPT', efforts: ['high'], effortSource: 'api' }], selection: { model: 'gpt-5.4', effort: 'high' } };
    expect(vProvider(p)).toMatchObject(p);
    expect(() => vProvider({ ...p, models: [{ id: 'm', efforts: ['imaginary'] }] })).toThrow();
  });
  it('resolves saved connection choices consistently for defaults and per-skill use', () => {
    const s = mergeSettings({});
    s.providers.push({ id: 'work', kind: 'responses', label: 'Work', selection: { model: 'gpt-5.4', effort: 'high' } });
    s.defaults.direct.providerId = 'work';
    expect(selectedDirect(s, 'eli5')).toMatchObject({ model: 'gpt-5.4', effort: 'high' });
    expect(selectedDirect(s, 'eli5', { effort: 'low' })).toMatchObject({ model: 'gpt-5.4', effort: 'low' });
  });
});
