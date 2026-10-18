import { useEffect, useState } from 'react';
import type { HarnessProbeInfo, IsolationInfo } from '../../shared/api';
import { DEFAULT_HARNESSES, EXPLAIN_LANGS, SUGGESTED_MODELS } from '../../shared/defaults';
import { paramSupport } from '../../shared/capabilities';
import { hotkeyFromEvent } from '../../shared/hotkey';
import { VERIFICATION, type Verification } from '../../shared/verification';
import { UI_LANG_NAMES, type T } from '../../shared/i18n';
import { KNOWN_SKILLS, skillLabel, type ParsedSkill } from '../../shared/skills';
import {
  UI_LANGS,
  type AgentEngine,
  type DataScope,
  type DirectEngine,
  type Effort,
  type HarnessConfig,
  type ProviderConfig,
  type Settings as SettingsT,
  type SkillInfo,
  type SkillOverride,
  type ThemePref,
  type UiLang,
} from '../../shared/types';
import { api } from '../api';
import { langName } from '../lib/lang';
import { ConnectionSettings } from './ConnectionSettings';
import { Icon } from './Icon';
import { connectionCopy, effortLabel } from '../../shared/connection-copy';
import { modelInfo } from '../../shared/model-catalog';

type Tab = 'general' | 'providers' | 'models' | 'harnesses' | 'skills';

export function Settings(props: {
  settings: SettingsT;
  skills: SkillInfo[];
  t: T;
  onChange: (patch: Partial<SettingsT>) => Promise<void>;
  onSkills: (list: SkillInfo[]) => void;
  onClose: () => void;
  onSaved: (settings: SettingsT) => void;
}) {
  const { t } = props;
  const [tab, setTab] = useState<Tab>('general');
  const describe: Record<Tab, string> = {
    general: t('paneGeneral'),
    providers: t('paneProviders'),
    models: t('paneModels'),
    harnesses: t('paneHarnesses'),
    skills: t('paneSkills'),
  };
  const tabs: [Tab, string][] = [
    ['general', t('tabGeneral')],
    ['providers', connectionCopy(props.settings.uiLang).title],
    ['models', t('tabModels')],
    ['harnesses', t('tabHarnesses')],
    ['skills', t('tabSkills')],
  ];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal settings" role="dialog" aria-label={t('settings')} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <div className="modal-head">
          <h2>{t('settings')}</h2>
          <button className="icon" onClick={props.onClose} title={t('close')} aria-label={t('close')}>
            <Icon name="close" />
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            {tabs.map(([id, label]) => (
              <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            <div className="pane-head">
              <h3>{tabs.find(([id]) => id === tab)![1]}</h3>
              <p>{describe[tab]}</p>
            </div>
            {tab === 'general' && <General {...props} />}
            {tab === 'providers' && <ConnectionSettings settings={props.settings} onSaved={props.onSaved} />}
            {tab === 'models' && <Models {...props} />}
            {tab === 'harnesses' && <Harnesses {...props} />}
            {tab === 'skills' && <Skills {...props} />}
          </div>
        </div>
      </div>
    </div>
  );
}

type PaneProps = Parameters<typeof Settings>[0];

/** Text input that commits on blur or Enter instead of every keystroke. */
function Field(props: { value: string; onCommit: (v: string) => void; placeholder?: string; type?: string; multiline?: boolean; rows?: number }) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  const commit = () => v !== props.value && props.onCommit(v);
  return props.multiline ? (
    <textarea value={v} rows={props.rows ?? 3} placeholder={props.placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />
  ) : (
    <input
      type={props.type ?? 'text'}
      value={v}
      placeholder={props.placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

function General({ settings, t, onChange }: PaneProps) {
  const [recording, setRecording] = useState(false);
  return (
    <div className="form two-col">
      <label>
        {t('uiLanguage')}
        <select value={settings.uiLang} onChange={(e) => onChange({ uiLang: e.target.value as UiLang })}>
          {UI_LANGS.map((l) => (
            <option key={l} value={l}>{UI_LANG_NAMES[l]}</option>
          ))}
        </select>
      </label>
      <label>
        {t('explainLanguage')}
        <select value={settings.explainLang} onChange={(e) => onChange({ explainLang: e.target.value })}>
          {EXPLAIN_LANGS.map((l) => (
            <option key={l} value={l}>{l === 'ui' ? t('sameAsUi') : langName(l, settings.uiLang)}</option>
          ))}
        </select>
      </label>
      <label>
        {t('theme')}
        <select value={settings.theme} onChange={(e) => onChange({ theme: e.target.value as ThemePref })} data-testid="theme-select">
          <option value="system">{t('themeSystem')}</option>
          <option value="light">{t('light')}</option>
          <option value="dark">{t('dark')}</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.pdfDim} onChange={(e) => onChange({ pdfDim: e.target.checked })} />
        {t('pdfDim')}
      </label>
      <label>
        {t('hotkey')}
        <div className="row">
          <kbd className="big">{recording ? t('pressKeys') : settings.hotkey}</kbd>
          <button
            onClick={() => setRecording(true)}
            onKeyDown={(e) => {
              if (!recording) return;
              e.preventDefault();
              if (e.key === 'Escape') return setRecording(false);
              const hk = hotkeyFromEvent(e.nativeEvent);
              if (hk) {
                setRecording(false);
                void onChange({ hotkey: hk });
              }
            }}
            onBlur={() => setRecording(false)}
          >
            {t('change')}
          </button>
        </div>
      </label>
      <label>
        {t('dataScope')}
        <select value={settings.dataScope} onChange={(e) => onChange({ dataScope: e.target.value as DataScope })} data-testid="data-scope">
          <option value="sentence">{t('scopeSentence')}</option>
          <option value="paragraph">{t('scopeParagraph')}</option>
          <option value="document">{t('scopeDocument')}</option>
        </select>
      </label>
      <label>
        {t('profile')}
        <Field multiline value={settings.profile} placeholder={t('profileHint')} onCommit={(v) => onChange({ profile: v })} />
      </label>
      <label>
        {t('concurrency')}
        <input
          type="number"
          min={1}
          max={8}
          value={settings.agentConcurrency}
          onChange={(e) => onChange({ agentConcurrency: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
        />
      </label>
    </div>
  );
}

function ModelInput(props: { value: string; kind?: string; onCommit: (v: string) => void; id: string; placeholder?: string }) {
  const list = SUGGESTED_MODELS[props.kind ?? ''] ?? [];
  return (
    <>
      <input
        list={`models-${props.id}`}
        defaultValue={props.value}
        key={props.value}
        placeholder={props.placeholder}
        onBlur={(e) => e.target.value !== props.value && props.onCommit(e.target.value.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <datalist id={`models-${props.id}`}>
        {list.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
}

function DirectRow(props: { label: string; engine: DirectEngine; settings: SettingsT; t: T; onChange: (e: DirectEngine) => void; id: string }) {
  const { engine, settings, t } = props;
  const provider = settings.providers.find((p) => p.id === engine.providerId);
  const kind = provider?.kind;
  const support = provider ? paramSupport(provider, engine.model) : undefined;
  return (
    <tr>
      <th>{props.label}</th>
      <td>
        <select value={engine.providerId} onChange={(e) => { const p = settings.providers.find((p) => p.id === e.target.value); props.onChange({ ...engine, providerId: e.target.value, ...(p?.selection ?? {}) }); }}>
          {settings.providers.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </td>
      <td>
        {provider?.selection ? <span className="small">{provider.selection.model}</span> : <ModelInput id={props.id} value={engine.model} kind={kind} onCommit={(model) => props.onChange({ ...engine, model })} />}
      </td>
      <td>
        {provider?.selection ? <span className="small">{effortLabel(settings.uiLang, provider.selection.effort, modelInfo(provider, provider.selection.model).thinking)}</span> : <EffortSelect value={engine.effort} onChange={(effort) => props.onChange({ ...engine, effort })} />}
        <NotSent t={t} field={support?.effort ?? null} />
      </td>
      <td>
        <input
          type="number"
          min={256}
          step={256}
          value={engine.maxTokens}
          title={`${t('maxTokens')} — ${t('maxTokensNote')}`}
          onChange={(e) => props.onChange({ ...engine, maxTokens: Math.max(256, Number(e.target.value) || 1024) })}
        />
        <NotSent t={t} field={support?.maxTokens ?? null} />
      </td>
    </tr>
  );
}

function EffortSelect(props: { value: Effort | ''; onChange: (e: Effort) => void; allowInherit?: string; provider?: ProviderConfig; model?: string }) {
  const options: Effort[] = props.provider?.selection ? ['default', ...modelInfo(props.provider, props.model ?? props.provider.selection.model).efforts] : ['low', 'medium', 'high', 'xhigh', 'max'];
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value as Effort)}>
      {props.allowInherit !== undefined && <option value="">{props.allowInherit}</option>}
      {options.map((x) => (
        <option key={x} value={x}>{x}</option>
      ))}
    </select>
  );
}

function AgentRow(props: { label: string; engine: AgentEngine; settings: SettingsT; t: T; onChange: (e: AgentEngine) => void }) {
  const { engine, settings, t } = props;
  const pi = settings.harnesses.find((h) => h.id === engine.harnessId)?.kind === 'pi';
  // The built-in Pi agent uses a model connection; empty = the one for short answers.
  const provider = settings.providers.find((p) => p.id === (engine.providerId || settings.defaults.direct.providerId));
  const model = engine.model || provider?.selection?.model || settings.defaults.direct.model;
  return (
    <tr>
      <th>{props.label}</th>
      <td>
        <select value={engine.harnessId} onChange={(e) => props.onChange({ ...engine, harnessId: e.target.value })}>
          {settings.harnesses.map((h) => (
            <option key={h.id} value={h.id}>{h.label}</option>
          ))}
        </select>
        {pi && (
          <select value={engine.providerId ?? ''} onChange={(e) => props.onChange({ ...engine, providerId: e.target.value, model: '', effort: 'default' })} data-testid="pi-connection">
            <option value="">{t('sameAsAnswers')}</option>
            {settings.providers
              .filter((p) => p.kind === 'fake' || p.selection)
              .map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
          </select>
        )}
      </td>
      <td>
        <ModelInput id="agent" value={engine.model} kind={pi ? (provider?.kind ?? 'anthropic') : 'anthropic'} placeholder={pi ? t('connectionModelDefault') : undefined} onCommit={(m) => props.onChange({ ...engine, model: m })} />
      </td>
      <td>
        <EffortSelect value={engine.effort} provider={pi ? provider : undefined} model={model} onChange={(effort) => props.onChange({ ...engine, effort })} />
      </td>
      <td>
        <div className="row">
          <input
            type="number"
            min={0}
            step={0.5}
            value={engine.budgetUsd}
            title={t('budget')}
            onChange={(e) => props.onChange({ ...engine, budgetUsd: Math.max(0, Number(e.target.value) || 0) })}
          />
          <input
            type="number"
            min={1}
            value={engine.timeoutMinutes}
            title={t('timeout')}
            onChange={(e) => props.onChange({ ...engine, timeoutMinutes: Math.max(1, Number(e.target.value) || 60) })}
          />
        </div>
      </td>
    </tr>
  );
}

function Models({ settings, t, onChange }: PaneProps) {
  const d = settings.defaults;
  return (
    <div className="form">
      <table className="engine-table">
        <thead>
          <tr>
            <th>{t('usedFor')}</th>
            <th>{t('provider')} / {t('harness')}</th>
            <th>{t('model')}</th>
            <th>{t('effort')}</th>
            <th>{t('maxTokens')} / {t('budget')}, {t('timeout')}</th>
          </tr>
        </thead>
        <tbody>
          <DirectRow id="quick" label={t('quickRow')} engine={d.quick} settings={settings} t={t} onChange={(quick) => onChange({ defaults: { ...d, quick } })} />
          <DirectRow id="direct" label={t('directRow')} engine={d.direct} settings={settings} t={t} onChange={(direct) => onChange({ defaults: { ...d, direct } })} />
          <AgentRow label={t('agentRow')} engine={d.agent} settings={settings} t={t} onChange={(agent) => onChange({ defaults: { ...d, agent } })} />
        </tbody>
      </table>
      <p className="muted small">{connectionCopy(settings.uiLang).defaultsHint}</p>
      <p className="muted small">{t('maxTokensNote')}</p>
      <p className="muted small">{settings.harnesses.find((h) => h.id === d.agent.harnessId)?.kind === 'pi' ? t('piBudgetNote') : budgetNote(t, settings.harnesses.find((h) => h.id === d.agent.harnessId)?.command ?? '')}</p>
    </div>
  );
}

function Harnesses({ settings, t, onChange }: PaneProps) {
  const update = (id: string, patch: Partial<HarnessConfig>) =>
    onChange({ harnesses: settings.harnesses.map((h) => (h.id === id ? { ...h, ...patch } : h)) });
  const [iso, setIso] = useState<IsolationInfo | null>(null);
  const [probes, setProbes] = useState<Record<string, HarnessProbeInfo | 'busy' | string>>({});
  useEffect(() => {
    void api.agent.isolation().then(setIso);
  }, []);
  const probe = async (id: string) => {
    setProbes((p) => ({ ...p, [id]: 'busy' }));
    try {
      const r = await api.agent.probe(id);
      setProbes((p) => ({ ...p, [id]: r }));
    } catch (err) {
      setProbes((p) => ({ ...p, [id]: String((err as Error).message) }));
    }
  };
  return (
    <div className="form">
      <div className="box">
        <label className="check">
          <input type="checkbox" checked={settings.agentsEnabled} onChange={(e) => onChange({ agentsEnabled: e.target.checked })} data-testid="agents-enabled" />
          {t('agentsEnabled')}
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.requireIsolation} onChange={(e) => onChange({ requireIsolation: e.target.checked })} />
          {t('requireIsolation')}
        </label>
        <p className={`small ${iso?.isolated ? 'ok' : 'warn'}`}>
          {t('isolation')}: {iso?.detail ?? '…'}
        </p>
        {Object.keys(settings.agentTrust).length > 0 && (
          <div className="row">
            <span className="muted small">{Object.keys(settings.agentTrust).join(', ')}</span>
            <button onClick={() => void api.agent.forgetTrust().then(() => onChange({}))}>{t('forgetApprovals')}</button>
          </div>
        )}
      </div>
      <p className="muted small">{t('commandHint')}</p>
      {settings.harnesses.map((h) => {
        const preset = DEFAULT_HARNESSES.find((x) => x.id === h.id);
        if (h.kind === 'pi')
          return (
            <fieldset key={h.id} className="box" data-testid="pi-harness">
              <legend>{h.label}</legend>
              <p className="small">{t('piHarnessNote')}</p>
              <p className="muted small">{t('piBudgetNote')}</p>
              <p className="muted small">
                {t('verification')}: {verificationText(t, VERIFICATION[h.id] ?? 'unverified')}
              </p>
            </fieldset>
          );
        return (
          <fieldset key={h.id} className="box">
            <legend>
              {h.label} {h.unverified && <span className="badge warn-badge" title={t('unverified')}>?</span>}
            </legend>
            {h.unverified && <p className="warn small">{t('unverified')}</p>}
            <label>
              {t('providerName')}
              <Field value={h.label} onCommit={(v) => update(h.id, { label: v })} />
            </label>
            <label>
              {t('command')}
              <Field multiline rows={4} value={h.command} onCommit={(v) => update(h.id, { command: v.replace(/\s*\n\s*/g, ' ').trim() })} />
            </label>
            <div className="grid2">
              <label>
                {t('parser')}
                <select value={h.parser} onChange={(e) => update(h.id, { parser: e.target.value as HarnessConfig['parser'] })}>
                  <option value="claude-stream-json">Claude Code stream-json</option>
                  <option value="plain">Plain text</option>
                </select>
              </label>
              <label>
                {t('skillDirs')}
                <Field
                  value={h.skillDirs.join(', ')}
                  onCommit={(v) => update(h.id, { skillDirs: v.split(',').map((s) => s.trim()).filter((s) => s && !s.includes('..')) })}
                />
              </label>
              <label>
                {t('keySource')}
                <select value={h.keyFromProvider ?? ''} onChange={(e) => update(h.id, { keyFromProvider: e.target.value })}>
                  <option value="">{t('harnessLogin')}</option>
                  {settings.providers
                    .filter((p) => p.kind !== 'fake')
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                </select>
              </label>
              <label>
                {t('keyEnv')}
                <Field value={h.keyEnv ?? ''} placeholder="ANTHROPIC_API_KEY" onCommit={(v) => update(h.id, { keyEnv: v.trim() })} />
              </label>
            </div>
            <label>
              {t('envAllow')}
              <Field
                value={(h.envAllow ?? []).join(', ')}
                onCommit={(v) => update(h.id, { envAllow: v.split(/[,\s]+/).map((x) => x.trim()).filter((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x)) })}
              />
            </label>
            <p className="muted small">{budgetNote(t, h.command)}</p>
            <p className="muted small">
              {t('verification')}: {verificationText(t, VERIFICATION[h.id] ?? 'unverified')}
            </p>
            <div className="row">
              <button disabled={probes[h.id] === 'busy'} onClick={() => void probe(h.id)}>{t('checkHarness')}</button>
              <span className="small">{probeText(t, probes[h.id])}</span>
            </div>
            <div className="row">
              {preset && (
                <button onClick={() => update(h.id, { ...preset, skillDirs: [...preset.skillDirs], envAllow: preset.envAllow ? [...preset.envAllow] : undefined })}>{t('reset')}</button>
              )}
              {!preset && (
                <button className="danger" onClick={() => onChange({ harnesses: settings.harnesses.filter((x) => x.id !== h.id) })}>
                  {t('delete')}
                </button>
              )}
            </div>
          </fieldset>
        );
      })}
      <button
        onClick={() =>
          onChange({
            harnesses: [
              ...settings.harnesses,
              { id: `custom-${Date.now().toString(36)}`, label: 'Custom', command: '', parser: 'plain', skillDirs: ['.agents/skills'] },
            ],
          })
        }
      >
        + {t('addHarness')}
      </button>
    </div>
  );
}

function Skills({ settings, skills, t, onChange, onSkills }: PaneProps) {
  const [editing, setEditing] = useState<{ parsed: ParsedSkill; previous?: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const lang = settings.uiLang;

  const override = (name: string, patch: SkillOverride) =>
    onChange({ skillOverrides: { ...settings.skillOverrides, [name]: { ...settings.skillOverrides[name], ...patch } } });

  const move = (i: number, dir: -1 | 1) => {
    const order = skills.map((s) => s.name);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    const next = { ...settings.skillOverrides };
    order.forEach((n, k) => (next[n] = { ...next[n], order: k }));
    void onChange({ skillOverrides: next }).then(async () => onSkills(await api.skills.list()));
  };

  const run = async (label: string, fn: () => Promise<SkillInfo[] | null>) => {
    setBusy(label);
    setError('');
    try {
      const list = await fn();
      if (list) onSkills(list);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy('');
    }
  };

  if (editing) {
    return (
      <SkillEditor
        t={t}
        initial={editing.parsed}
        onCancel={() => setEditing(null)}
        onSave={(p) =>
          run('save', async () => {
            const list = await api.skills.save(p, editing.previous);
            setEditing(null);
            return list;
          })
        }
        error={error}
      />
    );
  }

  return (
    <div className="form">
      <p className="muted small">{t('skillsIntro')}</p>
      <div className="row">
        <button
          onClick={() =>
            setEditing({ parsed: { name: '', description: '', body: '', glossa: { runner: 'direct', output: 'markdown', label: {} } } })
          }
        >
          + {t('newSkill')}
        </button>
        <button disabled={!!busy} onClick={() => run('import', () => api.skills.importFolder())}>{t('importFolder')}</button>
      </div>
      {KNOWN_SKILLS.map((k) => {
        const have = skills.some((s) => s.name === k.name);
        return (
          <div key={k.name} className="box known">
            <div className="row">
              <strong>{skillLabel(k, lang)}</strong>
              <span className="muted small">{k.homepage}</span>
              {have ? (
                <span className="ok row">
                  <Icon name="check" size={14} />
                  {t('installed')}
                </span>
              ) : (
                <button disabled={!!busy} onClick={() => run(k.name, () => api.skills.installKnown(k.name))}>
                  {busy === k.name ? t('installing') : t('install')}
                </button>
              )}
            </div>
            <p className="small muted">{(k.note as Record<string, string>)[lang] ?? k.note.en}</p>
          </div>
        );
      })}
      {error && <p className="error-text">{error}</p>}
      <table className="skills-table">
        <tbody>
          {skills.map((s, i) => {
            const o = settings.skillOverrides[s.name] ?? {};
            return (
              <SkillRow
                key={s.name}
                s={s}
                o={o}
                i={i}
                count={skills.length}
                t={t}
                lang={lang}
                settings={settings}
                open={open === s.name}
                onToggleOpen={() => setOpen(open === s.name ? null : s.name)}
                onOverride={(patch) => override(s.name, patch).then(async () => onSkills(await api.skills.list()))}
                onMove={(d) => move(i, d)}
                onEdit={async () => {
                  const r = await api.skills.read(s.name);
                  setEditing({ parsed: r.parsed, previous: r.source === 'user' ? s.name : undefined });
                }}
                onDelete={() => {
                  if (window.confirm(t('confirmDelete'))) void run('delete', () => api.skills.remove(s.name));
                }}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SkillRow(props: {
  s: SkillInfo;
  o: SkillOverride;
  i: number;
  count: number;
  t: T;
  lang: string;
  settings: SettingsT;
  open: boolean;
  onToggleOpen: () => void;
  onOverride: (p: SkillOverride) => void;
  onMove: (d: -1 | 1) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { s, o, t, settings } = props;
  return (
    <>
      <tr>
        <td>
          <input type="checkbox" checked={s.enabled} title={t('enabled')} onChange={(e) => props.onOverride({ enabled: e.target.checked })} />
        </td>
        <td>
          <strong>{skillLabel(s, props.lang)}</strong> <span className="muted small">{s.name}</span>{' '}
          <span className="badge">{s.source === 'builtin' ? t('builtin') : t('userSkill')}</span>
          <div className="muted small clamp2">{s.description}</div>
        </td>
        <td>
          <select value={s.runner} title={t('runner')} onChange={(e) => props.onOverride({ runner: e.target.value as SkillInfo['runner'] })}>
            <option value="direct">{t('direct')}</option>
            <option value="agent">{t('agent')}</option>
          </select>
          <select value={s.output} title={t('output')} onChange={(e) => props.onOverride({ output: e.target.value as SkillInfo['output'] })}>
            <option value="markdown">Markdown</option>
            <option value="html" disabled={s.runner === 'direct'} title={s.runner === 'direct' ? t('htmlNeedsAgent') : undefined}>
              HTML
            </option>
          </select>
          {s.runner === 'direct' && s.output === 'html' && <div className="error-text small">{t('htmlNeedsAgent')}</div>}
        </td>
        <td className="nowrap">
          <button className="icon" disabled={props.i === 0} title={t('moveUp')} aria-label={t('moveUp')} onClick={() => props.onMove(-1)}>
            <Icon name="up" />
          </button>
          <button className="icon" disabled={props.i === props.count - 1} title={t('moveDown')} aria-label={t('moveDown')} onClick={() => props.onMove(1)}>
            <Icon name="down" />
          </button>
          <button className="icon" title={t('overrides')} aria-label={t('overrides')} onClick={props.onToggleOpen}>
            <Icon name="settings" />
          </button>
          <button className="icon" title={t('edit')} aria-label={t('edit')} onClick={props.onEdit}>
            <Icon name="edit" size={15} />
          </button>
          {s.source === 'user' && (
            <button className="icon danger" title={t('delete')} aria-label={t('delete')} onClick={props.onDelete}>
              <Icon name="close" />
            </button>
          )}
        </td>
      </tr>
      {props.open && (
        <tr className="override-row">
          <td />
          <td colSpan={3}>
            <div className="row wrap">
              <span className="muted">{t('overrides')}:</span>
              {s.runner === 'direct' ? (
                <>
                  <select
                    value={o.direct?.providerId ?? ''}
                    onChange={(e) => props.onOverride({ direct: { ...o.direct, providerId: e.target.value || undefined, model: undefined, effort: undefined } })}
                  >
                    <option value="">{t('provider')}: {t('inherit')}</option>
                    {settings.providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  <ModelInput
                    id={`skill-${s.name}`}
                    value={o.direct?.model ?? ''}
                    placeholder={`${t('model')}: ${t('inherit')}`}
                    kind={settings.providers.find((p) => p.id === (o.direct?.providerId ?? settings.defaults.direct.providerId))?.kind}
                    onCommit={(model) => props.onOverride({ direct: { ...o.direct, model: model || undefined, effort: model && settings.providers.find((p) => p.id === (o.direct?.providerId ?? settings.defaults.direct.providerId))?.selection ? 'default' : undefined } })}
                  />
                  <EffortSelect
                    provider={settings.providers.find((p) => p.id === (o.direct?.providerId ?? settings.defaults.direct.providerId))}
                    model={o.direct?.model}
                    value={o.direct?.effort ?? ''}
                    allowInherit={`${t('effort')}: ${t('inherit')}`}
                    onChange={(effort) => props.onOverride({ direct: { ...o.direct, effort: effort || undefined } })}
                  />
                </>
              ) : (
                <>
                  <select
                    value={o.agent?.harnessId ?? ''}
                    onChange={(e) => props.onOverride({ agent: { ...o.agent, harnessId: e.target.value || undefined } })}
                  >
                    <option value="">{t('harness')}: {t('inherit')}</option>
                    {settings.harnesses.map((h) => (
                      <option key={h.id} value={h.id}>{h.label}</option>
                    ))}
                  </select>
                  <ModelInput
                    id={`skill-${s.name}`}
                    value={o.agent?.model ?? ''}
                    placeholder={`${t('model')}: ${t('inherit')}`}
                    kind="anthropic"
                    onCommit={(model) => props.onOverride({ agent: { ...o.agent, model: model || undefined } })}
                  />
                  <EffortSelect
                    value={o.agent?.effort ?? ''}
                    allowInherit={`${t('effort')}: ${t('inherit')}`}
                    onChange={(effort) => props.onOverride({ agent: { ...o.agent, effort: effort || undefined } })}
                  />
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function SkillEditor(props: { t: T; initial: ParsedSkill; onSave: (p: ParsedSkill) => void; onCancel: () => void; error: string }) {
  const { t } = props;
  const [p, setP] = useState<ParsedSkill>(props.initial);
  const g = p.glossa;
  const setG = (patch: Partial<ParsedSkill['glossa']>) => setP({ ...p, glossa: { ...g, ...patch } });
  return (
    <div className="form">
      <div className="grid2">
        <label>
          {t('skillName')}
          <input value={p.name} pattern="[a-z0-9][a-z0-9-]*" onChange={(e) => setP({ ...p, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
        </label>
        <label>
          {t('runner')} / {t('output')}
          <div className="row">
            <select value={g.runner ?? 'direct'} onChange={(e) => setG({ runner: e.target.value as 'direct' | 'agent' })}>
              <option value="direct">{t('direct')}</option>
              <option value="agent">{t('agent')}</option>
            </select>
            <select value={g.output ?? 'markdown'} onChange={(e) => setG({ output: e.target.value as 'markdown' | 'html' })}>
              <option value="markdown">Markdown</option>
              <option value="html" disabled={(g.runner ?? 'direct') === 'direct'}>HTML</option>
            </select>
          </div>
        </label>
      </div>
      <label>
        {t('description')}
        <textarea rows={2} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
      </label>
      <label>{t('labels')}</label>
      <div className="grid4">
        {UI_LANGS.map((l) => (
          <input
            key={l}
            placeholder={UI_LANG_NAMES[l]}
            value={(g.label as Record<string, string> | undefined)?.[l] ?? ''}
            onChange={(e) => setG({ label: { ...g.label, [l]: e.target.value } })}
          />
        ))}
      </div>
      {g.runner === 'agent' && (
        <label>
          {t('taskTemplate')}
          <textarea rows={5} value={g.task ?? ''} placeholder={t('taskHint')} onChange={(e) => setG({ task: e.target.value || undefined })} />
        </label>
      )}
      <label>
        {t('instructions')}
        <textarea className="mono" rows={14} value={p.body} onChange={(e) => setP({ ...p, body: e.target.value })} />
      </label>
      {props.error && <p className="error-text">{props.error}</p>}
      <div className="row">
        <button className="primary" disabled={!p.name || !p.description.trim()} onClick={() => props.onSave(cleanLabels(p))}>
          {t('save')}
        </button>
        <button onClick={props.onCancel}>{t('cancel')}</button>
      </div>
    </div>
  );
}

function cleanLabels(p: ParsedSkill): ParsedSkill {
  const label = Object.fromEntries(Object.entries(p.glossa.label ?? {}).filter(([, v]) => v && v.trim()));
  return { ...p, description: p.description.trim(), glossa: { ...p.glossa, label: Object.keys(label).length ? label : undefined } };
}

function verificationText(t: T, v: Verification): string {
  return v === 'test-double' ? t('verTestDouble') : v === 'flags-checked' ? t('verFlags') : v === 'n/a' ? '—' : t('verUnverified');
}

function NotSent({ t, field }: { t: T; field: string | null }) {
  return field ? null : <div className="muted small">{t('notSent')}</div>;
}

function budgetNote(t: T, command: string): string {
  const flag = /(--[\w-]+)[= ]+\{budget\}/.exec(command)?.[1];
  return flag ? t('budgetEnforced', { flag }) : t('budgetNotEnforced', { budget: '{budget}' });
}

function probeText(t: T, p: HarnessProbeInfo | 'busy' | string | undefined): string {
  if (!p) return '';
  if (p === 'busy') return '…';
  if (typeof p === 'string') return p;
  if (p.status === 'missing' || p.status === 'error') return t('probeMissing', { detail: p.detail ?? p.binary });
  if (p.status === 'ok') return t('probeOk', { version: p.version ?? '?' });
  return t('probeFlags', { version: p.version ?? '?', flags: p.missingFlags.join(' ') });
}
