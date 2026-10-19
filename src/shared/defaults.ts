import type { HarnessConfig, ProviderConfig, Settings, UiLang } from './types';
import { inferPreset } from './provider-presets';

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic (Claude)', serverFallback: true },
  { id: 'openai', kind: 'openai', label: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', sendReasoningEffort: false },
  { id: 'ollama', kind: 'openai', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', sendReasoningEffort: false },
  { id: 'demo', kind: 'fake', label: 'Offline demo (no AI)' },
];

/** The built-in agent every skill runs with by default (see runners/pi.ts). */
export const PI_HARNESS: HarnessConfig = { id: 'pi', label: 'Pi (built in)', kind: 'pi', command: '', parser: 'plain', skillDirs: ['.pi/skills'] };

/** Removed in settings v4: replaced by the built-in Pi agent. */
const REMOVED_HARNESSES = ['claude-code'];

export const DEFAULT_HARNESSES: HarnessConfig[] = [
  PI_HARNESS,
  {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex exec --model {model} -c model_reasoning_effort={effort} --full-auto -',
    parser: 'plain',
    skillDirs: ['.agents/skills', '.codex/skills'],
    keyFromProvider: '',
    keyEnv: 'OPENAI_API_KEY',
    unverified: true,
    envAllow: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
    // Codex expects to run inside a git repository; the job folder gets its own.
    gitInit: true,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode run --model {model} {prompt}',
    parser: 'plain',
    skillDirs: ['.opencode/skills', '.claude/skills'],
    keyFromProvider: '',
    unverified: true,
    envAllow: ['OPENCODE_CONFIG'],
  },
];

export const SETTINGS_VERSION = 5;

export function defaultSettings(uiLang: UiLang = 'en'): Settings {
  return {
    settingsVersion: SETTINGS_VERSION,
    uiLang,
    explainLang: 'ui',
    hotkey: 'Alt+Q',
    locateHotkey: 'Alt+L',
    captureHotkey: 'Alt+A',
    quickSkill: 'quick-gloss',
    autoQuick: true,
    outputDir: '',
    dataScope: 'paragraph',
    profile: '',
    theme: 'system',
    pdfDim: false,
    agentConcurrency: 2,
    agentsEnabled: false,
    requireIsolation: false,
    agentTrust: {},
    providers: DEFAULT_PROVIDERS.map((p) => ({ ...p })),
    harnesses: DEFAULT_HARNESSES.map((h) => ({ ...h, skillDirs: [...h.skillDirs] })),
    defaults: {
      quick: { providerId: 'anthropic', model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1024 },
      direct: { providerId: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', maxTokens: 16000 },
      agent: { harnessId: 'pi', providerId: '', model: '', effort: 'default', budgetUsd: 5, timeoutMinutes: 60 },
    },
    skillOverrides: {},
    usageLimits: {},
  };
}

type LegacySettings = Partial<Settings> & { sendFullDocument?: boolean; agentWarningAccepted?: boolean; autoQuickGloss?: boolean; prewarmDocuments?: boolean };

/**
 * Bring stored settings up to the current version.
 * v1 → v2: `sendFullDocument` was on by default, so a stored `true` cannot be told
 * apart from a choice; it becomes the minimal 'paragraph' scope and full-document
 * sending must be granted again. `agentWarningAccepted` (an explicit click on the
 * risk notice) is kept as `agentsEnabled`; every run still needs approval.
 */
export function migrateSettings(saved: LegacySettings): Partial<Settings> {
  if (saved.settingsVersion === SETTINGS_VERSION) return saved;
  let s: LegacySettings = saved;
  if ((s.settingsVersion ?? 1) < 2) {
    const { sendFullDocument: _full, agentWarningAccepted, ...rest } = s;
    s = { ...rest, settingsVersion: 2, dataScope: 'paragraph', prewarmDocuments: false, agentsEnabled: agentWarningAccepted === true, agentTrust: {} };
  }
  // v2 → v3 changed only model connections; their grants are kept.
  if ((s.settingsVersion ?? 1) < 4) s = toV4(s);
  return toV5(s);
}

/**
 * v4 → v5: every skill runs on the built-in Pi agent with the same connection,
 * model and effort as skill answers. Workspace skills no longer default to a
 * separate engine (which could still name a Claude model) or to a CLI.
 */
function toV5(s: LegacySettings): Partial<Settings> {
  return {
    ...s,
    settingsVersion: SETTINGS_VERSION,
    ...(s.defaults ? { defaults: { ...s.defaults, agent: { ...s.defaults.agent, harnessId: 'pi', providerId: '', model: '', effort: 'default' } } } : {}),
  };
}

/**
 * v3 → v4: skills run with the built-in Pi agent. The Claude Code preset is gone;
 * engines that used it move to Pi with the connection's own model. Codex,
 * OpenCode and custom CLIs stay. The automatic quick explanation and document
 * prewarming are gone. Remembered approvals named a harness command, so they are
 * cleared; agentsEnabled (the risk notice) is kept.
 */
function toV4(s: LegacySettings): LegacySettings {
  const { autoQuickGloss: _auto, prewarmDocuments: _prewarm, ...rest } = s;
  const toPi = <T extends { harnessId?: string; model?: string; effort?: Settings['defaults']['agent']['effort'] }>(e: T | undefined): T | undefined =>
    e && e.harnessId && REMOVED_HARNESSES.includes(e.harnessId) ? { ...e, harnessId: 'pi', model: '', effort: 'default' } : e;
  const overrides = Object.fromEntries(Object.entries(rest.skillOverrides ?? {}).map(([k, o]) => [k, o.agent ? { ...o, agent: toPi(o.agent) } : o]));
  return {
    ...rest,
    settingsVersion: SETTINGS_VERSION,
    harnesses: rest.harnesses?.filter((h) => !REMOVED_HARNESSES.includes(h.id)),
    ...(rest.defaults ? { defaults: { ...rest.defaults, agent: toPi(rest.defaults.agent)! } } : {}),
    ...(rest.skillOverrides ? { skillOverrides: overrides } : {}),
    agentTrust: {},
  };
}

/** Fill in fields added in newer versions; keep everything the user set. */
export function mergeSettings(stored: LegacySettings | undefined, uiLang: UiLang = 'en'): Settings {
  const d = defaultSettings(uiLang);
  if (!stored) return d;
  const saved = migrateSettings(stored);
  const byId = <T extends { id: string }>(defs: T[], user: T[] | undefined) => {
    if (!user) return defs;
    const ids = new Set(user.map((u) => u.id));
    // Fields added to a preset later (e.g. envAllow) fill in where the user's copy lacks them.
    const filled = user.map((u) => ({ ...defs.find((x) => x.id === u.id), ...u }));
    return [...filled, ...defs.filter((x) => !ids.has(x.id))];
  };
  return {
    ...d,
    ...saved,
    providers: byId(d.providers, saved.providers).map((p) => p.kind === 'fake' ? p : { ...p, presetId: inferPreset(p) }),
    harnesses: byId(d.harnesses, saved.harnesses),
    defaults: {
      quick: { ...d.defaults.quick, ...saved.defaults?.quick },
      direct: { ...d.defaults.direct, ...saved.defaults?.direct },
      agent: { ...d.defaults.agent, ...saved.defaults?.agent },
    },
    skillOverrides: saved.skillOverrides ?? {},
    agentTrust: saved.agentTrust ?? {},
    usageLimits: saved.usageLimits ?? {},
  };
}

export const SUGGESTED_MODELS: Record<string, string[]> = {
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'],
  openai: [],
  fake: ['fake'],
};

export const EXPLAIN_LANGS = ['ui', 'en', 'de', 'fr', 'zh', 'es', 'it', 'ja', 'ko', 'pt', 'ru', 'ar'];
