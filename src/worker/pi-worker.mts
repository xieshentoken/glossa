// Runs one skill job with the built-in Pi agent, in its own process (an Electron
// utility process in the app, a Node child process in tests). It depends only on
// the Pi SDK so Node can run this file directly; the main process prepares
// everything else (see src/main/runners/pi.ts).
//
// Isolation from the user's own Pi setup: in-memory settings, sessions and
// credentials, no resource discovery (only the skill handed over), no catalog
// refresh, version check or install telemetry. The key arrives in the run
// message, never through the environment or the command line.

import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createExtensionRuntime,
  loadSkillsFromDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';

export type PiApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'google-generative-ai';
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The model a run uses, built from a Glossa connection. */
export interface PiModelSpec {
  /** Glossa's offline demo connection: a scripted model, nothing leaves the computer. */
  demo?: boolean;
  api: PiApi;
  baseUrl: string;
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
  compat?: Record<string, unknown>;
  maxTokens: number;
  /** Pi catalog entry for the same model; only its prices and context window are used. */
  catalog?: { provider: string; id: string };
  /** Omitted: no thinking parameter is sent. */
  thinkingLevel?: PiThinkingLevel;
}

export interface PiTask {
  workspace: string;
  agentDir: string;
  /** 'answer': the final message is the result. 'workspace': the agent writes outputFile. */
  mode: 'answer' | 'workspace';
  appendSystem: string[];
  prompt: string;
  /** Folder holding the copied skill (workspace mode). */
  skillsDir?: string;
  /** Relative to the workspace. */
  outputFile: string;
  model: PiModelSpec;
  apiKey?: string;
  budgetUsd: number;
  /** Pictures attached to the prompt (a captured area), base64. */
  images?: { data: string; mimeType: string }[];
  /** The prompt also stands without them: a model Pi knows cannot read pictures gets the text alone. */
  imagesOptional?: boolean;
  /** What the demo model echoes back; delayMs slows it down (tests of the queue). */
  demo?: { skill: string; term: string; lang: string; model: string; effort: string; output: 'markdown' | 'html'; delayMs?: number };
}

export interface PiRunResult {
  text: string;
  stop: 'complete' | 'length' | 'error' | 'aborted';
  error?: string;
  costUsd?: number;
  /** Tokens the model reported for the whole run (input, output and cache). */
  tokens?: number;
  /** The model's price is known, so costUsd counts (0 can then mean "free"). */
  priced?: boolean;
}

export type ToWorker = { type: 'run'; task: PiTask } | { type: 'abort' };
export type FromWorker =
  | { type: 'text'; delta: string }
  /** The model called tools; text streamed so far was not the final answer. */
  | { type: 'turn' }
  | { type: 'progress'; line: string }
  | { type: 'done'; result: PiRunResult }
  | { type: 'fail'; message: string };

const PROVIDER = 'glossa';

interface Port {
  send(m: FromWorker): void;
  onMessage(cb: (m: ToWorker) => void): void;
}

function parentPort(): Port {
  const utility = (process as unknown as { parentPort?: { postMessage(m: unknown): void; on(e: 'message', cb: (ev: { data: unknown }) => void): void } }).parentPort;
  if (utility) return { send: (m) => utility.postMessage(m), onMessage: (cb) => utility.on('message', (ev) => cb(ev.data as ToWorker)) };
  return { send: (m) => process.send?.(m), onMessage: (cb) => process.on('message', (m) => cb(m as ToWorker)) };
}

function demoModel(task: PiTask): { runtimeProvider: ReturnType<typeof fauxProvider>; model: Model<string> } {
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: task.model.id }], tokensPerSecond: 400 });
  const d = task.demo ?? { skill: 'skill', term: '?', lang: '?', model: task.model.id, effort: 'default', output: 'markdown' as const };
  const pictures = task.images?.length ? `, with ${task.images.length} picture${task.images.length > 1 ? 's' : ''}` : '';
  const line = `**${d.term}** — offline sample explanation (${d.skill}, ${d.lang}, ${d.model}, effort ${d.effort}${pictures}).`;
  const slow = (msg: AssistantMessage) => async (_c: unknown, options?: { signal?: AbortSignal }) => {
    if (d.delayMs) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, d.delayMs);
        options?.signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()));
      });
    }
    return msg;
  };
  if (task.mode === 'answer') faux.setResponses([slow(fauxAssistantMessage([fauxText(line)]))]);
  else {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const content = d.output === 'html' ? `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.term)}</title></head><body><h1>${esc(d.term)}</h1><p>${esc(line)}</p></body></html>` : line;
    faux.setResponses([
      slow(fauxAssistantMessage([fauxToolCall('write', { path: task.outputFile, content })], { stopReason: 'toolUse' })),
      fauxAssistantMessage([fauxText(`Wrote ${task.outputFile}.`)]),
    ]);
  }
  return { runtimeProvider: faux, model: faux.getModel() };
}

/** Whether the model can read the task's pictures; unknown models (custom endpoints) are asked anyway. */
function seesPictures(known: Model<string> | undefined): boolean {
  return !known || known.input.includes('image');
}

async function resolveModel(task: PiTask, runtime: ModelRuntime): Promise<Model<string>> {
  if (task.model.demo) {
    const { runtimeProvider, model } = demoModel(task);
    runtime.registerNativeProvider(runtimeProvider.provider);
    return model;
  }
  const m = task.model;
  const known = m.catalog ? runtime.getModel(m.catalog.provider, m.catalog.id) : undefined;
  if (task.images?.length && !seesPictures(known)) {
    if (!task.imagesOptional) throw new Error(`${m.id} cannot read pictures, and this area has no text. Choose a model that can see images for this skill (Settings → Models & effort).`);
    task.images = undefined;
  }
  runtime.registerProvider(PROVIDER, {
    name: 'Glossa connection',
    baseUrl: m.baseUrl,
    api: m.api,
    models: [
      {
        id: m.id,
        name: m.id,
        api: m.api,
        baseUrl: m.baseUrl,
        input: task.images?.length ? ['text', 'image'] : ['text'],
        reasoning: m.reasoning,
        ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
        ...(m.compat ? { compat: m.compat as never } : {}),
        cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: known?.contextWindow ?? 128_000,
        maxTokens: m.maxTokens,
      },
    ],
  });
  if (task.apiKey) await runtime.setRuntimeApiKey(PROVIDER, task.apiKey);
  const model = runtime.getModel(PROVIDER, m.id);
  if (!model) throw new Error(`Pi could not set up the model ${m.id}.`);
  return model;
}

function textOf(msg: AssistantMessage): string {
  return msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

async function run(task: PiTask, port: Port, abort: { current?: () => void }): Promise<PiRunResult> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const hadPictures = !!task.images?.length;
  const model = await resolveModel(task, runtime);
  if (hadPictures && !task.images) port.send({ type: 'progress', line: `${model.id} cannot read pictures: only the area's text was sent` });
  const skills = task.skillsDir ? loadSkillsFromDir({ dir: task.skillsDir, source: 'glossa' }) : { skills: [], diagnostics: [] };
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => skills,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => task.appendSystem,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd: task.workspace,
    agentDir: task.agentDir,
    model,
    ...(task.model.thinkingLevel ? { thinkingLevel: task.model.thinkingLevel } : { thinkingLevel: 'off' as const }),
    modelRuntime: runtime,
    resourceLoader,
    // Unrestricted, as decided for Glossa: every built-in tool.
    tools: ['read', 'write', 'edit', 'bash', 'ls', 'grep', 'find'],
    sessionManager: SessionManager.inMemory(task.workspace),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, enableInstallTelemetry: false, retry: { enabled: true, maxRetries: 2 } }),
  });
  let cost = 0;
  let tokens = 0;
  let overBudget = false;
  const priced = model.cost.input > 0 || model.cost.output > 0;
  let last: AssistantMessage | undefined;
  abort.current = () => void session.abort();
  session.subscribe((e) => {
    if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') port.send({ type: 'text', delta: e.assistantMessageEvent.delta });
    else if (e.type === 'tool_execution_start') port.send({ type: 'progress', line: `${e.toolName}${describeArgs(e.args)}` });
    else if (e.type === 'message_end' && e.message.role === 'assistant') {
      last = e.message;
      cost += e.message.usage?.cost?.total ?? 0;
      tokens += e.message.usage?.totalTokens ?? 0;
      if (task.budgetUsd > 0 && cost > task.budgetUsd && !overBudget) {
        overBudget = true;
        void session.abort();
      }
      // A new turn starts a new answer; only the final message counts.
      if (e.message.stopReason === 'toolUse') port.send({ type: 'turn' });
    }
  });
  try {
    await session.prompt(task.prompt, task.images?.length ? { images: task.images.map((i) => ({ type: 'image' as const, ...i })) } : undefined);
  } finally {
    session.dispose();
  }
  const costUsd = cost > 0 ? cost : undefined;
  const used = { tokens: tokens || undefined, priced };
  if (overBudget) return { text: last ? textOf(last) : '', stop: 'error', error: `Stopped: the budget of $${task.budgetUsd} was reached.`, costUsd, ...used };
  if (!last) return { text: '', stop: 'error', error: 'Pi returned no answer.', costUsd, ...used };
  const text = textOf(last);
  switch (last.stopReason) {
    case 'stop':
      return { text, stop: 'complete', costUsd, ...used };
    case 'length':
      return { text, stop: 'length', costUsd, ...used };
    case 'aborted':
      return { text, stop: 'aborted', costUsd, ...used };
    default:
      return { text, stop: 'error', error: last.errorMessage || `Pi stopped (${last.stopReason}).`, costUsd, ...used };
  }
}

function describeArgs(args: unknown): string {
  const a = args as { path?: string; command?: string; pattern?: string } | undefined;
  const v = a?.path ?? a?.command ?? a?.pattern;
  return typeof v === 'string' ? ` ${v.length > 80 ? `${v.slice(0, 77)}…` : v}` : '';
}

const port = parentPort();
const abort: { current?: () => void; requested?: boolean } = {};
port.onMessage((m) => {
  if (m.type === 'abort') {
    abort.requested = true;
    abort.current?.();
  } else if (m.type === 'run') {
    run(m.task, port, abort)
      .then((result) => port.send({ type: 'done', result: abort.requested ? { ...result, stop: 'aborted' } : result }))
      .catch((err: unknown) => port.send({ type: 'fail', message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setTimeout(() => process.exit(0), 50));
  }
});
