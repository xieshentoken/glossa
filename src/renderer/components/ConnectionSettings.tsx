import { useEffect, useRef, useState } from 'react';
import type { KeyStatus } from '../../shared/api';
import type { ConnectionDiscovery, ConnectionDraft, ConnectionSave } from '../../shared/connections';
import type { Effort, ProviderConfig, ProviderPresetId, Settings } from '../../shared/types';
import { connectionCopy, effortLabel } from '../../shared/connection-copy';
import { documentedModel, modelInfo } from '../../shared/model-catalog';
import { inferPreset, presetFor, PROVIDER_PRESETS } from '../../shared/provider-presets';
import { api } from '../api';

interface Props { settings: Settings; onSaved: (settings: Settings) => void }
export function ConnectionSettings({ settings, onSaved }: Props) {
  const c = connectionCopy(settings.uiLang);
  const [status, setStatus] = useState<KeyStatus>();
  const [editing, setEditing] = useState<ProviderConfig | 'new'>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => { setError(''); try { await action(); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { let live = true; api.keys.status().then((s) => { if (live) setStatus(s); }).catch((e) => { if (live) setError(e.message); }); return () => { live = false; }; }, [settings.providers]);
  if (editing) return <ConnectionEditor key={editing === 'new' ? 'new' : editing.id} settings={settings} existing={editing === 'new' ? undefined : editing} status={status}
    onCancel={() => setEditing(undefined)} onSaved={(s) => { onSaved(s); setEditing(undefined); setNotice(c.saved); }} />;
  return <div className="form" data-testid="connections">
    {/* The pane heading names the section; the action sits on its own row. */}
    <div className="row connection-heading"><span /><button className="primary" onClick={() => { setNotice(''); setEditing('new'); }} data-testid="connection-add">+ {c.add}</button></div>
    {notice && <p className="ok" role="status">{notice}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {status && !status.persistent && <p className="warn">{c.noProtection}</p>}
    {!!status?.legacyPlaintext.length && <button onClick={() => void run(async () => { setStatus(await api.keys.removePlaintext()); })}>{c.removePlaintext}</button>}
    {settings.providers.filter((p) => p.kind !== 'fake').map((p) => <div className="box connection-summary" key={p.id}>
      <div className="row connection-heading"><strong>{p.label}</strong><button onClick={() => { setNotice(''); setEditing(p); }}>{c.edit}</button></div>
      <span className="muted small">{presetFor(inferPreset(p)).label} · {p.selection ? `${p.selection.model} · ${effortLabel(settings.uiLang, p.selection.effort, modelInfo(p, p.selection.model).thinking)}` : c.legacy}</span>
      <span className="small">{status?.keys[p.id] === 'stored' ? c.storedKey : status?.keys[p.id] === 'session' ? c.sessionKey : status?.keys[p.id] === 'plaintext' ? c.plainKey : c.noKey}</span>
      <div className="row wrap">
        {status?.keys[p.id] && <button onClick={() => { if (window.confirm(c.confirmClear)) void run(async () => { setStatus(await api.keys.set(p.id, null)); setNotice(c.cleared); }); }}>{c.clearKey}</button>}
        {!['anthropic', 'openai', 'ollama', 'demo'].includes(p.id) && <button className="danger" onClick={() => { if (window.confirm(c.confirmRemove)) void run(async () => { onSaved(await api.connections.remove(p.id)); }); }}>{c.remove}</button>}
      </div>
    </div>)}
    <p className="muted small">{c.testCost}</p>
  </div>;
}

function ConnectionEditor({ settings, existing, status, onCancel, onSaved }: {
  settings: Settings; existing?: ProviderConfig; status?: KeyStatus; onCancel: () => void; onSaved: (s: Settings) => void;
}) {
  const c = connectionCopy(settings.uiLang);
  const [draft, setDraft] = useState<ConnectionDraft>(() => ({ id: existing?.id, presetId: existing ? inferPreset(existing) : 'anthropic', label: existing?.label ?? '', baseUrl: existing?.baseUrl ?? '', kind: existing?.kind === 'fake' ? 'openai' : existing?.kind ?? 'openai' }));
  const [key, setKey] = useState('');
  const [discovery, setDiscovery] = useState<ConnectionDiscovery>();
  const [model, setModel] = useState(existing?.selection?.model ?? '');
  const [effort, setEffort] = useState<Effort>(existing?.selection?.effort ?? 'default');
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save'>();
  const [error, setError] = useState('');
  const [useFor, setUseFor] = useState<ConnectionSave['useFor']>(existing ? 'none' : 'both');
  const [mode, setMode] = useState<'persist' | 'session'>(status?.persistent ? 'persist' : 'session');
  const active = useRef<{ requestId: string; ticket?: string } | undefined>(undefined);
  const alive = useRef(true);
  const preset = presetFor(draft.presetId);
  const info = discovery?.models.find((m) => m.id === model) ?? documentedModel(draft.presetId, model);
  const hasKey = !!existing && !!status?.keys[existing.id];
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (active.current) void api.connections.cancel(active.current.requestId, active.current.ticket).catch(() => {}); }; }, []);
  const invalidate = () => {
    if (active.current) void api.connections.cancel(active.current.requestId, active.current.ticket).catch(() => {});
    active.current = undefined; setDiscovery(undefined); setError('');
  };
  const updateDraft = (patch: Partial<ConnectionDraft>) => { invalidate(); setDraft((d) => ({ ...d, ...patch })); };
  const test = async () => {
    invalidate(); setBusy('test');
    const requestId = crypto.randomUUID(); active.current = { requestId };
    try {
      const result = await api.connections.test({ requestId, draft, ...(key.trim() ? { key } : {}) });
      if (!alive.current || active.current?.requestId !== requestId) { void api.connections.cancel(requestId, result.ticket); return; }
      active.current = { requestId, ticket: result.ticket }; setDiscovery(result);
      const chosen = result.models.find((m) => m.id === existing?.selection?.model) ?? result.models[0];
      setModel(chosen?.id ?? existing?.selection?.model ?? ''); setManual(result.source === 'manual');
      const preferred = existing?.selection?.effort;
      setEffort(preferred && chosen?.efforts.includes(preferred) ? preferred : 'default');
    } catch (e) { if (alive.current && active.current?.requestId === requestId) setError((e as Error).message); }
    finally { if (alive.current) setBusy(undefined); }
  };
  const save = async () => {
    if (!discovery) return;
    const requestId = crypto.randomUUID(); active.current = { requestId, ticket: discovery.ticket }; setBusy('save'); setError('');
    try {
      const saved = await api.connections.save({ requestId, ticket: discovery.ticket, model: model.trim(), effort, mode, useFor });
      if (alive.current) { active.current = undefined; setKey(''); onSaved(saved); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(undefined); }
  };
  const selectModel = (id: string) => { setModel(id); setEffort('default'); setError(''); };
  return <div className="form connection-editor" data-testid="connection-editor">
    <h3>{existing ? c.edit : c.add}</h3>
    <fieldset className="connection-fields" disabled={!!busy}>
      <label>{c.provider}<select value={draft.presetId} onChange={(e) => { updateDraft({ presetId: e.target.value as ProviderPresetId }); setKey(''); }} data-testid="connection-preset">
        {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.id === 'custom' && settings.uiLang === 'zh' ? '自定义服务商' : p.label}</option>)}
      </select></label>
      <label>{c.name}<input value={draft.label} maxLength={80} placeholder={preset.label} onChange={(e) => updateDraft({ label: e.target.value })} data-testid="connection-name" /></label>
      {draft.presetId === 'custom' && <>
        <label>{c.address}<input value={draft.baseUrl ?? ''} placeholder="https://api.example.com/v1" onChange={(e) => updateDraft({ baseUrl: e.target.value })} data-testid="connection-url" /></label>
        <details><summary>{c.protocol}</summary><select aria-label={c.protocol} value={draft.kind} onChange={(e) => updateDraft({ kind: e.target.value as ConnectionDraft['kind'] })}>
          <option value="openai">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Gemini</option>
        </select></details>
      </>}
      {preset.blocked ? <p className="warn" role="status">{c.goPending}</p> : <label>{c.key}<input type="password" autoComplete="off" value={key} placeholder={hasKey ? c.existingKey : 'API key'} onChange={(e) => { invalidate(); setKey(e.target.value); }} data-testid="connection-key" /></label>}
      {preset.docs && <button className="link connection-docs" type="button" onClick={() => void api.app.openExternal(preset.docs).catch((e) => setError(e.message))}>{c.docs} ↗</button>}
      <button type="button" onClick={test} disabled={preset.blocked || (!key.trim() && !hasKey) || (draft.presetId === 'custom' && !draft.baseUrl?.trim())} data-testid="connection-test">{busy === 'test' ? c.testing : c.test}</button>
    </fieldset>
    {discovery && <fieldset className="connection-fields box" disabled={!!busy}>
      <p className="muted small" role="status">{discovery.source === 'api' ? discovery.models.length ? c.apiSource : c.emptySource : discovery.source === 'documented' ? c.documentedSource : c.manualSource}</p>
      <label>{c.model}{manual ? <input value={model} onChange={(e) => selectModel(e.target.value)} data-testid="connection-model-manual" /> : <select value={model} onChange={(e) => selectModel(e.target.value)} data-testid="connection-model">
        {!discovery.models.length && <option value="">—</option>}
        {discovery.models.map((m) => <option key={m.id} value={m.id}>{m.label === m.id ? m.id : `${m.label} · ${m.id}`}</option>)}
      </select>}</label>
      {discovery.source !== 'api' && <label className="check"><input type="checkbox" checked={manual} onChange={(e) => { setManual(e.target.checked); selectModel(e.target.checked ? '' : discovery.models[0]?.id ?? ''); }} />{c.manual}</label>}
      <label>{c.effort}<select value={effort} onChange={(e) => setEffort(e.target.value as Effort)} data-testid="connection-effort">
        <option value="default">{c.defaultEffort}</option>{info.efforts.map((e) => <option key={e} value={e}>{info.thinking === 'toggle' ? e === 'none' ? c.thinkingOff : c.thinkingOn : e}</option>)}
      </select></label>
      <span className="muted small">{info.effortSource === 'api' ? c.apiEffort : info.effortSource === 'documented' ? c.documentedEffort : c.unknownEffort}</span>
      <label>{c.useFor}<select value={useFor} onChange={(e) => setUseFor(e.target.value as ConnectionSave['useFor'])} data-testid="connection-use">
        <option value="none">{c.useNone}</option><option value="quick">{c.useQuick}</option><option value="direct">{c.useDirect}</option><option value="both">{c.useBoth}</option>
      </select></label>
      <label className="check"><input type="checkbox" checked={mode === 'persist'} disabled={!status?.persistent} onChange={(e) => setMode(e.target.checked ? 'persist' : 'session')} />{status?.persistent ? c.protected : c.session}</label>
      <button className="primary" onClick={save} disabled={!model.trim()} data-testid="connection-save">{busy === 'save' ? c.saving : c.save}</button>
    </fieldset>}
    {error && <p className="error-text" role="alert" data-testid="connection-error">{error}</p>}
    <p className="muted small">{c.testCost}</p>
    <button onClick={onCancel} data-testid="connection-cancel">{c.cancel}</button>
  </div>;
}
