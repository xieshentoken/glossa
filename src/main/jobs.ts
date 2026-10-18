// Job lifecycle: plan → authorization → cache → queue → run → validate output → persist/emit.
// Every run is an agent run (see job-plan.ts): short answers and workspace tasks
// with the built-in Pi agent, or workspace tasks with an external CLI harness.
//
// Layout of jobs/<id>/:
//   job.json      metadata (never inside the agent's working directory)
//   harness.log   external CLI runs, secrets redacted
//   pi.log        built-in Pi runs: the tools it used
//   pi/           Pi's own config folder for this run (in place of ~/.pi)
//   work/         the agent's working directory
//   work/output/  the result, see output-contract.ts
// Jobs written before layout 2 kept their output in jobs/<id>/output/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PI_HARNESS } from '../shared/defaults';
import { buildDirectPrompt } from '../shared/prompts';
import { modelInfo } from '../shared/model-catalog';
import { skillLabel } from '../shared/skills';
import type { JobRequest, JobState, ProviderConfig, SkillInfo, Theme } from '../shared/types';
import { authorizeAgentRun, denyAll, PI_TOOLS, type AgentApprover } from './agent-policy';
import { redactor, secretValues } from './agent-env';
import { ResultCache } from './cache';
import { detectIsolation, type IsolationStatus } from './isolation';
import { AREA_PICTURE, JobRejected, planJob, type JobPlan } from './job-plan';
import { OUTPUT_FILES, OUTPUT_SPECS, readOutputText, validateOutput, writeOutput } from './output-contract';
import { exportResult, outputDirFor } from './output-export';
import { piModelSpec } from './pi-model';
import { isAbort } from './providers';
import { collectOutput, harnessArgv, prepareWorkspace, runAgent, type AgentRunOptions, type AgentRunResult } from './runners/agent';
import type { PiRunner, PiTask } from './runners/pi';
import type { Store } from './store';

export { JobRejected, resolveAgent, resolveDirect, resolveExplainLang } from './job-plan';

export interface JobDeps {
  store: Store;
  skills: () => SkillInfo[];
  /** Content hash of a skill (SKILL.md for direct skills, the whole folder for agent skills). */
  skillHash: (s: SkillInfo) => string;
  docText: (docId: string) => string | undefined;
  emit: (state: JobState) => void;
  /** Runs the built-in Pi agent (a worker process in the app). Default: not available. */
  piRunner?: PiRunner;
  agentRunner?: (o: AgentRunOptions) => Promise<AgentRunResult>;
  /** Shows the main-process approval dialog. Default: refuse everything. */
  approveAgent?: AgentApprover;
  /** Shows the one-time notice that skills run with an agent; true turns agents on. Default: no. */
  confirmAgents?: () => Promise<boolean>;
  isolation?: () => IsolationStatus;
  /** The theme shown now ('system' resolved); results are made for it. Default: light unless 'dark' is chosen. */
  theme?: () => Theme;
}

const ANSWER_TIMEOUT_MIN = 10;
/** Slows Glossa's offline demo model (queue tests); no effect on real connections. */
const demoDelay = () => Number(process.env.GLOSSA_PI_DEMO_DELAY_MS) || 0;

const JOB_ID_RE = /^[a-z0-9-]{8,64}$/;
const LAYOUT = 2;
const TERMINAL = new Set(['done', 'partial', 'error', 'cancelled']);

type JobRecord = JobState & { layout?: number; cacheKey?: string };

export const MISSING_OUTPUT = 'The saved result is missing or damaged. Run it again to regenerate it.';
const INTERRUPTED = 'Interrupted (the app was closed while this job was running). Run it again to restart it.';

export class JobManager {
  private jobs = new Map<string, JobRecord>();
  private aborts = new Map<string, AbortController>();
  private inflight = new Map<string, string>();
  private agentQueue: (() => void)[] = [];
  private agentsRunning = 0;
  private closing = false;
  private autoNoticeDeclined = false;
  readonly cache: ResultCache;

  constructor(private deps: JobDeps) {
    this.cache = new ResultCache(deps.store.cacheFile);
  }

  jobDir(id: string): string {
    if (typeof id !== 'string' || !JOB_ID_RE.test(id)) throw new Error('Invalid job id');
    return path.join(this.deps.store.jobsDir, id);
  }

  private outputRoot(job: JobRecord): string {
    const owner = job.resultOf ? this.load(job.resultOf) : job;
    const id = owner?.id ?? job.resultOf ?? job.id;
    return (owner?.layout ?? 0) >= LAYOUT ? path.join(this.jobDir(id), 'work') : this.jobDir(id);
  }

  /** Folder holding the result files of a usable job (for the output protocol). */
  outputDir(id: string): string | undefined {
    const job = this.get(id);
    if (!job || (job.status !== 'done' && job.status !== 'partial')) return undefined;
    return this.outputRoot(this.jobs.get(id)!);
  }

  outputFile(id: string): string | undefined {
    const job = this.get(id);
    const root = this.outputDir(id);
    return job && root ? path.join(root, OUTPUT_SPECS[job.output].file) : undefined;
  }

  /** A finished result as text (at most 2 MB), for the plain view. */
  outputText(id: string): { output: JobState['output']; text: string } | undefined {
    const job = this.get(id);
    const file = this.outputFile(id);
    if (!job || !file) return undefined;
    return { output: job.output, text: fs.readFileSync(file).subarray(0, 2_000_000).toString('utf8') };
  }

  private load(id: string): JobRecord | undefined {
    const mem = this.jobs.get(id);
    if (mem) return mem;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.jobDir(id), 'job.json'), 'utf8')) as JobRecord;
      if (saved.id !== id) return undefined;
      if (saved.status === 'running' || saved.status === 'queued') {
        // Never resumed automatically, agent runs included.
        saved.status = 'error';
        saved.interrupted = true;
        saved.error = INTERRUPTED;
      }
      this.jobs.set(id, saved);
      return saved;
    } catch {
      return undefined;
    }
  }

  /** Current state. Finished jobs are checked against their output and get their text back after a restart. */
  get(id: string): JobState | undefined {
    const job = this.load(id);
    if (!job) return undefined;
    if (job.status !== 'done' && job.status !== 'partial') return this.public(job);
    const root = this.outputRoot(job);
    const check = validateOutput(root, job.output);
    if (!check.ok) {
      if (job.cacheKey) this.cache.delete(job.cacheKey);
      return this.public({ ...job, status: 'error', error: MISSING_OUTPUT, outputMissing: true, text: undefined });
    }
    if (job.output === 'markdown' && !job.text) job.text = readOutputText(root, 'markdown');
    return this.public(job);
  }

  private public(job: JobRecord): JobState {
    const { layout: _l, cacheKey: _k, ...state } = job;
    return state;
  }

  private update(id: string, patch: Partial<JobRecord>, finalize = false): void {
    const cur = this.jobs.get(id);
    if (!cur) return;
    // Late events (stream chunks, progress) never change a finished job.
    if (TERMINAL.has(cur.status) && !finalize) return;
    const next = { ...cur, ...patch };
    this.jobs.set(id, next);
    if (finalize || patch.status === 'queued') this.persist(next);
    this.deps.emit(this.public(next));
  }

  private persist(job: JobRecord): void {
    const { text: _text, ...meta } = job;
    fs.mkdirSync(this.jobDir(job.id), { recursive: true });
    fs.writeFileSync(path.join(this.jobDir(job.id), 'job.json'), JSON.stringify(meta, null, 2));
  }

  private newId(): string {
    return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  }

  private settings() {
    return this.deps.store.getSettings();
  }

  async start(req: JobRequest): Promise<JobState> {
    const settings = this.settings();
    const plan = planJob({ req, settings: { ...settings, theme: this.theme() }, skills: this.deps.skills(), skillHash: this.deps.skillHash, docText: this.deps.docText });
    if (plan.image && !this.deps.store.captures.has(plan.image)) throw new JobRejected('The picture of this area is gone. Capture the area again.');

    if (!req.force) {
      const hit = this.cacheHit(plan, req);
      if (hit) return hit;
      const running = this.inflight.get(plan.cacheKey);
      if (running && this.jobs.get(running) && !TERMINAL.has(this.jobs.get(running)!.status)) return this.public(this.jobs.get(running)!);
    }

    await this.authorize(plan, req);
    // An identical request may have started while this one waited for approval.
    if (!req.force) {
      const running = this.inflight.get(plan.cacheKey);
      if (running && this.jobs.get(running) && !TERMINAL.has(this.jobs.get(running)!.status)) return this.public(this.jobs.get(running)!);
    }

    const id = this.newId();
    const job: JobRecord = {
      id,
      docId: req.docId,
      skill: plan.skill.name,
      term: plan.context.term,
      runner: plan.runner,
      output: plan.skill.output,
      status: 'queued',
      progress: '',
      engineLabel: plan.engineLabel,
      recipient: plan.recipient,
      startedAt: Date.now(),
      layout: LAYOUT,
      cacheKey: plan.cacheKey,
    };
    this.jobs.set(id, job);
    fs.mkdirSync(path.join(this.jobDir(id), 'work'), { recursive: true });
    this.persist(job);
    this.inflight.set(plan.cacheKey, id);
    const ac = new AbortController();
    this.aborts.set(id, ac);
    const run = this.queueAgent(() => (plan.runner === 'direct' ? this.runAnswer(id, plan, ac.signal) : this.runAgentJob(id, plan, ac.signal)), ac.signal);
    run
      .then((outcome) => {
        if (this.closing) return;
        if (ac.signal.aborted) return this.update(id, { status: 'cancelled', finishedAt: Date.now() }, true);
        this.finish(id, plan, outcome);
      })
      .catch((err: unknown) => {
        if (this.closing) return;
        const cancelled = ac.signal.aborted || isAbort(err);
        this.update(id, { status: cancelled ? 'cancelled' : 'error', error: cancelled ? undefined : errorMessage(err), finishedAt: Date.now() }, true);
      })
      .finally(() => {
        this.aborts.delete(id);
        if (this.inflight.get(plan.cacheKey) === id) this.inflight.delete(plan.cacheKey);
      });
    return this.public(job);
  }

  /** A finished, still-valid result for the same inputs becomes a new job of this request. */
  private cacheHit(plan: JobPlan, req: JobRequest): JobState | undefined {
    const hitId = this.cache.get(plan.cacheKey);
    const hit = hitId ? this.load(hitId) : undefined;
    if (!hit || hit.status !== 'done') return undefined;
    const ownerId = hit.resultOf ?? hit.id;
    const owner = this.load(ownerId);
    if (!owner || !validateOutput(this.outputRoot(owner), owner.output).ok) {
      this.cache.delete(plan.cacheKey);
      return undefined;
    }
    const job: JobRecord = {
      id: this.newId(),
      docId: req.docId,
      skill: plan.skill.name,
      term: plan.context.term,
      runner: plan.runner,
      output: owner.output,
      status: 'done',
      progress: '',
      engineLabel: owner.engineLabel,
      recipient: owner.recipient,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      cached: true,
      resultOf: ownerId,
      costUsd: undefined,
      layout: LAYOUT,
    };
    Object.assign(job, this.saveCopy(plan, this.outputRoot(owner), owner.output));
    this.jobs.set(job.id, job);
    this.persist(job);
    return this.get(job.id);
  }

  /** A copy of a finished result in the output folder chosen for its skill, if any. Never fails the job. */
  private saveCopy(plan: JobPlan, outputRoot: string, output: JobState['output']): Pick<JobRecord, 'savedTo' | 'saveError'> {
    const settings = this.settings();
    const dir = outputDirFor(settings, plan.skill.name);
    if (!dir) return {};
    try {
      return { savedTo: exportResult({ dir, outputRoot, output, docTitle: plan.context.docTitle || 'Glossa', term: plan.context.term, skill: skillLabel(plan.skill, settings.uiLang) }) };
    } catch (err) {
      return { saveError: `Not saved to the output folder: ${(err as Error).message}` };
    }
  }

  private finish(id: string, plan: JobPlan, outcome: RunOutcome): void {
    const job = this.jobs.get(id)!;
    const output = outcome.output ?? job.output;
    const check = validateOutput(this.outputRoot(job), output);
    if (!check.ok) {
      this.update(id, { status: 'error', output, error: `The run ended without a valid result (${check.reason}).`, finishedAt: Date.now() }, true);
      return;
    }
    const complete = !outcome.partial;
    const saved = this.saveCopy(plan, this.outputRoot(job), output);
    this.update(
      id,
      {
        status: complete ? 'done' : 'partial',
        output,
        partialReason: outcome.partial,
        error: outcome.note,
        costUsd: outcome.costUsd,
        finishedAt: Date.now(),
        ...saved,
        ...(output === 'markdown' ? { text: readOutputText(this.outputRoot(job), 'markdown') } : {}),
      },
      true,
    );
    // Only complete answers produced for exactly these inputs are reused.
    if (complete && output === plan.skill.output) this.cache.set(plan.cacheKey, id);
  }

  /** The saved copy of a result, when it is still there. */
  savedCopy(id: string): string | undefined {
    const p = this.load(id)?.savedTo;
    return p && fs.existsSync(p) ? p : undefined;
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort();
  }

  cancelAll(): void {
    for (const ac of this.aborts.values()) ac.abort();
  }

  /** The app is quitting: unfinished jobs are marked interrupted (never resumed), then stopped. */
  shutdown(): void {
    this.closing = true;
    for (const id of this.aborts.keys()) {
      const job = this.jobs.get(id);
      if (job && !TERMINAL.has(job.status)) this.update(id, { status: 'error', interrupted: true, error: INTERRUPTED, finishedAt: Date.now() }, true);
    }
    this.cancelAll();
  }

  theme(): Theme {
    return this.deps.theme?.() ?? (this.settings().theme === 'dark' ? 'dark' : 'light');
  }

  isolation(): IsolationStatus {
    return (this.deps.isolation ?? detectIsolation)();
  }

  private pi(task: PiTask, timeoutMinutes: number, signal: AbortSignal, onText: (t: string) => void, onProgress: (l: string) => void) {
    if (!this.deps.piRunner) throw new Error('The built-in Pi agent is not available.');
    return this.deps.piRunner({ task, timeoutMinutes, signal, onText, onProgress });
  }

  /** The key of a connection; one that needs a key must have it (a missing key is never replaced by another). */
  private key(cfg: ProviderConfig): string | undefined {
    const key = this.deps.store.getKey(cfg.id);
    if (cfg.kind !== 'fake' && cfg.selection && !key) throw new JobRejected(`The API key for "${cfg.label}" is unavailable. Enter a key under Model connections before using it.`);
    return key;
  }

  private pictureFile(plan: JobPlan): { name: string; data: Buffer } | undefined {
    return plan.image ? { name: AREA_PICTURE, data: this.deps.store.captures.read(plan.image) } : undefined;
  }

  /** A captured area's picture for Pi. Optional when the area had text: a model that cannot read pictures gets the text alone. */
  private pictureFor(plan: JobPlan): Pick<PiTask, 'images' | 'imagesOptional'> {
    const p = this.pictureFile(plan);
    return p ? { images: [{ data: p.data.toString('base64'), mimeType: 'image/png' }], imagesOptional: !!plan.context.sentence.trim() } : {};
  }

  /** Short answer: Pi gets the passage and the skill in one prompt; its final message is the result. */
  private async runAnswer(id: string, plan: Extract<JobPlan, { runner: 'direct' }>, signal: AbortSignal): Promise<RunOutcome> {
    const settings = this.settings();
    this.update(id, { status: 'running', startedAt: Date.now(), progress: '' });
    const prompt = buildDirectPrompt({ skill: plan.skill, ctx: plan.context, explainLang: plan.explainLang, profile: settings.profile, docText: plan.docText, picture: !!plan.image });
    const workspace = path.join(this.jobDir(id), 'work');
    let lastEmit = 0;
    const r = await this.pi(
      {
        workspace,
        agentDir: path.join(this.jobDir(id), 'pi'),
        mode: 'answer',
        appendSystem: prompt.system.map((x) => x.text),
        prompt: prompt.user,
        outputFile: OUTPUT_FILES.markdown,
        model: piModelSpec(plan.provider, plan.engine.model, plan.engine.effort, plan.engine.maxTokens),
        apiKey: this.key(plan.provider),
        budgetUsd: 0,
        ...this.pictureFor(plan),
        demo: { skill: plan.skill.name, term: plan.context.term, lang: plan.explainLang, model: plan.engine.model, effort: plan.engine.effort, output: 'markdown', delayMs: demoDelay() },
      },
      ANSWER_TIMEOUT_MIN,
      signal,
      (text) => {
        const now = Date.now();
        if (now - lastEmit > 60 || !text) {
          lastEmit = now;
          this.update(id, { text });
        }
      },
      (line) => this.update(id, { progress: line }),
    );
    if (r.stop === 'aborted' || signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    if (r.stop === 'complete') {
      writeOutput(workspace, 'markdown', r.text);
      return { costUsd: r.costUsd };
    }
    if (r.stop === 'length') {
      writeOutput(workspace, 'markdown', r.text);
      return { partial: 'length', note: 'The answer was cut off at the length limit (max tokens).', costUsd: r.costUsd };
    }
    // Text that arrived before a failure is kept and shown, flagged as incomplete.
    if (r.text.trim()) {
      writeOutput(workspace, 'markdown', r.text);
      return { partial: 'interrupted', note: `Incomplete answer: ${r.error ?? 'the run stopped'}`, costUsd: r.costUsd };
    }
    throw new Error(r.error ?? 'Pi stopped without an answer.');
  }

  /** Workspace task with the built-in Pi agent: the skill is copied into the job folder; Pi writes the result file. */
  private async runPiTask(id: string, plan: Extract<JobPlan, { runner: 'agent' }>, signal: AbortSignal): Promise<RunOutcome> {
    const settings = this.settings();
    const provider = plan.provider!;
    const workspace = path.join(this.jobDir(id), 'work');
    prepareWorkspace({ workspace, skill: plan.skill, harness: plan.harness, ctx: plan.context, explainLang: plan.explainLang, profile: settings.profile, picture: this.pictureFile(plan) });
    fs.writeFileSync(path.join(workspace, 'task.md'), plan.task);
    const r = await this.pi(
      {
        workspace,
        agentDir: path.join(this.jobDir(id), 'pi'),
        mode: 'workspace',
        appendSystem: [],
        prompt: plan.task,
        skillsDir: path.join(workspace, plan.harness.skillDirs[0] ?? '.pi/skills'),
        outputFile: OUTPUT_FILES[plan.skill.output],
        model: piModelSpec(provider, plan.engine.model, plan.engine.effort, modelInfo(provider, plan.engine.model).maxOutputTokens ?? 32_000),
        apiKey: this.key(provider),
        budgetUsd: plan.engine.budgetUsd,
        ...this.pictureFor(plan),
        demo: { skill: plan.skill.name, term: plan.context.term, lang: plan.explainLang, model: plan.engine.model, effort: plan.engine.effort, output: plan.skill.output, delayMs: demoDelay() },
      },
      plan.engine.timeoutMinutes,
      signal,
      () => {},
      (line) => this.update(id, { progress: line }),
    );
    if (r.stop === 'aborted' || signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    // A result file counts even if the run ended badly afterwards (e.g. budget reached); it is still validated.
    const output = collectOutput(workspace, plan.skill.output, r.stop === 'complete' ? r.text : undefined);
    if (!output) throw new Error(`No output was produced. ${r.error ?? ''}`.trim());
    return { output, costUsd: r.costUsd };
  }

  /** Every run passes the agent gate (agent-policy.ts); short answers run with the built-in Pi agent. */
  private async authorize(plan: JobPlan, req: JobRequest): Promise<void> {
    const settings = this.settings();
    const harness = plan.runner === 'agent' ? plan.harness : (settings.harnesses.find((h) => h.kind === 'pi') ?? PI_HARNESS);
    const workspace = path.join(this.deps.store.jobsDir, '<new job>', 'work');
    let command = `${harness.label} · ${PI_TOOLS.join(' ')}`;
    if (harness.kind !== 'pi') {
      const apiKey = harness.keyFromProvider ? this.deps.store.getKey(harness.keyFromProvider) : undefined;
      const engine = plan.runner === 'agent' ? plan.engine : settings.defaults.agent;
      const argv = harnessArgv({ harness, engine, workspace, task: '<task>' }, `${workspace}/${harness.skillDirs[0] ?? '.claude/skills'}/${plan.skill.name}`);
      command = redactor(secretValues({}, [apiKey]))(argv.join(' '));
    }
    await authorizeAgentRun({
      origin: req.origin === 'user' ? 'user' : 'auto',
      settings,
      skill: plan.skill,
      skillHash: plan.skillHash,
      harness,
      request: { command, model: plan.engine.model, workspace: path.dirname(workspace), recipient: plan.recipient },
      isolation: this.isolation(),
      approve: this.deps.approveAgent ?? denyAll,
      enableAgents: async () => {
        // A declined notice is not shown again by the next automatic start, only by a click.
        if (req.origin !== 'user' && this.autoNoticeDeclined) return false;
        if (!(await (this.deps.confirmAgents ?? (async () => false))())) {
          if (req.origin !== 'user') this.autoNoticeDeclined = true;
          return false;
        }
        this.deps.store.setSettings({ agentsEnabled: true });
        return true;
      },
      remember: (skill, token) => this.deps.store.setTrust(skill, token),
    });
  }

  private queueAgent(fn: () => Promise<RunOutcome>, signal: AbortSignal): Promise<RunOutcome> {
    const limit = Math.max(1, this.settings().agentConcurrency);
    return new Promise<RunOutcome>((resolve, reject) => {
      const go = () => {
        if (signal.aborted) {
          this.agentQueue.shift()?.();
          return reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
        }
        this.agentsRunning++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.agentsRunning--;
            this.agentQueue.shift()?.();
          });
      };
      if (this.agentsRunning < limit) go();
      else {
        this.agentQueue.push(go);
        signal.addEventListener('abort', () => {
          const i = this.agentQueue.indexOf(go);
          if (i >= 0) {
            this.agentQueue.splice(i, 1);
            reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
          }
        });
      }
    });
  }

  private async runAgentJob(id: string, plan: Extract<JobPlan, { runner: 'agent' }>, signal: AbortSignal): Promise<RunOutcome> {
    const settings = this.settings();
    this.update(id, { status: 'running', startedAt: Date.now(), progress: 'Preparing workspace' });
    if (plan.harness.kind === 'pi') return this.runPiTask(id, plan, signal);
    const res = await (this.deps.agentRunner ?? runAgent)({
      workspace: path.join(this.jobDir(id), 'work'),
      skill: plan.skill,
      harness: plan.harness,
      engine: plan.engine,
      task: plan.task,
      ctx: plan.context,
      explainLang: plan.explainLang,
      profile: settings.profile,
      picture: this.pictureFile(plan),
      apiKey: plan.harness.keyFromProvider ? this.deps.store.getKey(plan.harness.keyFromProvider) : undefined,
      signal,
      onProgress: (line) => this.update(id, { progress: line }),
    });
    return { output: res.output, costUsd: res.costUsd };
  }

  /** Job ids that are still needed (running, or the result of a shared/cached job). */
  liveIds(): Set<string> {
    const ids = new Set<string>(this.aborts.keys());
    for (const j of this.jobs.values()) if (j.resultOf) ids.add(j.resultOf);
    return ids;
  }
}

interface RunOutcome {
  output?: JobState['output'];
  partial?: 'length' | 'interrupted';
  note?: string;
  costUsd?: number;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Pi reports provider errors as text; Glossa's own requests carry the status.
    const status = (err as { status?: number }).status;
    if (status === 401 || (!status && /\b401\b|unauthori[sz]ed|invalid (x-)?api[ -]key/i.test(err.message))) return 'The API key was rejected (401). Check it in Settings → Providers.';
    if (status === 429 || (!status && /\b429\b|rate[ -]limit/i.test(err.message))) return 'Rate limited by the provider (429). Try again in a moment.';
    return err.message;
  }
  return String(err);
}
