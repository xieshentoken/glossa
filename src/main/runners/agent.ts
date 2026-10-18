// Runs an agent harness CLI (Claude Code, Codex, OpenCode, custom) in a job
// workspace that contains a copy of the skill, the lookup context and an output
// folder. Authorization happens before this (agent-policy.ts); this module only
// limits what the process inherits and cleans up after it.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { contextFile } from '../../shared/prompts';
import { buildCommand } from '../../shared/template';
import type { AgentEngine, HarnessConfig, OutputKind, SkillInfo, TermContext } from '../../shared/types';
import { buildAgentEnv, redactor, secretValues } from '../agent-env';
import { copyTreeSafe, readFileSafe, resolveInside, writeFileAtomic } from '../fs-safe';
import { OUTPUT_SPECS } from '../output-contract';
import { lineParser } from './stream-parsers';

export interface AgentRunOptions {
  /** The agent's working directory (inside the job folder, separate from job metadata). */
  workspace: string;
  skill: SkillInfo;
  harness: HarnessConfig;
  engine: AgentEngine;
  task: string;
  ctx: TermContext;
  explainLang: string;
  profile?: string;
  apiKey?: string;
  signal: AbortSignal;
  onProgress: (line: string) => void;
  /** Environment to pick allowed variables from (tests pass a synthetic one). */
  parentEnv?: NodeJS.ProcessEnv;
}

export interface AgentRunResult {
  output: OutputKind;
  costUsd?: number;
}

export function harnessArgv(o: Pick<AgentRunOptions, 'harness' | 'engine' | 'workspace' | 'task'>, skillDir: string): string[] {
  return buildCommand(o.harness.command, {
    model: o.engine.model,
    effort: o.engine.effort,
    budget: o.engine.budgetUsd > 0 ? String(o.engine.budgetUsd) : '',
    workspace: o.workspace,
    skillDir,
    prompt: o.task,
  });
}

export function prepareWorkspace(o: Pick<AgentRunOptions, 'workspace' | 'skill' | 'harness' | 'ctx' | 'explainLang' | 'profile'>): string[] {
  fs.mkdirSync(path.join(o.workspace, 'output'), { recursive: true });
  fs.mkdirSync(path.join(o.workspace, '.tmp'), { recursive: true });
  const dirs: string[] = [];
  for (const rel of o.harness.skillDirs.length ? o.harness.skillDirs : ['.claude/skills']) {
    const dest = resolveInside(o.workspace, `${rel}/${o.skill.name}`);
    copyTreeSafe(o.skill.dir, dest);
    dirs.push(dest);
  }
  fs.writeFileSync(path.join(o.workspace, 'context.md'), contextFile(o.ctx, o.explainLang, o.profile));
  return dirs;
}

/** Put the agent's result at the contract path; links and oversize files are not followed or copied. */
export function collectOutput(workspace: string, kind: OutputKind, fallbackText: string | undefined): OutputKind | undefined {
  const spec = OUTPUT_SPECS[kind];
  try {
    const st = fs.lstatSync(path.join(workspace, spec.file));
    if (st.isFile() && !st.isSymbolicLink()) return kind;
    fs.rmSync(path.join(workspace, spec.file), { force: true }); // a link or folder in its place
  } catch {
    // not there; look for another file of the right type
  }
  const ext = kind === 'html' ? '.html' : '.md';
  const outDir = path.join(workspace, 'output');
  let names: string[] = [];
  try {
    names = fs.readdirSync(outDir).filter((f) => f.endsWith(ext)).sort();
  } catch {
    // no output folder
  }
  for (const name of names) {
    try {
      writeFileAtomic(path.join(workspace, spec.file), readFileSafe(workspace, `output/${name}`, { maxBytes: spec.maxBytes }));
      return kind;
    } catch {
      // refused (link, hard link, too large); try the next
    }
  }
  if (fallbackText?.trim()) {
    // The agent answered in text instead of writing the file.
    writeFileAtomic(path.join(workspace, OUTPUT_SPECS.markdown.file), fallbackText);
    return 'markdown';
  }
  return undefined;
}

function gitInit(workspace: string, env: NodeJS.ProcessEnv): void {
  const r = spawnSync('git', ['init', '-q'], { cwd: workspace, env, stdio: 'ignore', timeout: 20_000 });
  if (r.error || r.status !== 0) throw new Error('This harness needs a git repository in its job folder, but "git init" failed. Is git installed?');
}

export function runAgent(o: AgentRunOptions): Promise<AgentRunResult> {
  const skillDirs = prepareWorkspace(o);
  const promptAsArg = o.harness.command.includes('{prompt}');
  const argv = harnessArgv(o, skillDirs[0]);
  fs.writeFileSync(path.join(o.workspace, 'task.md'), o.task);

  const env = buildAgentEnv({
    parent: o.parentEnv,
    extraAllow: o.harness.envAllow,
    apiKey: o.apiKey,
    keyEnv: o.harness.keyEnv,
    tmpDir: path.join(o.workspace, '.tmp'),
  });
  const redact = redactor(secretValues(env, [o.apiKey]));
  if (o.harness.gitInit) gitInit(o.workspace, env);

  return new Promise((resolve, reject) => {
    // TODO(windows): CLIs installed as .cmd shims need resolving before spawn.
    const child = spawn(argv[0], argv.slice(1), {
      cwd: o.workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so cancel/timeout stops the agent and its children, and nothing else.
      detached: process.platform !== 'win32',
    });
    const parse = lineParser(o.harness.parser);
    const log = fs.createWriteStream(path.join(o.workspace, '..', 'harness.log'));
    const logWrite = (d: Buffer) => log.write(redact(d.toString('utf8')));
    let stderrTail = '';
    let lastProgress = '';
    let result: string | undefined;
    let costUsd: number | undefined;
    let reportedError = false;
    let killed: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const alive = () => child.exitCode === null && child.signalCode === null;

    const signalGroup = (s: NodeJS.Signals) => {
      if (!alive()) return;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, s);
        else child.kill(s);
      } catch {
        // already gone
      }
    };
    const kill = (why: string) => {
      if (killed || !alive()) return;
      killed = why;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 5000);
    };
    const onAbort = () => kill('cancelled');
    if (o.signal.aborted) queueMicrotask(onAbort);
    o.signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => kill(`timed out after ${o.engine.timeoutMinutes} min`), o.engine.timeoutMinutes * 60_000);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      o.signal.removeEventListener('abort', onAbort);
      log.end();
    };

    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      logWrite(d);
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const p = parse(line);
        if (p.result !== undefined) result = p.result;
        if (p.costUsd !== undefined) costUsd = p.costUsd;
        if (p.isError) reportedError = true;
        if (p.progress && p.progress !== lastProgress && !killed) {
          lastProgress = p.progress;
          o.onProgress(redact(p.progress));
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      logWrite(d);
      stderrTail = (stderrTail + d.toString('utf8')).slice(-2000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(new Error(err.code === 'ENOENT' ? `Harness command not found: ${argv[0]}. Install it or change the harness in Settings.` : redact(err.message)));
    });
    child.on('close', (code) => {
      cleanup();
      if (killed) return reject(new Error(killed === 'cancelled' ? 'Cancelled' : `Agent ${killed}`));
      const output = collectOutput(o.workspace, o.skill.output, reportedError ? undefined : result);
      // An output file counts even if the harness exited non-zero afterwards (e.g. budget reached);
      // the job manager still validates it before calling the job done.
      if (output) return resolve({ output, costUsd });
      const why = (reportedError && result) || stderrTail.trim() || `exit code ${code}`;
      reject(new Error(redact(`No output was produced. ${why.slice(-600)}`)));
    });

    if (promptAsArg) child.stdin.end();
    else child.stdin.end(o.task);
  });
}
