// Runs one job with the built-in Pi agent in its own process (see
// src/worker/pi-worker.mts) and relays its events. The process gets an
// allow-listed environment without any keys; the key travels in the run
// message. Cancel and timeout ask Pi to stop, then end the process.

import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FromWorker, PiRunResult, PiTask, ToWorker } from '../../worker/pi-worker.mjs';
import { buildAgentEnv, redactor, secretValues } from '../agent-env';

export type { PiModelSpec, PiRunResult, PiTask } from '../../worker/pi-worker.mjs';

export interface WorkerHandle {
  /** Known at once for Node child processes; Electron reports it on 'spawn'. */
  pid?: number;
  onSpawn?(cb: (pid: number | undefined) => void): void;
  send(m: ToWorker): void;
  onMessage(cb: (m: FromWorker) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export type SpawnWorker = (env: NodeJS.ProcessEnv) => WorkerHandle;

export interface PiRunOptions {
  task: PiTask;
  timeoutMinutes: number;
  signal: AbortSignal;
  /** The answer streamed so far (cleared when the model goes on to use tools). */
  onText: (text: string) => void;
  onProgress: (line: string) => void;
  spawn: SpawnWorker;
  /** Environment to pick allowed variables from (tests pass a synthetic one). */
  parentEnv?: NodeJS.ProcessEnv;
  /** Electron binary, offered to skills as `node` when no Node.js is installed. */
  nodeShim?: string;
}

export type PiRunner = (o: Omit<PiRunOptions, 'spawn'>) => Promise<PiRunResult>;

const STOP_GRACE_MS = 3000;

export function workerEnv(o: Pick<PiRunOptions, 'task' | 'parentEnv' | 'nodeShim'>): NodeJS.ProcessEnv {
  // Electron itself starts the worker; on Linux it may only find its libraries through LD_LIBRARY_PATH.
  const env = buildAgentEnv({ parent: o.parentEnv, tmpDir: path.join(o.task.workspace, '.tmp'), extraAllow: ['LD_LIBRARY_PATH'] });
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  env.PI_CODING_AGENT_DIR = o.task.agentDir;
  if (o.nodeShim && process.platform !== 'win32') {
    // TODO(windows): a node.cmd shim.
    const bin = path.join(o.task.workspace, '.glossa-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(o.nodeShim)} "$@"\n`, { mode: 0o755 });
    // Last, so an installed Node.js wins.
    env.PATH = [env.PATH, bin].filter(Boolean).join(path.delimiter);
  }
  return env;
}

const aborted = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

/** Worker processes started and not yet exited (for checks and diagnostics). */
const live = new Set<number>();
let started: number[] = [];
export const piWorkers = () => ({ live: [...live], started: [...started] });

export function runPi(o: PiRunOptions): Promise<PiRunResult> {
  fs.mkdirSync(path.join(o.task.workspace, '.tmp'), { recursive: true });
  fs.mkdirSync(o.task.agentDir, { recursive: true });
  const redact = redactor(secretValues({}, [o.task.apiKey]));
  const log = fs.createWriteStream(path.join(o.task.workspace, '..', 'pi.log'));
  return new Promise((resolve, reject) => {
    const w = o.spawn(workerEnv(o));
    let pid: number | undefined;
    const track = (p: number | undefined) => {
      if (!p) return;
      pid = p;
      live.add(p);
      started = [...started.slice(-19), p];
    };
    if (w.pid) track(w.pid);
    else w.onSpawn?.(track);
    w.onExit(() => pid && live.delete(pid));
    let text = '';
    let settled = false;
    let why: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (reason: string) => {
      if (why || settled) return;
      why = reason;
      w.send({ type: 'abort' });
      killTimer = setTimeout(() => w.kill(), STOP_GRACE_MS);
    };
    const onAbort = () => stop('cancelled');
    const timer = setTimeout(() => stop(`timed out after ${o.timeoutMinutes} min`), o.timeoutMinutes * 60_000);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      o.signal.removeEventListener('abort', onAbort);
      log.end();
      fn();
    };
    const stopped = () => (why === 'cancelled' ? reject(aborted()) : reject(new Error(`Pi ${why}`)));
    if (o.signal.aborted) queueMicrotask(onAbort);
    else o.signal.addEventListener('abort', onAbort);

    w.onMessage((m) => {
      if (settled) return;
      if (m.type === 'text') {
        text += m.delta;
        o.onText(text);
      } else if (m.type === 'turn') {
        text = '';
        o.onText('');
      } else if (m.type === 'progress') {
        const line = redact(m.line);
        log.write(`${line}\n`);
        o.onProgress(line);
      } else if (m.type === 'done') finish(() => (why ? stopped() : resolve({ ...m.result, error: m.result.error && redact(m.result.error) })));
      else if (m.type === 'fail') finish(() => (why ? stopped() : reject(new Error(redact(m.message)))));
    });
    w.onExit((code) => finish(() => (why ? stopped() : reject(new Error(`The Pi worker stopped unexpectedly (exit code ${code}).`)))));
    w.send({ type: 'run', task: o.task });
  });
}

/** Node child process running the worker file (tests, and anywhere without Electron). */
export function forkSpawner(workerFile: string): SpawnWorker {
  return (env) => {
    const child = fork(workerFile, [], { env, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    return {
      pid: child.pid,
      send: (m) => child.send(m),
      onMessage: (cb) => child.on('message', (m) => cb(m as FromWorker)),
      onExit: (cb) => child.on('exit', (code) => cb(code)),
      kill: () => child.kill('SIGKILL'),
    };
  };
}
