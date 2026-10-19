// Runtime checks for everything that arrives over IPC. TypeScript types say
// nothing about what a renderer actually sends.

import path from 'node:path';
import { parseHotkey } from '../shared/hotkey';
import { SKILL_NAME_RE, type ParsedSkill } from '../shared/skills';
import { splitArgs } from '../shared/template';
import {
  CARD_WINDOWS,
  DATA_SCOPES,
  EFFORTS,
  THEME_PREFS,
  UI_LANGS,
  type AgentEngine,
  type DirectEngine,
  type HarnessConfig,
  type JobRequest,
  type ProviderConfig,
  type ModelInfo,
  type Settings,
  type SkillOverride,
  type Rect,
  type TermCard,
  type TermContext,
  type TermLocator,
  type CardCapture,
  type Region,
  type ViewTheme,
} from '../shared/types';

export class InvalidArgument extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgument';
  }
}

const fail = (what: string): never => {
  throw new InvalidArgument(`Invalid ${what}`);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string, allowed: string[]): Record<string, unknown> {
  if (!isObj(v)) fail(what);
  const extra = Object.keys(v as object).filter((k) => !allowed.includes(k));
  if (extra.length) fail(`${what} (unexpected field ${extra[0]})`);
  return v as Record<string, unknown>;
}
export function str(v: unknown, what: string, max: number, re?: RegExp): string {
  if (typeof v !== 'string' || v.length > max || (re && !re.test(v))) fail(what);
  return v as string;
}
function optStr(v: unknown, what: string, max: number, re?: RegExp): string | undefined {
  return v === undefined ? undefined : str(v, what, max, re);
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail(what);
  return v as boolean;
}
function optBool(v: unknown, what: string): boolean | undefined {
  return v === undefined ? undefined : bool(v, what);
}
function num(v: unknown, what: string, min: number, max: number, int = true): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) fail(what);
  return v as number;
}
function oneOf<T extends string>(v: unknown, what: string, values: readonly T[]): T {
  if (!values.includes(v as T)) fail(what);
  return v as T;
}

export const JOB_ID = /^[a-z0-9-]{8,64}$/;
export const CAPTURE_ID = /^[a-f0-9]{64}$/;
export const DOC_ID = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MODEL = /^[\w.:/@+-]{1,200}$/;
const LANG = /^(ui|[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*)$/;

export const vJobId = (v: unknown) => str(v, 'job id', 64, JOB_ID);
export const vDocId = (v: unknown) => str(v, 'document id', 64, DOC_ID);
export const vCaptureId = (v: unknown) => str(v, 'picture id', 64, CAPTURE_ID);
export const vSkillName = (v: unknown) => str(v, 'skill name', 64, SKILL_NAME_RE);
export const vProviderId = (v: unknown) => str(v, 'provider id', 40, ID);
export const vModel = (v: unknown) => str(v, 'model', 200, MODEL);

export function vUrl(v: unknown): string {
  return str(v, 'address', 4000);
}

export function vViewTheme(v: unknown): ViewTheme {
  return oneOf(v, 'theme', ['light', 'dark', 'paper'] as const);
}

export function vAbsPath(v: unknown): string {
  const p = str(v, 'path', 4096);
  if (!path.isAbsolute(p) || p.includes('\0')) fail('path');
  return p;
}

function vContext(v: unknown): TermContext {
  const o = obj(v, 'context', ['term', 'sentence', 'paragraph', 'heading', 'docTitle', 'docSource', 'docLang', 'termLang']);
  const term = str(o.term, 'term', 300).trim();
  if (!term) fail('term');
  return {
    term,
    sentence: str(o.sentence, 'sentence', 5000),
    paragraph: str(o.paragraph, 'paragraph', 10000),
    heading: optStr(o.heading, 'heading', 1000),
    docTitle: str(o.docTitle, 'document title', 1000),
    docSource: str(o.docSource, 'document source', 4096),
    docLang: optStr(o.docLang, 'document language', 40),
    termLang: optStr(o.termLang, 'term language', 40),
  };
}

function vDirectPartial(v: unknown, what: string): Partial<DirectEngine> | undefined {
  if (v === undefined) return undefined;
  const o = obj(v, what, ['providerId', 'model', 'effort', 'maxTokens']);
  return {
    providerId: o.providerId === undefined || o.providerId === '' ? undefined : vProviderId(o.providerId),
    model: o.model === undefined || o.model === '' ? undefined : vModel(o.model),
    effort: o.effort === undefined || o.effort === '' ? undefined : oneOf(o.effort, 'effort', EFFORTS),
    maxTokens: o.maxTokens === undefined ? undefined : num(o.maxTokens, 'max tokens', 1, 200_000),
  };
}

function vAgentPartial(v: unknown, what: string): Partial<AgentEngine> | undefined {
  if (v === undefined) return undefined;
  const o = obj(v, what, ['harnessId', 'providerId', 'model', 'effort', 'budgetUsd', 'timeoutMinutes']);
  return {
    harnessId: o.harnessId === undefined || o.harnessId === '' ? undefined : str(o.harnessId, 'harness id', 40, ID),
    providerId: o.providerId === undefined || o.providerId === '' ? (o.providerId as '' | undefined) : vProviderId(o.providerId),
    model: o.model === undefined || o.model === '' ? undefined : vModel(o.model),
    effort: o.effort === undefined || o.effort === '' ? undefined : oneOf(o.effort, 'effort', EFFORTS),
    budgetUsd: o.budgetUsd === undefined ? undefined : num(o.budgetUsd, 'budget', 0, 1000, false),
    timeoutMinutes: o.timeoutMinutes === undefined ? undefined : num(o.timeoutMinutes, 'timeout', 1, 600, false),
  };
}

export function vJobRequest(v: unknown): JobRequest {
  const o = obj(v, 'request', ['docId', 'skill', 'context', 'explainLang', 'direct', 'agent', 'image', 'force', 'origin']);
  return {
    docId: vDocId(o.docId),
    skill: vSkillName(o.skill),
    context: vContext(o.context),
    explainLang: str(o.explainLang, 'answer language', 40, LANG),
    direct: vDirectPartial(o.direct, 'direct engine'),
    agent: vAgentPartial(o.agent, 'agent engine'),
    image: o.image === undefined ? undefined : vCaptureId(o.image),
    force: optBool(o.force, 'force'),
    origin: o.origin === undefined ? 'auto' : oneOf(o.origin, 'origin', ['user', 'auto'] as const),
  };
}

const CARD_ID = /^[a-z0-9]{1,64}$/;

function vRect(v: unknown, what: string): Rect {
  const r = obj(v, what, ['x', 'y', 'w', 'h']);
  return {
    x: num(r.x, 'x', -1e5, 1e5, false),
    y: num(r.y, 'y', -1e5, 1e5, false),
    w: num(r.w, 'w', 0, 1e5, false),
    h: num(r.h, 'h', 0, 1e5, false),
  };
}

function vLocator(v: unknown): TermLocator | undefined {
  if (v === undefined) return undefined;
  const o = obj(v, 'term location', ['quote', 'prefix', 'suffix', 'index', 'page', 'region']);
  return {
    quote: str(o.quote, 'located term', 600),
    prefix: str(o.prefix, 'text before the term', 200),
    suffix: str(o.suffix, 'text after the term', 200),
    index: o.index === undefined ? undefined : num(o.index, 'term position', 0, 1e9),
    page: o.page === undefined ? undefined : num(o.page, 'page', 1, 1e6),
    region: o.region === undefined ? undefined : vRegion(o.region),
  };
}

function vRegion(v: unknown): Region {
  const r = obj(v, 'area', ['x', 'y', 'w', 'h', 'px']);
  const px = r.px === undefined ? undefined : bool(r.px, 'area unit');
  const max = px ? 1e7 : 2;
  return { x: num(r.x, 'area x', -max, max, false), y: num(r.y, 'area y', -max, max, false), w: num(r.w, 'area width', 0, max, false), h: num(r.h, 'area height', 0, max, false), ...(px ? { px } : {}) };
}

function vCapture(v: unknown): CardCapture | undefined {
  if (v === undefined) return undefined;
  const o = obj(v, 'picture', ['id', 'w', 'h', 'send']);
  return { id: vCaptureId(o.id), w: num(o.w, 'picture width', 1, 10_000), h: num(o.h, 'picture height', 1, 10_000), send: bool(o.send, 'send picture') };
}

/** A rectangle of the window to capture, in CSS pixels. */
export function vCaptureRect(v: unknown): { x: number; y: number; width: number; height: number } {
  const o = obj(v, 'area', ['x', 'y', 'width', 'height']);
  return { x: num(o.x, 'x', 0, 1e5, false), y: num(o.y, 'y', 0, 1e5, false), width: num(o.width, 'width', 4, 1e5, false), height: num(o.height, 'height', 4, 1e5, false) };
}

export function vTermCards(v: unknown): TermCard[] {
  if (!Array.isArray(v) || v.length > 200) fail('cards');
  return (v as unknown[]).map((c) => {
    const o = obj(c, 'card', ['id', 'term', 'context', 'explainLang', 'rect', 'window', 'tasks', 'activeTask', 'createdAt', 'locator', 'capture']);
    if (!Array.isArray(o.tasks) || o.tasks.length > 50) fail('card tasks');
    return {
      id: str(o.id, 'card id', 64, CARD_ID),
      term: str(o.term, 'card term', 300),
      context: vContext(o.context),
      explainLang: str(o.explainLang, 'answer language', 40, LANG),
      rect: vRect(o.rect, 'card rect'),
      window: oneOf(o.window, 'card window', CARD_WINDOWS),
      tasks: (o.tasks as unknown[]).map((t) => {
        const x = obj(t, 'card task', ['id', 'jobId', 'skill', 'createdAt', 'request']);
        return {
          id: str(x.id, 'task id', 64, CARD_ID),
          jobId: vJobId(x.jobId),
          skill: vSkillName(x.skill),
          createdAt: num(x.createdAt, 'createdAt', 0, 1e14),
          request: vJobRequest(x.request),
        };
      }),
      activeTask: optStr(o.activeTask, 'active task', 64, CARD_ID),
      createdAt: num(o.createdAt, 'createdAt', 0, 1e14),
      locator: vLocator(o.locator),
      capture: vCapture(o.capture),
    };
  });
}

export function vParsedSkill(v: unknown): ParsedSkill {
  const o = obj(v, 'skill', ['name', 'description', 'body', 'glossa']);
  const g = obj(o.glossa ?? {}, 'skill metadata', ['runner', 'output', 'label', 'task', 'timeoutMinutes']);
  let label: ParsedSkill['glossa']['label'];
  if (g.label !== undefined) {
    const l = obj(g.label, 'labels', [...UI_LANGS]);
    label = Object.fromEntries(Object.entries(l).map(([k, x]) => [k, str(x, 'label', 60)]));
  }
  return {
    name: vSkillName(o.name),
    description: str(o.description, 'description', 2000).trim() || fail('description'),
    body: str(o.body, 'instructions', 200_000),
    glossa: {
      runner: g.runner === undefined ? undefined : oneOf(g.runner, 'runner', ['direct', 'agent'] as const),
      output: g.output === undefined ? undefined : oneOf(g.output, 'output', ['markdown', 'html'] as const),
      label,
      task: optStr(g.task, 'task', 20_000),
      timeoutMinutes: g.timeoutMinutes === undefined ? undefined : num(g.timeoutMinutes, 'timeout', 1, 600),
    },
  };
}

export function vProvider(v: unknown): ProviderConfig {
  const o = obj(v, 'provider', ['id', 'kind', 'label', 'baseUrl', 'sendReasoningEffort', 'serverFallback', 'maxTokensField', 'presetId', 'models', 'selection']);
  const baseUrl = optStr(o.baseUrl, 'base URL', 2000);
  if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) fail('base URL (http or https only)');
  return {
    id: vProviderId(o.id),
    kind: oneOf(o.kind, 'provider type', ['anthropic', 'openai', 'responses', 'gemini', 'fake'] as const),
    label: str(o.label, 'provider name', 80),
    baseUrl,
    sendReasoningEffort: optBool(o.sendReasoningEffort, 'reasoning effort'),
    serverFallback: optBool(o.serverFallback, 'fallback'),
    maxTokensField: o.maxTokensField === undefined ? undefined : oneOf(o.maxTokensField, 'length field', ['max_tokens', 'max_completion_tokens', 'none'] as const),
    presetId: o.presetId === undefined ? undefined : oneOf(o.presetId, 'provider preset', ['anthropic', 'openai', 'deepseek', 'glm-cn', 'zai', 'kimi', 'opencode-go', 'grok', 'gemini', 'custom'] as const),
    models: o.models === undefined ? undefined : vModels(o.models),
    selection: o.selection === undefined ? undefined : vSelection(o.selection),
  };
}

function vSelection(v: unknown): NonNullable<ProviderConfig['selection']> {
  const o = obj(v, 'model selection', ['model', 'effort']);
  return { model: vModel(o.model), effort: oneOf(o.effort, 'effort', EFFORTS) };
}

function vModels(v: unknown): ModelInfo[] {
  if (!Array.isArray(v) || v.length > 1000) fail('model catalog');
  return (v as unknown[]).map((raw) => {
    const o = obj(raw, 'model info', ['id', 'label', 'efforts', 'effortSource', 'maxOutputTokens', 'thinking']);
    if (!Array.isArray(o.efforts) || o.efforts.length > EFFORTS.length) fail('model efforts');
    return {
      id: vModel(o.id), label: str(o.label, 'model label', 200),
      efforts: (o.efforts as unknown[]).map((e) => oneOf(e, 'model effort', EFFORTS)),
      effortSource: oneOf(o.effortSource, 'capability source', ['api', 'documented', 'unknown'] as const),
      maxOutputTokens: o.maxOutputTokens === undefined ? undefined : num(o.maxOutputTokens, 'output limit', 1, 10_000_000),
      thinking: o.thinking === undefined ? undefined : oneOf(o.thinking, 'thinking control', ['effort', 'toggle'] as const),
    };
  });
}

function vHarness(v: unknown): HarnessConfig {
  const o = obj(v, 'harness', ['id', 'label', 'kind', 'command', 'parser', 'skillDirs', 'keyFromProvider', 'keyEnv', 'unverified', 'envAllow', 'gitInit']);
  const command = str(o.command, 'command', 4000);
  try {
    splitArgs(command);
  } catch {
    fail('command (unbalanced quotes)');
  }
  if (!Array.isArray(o.skillDirs) || o.skillDirs.length > 5) fail('skill folders');
  const skillDirs = (o.skillDirs as unknown[]).map((d) => {
    const s = str(d, 'skill folder', 200, /^[\w.-]+(\/[\w.-]+)*$/);
    if (s.split('/').some((p) => p === '..' || p === '.')) fail('skill folder');
    return s;
  });
  const envAllow = o.envAllow === undefined ? undefined : Array.isArray(o.envAllow) && o.envAllow.length <= 40 ? o.envAllow.map((e) => str(e, 'variable name', 64, ENV_NAME)) : fail('variables');
  return {
    id: str(o.id, 'harness id', 40, ID),
    label: str(o.label, 'harness name', 80),
    kind: o.kind === undefined ? undefined : oneOf(o.kind, 'harness type', ['cli', 'pi'] as const),
    command,
    parser: oneOf(o.parser, 'output format', ['claude-stream-json', 'plain'] as const),
    skillDirs,
    keyFromProvider: o.keyFromProvider === undefined || o.keyFromProvider === '' ? (o.keyFromProvider as '' | undefined) : vProviderId(o.keyFromProvider),
    keyEnv: o.keyEnv === undefined || o.keyEnv === '' ? (o.keyEnv as '' | undefined) : str(o.keyEnv, 'variable name', 64, ENV_NAME),
    unverified: optBool(o.unverified, 'unverified'),
    envAllow,
    gitInit: optBool(o.gitInit, 'git init'),
  };
}

function vOverride(v: unknown): SkillOverride {
  const o = obj(v, 'skill override', ['enabled', 'order', 'runner', 'output', 'direct', 'agent', 'outputDir']);
  return {
    enabled: optBool(o.enabled, 'enabled'),
    order: o.order === undefined ? undefined : num(o.order, 'order', 0, 10_000),
    runner: o.runner === undefined ? undefined : oneOf(o.runner, 'runner', ['direct', 'agent'] as const),
    output: o.output === undefined ? undefined : oneOf(o.output, 'output', ['markdown', 'html'] as const),
    direct: vDirectPartial(o.direct, 'direct override'),
    agent: vAgentPartial(o.agent, 'agent override'),
    // Which folders are allowed is checked against the stored settings (settings-policy.ts).
    outputDir: o.outputDir === undefined ? undefined : vOutputDir(o.outputDir),
  };
}

/** '' or an absolute path; settings-policy.ts only lets through folders chosen in the main-process dialog. */
function vOutputDir(v: unknown): string {
  const p = str(v, 'output folder', 4096);
  return p === '' ? p : vAbsPath(p);
}

/** Keys the renderer may never set: they are written by the main process only. */
export const MAIN_ONLY_SETTINGS = ['agentTrust', 'settingsVersion'] as const;

export function vSettingsPatch(v: unknown): Partial<Settings> {
  const o = obj(v, 'settings', [
    'uiLang', 'explainLang', 'hotkey', 'locateHotkey', 'captureHotkey', 'quickSkill', 'autoQuick', 'outputDir', 'dataScope', 'profile', 'theme', 'pdfDim',
    'agentConcurrency', 'agentsEnabled', 'requireIsolation', 'providers', 'harnesses', 'defaults', 'skillOverrides', 'usageLimits',
  ]);
  const p: Partial<Settings> = {};
  if (o.uiLang !== undefined) p.uiLang = oneOf(o.uiLang, 'interface language', UI_LANGS);
  if (o.explainLang !== undefined) p.explainLang = str(o.explainLang, 'explanation language', 40, LANG);
  if (o.hotkey !== undefined) p.hotkey = parseHotkey(str(o.hotkey, 'hotkey', 40)) ? (o.hotkey as string) : fail('hotkey');
  if (o.locateHotkey !== undefined) p.locateHotkey = parseHotkey(str(o.locateHotkey, 'hotkey', 40)) ? (o.locateHotkey as string) : fail('hotkey');
  if (o.captureHotkey !== undefined) p.captureHotkey = parseHotkey(str(o.captureHotkey, 'hotkey', 40)) ? (o.captureHotkey as string) : fail('hotkey');
  if (o.quickSkill !== undefined) p.quickSkill = vSkillName(o.quickSkill);
  if (o.autoQuick !== undefined) p.autoQuick = bool(o.autoQuick, 'automatic quick explanation');
  if (o.outputDir !== undefined) p.outputDir = vOutputDir(o.outputDir);
  if (o.dataScope !== undefined) p.dataScope = oneOf(o.dataScope, 'data scope', DATA_SCOPES);
  if (o.profile !== undefined) p.profile = str(o.profile, 'profile', 2000);
  if (o.theme !== undefined) p.theme = oneOf(o.theme, 'theme', THEME_PREFS);
  if (o.pdfDim !== undefined) p.pdfDim = bool(o.pdfDim, 'dim PDF pages');
  if (o.agentConcurrency !== undefined) p.agentConcurrency = num(o.agentConcurrency, 'concurrency', 1, 8);
  if (o.agentsEnabled !== undefined) p.agentsEnabled = bool(o.agentsEnabled, 'agents enabled');
  if (o.requireIsolation !== undefined) p.requireIsolation = bool(o.requireIsolation, 'require isolation');
  if (o.providers !== undefined) {
    if (!Array.isArray(o.providers) || o.providers.length > 20) fail('providers');
    p.providers = (o.providers as unknown[]).map(vProvider);
  }
  if (o.harnesses !== undefined) {
    if (!Array.isArray(o.harnesses) || o.harnesses.length > 20) fail('harnesses');
    p.harnesses = (o.harnesses as unknown[]).map(vHarness);
  }
  if (o.defaults !== undefined) {
    const d = obj(o.defaults, 'defaults', ['quick', 'direct', 'agent']);
    const full = <T>(x: Partial<T> | undefined, keys: (keyof T)[], what: string): T => {
      if (!x || keys.some((k) => x[k] === undefined)) fail(what);
      return x as T;
    };
    p.defaults = {
      quick: full(vDirectPartial(d.quick, 'quick engine'), ['providerId', 'model', 'effort', 'maxTokens'], 'quick engine'),
      direct: full(vDirectPartial(d.direct, 'direct engine'), ['providerId', 'model', 'effort', 'maxTokens'], 'direct engine'),
      agent: full(vAgentPartial(d.agent, 'agent engine'), ['harnessId', 'effort', 'budgetUsd', 'timeoutMinutes'], 'agent engine'),
    };
    p.defaults.agent.model ??= '';
  }
  if (o.usageLimits !== undefined) {
    if (!isObj(o.usageLimits) || Object.keys(o.usageLimits).length > 40) fail('usage limits');
    p.usageLimits = Object.fromEntries(
      Object.entries(o.usageLimits as object).map(([k, x]) => {
        const l = obj(x, 'usage limit', ['period', 'usd', 'tokens']);
        return [vProviderId(k), { period: oneOf(l.period, 'limit period', ['day', 'month'] as const), usd: num(l.usd, 'dollar limit', 0, 100_000, false), tokens: num(l.tokens, 'token limit', 0, 1e11) }];
      }),
    );
  }
  if (o.skillOverrides !== undefined) {
    if (!isObj(o.skillOverrides) || Object.keys(o.skillOverrides).length > 200) fail('skill overrides');
    p.skillOverrides = Object.fromEntries(Object.entries(o.skillOverrides as object).map(([k, x]) => [vSkillName(k), vOverride(x)]));
  }
  return p;
}
