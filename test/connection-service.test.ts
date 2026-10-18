import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionService } from '../src/main/connections';
import { Store } from '../src/main/store';
import { box, tmpDir } from './helpers';
import { connectionTest, connectionSave } from '../src/main/connection-validation';
import type { ConnectionSave, ConnectionTest } from '../src/shared/connections';
import type { StreamRequest } from '../src/main/providers';

const dirs: string[] = [];
const services: ConnectionService[] = [];
afterEach(() => { for (const s of services.splice(0)) s.dispose(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const request = (over: Partial<ConnectionTest> = {}): ConnectionTest => ({ requestId: 'test-request-1', draft: { presetId: 'custom', label: 'Work', baseUrl: 'https://example.test/v1' }, key: 'test-secret-value', ...over });
function setup(fetchImpl: typeof fetch, respond?: (r: StreamRequest) => Promise<{ text: string; finish: 'complete' | 'length' }>) {
  const dir = tmpDir(); dirs.push(dir);
  const store = new Store(dir, box);
  const sent: StreamRequest[] = [];
  const service = new ConnectionService(store, { fetch: fetchImpl, provider: () => ({ stream: async (r) => { sent.push(r); return respond ? respond(r) : { text: 'OK', finish: 'complete' }; } }) });
  services.push(service);
  return { store, service, dir, sent };
}
const catalog = ((() => Promise.resolve(Response.json({ data: [{ id: 'm', capabilities: { reasoning_effort: ['low', 'high'] } }] }))) as typeof fetch);
function selection(ticket: string, over: Partial<ConnectionSave> = {}): ConnectionSave { return { requestId: 'save-request-1', ticket, model: 'm', effort: 'high', mode: 'persist', useFor: 'both', ...over }; }

describe('connection lifecycle', () => {
  it('keeps test drafts out of settings and encrypted key storage until save', async () => {
    const { store, service, dir, sent } = setup(catalog);
    const initial = JSON.stringify(store.getSettings());
    const d = await service.test(request());
    expect(JSON.stringify(store.getSettings())).toBe(initial);
    expect(fs.existsSync(store.secretsFile)).toBe(false);
    const saved = await service.save(selection(d.ticket));
    const p = saved.providers.find((p) => p.label === 'Work')!;
    expect(store.getKey(p.id)).toBe('test-secret-value');
    expect(fs.readFileSync(store.secretsFile, 'utf8')).not.toContain('test-secret-value');
    expect(saved.defaults.quick).toMatchObject({ providerId: p.id, model: 'm', effort: 'high' });
    expect(sent[0]).toMatchObject({ model: 'm', effort: 'high' });
    expect(sent[0].user).not.toContain('document');
    expect(new Store(dir, box).getSettings().providers.find((x) => x.id === p.id)).toMatchObject(p);
    expect(new Store(dir, box).getKey(p.id)).toBe('test-secret-value');
  });
  it('supports multiple independently named keys for the same provider', async () => {
    const { store, service } = setup(catalog);
    for (const name of ['Personal', 'Work']) {
      const req = request(); req.draft.label = name;
      const t = await service.test(req);
      await service.save(selection(t.ticket));
    }
    const entries = store.getSettings().providers.filter((p) => p.selection);
    expect(entries.map((p) => p.label)).toEqual(['Personal', 'Work']);
    expect(new Set(entries.map((p) => p.id)).size).toBe(2);
  });
  it('refuses unlisted models and unsupported effort without running a probe', async () => {
    const { service, sent } = setup(catalog);
    const d = await service.test(request());
    await expect(service.save(selection(d.ticket, { model: 'other' }))).rejects.toThrow('returned');
    await expect(service.save(selection(d.ticket, { effort: 'max' }))).rejects.toThrow('not supported');
    expect(sent).toHaveLength(0);
  });
  it('cancel discards the ticket and cannot save afterward', async () => {
    const { service, store } = setup(catalog);
    const d = await service.test(request());
    service.cancel('test-request-1', d.ticket);
    await expect(service.save(selection(d.ticket))).rejects.toThrow('expired');
    expect(store.getSettings().providers.some((p) => p.label === 'Work')).toBe(false);
  });
  it('rejects saving if the editor is closed while the probe is in flight', async () => {
    let finish!: () => void;
    const { service, store } = setup(catalog, () => new Promise((resolve) => { finish = () => resolve({ text: 'OK', finish: 'complete' }); }));
    const d = await service.test(request());
    const saving = service.save(selection(d.ticket));
    service.cancel('save-request-1', d.ticket); finish();
    await expect(saving).rejects.toThrow();
    expect(store.keyStatus().keys).toEqual({});
  });
  it('redacts a provider error that echoes the key and does not save a failed probe', async () => {
    const { service, store } = setup(catalog, async () => { throw new Error('Rejected test-secret-value'); });
    const d = await service.test(request());
    await expect(service.save(selection(d.ticket))).rejects.toThrow('Rejected [redacted]');
    expect(store.keyStatus().keys).toEqual({});
  });
  it('rejects empty or truncated probes', async () => {
    const { service, store } = setup(catalog, async () => ({ text: 'half', finish: 'length' }));
    const d = await service.test(request());
    await expect(service.save(selection(d.ticket))).rejects.toThrow('complete text');
    expect(store.keyStatus().keys).toEqual({});
  });
  it('does not forward a saved key to a changed address', async () => {
    const { service, store } = setup(catalog);
    store.setSettings({ providers: [...store.getSettings().providers, { id: 'existing', kind: 'openai', label: 'Old', baseUrl: 'https://old.example/v1', presetId: 'custom' }] });
    store.setKey('existing', 'old-key');
    const req = request({ key: undefined }); req.draft.id = 'existing';
    await expect(service.test(req)).rejects.toThrow('address changed');
  });
  it('restores the old key and settings after a settings write failure', async () => {
    const { service, store } = setup(catalog);
    store.setSettings({ providers: [...store.getSettings().providers, { id: 'existing', kind: 'openai', label: 'Old', baseUrl: 'https://example.test/v1', presetId: 'custom' }] });
    store.setKey('existing', 'old-key');
    const initial = JSON.stringify(store.getSettings());
    const req = request(); req.draft.id = 'existing';
    const d = await service.test(req);
    // An actual filesystem failure, not a mocked store implementation.
    fs.renameSync(store.settingsFile, path.join(store.dir, 'settings.backup'));
    fs.mkdirSync(store.settingsFile);
    await expect(service.save(selection(d.ticket))).rejects.toThrow();
    expect(store.getKey('existing')).toBe('old-key');
    expect(JSON.stringify(store.getSettings())).toBe(initial);
  });
  it('keeps the OpenCode Go preset blocked without sending a request', async () => {
    let calls = 0;
    const { service } = setup((async () => { calls++; return Response.json({ data: [] }); }) as typeof fetch);
    const r = request(); r.draft.presetId = 'opencode-go';
    await expect(service.test(r)).rejects.toThrow('coding-agent');
    expect(calls).toBe(0);
  });
  it('supports manual-model fallback without claiming that authentication passed', async () => {
    const { service } = setup((async () => new Response('', { status: 404 })) as typeof fetch);
    const d = await service.test(request());
    expect(d).toMatchObject({ models: [], source: 'manual' });
    await expect(service.save(selection(d.ticket, { model: 'manual-model', effort: 'default' }))).resolves.toHaveProperty('providers');
  });
  it('rejects unsupported IPC fields and invalid model IDs', () => {
    expect(() => connectionTest({ ...request(), secret: 'x' })).toThrow();
    expect(() => connectionSave(selection('valid-ticket', { model: '../../bad model' }))).toThrow();
  });
  it('removes only unreferenced configurations and their keys', async () => {
    const { service, store } = setup(catalog);
    const d = await service.test(request());
    const s = await service.save(selection(d.ticket));
    const id = s.defaults.direct.providerId;
    expect(() => store.removeConnection(id)).toThrow('in use');
    store.setSettings({ defaults: { ...s.defaults, quick: { ...s.defaults.quick, providerId: 'demo' }, direct: { ...s.defaults.direct, providerId: 'demo' } } });
    store.removeConnection(id);
    expect(store.getKey(id)).toBeUndefined();
    expect(store.getSettings().providers.some((p) => p.id === id)).toBe(false);
  });
});
