// P0-4: what leaves the computer, enforced in the main process.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorizeSettingsPatch, GrantDeclined } from '../src/main/settings-policy';
import { InvalidArgument, vSettingsPatch } from '../src/main/validate';
import { applyScope, directRecipient } from '../src/shared/data-scope';
import { defaultSettings, mergeSettings, SETTINGS_VERSION } from '../src/shared/defaults';
import { req, settle, setup, tmpDir } from './helpers';

const DOC = 'SECRET-DOCUMENT-BODY lorem ipsum';
let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sent = (h: ReturnType<typeof setup>) => JSON.stringify(h.requests.map((r) => [r.system, r.user]));

describe('defaults and migration', () => {
  it('new installs send only the paragraph and run skills with the built-in Pi agent', () => {
    const s = defaultSettings();
    expect(s).toMatchObject({ dataScope: 'paragraph', agentsEnabled: false, settingsVersion: SETTINGS_VERSION });
    expect(s.defaults.agent).toMatchObject({ harnessId: 'pi', model: '', effort: 'default' });
    expect(s.harnesses.map((h) => h.id)).toEqual(['pi', 'codex', 'opencode']);
  });
  it('a stored legacy sendFullDocument (default true) is not treated as consent', () => {
    const m = mergeSettings({ sendFullDocument: true, hotkey: 'Ctrl+E' } as never);
    expect(m).toMatchObject({ dataScope: 'paragraph', hotkey: 'Ctrl+E', settingsVersion: SETTINGS_VERSION });
    expect(m).not.toHaveProperty('sendFullDocument');
  });
  it('an explicit legacy agent risk acceptance is kept, approvals are not', () => {
    expect(mergeSettings({ agentWarningAccepted: true } as never)).toMatchObject({ agentsEnabled: true, agentTrust: {} });
    expect(mergeSettings({} as never).agentsEnabled).toBe(false);
  });
  it('current-version settings keep a granted document scope', () => {
    expect(mergeSettings({ settingsVersion: 2, dataScope: 'document' }).dataScope).toBe('document');
  });
  it('v3 → v4: Claude Code moves to the built-in Pi agent; other CLIs, grants and connections stay', () => {
    const codex = { id: 'codex', label: 'Codex CLI', command: 'codex exec -', parser: 'plain' as const, skillDirs: ['.agents/skills'] };
    const claude = { id: 'claude-code', label: 'Claude Code CLI', command: 'claude -p', parser: 'claude-stream-json' as const, skillDirs: ['.claude/skills'] };
    const m = mergeSettings({
      settingsVersion: 3,
      dataScope: 'document',
      agentsEnabled: true,
      agentTrust: { anatomy: 'old-token' },
      autoQuickGloss: true,
      prewarmDocuments: true,
      harnesses: [claude, codex],
      defaults: { ...defaultSettings().defaults, agent: { harnessId: 'claude-code', model: 'claude-opus-5-5', effort: 'high', budgetUsd: 3, timeoutMinutes: 30 } },
      skillOverrides: { anatomy: { agent: { harnessId: 'claude-code', model: 'x' } }, other: { agent: { harnessId: 'codex', model: 'gpt' } } },
    } as never);
    expect(m.harnesses.map((h) => h.id)).toEqual(['codex', 'pi', 'opencode']);
    expect(m.defaults.agent).toEqual({ harnessId: 'pi', model: '', effort: 'default', budgetUsd: 3, timeoutMinutes: 30, providerId: '' });
    expect(m.skillOverrides.anatomy.agent).toEqual({ harnessId: 'pi', model: '', effort: 'default' });
    expect(m.skillOverrides.other.agent).toEqual({ harnessId: 'codex', model: 'gpt' });
    expect(m).toMatchObject({ dataScope: 'document', agentsEnabled: true, agentTrust: {} });
    expect(m).not.toHaveProperty('autoQuickGloss');
    expect(m).not.toHaveProperty('prewarmDocuments');
  });
});

describe('payloads', () => {
  it('by default the document text is not sent, only the passage', async () => {
    const h = setup(dir, { dataScope: 'paragraph' }, { docText: () => DOC });
    await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(sent(h)).not.toContain('SECRET-DOCUMENT-BODY');
    expect(sent(h)).toContain('It compares forces.');
  });
  it("'sentence' drops the paragraph too", async () => {
    const h = setup(dir, { dataScope: 'sentence' }, { docText: () => DOC });
    await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(sent(h)).not.toContain('It compares forces.');
    expect(sent(h)).toContain('The Reynolds number matters.');
  });
  it("'document' sends the text; revoking stops it for the next request", async () => {
    const h = setup(dir, { dataScope: 'document' }, { docText: () => DOC });
    await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(sent(h)).toContain('SECRET-DOCUMENT-BODY');
    h.store.setSettings({ dataScope: 'paragraph' });
    h.requests.length = 0;
    await settle(h.jobs, (await h.jobs.start(req('eli5', { force: true }))).id);
    expect(sent(h)).not.toContain('SECRET-DOCUMENT-BODY');
  });
  it('the main process trims oversized context whatever the renderer sends', () => {
    const c = applyScope({ term: 't', sentence: 'x'.repeat(9000), paragraph: 'y'.repeat(9000), docTitle: 'd', docSource: 's' }, 'paragraph');
    expect(c.sentence.length).toBeLessThanOrEqual(1200);
    expect(c.paragraph.length).toBeLessThanOrEqual(2400);
  });
  it('agents never get the whole document, even with the document scope', async () => {
    const h = setup(dir, { dataScope: 'document' }, { docText: () => DOC });
    const j = await settle(h.jobs, (await h.jobs.start(req('fake-figure'))).id);
    const work = path.join(h.jobs.jobDir(j.id), 'work');
    const all = fs.readFileSync(path.join(work, 'context.md'), 'utf8') + fs.readFileSync(path.join(work, 'task.md'), 'utf8');
    expect(all).not.toContain('SECRET-DOCUMENT-BODY');
  });
  it('names the recipient endpoint, model and scope (local endpoints too)', () => {
    expect(directRecipient({ id: 'o', kind: 'openai', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' }, 'qwen3', 'paragraph')).toBe('localhost:11434 · qwen3 · paragraph');
    expect(directRecipient({ id: 'a', kind: 'anthropic', label: 'A' }, 'claude-haiku-5-5', 'document')).toBe('api.anthropic.com · claude-haiku-5-5 · document');
  });
});

describe('granting in the main process', () => {
  const s = defaultSettings();
  it('widening asks; declining throws; narrowing does not ask', async () => {
    const asked: string[] = [];
    const yes = async (g: string) => (asked.push(g), true);
    expect(await authorizeSettingsPatch(s, { dataScope: 'document', agentsEnabled: true }, yes)).toMatchObject({ dataScope: 'document', agentsEnabled: true });
    expect(asked).toEqual(['document', 'agents']);
    await expect(authorizeSettingsPatch(s, { agentsEnabled: true }, async () => false)).rejects.toBeInstanceOf(GrantDeclined);
    const no = async () => {
      throw new Error('should not ask');
    };
    expect(await authorizeSettingsPatch({ ...s, dataScope: 'document' }, { dataScope: 'sentence' }, no)).toEqual({ dataScope: 'sentence' });
    expect(await authorizeSettingsPatch({ ...s, agentsEnabled: true, agentTrust: { x: 'y' } }, { agentsEnabled: false }, no)).toMatchObject({ agentTrust: {} });
  });
  it('the renderer cannot write approvals or unknown keys', () => {
    expect(() => vSettingsPatch({ agentTrust: { anatomy: 'x' } })).toThrow(InvalidArgument);
    expect(() => vSettingsPatch({ settingsVersion: 1 })).toThrow(InvalidArgument);
    expect(() => vSettingsPatch({ dataScope: 'everything' })).toThrow(InvalidArgument);
    expect(vSettingsPatch({ dataScope: 'sentence' })).toEqual({ dataScope: 'sentence' });
  });
});

describe('settings round trip through the IPC validator', () => {
  it('accepts every renderer-editable field of real settings unchanged', () => {
    const { agentTrust: _t, settingsVersion: _v, ...editable } = mergeSettings({ settingsVersion: 2, dataScope: 'sentence', skillOverrides: { eli5: { enabled: false, order: 3, direct: { model: 'm', effort: 'low' } } } });
    const back = vSettingsPatch(JSON.parse(JSON.stringify(editable)));
    expect(JSON.parse(JSON.stringify(back))).toEqual(JSON.parse(JSON.stringify(editable)));
  });
});
