import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentApprovalRequest, AgentApprover } from '../src/main/agent-policy';
import { JobManager, type JobDeps } from '../src/main/jobs';
import { FakeProvider } from '../src/main/providers/fake';
import { isAbort, StreamError, type Provider, type StreamRequest } from '../src/main/providers';
import type { PiRunner } from '../src/main/runners/pi';
import { SkillRegistry } from '../src/main/skills';
import type { KeyBackend } from '../src/main/secrets';
import { Store } from '../src/main/store';
import type { JobRequest, JobState, Settings } from '../src/shared/types';

export const ROOT = path.resolve(__dirname, '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');

export const box: KeyBackend = {
  protection: () => ({ ok: true }),
  encrypt: (s) => Buffer.from(s).toString('base64').split('').reverse().join(''),
  decrypt: (s) => Buffer.from(s.split('').reverse().join(''), 'base64').toString(),
};

export function tmpDir(prefix = 'glossa-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Harness {
  store: Store;
  registry: SkillRegistry;
  jobs: JobManager;
  events: JobState[];
  requests: StreamRequest[];
  approvals: AgentApprovalRequest[];
  approve: { decision: { approved: boolean; remember: boolean } };
}

export function fakeAgentCommand(extra = ''): string {
  return `node ${JSON.stringify(path.join(FIXTURES, 'fake-agent.mjs'))} --model {model} --max-budget-usd {budget}${extra}`;
}

/**
 * Stand-in for the built-in Pi agent in short-answer mode: the prompt Pi would get
 * goes to a recording fake provider, and its outcome is reported the way the Pi
 * worker reports it. The real worker is tested in pi-worker.test.ts.
 */
export function fakePiRunner(stream: (r: StreamRequest) => ReturnType<Provider['stream']>): PiRunner {
  return async (o) => {
    let text = '';
    try {
      const r = await stream({
        system: o.task.appendSystem.map((t) => ({ text: t })),
        user: o.task.prompt,
        model: o.task.demo?.model ?? o.task.model.id,
        effort: (o.task.demo?.effort ?? 'default') as StreamRequest['effort'],
        maxTokens: o.task.model.maxTokens,
        signal: o.signal,
        onText: (d) => {
          text += d;
          o.onText(text);
        },
      });
      return { text: r.text || text, stop: r.finish === 'length' ? 'length' : 'complete' };
    } catch (err) {
      if (isAbort(err, o.signal)) return { text, stop: 'aborted' };
      const partial = err instanceof StreamError && err.kind !== 'refusal' ? err.partialText || text : '';
      return { text: partial, stop: 'error', error: (err as Error).message };
    }
  };
}

/** Store + registry + job manager over a temp folder, with a recording fake provider behind the Pi stand-in. */
export function setup(
  dir: string,
  settings: Partial<Settings> = {},
  over: Partial<JobDeps> & { provider?: (r: StreamRequest) => ReturnType<Provider['stream']>; docText?: (id: string) => string | undefined } = {},
): Harness {
  const store = new Store(dir, box);
  store.setSettings({
    agentConcurrency: 1,
    agentsEnabled: true,
    defaults: {
      quick: { providerId: 'demo', model: 'fake', effort: 'low', maxTokens: 1000 },
      direct: { providerId: 'demo', model: 'fake', effort: 'high', maxTokens: 1000 },
      agent: { harnessId: 'fake', model: 'm1', effort: 'low', budgetUsd: 0, timeoutMinutes: 1 },
    },
    harnesses: [{ id: 'fake', label: 'Fake', command: fakeAgentCommand(), parser: 'claude-stream-json', skillDirs: ['.claude/skills'], envAllow: ['FAKE_AGENT_MODE', 'FAKE_AGENT_DUMP_ENV'] }],
    ...settings,
  });
  const registry = new SkillRegistry(path.join(ROOT, 'builtin-skills'), store.skillsDir);
  if (!fs.existsSync(path.join(store.skillsDir, 'fake-figure'))) registry.importFolder(path.join(FIXTURES, 'skills', 'fake-figure'));
  const events: JobState[] = [];
  const requests: StreamRequest[] = [];
  const approvals: AgentApprovalRequest[] = [];
  const approve = { decision: { approved: true, remember: false } };
  const approver: AgentApprover = async (r) => {
    approvals.push(r);
    return approve.decision;
  };
  const { provider, docText, ...rest } = over;
  const jobs = new JobManager({
    store,
    skills: () => registry.list(store.getSettings()),
    skillHash: (s) => registry.contentHash(s),
    docText: docText ?? (() => 'DOCUMENT TEXT'),
    emit: (s) => events.push(s),
    piRunner: fakePiRunner((r) => {
      requests.push(r);
      return provider ? provider(r) : new FakeProvider(1).stream(r);
    }),
    approveAgent: approver,
    ...rest,
  });
  return { store, registry, jobs, events, requests, approvals, approve };
}

export const req = (skill: string, over: Partial<JobRequest> = {}): JobRequest => ({
  docId: 'b'.repeat(64),
  skill,
  explainLang: 'fr',
  origin: 'user',
  context: { term: 'Reynolds number', sentence: 'The Reynolds number matters.', paragraph: 'The Reynolds number matters. It compares forces.', docTitle: 'D', docSource: '/d.pdf' },
  ...over,
});

export async function settle(jobs: JobManager, id: string, ms = 10000): Promise<JobState> {
  const end = Date.now() + ms;
  for (;;) {
    const j = jobs.get(id)!;
    if (!['running', 'queued'].includes(j.status)) return j;
    if (Date.now() > end) throw new Error('job did not finish');
    await new Promise((r) => setTimeout(r, 15));
  }
}
