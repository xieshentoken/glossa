// P0-5: one main-process gate for every agent entry point; minimal environment;
// honest isolation status; cancel stops only the job's own process group.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentEnv, redactor, secretValues } from '../src/main/agent-env';
import { dangerousFlag } from '../src/main/agent-policy';
import { detectIsolation } from '../src/main/isolation';
import { vJobRequest } from '../src/main/validate';
import { defaultSettings, mergeSettings } from '../src/shared/defaults';
import { fakeAgentCommand, req, settle, setup, tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of ['FAKE_AGENT_MODE', 'FAKE_AGENT_DUMP_ENV', 'GLOSSA_SYNTHETIC_SECRET', 'GLOSSA_SYNTHETIC_OTHER']) delete process.env[k];
});

const spyRunner = () => {
  const calls: unknown[] = [];
  return { calls, agentRunner: async (o: unknown) => (calls.push(o), { output: 'html' as const }) };
};

describe('authorization gate', () => {
  it('an automatic start never runs an agent (and does not even ask)', async () => {
    const r = spyRunner();
    const h = setup(dir, {}, { agentRunner: r.agentRunner });
    await expect(h.jobs.start(req('fake-figure', { origin: 'auto' }))).rejects.toThrow(/explicit click/);
    expect(r.calls).toHaveLength(0);
    expect(h.approvals).toHaveLength(0);
  });

  it('an IPC request without an origin is treated as automatic', async () => {
    const raw = { ...req('fake-figure') } as Record<string, unknown>;
    delete raw.origin;
    expect(vJobRequest(raw).origin).toBe('auto');
  });

  it('agent skills off → refused before anything starts', async () => {
    const r = spyRunner();
    const h = setup(dir, { agentsEnabled: false }, { agentRunner: r.agentRunner });
    await expect(h.jobs.start(req('fake-figure'))).rejects.toThrow(/turned off/);
    expect(r.calls).toHaveLength(0);
  });

  it('declined approval → refused; re-runs and forced runs pass the same gate', async () => {
    const r = spyRunner();
    const h = setup(dir, {}, { agentRunner: r.agentRunner });
    h.approve.decision = { approved: false, remember: false };
    await expect(h.jobs.start(req('fake-figure'))).rejects.toThrow(/not approved/);
    await expect(h.jobs.start(req('fake-figure', { force: true }))).rejects.toThrow(/not approved/);
    expect(r.calls).toHaveLength(0);
    expect(h.approvals[0]).toMatchObject({ skill: 'fake-figure', skillSource: 'user', isolation: { isolated: false } });
    expect(h.approvals[0].command).toContain('fake-agent.mjs');
  });

  it('the default approver (no dialog wired) refuses', async () => {
    const r = spyRunner();
    const h = setup(dir, {}, { agentRunner: r.agentRunner, approveAgent: undefined });
    await expect(h.jobs.start(req('fake-figure'))).rejects.toThrow(/not approved/);
  });

  it('"remember" covers this skill content and harness only', async () => {
    const r = spyRunner();
    const h = setup(dir, {}, { agentRunner: r.agentRunner });
    h.approve.decision = { approved: true, remember: true };
    await h.jobs.start(req('fake-figure'));
    h.approve.decision = { approved: false, remember: false };
    await h.jobs.start(req('fake-figure', { force: true }));
    expect(h.approvals).toHaveLength(1);
    // Skill content changes → asked again.
    fs.appendFileSync(path.join(h.store.skillsDir, 'fake-figure', 'SKILL.md'), '\nmore\n');
    await expect(h.jobs.start(req('fake-figure', { force: true }))).rejects.toThrow(/not approved/);
    expect(h.approvals).toHaveLength(2);
  });

  it('refuses harness commands that switch off the agent’s own checks', async () => {
    for (const cmd of ['claude -p --dangerously-skip-permissions', 'claude -p --permission-mode bypassPermissions', 'codex exec --dangerously-bypass-approvals-and-sandbox', 'codex exec --yolo']) {
      expect(dangerousFlag({ id: 'x', label: 'x', command: cmd, parser: 'plain', skillDirs: [] })).toBeDefined();
    }
    const h = setup(dir, { harnesses: [{ id: 'fake', label: 'F', command: fakeAgentCommand(' --dangerously-skip-permissions'), parser: 'plain', skillDirs: ['.claude/skills'] }] });
    await expect(h.jobs.start(req('fake-figure'))).rejects.toThrow(/safety checks/);
    expect(h.approvals).toHaveLength(0);
  });

  it('with "require isolation" on, runs are refused because none is available', async () => {
    const h = setup(dir, { requireIsolation: true });
    await expect(h.jobs.start(req('fake-figure'))).rejects.toThrow(/require OS isolation/);
  });

  it('reports isolation honestly', () => {
    const s = detectIsolation('linux', '/nonexistent');
    expect(s).toMatchObject({ isolated: false, mode: 'none', toolsFound: [] });
    expect(s.detail).toMatch(/No OS-level isolation/);
  });
});

describe('built-in Pi agent', () => {
  const onPi = { defaults: { quick: { providerId: 'demo', model: 'fake', effort: 'low' as const, maxTokens: 1000 }, direct: { providerId: 'demo', model: 'fake', effort: 'high' as const, maxTokens: 1000 }, agent: { harnessId: 'pi', providerId: 'demo', model: '', effort: 'default' as const, budgetUsd: 0, timeoutMinutes: 1 } } };

  it('runs built-in skills without an approval dialog, and never automatically', async () => {
    const h = setup(dir);
    expect((await settle(h.jobs, (await h.jobs.start(req('eli5'))).id)).status).toBe('done');
    expect(h.approvals).toHaveLength(0);
    await expect(h.jobs.start(req('eli5', { origin: 'auto', force: true }))).rejects.toThrow(/explicit click/);
  });

  it('shows the one-time notice on the first run; accepting turns agents on, declining refuses', async () => {
    const no = setup(dir, { agentsEnabled: false }, { confirmAgents: async () => false });
    await expect(no.jobs.start(req('eli5'))).rejects.toThrow(/agents are turned off/);
    expect(no.store.getSettings().agentsEnabled).toBe(false);
    let asked = 0;
    const yes = setup(tmpDir(), { agentsEnabled: false }, { confirmAgents: async () => (asked++, true) });
    expect((await settle(yes.jobs, (await yes.jobs.start(req('eli5'))).id)).status).toBe('done');
    await yes.jobs.start(req('quick-gloss'));
    expect(asked).toBe(1);
    expect(yes.store.getSettings().agentsEnabled).toBe(true);
  });

  it('asks once per version for a skill the user added', async () => {
    let ran = 0;
    const h = setup(dir, onPi, { piRunner: async () => (ran++, { text: '', stop: 'error', error: 'stub' }) });
    h.approve.decision = { approved: true, remember: false };
    await settle(h.jobs, (await h.jobs.start(req('fake-figure'))).id);
    await settle(h.jobs, (await h.jobs.start(req('fake-figure', { force: true }))).id);
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ harness: 'Pi (built in)', command: 'Pi (built in) · read write edit bash ls grep find', recipient: 'offline demo (nothing is sent) · fake · paragraph' });
    fs.appendFileSync(path.join(h.store.skillsDir, 'fake-figure', 'SKILL.md'), '\nmore\n');
    h.approve.decision = { approved: false, remember: false };
    await expect(h.jobs.start(req('fake-figure', { force: true }))).rejects.toThrow(/not approved/);
    expect(h.approvals).toHaveLength(2);
    expect(ran).toBe(2);
  });
});

describe('environment', () => {
  it('passes only allow-listed variables, a private TMPDIR, and the chosen key — redacted in the log', async () => {
    process.env.GLOSSA_SYNTHETIC_SECRET = 'synthetic-should-not-leak';
    process.env.GLOSSA_SYNTHETIC_OTHER = 'x';
    process.env.FAKE_AGENT_DUMP_ENV = '1';
    const h = setup(dir);
    h.store.setSettings({ harnesses: [{ ...h.store.getSettings().harnesses[0], keyFromProvider: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY' }] });
    h.store.setKey('anthropic', 'sk-synthetic-test-only-00000000000000000000');
    const j = await settle(h.jobs, (await h.jobs.start(req('fake-figure'))).id);
    expect(j.status).toBe('done');
    const work = path.join(h.jobs.jobDir(j.id), 'work');
    const env = JSON.parse(fs.readFileSync(path.join(work, 'env.json'), 'utf8'));
    expect(env.GLOSSA_SYNTHETIC_SECRET).toBeUndefined();
    expect(env.GLOSSA_SYNTHETIC_OTHER).toBeUndefined();
    expect(env.PATH).toBeDefined();
    expect(env.TMPDIR).toBe(path.join(work, '.tmp'));
    expect(env.ANTHROPIC_API_KEY).toBe('sk-synthetic-test-only-00000000000000000000');
    const log = fs.readFileSync(path.join(h.jobs.jobDir(j.id), 'harness.log'), 'utf8');
    expect(log).toContain('using key [redacted]');
    expect(log).not.toContain('sk-synthetic-test-only-00000000000000000000');
  });

  it('builds the allow-list per platform and redacts proxy credentials', () => {
    const env = buildAgentEnv({ parent: { PATH: '/bin', SECRET_THING: 'x', HTTPS_PROXY: 'http://u:pa55word@proxy:8080', LC_ALL: 'C', SystemRoot: 'C:\\W' }, tmpDir: '/t', platform: 'win32' });
    expect(Object.keys(env).sort()).toEqual(['HTTPS_PROXY', 'LC_ALL', 'NO_COLOR', 'PATH', 'SystemRoot', 'TEMP', 'TERM', 'TMP', 'TMPDIR']);
    expect(redactor(secretValues(env))('via http://u:pa55word@proxy')).toBe('via http://[redacted]@proxy');
    expect(Object.keys(buildAgentEnv({ parent: { SystemRoot: 'x' }, tmpDir: '/t', platform: 'linux' }))).not.toContain('SystemRoot');
  });
});

describe('cancel', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  it('stops the agent and its children, and frees the queue', async () => {
    process.env.FAKE_AGENT_MODE = 'hang';
    const h = setup(dir);
    const j = await h.jobs.start(req('fake-figure'));
    const pidsFile = path.join(h.jobs.jobDir(j.id), 'work', 'pids.json');
    for (let i = 0; i < 200 && !fs.existsSync(pidsFile); i++) await new Promise((r) => setTimeout(r, 20));
    const pids: number[] = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
    expect(pids.every(alive)).toBe(true);
    h.jobs.cancel(j.id);
    expect((await settle(h.jobs, j.id)).status).toBe('cancelled');
    for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
    expect(pids.some(alive)).toBe(false);
    expect(alive(process.pid)).toBe(true);
    delete process.env.FAKE_AGENT_MODE;
    const next = await h.jobs.start(req('fake-figure', { force: true }));
    expect((await settle(h.jobs, next.id)).status).toBe('done');
  });
});

describe('one engine for every skill', () => {
  it('built-in Anatomy runs on the built-in Pi agent with the skill-answer connection, whatever the old agent settings say', async () => {
    const seen: { model: unknown; label?: string }[] = [];
    let cli = 0;
    const h = setup(dir, {}, {
      agentRunner: async () => (cli++, { output: 'html' as const }),
      piRunner: async (o) => (seen.push({ model: o.task.model }), { text: '', stop: 'error', error: 'stub' }),
    });
    // Leftovers of the Claude Code era: a CLI as the agent default and a Claude model for it.
    h.store.setSettings({ defaults: { ...h.store.getSettings().defaults, agent: { harnessId: 'fake', model: 'claude-opus-5-5', effort: 'max', budgetUsd: 2, timeoutMinutes: 5 } } });
    const j = await settle(h.jobs, (await h.jobs.start(req('anatomy'))).id);
    expect(cli).toBe(0);
    expect(j.engineLabel).toBe('Pi · Offline demo (no AI) · fake · high');
    expect(seen[0].model).toMatchObject({ demo: true, id: 'fake' });
    expect(h.approvals).toHaveLength(0); // built in: no dialog
  });

  it('v4 → v5: the separate workspace engine is cleared; limits stay', () => {
    const m = mergeSettings({ settingsVersion: 4, defaults: { ...defaultSettings().defaults, agent: { harnessId: 'codex', providerId: 'x', model: 'claude-opus-5-5', effort: 'max', budgetUsd: 3, timeoutMinutes: 30 } } });
    expect(m.defaults.agent).toEqual({ harnessId: 'pi', providerId: '', model: '', effort: 'default', budgetUsd: 3, timeoutMinutes: 30 });
    expect(m.settingsVersion).toBe(5);
  });
});
