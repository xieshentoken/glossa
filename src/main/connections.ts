// Temporary drafts and credentials stay in the main process until Save succeeds.
import { randomUUID } from 'node:crypto';
import type { ConnectionDiscovery, ConnectionSave, ConnectionTest } from '../shared/connections';
import type { ModelInfo, ProviderConfig, Settings } from '../shared/types';
import { documentedModel, checkEffort } from '../shared/model-catalog';
import { normalizeBaseUrl, presetFor } from '../shared/provider-presets';
import { createProvider, type Provider } from './providers';
import { discoverModels } from './providers/discovery';
import type { Store } from './store';

interface Pending { cfg: ProviderConfig; key: string; models: ModelInfo[]; source: ConnectionDiscovery['source']; expires: number; requestId: string; revision: string }
interface Options {
  fetch?: typeof fetch;
  provider?: (cfg: ProviderConfig, key: string) => Provider;
  now?: () => number;
  timeoutMs?: number;
}

function safeError(error: unknown, key: string): Error {
  const raw = error instanceof Error ? error.message : 'The provider request failed.';
  return new Error(raw.split(key).join('[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 800));
}

export class ConnectionService {
  private pending = new Map<string, Pending>();
  private operations = new Map<string, AbortController>();
  private now: () => number;
  private expiryTimer: ReturnType<typeof setInterval>;
  constructor(private store: Store, private options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.expiryTimer = setInterval(() => this.expire(), 60_000);
    this.expiryTimer.unref();
  }

  dispose(): void { clearInterval(this.expiryTimer); for (const a of this.operations.values()) a.abort(); this.operations.clear(); this.pending.clear(); }
  private expire(): void { for (const [id, p] of this.pending) if (p.expires <= this.now()) this.pending.delete(id); }
  cancel(requestId: string, ticket?: string): void {
    this.operations.get(requestId)?.abort();
    if (ticket) this.pending.delete(ticket);
    for (const [id, p] of this.pending) if (p.requestId === requestId) this.pending.delete(id);
  }
  private async operation<T>(id: string, key: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.operations.has(id)) throw new Error('This connection request is already running.');
    if (this.operations.size >= 4) throw new Error('Too many connection tests are running.');
    const ac = new AbortController();
    this.operations.set(id, ac);
    const timer = setTimeout(() => ac.abort(), this.options.timeoutMs ?? 60_000);
    try { return await run(ac.signal); }
    catch (error) { if (ac.signal.aborted) throw new Error('Connection test cancelled or timed out. Try again when ready.'); throw safeError(error, key); }
    finally { clearTimeout(timer); this.operations.delete(id); }
  }

  async test(req: ConnectionTest): Promise<ConnectionDiscovery> {
    this.expire();
    if (this.pending.size >= 10) throw new Error('Close an unfinished connection editor before testing another.');
    const preset = presetFor(req.draft.presetId);
    if (preset.blocked) throw new Error('OpenCode Go is designed for coding-agent traffic. Reader use has not been confirmed; the preset is reserved and no key is sent.');
    const existing = req.draft.id ? this.store.getSettings().providers.find((p) => p.id === req.draft.id) : undefined;
    if (req.draft.id && !existing) throw new Error('The connection no longer exists. Reopen the editor.');
    const key = req.key?.trim() || (existing ? this.store.getKey(existing.id) : undefined);
    if (!key) throw new Error('Enter an API key before testing the connection.');
    const cfg: ProviderConfig = {
      id: existing?.id ?? `key-${randomUUID().slice(0, 30)}`, label: req.draft.label.trim() || preset.label,
      presetId: preset.id, kind: preset.id === 'custom' ? req.draft.kind ?? 'openai' : preset.kind,
      baseUrl: normalizeBaseUrl(preset.id === 'custom' ? req.draft.baseUrl ?? '' : preset.baseUrl),
      ...(preset.id === 'custom' && existing?.maxTokensField ? { maxTokensField: existing.maxTokensField } : {}),
      ...(existing?.serverFallback !== undefined ? { serverFallback: existing.serverFallback } : {}),
    };
    if (cfg.kind === 'anthropic') cfg.baseUrl = cfg.baseUrl!.replace(/\/v1$/, '');
    if (existing && !req.key?.trim()) {
      const oldBase = normalizeBaseUrl(existing.baseUrl || presetFor(existing.presetId ?? 'custom').baseUrl);
      if (oldBase.replace(/\/v1$/, '') !== cfg.baseUrl!.replace(/\/v1$/, '')) throw new Error('The API address changed. Enter a key explicitly before sending it to the new address.');
    }
    // Keep existing custom protocol behavior until it is explicitly replaced by this editor.
    if (existing?.sendReasoningEffort && preset.id === 'custom') cfg.sendReasoningEffort = true;
    return this.operation(req.requestId, key, async (signal) => {
      const result = await discoverModels(cfg, key, signal, this.options.fetch);
      signal.throwIfAborted();
      const ticket = randomUUID();
      this.pending.set(ticket, { cfg, key, models: result.models, source: result.source, expires: this.now() + 10 * 60_000, requestId: req.requestId, revision: JSON.stringify(existing ?? null) });
      return { ticket, ...result };
    });
  }

  async save(req: ConnectionSave): Promise<Settings> {
    this.expire();
    const p = this.pending.get(req.ticket);
    if (!p) throw new Error('The test expired or was cancelled. Test this connection again.');
    const existing = this.store.getSettings().providers.find((c) => c.id === p.cfg.id);
    if (JSON.stringify(existing ?? null) !== p.revision) throw new Error('This connection changed since testing. Reopen the editor and test again.');
    let model = p.models.find((m) => m.id === req.model);
    if (!model && p.source === 'api') throw new Error('Choose a model returned by this connection.');
    if (!model) model = documentedModel(p.cfg.presetId ?? 'custom', req.model);
    const cfg: ProviderConfig = { ...p.cfg, models: [...p.models.filter((m) => m.id !== model!.id), model], selection: { model: req.model, effort: req.effort } };
    checkEffort(cfg, req.model, req.effort);
    return this.operation(req.requestId, p.key, async (signal) => {
      const result = await (this.options.provider ?? createProvider)(cfg, p.key).stream({
        system: [{ text: 'This is a connectivity test. Reply briefly.' }], user: 'Reply with OK.',
        model: req.model, effort: req.effort, maxTokens: Math.min(4096, model.maxOutputTokens ?? 4096), signal, onText: () => {},
      });
      signal.throwIfAborted();
      if (!this.pending.has(req.ticket)) throw new Error('The editor was closed. Nothing was saved.');
      if (JSON.stringify(this.store.getSettings().providers.find((c) => c.id === cfg.id) ?? null) !== p.revision) throw new Error('This connection changed while testing. Nothing was saved.');
      if (result.finish !== 'complete' || !result.text.trim()) throw new Error('The selected model did not return a complete text answer. Try another model or effort. Nothing was saved.');
      const settings = this.store.saveConnection(cfg, p.key, req.mode, req.useFor);
      this.pending.delete(req.ticket);
      return settings;
    });
  }
}
