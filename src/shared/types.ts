export type Effort = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export const EFFORTS: Effort[] = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export type UiLang = 'en' | 'de' | 'fr' | 'zh';

/** What the user chose; 'system' follows the operating system. */
/** 'paper': the interface and cards as fine paper (light underneath; documents keep their own look). */
export type ThemePref = 'system' | 'light' | 'dark' | 'paper';
export const THEME_PREFS: ThemePref[] = ['system', 'light', 'dark', 'paper'];
/** What is shown. */
export type Theme = 'light' | 'dark';
/** How a card's result page looks: the theme shown, or paper. */
export type ViewTheme = Theme | 'paper';
export const UI_LANGS: UiLang[] = ['en', 'de', 'fr', 'zh'];

export type OutputKind = 'markdown' | 'html';
export type RunnerKind = 'direct' | 'agent';
export type ProviderKind = 'anthropic' | 'openai' | 'responses' | 'gemini' | 'fake';
export type ProviderPresetId = 'anthropic' | 'openai' | 'deepseek' | 'glm-cn' | 'zai' | 'kimi' | 'opencode-go' | 'grok' | 'gemini' | 'custom';
export interface ModelInfo {
  id: string;
  label: string;
  /** Empty means unknown or no configurable effort. `default` always omits the parameter. */
  efforts: Effort[];
  effortSource: 'api' | 'documented' | 'unknown';
  maxOutputTokens?: number;
  thinking?: 'effort' | 'toggle';
}
export type StreamParser = 'claude-stream-json' | 'plain';

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  presetId?: ProviderPresetId;
  models?: ModelInfo[];
  selection?: { model: string; effort: Effort };
  /** Empty means the provider's official endpoint. */
  baseUrl?: string;
  /** OpenAI-compatible only: send `reasoning_effort`. Some servers reject it. */
  sendReasoningEffort?: boolean;
  /** Anthropic only: opt into server-side refusal fallbacks on models that support them. */
  serverFallback?: boolean;
  /** OpenAI-compatible only: which field carries the output limit. Empty = derived from the endpoint. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens' | 'none';
}

export interface HarnessConfig {
  id: string;
  label: string;
  /** 'pi': the built-in Pi agent (no command; uses a Glossa model connection). Default: an external CLI. */
  kind?: 'cli' | 'pi';
  /** Command line with {model} {effort} {budget} {workspace} {skillDir} {prompt} placeholders. Never run through a shell. Without {prompt}, the task is written to stdin. */
  command: string;
  parser: StreamParser;
  /** Folders (relative to the job workspace) the skill is copied into. */
  skillDirs: string[];
  /** Pass the key of this provider to the child process. Empty = the harness uses its own login. */
  keyFromProvider?: string;
  /** Environment variable that receives the key. */
  keyEnv?: string;
  /** Preset whose flags were not verified against an installed CLI. */
  unverified?: boolean;
  /** Extra environment variable names passed to the harness (a base set is always passed). */
  envAllow?: string[];
  /** Create a git repository in the job folder first (some CLIs require one). */
  gitInit?: boolean;
}

export interface DirectEngine {
  providerId: string;
  model: string;
  effort: Effort;
  maxTokens: number;
}

export interface AgentEngine {
  harnessId: string;
  /** Built-in Pi only: the model connection. Empty = the connection used for skill answers. */
  providerId?: string;
  model: string;
  effort: Effort;
  budgetUsd: number;
  timeoutMinutes: number;
}

export interface SkillOverride {
  enabled?: boolean;
  order?: number;
  runner?: RunnerKind;
  output?: OutputKind;
  direct?: Partial<DirectEngine>;
  agent?: Partial<AgentEngine>;
  /** Where this skill's results are saved: unset = Settings.outputDir, '' = not saved, else a folder chosen in a dialog. */
  outputDir?: string;
}

/** A limit on what one model connection (one API key) may use in Glossa per day or month. 0 = no limit of that kind. */
export interface UsageLimit {
  period: 'day' | 'month';
  usd: number;
  tokens: number;
}

export interface UsageTotals {
  usd: number;
  tokens: number;
  runs: number;
  /** Runs whose dollars are not counted (price unknown). */
  unpriced: number;
}

export interface UsageStatus extends UsageTotals {
  providerId: string;
  period: UsageLimit['period'];
  /** Start of the next period (local time), when the limit resets. */
  resetsAt: number;
  limit?: UsageLimit;
  /** Share of the limit used, the larger of dollars and tokens; undefined without a limit. */
  ratio?: number;
}

/** How much of the document leaves the computer with a request. */
export type DataScope = 'sentence' | 'paragraph' | 'document';
export const DATA_SCOPES: DataScope[] = ['sentence', 'paragraph', 'document'];

export interface Settings {
  /** Bumped when stored settings need migrating. */
  settingsVersion: number;
  uiLang: UiLang;
  /** 'ui' follows the interface language; otherwise a BCP-47 code or language name. */
  explainLang: string;
  hotkey: string;
  /** Scrolls the document to the focused card's term and highlights it. */
  locateHotkey: string;
  /** Drag over part of a document to explain its text or picture. */
  captureHotkey: string;
  quickSkill: string;
  /** A new card starts the quick skill at once (short-answer skills only). */
  autoQuick: boolean;
  /** Folder finished results are copied into; empty = not saved. Chosen in a main-process dialog. */
  outputDir: string;
  /** Context sent with each lookup. 'document' needs explicit consent (granted in the main process). */
  dataScope: DataScope;
  profile: string;
  theme: ThemePref;
  /** In the dark theme, show PDF pages with inverted colours. */
  pdfDim: boolean;
  agentConcurrency: number;
  /** Agent skills may run at all (granted in the main process after the risk notice). */
  agentsEnabled: boolean;
  /** Refuse agent runs when no OS-level isolation is available. */
  requireIsolation: boolean;
  /** Skill name → content hash the user approved for runs without asking again. Main process only. */
  agentTrust: Record<string, string>;
  providers: ProviderConfig[];
  harnesses: HarnessConfig[];
  defaults: { quick: DirectEngine; direct: DirectEngine; agent: AgentEngine };
  skillOverrides: Record<string, SkillOverride>;
  /** Connection id → its usage limit (see main/usage.ts). */
  usageLimits: Record<string, UsageLimit>;
}

export type LocalizedText = Partial<Record<UiLang, string>> & { en?: string };

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  source: 'builtin' | 'user';
  runner: RunnerKind;
  output: OutputKind;
  label: LocalizedText;
  /** Agent runner task template ({{term}}, {{explainLang}} …). */
  task?: string;
  timeoutMinutes?: number;
  /** Instructions (SKILL.md body). */
  body: string;
  enabled: boolean;
  order: number;
  /** Runner/output came from a known-skill preset rather than the skill's own frontmatter. */
  preset?: string;
}

export interface TermContext {
  term: string;
  sentence: string;
  paragraph: string;
  heading?: string;
  docTitle: string;
  docSource: string;
  docLang?: string;
  termLang?: string;
}

export interface JobRequest {
  docId: string;
  skill: string;
  context: TermContext;
  explainLang: string;
  direct?: Partial<DirectEngine>;
  agent?: Partial<AgentEngine>;
  /** A captured area of the document (its picture is sent along), see main/captures.ts. */
  image?: string;
  /** Skip the result cache. */
  force?: boolean;
  /** 'auto' = started without a click (e.g. the quick explanation). Agent skills never start automatically. */
  origin?: 'user' | 'auto';
}

/** 'partial' = a usable but incomplete answer (cut at the length limit or connection lost). Never cached. */
export type JobStatus = 'queued' | 'running' | 'done' | 'partial' | 'error' | 'cancelled';

export interface JobState {
  id: string;
  docId: string;
  skill: string;
  term: string;
  runner: RunnerKind;
  output: OutputKind;
  status: JobStatus;
  progress: string;
  /** Streamed text so far (direct runner). */
  text?: string;
  engineLabel: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  costUsd?: number;
  cached?: boolean;
  /** This job shows the result of another (cache hit); the result files live there. */
  resultOf?: string;
  partialReason?: 'length' | 'interrupted';
  /** The saved result is gone or damaged; the card offers to run again. */
  outputMissing?: boolean;
  /** The app was closed while this job ran or waited; it is never resumed automatically. */
  interrupted?: boolean;
  /** Where the request went: endpoint host or harness, model, and how much context. */
  recipient?: string;
  /** The copy of the result in the chosen output folder. */
  savedTo?: string;
  /** Copying the result to the output folder failed (the result itself is fine). */
  saveError?: string;
  /** The connection is near its usage limit (shown on the card). */
  usageNote?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One result card per run, as saved before cards held several runs (see shared/cards.ts). */
export interface LegacyCard {
  id: string;
  jobId: string;
  term: string;
  skill: string;
  rect: Rect;
  expanded: boolean;
  createdAt: number;
  /** The request that produced the job, for "run again". */
  request: JobRequest;
}

export type CardWindow = 'normal' | 'maximized' | 'minimized';
export const CARD_WINDOWS: CardWindow[] = ['normal', 'maximized', 'minimized'];

/** A skill run started from a card. The job id changes on "run again"; the task stays. */
export interface CardTask {
  id: string;
  jobId: string;
  skill: string;
  createdAt: number;
  request: JobRequest;
}

/**
 * Where a picked term is in its document, to find it again: the exact text with
 * some text on either side, and its position (characters, whitespace not
 * counted) in the reader's text, or in its page for PDFs.
 */
export interface TermLocator {
  quote: string;
  prefix: string;
  suffix: string;
  index?: number;
  /** PDF page, from 1. */
  page?: number;
  /** A captured area: where it was, as fractions of its PDF page or of the scrolled content. */
  region?: Region;
}

/** Fractions of a PDF page or of a reader's scrolled content; on web pages (`px`), CSS pixels from the page's top left, since pages grow. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  px?: boolean;
}

/** The picture of a captured area. */
export interface CardCapture {
  id: string;
  w: number;
  h: number;
  /** The picture goes with each run. False when the area held only text: the text says it all, and any model can read it. */
  send: boolean;
}

/** One picked term. Its context is fixed when the term is picked. */
export interface TermCard {
  id: string;
  /** Editable before a run; each run keeps the term it was started with. */
  term: string;
  context: TermContext;
  explainLang: string;
  /** Position and size when shown normally; kept while maximized or minimized. */
  rect: Rect;
  window: CardWindow;
  tasks: CardTask[];
  activeTask?: string;
  createdAt: number;
  /** Missing on cards saved before terms could be located; the sentence is used then. */
  locator?: TermLocator;
  /** Cards made from a captured area: its picture goes with every run. */
  capture?: CardCapture;
}

/** 'code': source code and data files (Python, JSON, YAML …), shown as monospaced lines. */
/** 'session': a Claude Code or Codex session (.jsonl), shown as a conversation. */
export type DocKind = 'web' | 'pdf' | 'docx' | 'markdown' | 'text' | 'html' | 'code' | 'session';

export interface DocInfo {
  docId: string;
  kind: DocKind;
  title: string;
  /** URL or absolute file path. */
  source: string;
  openedAt: number;
}

export interface DocRecord extends DocInfo {
  /** Saved by older versions; read once and replaced by termCards on the next save. */
  cards?: LegacyCard[];
  termCards?: TermCard[];
}

export interface PickedTerm {
  context: TermContext;
  /** Client rect of the term, in the reader's coordinate space. */
  rect: { x: number; y: number; width: number; height: number };
  locator?: TermLocator;
  capture?: CardCapture;
}
