// Locating a card's term, source-code documents, saving results to a chosen
// folder, and the quick explanation that starts with a new card.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeText, DocumentService, fileKind } from '../src/main/documents';
import { exportResult, outputDirFor, safeName } from '../src/main/output-export';
import { assertOutputDirs, authorizeSettingsPatch } from '../src/main/settings-policy';
import { vSettingsPatch, vTermCards } from '../src/main/validate';
import { codeHtml } from '../src/renderer/components/CodeView';
import { defaultSettings, mergeSettings } from '../src/shared/defaults';
import { bestMatch, locatorFromContext, normalize } from '../src/shared/term-locate';
import { req, settle, setup, tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('finding a term again', () => {
  it('compares text without whitespace, soft hyphens and case', () => {
    expect(normalize('Rey\u00adnolds  Num\nber')).toBe('reynoldsnumber');
  });

  it('picks the occurrence whose surroundings match, wherever lines were broken', () => {
    const hay = normalize('The flow is laminar. Below the critical value the flow is laminar. Above it, the flow becomes turbulent.');
    const m = bestMatch(hay, { quote: 'laminar', prefix: 'Below the critical value the flow is ', suffix: '. Above it' });
    expect(m && hay.slice(m.at, m.at + m.length)).toBe('laminar');
    expect(m!.at).toBe(normalize('The flow is laminar. Below the critical value the flow is ').length);
  });

  it('among equal surroundings, takes the one nearest the saved position', () => {
    const hay = normalize('x term y. x term y. x term y.');
    const second = normalize('x term y. x ').length;
    expect(bestMatch(hay, { quote: 'term', prefix: 'x ', suffix: ' y', index: second })!.at).toBe(second);
    expect(bestMatch(hay, { quote: 'term', prefix: 'x ', suffix: ' y', index: 0 })!.at).toBe(1);
  });

  it('reports a term that is gone, and builds a locator from the sentence for older cards', () => {
    expect(bestMatch(normalize('nothing here'), { quote: 'viscosity', prefix: '', suffix: '' })).toBeNull();
    const loc = locatorFromContext('Re', { term: 'Reynolds number', sentence: 'The Reynolds number compares forces.' });
    expect(loc).toEqual({ quote: 'Reynolds number', prefix: 'The ', suffix: ' compares forces.' });
  });

  it('cards keep their locator; malformed ones are refused', () => {
    const card = {
      id: 'c1', term: 't', explainLang: 'en', rect: { x: 0, y: 0, w: 300, h: 200 }, window: 'normal', tasks: [], createdAt: 1,
      context: { term: 't', sentence: 's', paragraph: '', docTitle: 'd', docSource: 's' },
    };
    const loc = { quote: 't', prefix: 'a ', suffix: ' b', index: 12, page: 3 };
    expect(vTermCards([{ ...card, locator: loc }])[0].locator).toEqual(loc);
    expect(vTermCards([card])[0].locator).toBeUndefined();
    expect(() => vTermCards([{ ...card, locator: { ...loc, page: 0 } }])).toThrow(/page/);
    expect(() => vTermCards([{ ...card, locator: { ...loc, extra: 1 } }])).toThrow(/unexpected field extra/);
  });

  it('the locate hotkey is a setting (Alt+L by default), must parse and differ from the pick hotkey', async () => {
    expect(defaultSettings().locateHotkey).toBe('Alt+L');
    expect(vSettingsPatch({ locateHotkey: 'Ctrl+Shift+L' }).locateHotkey).toBe('Ctrl+Shift+L');
    expect(() => vSettingsPatch({ locateHotkey: 'nonsense+' })).toThrow(/hotkey/);
    const cur = defaultSettings();
    await expect(authorizeSettingsPatch(cur, { locateHotkey: 'Alt+Q' }, async () => true)).rejects.toThrow(/must all differ/);
    await expect(authorizeSettingsPatch(cur, { hotkey: 'Alt+L' }, async () => true)).rejects.toThrow(/must all differ/);
    await expect(authorizeSettingsPatch(cur, { hotkey: 'Alt+L', locateHotkey: 'Alt+K' }, async () => true)).resolves.toBeTruthy();
  });
});

describe('source code documents', () => {
  it('opens common code and data files as code, by extension or by name', () => {
    for (const f of ['a.py', 'b.json', 'c.yaml', 'd.yml', 'e.ts', 'f.toml', 'g.sh', 'h.rs', 'Dockerfile', 'Makefile', '.gitignore']) expect(fileKind(`/x/${f}`)).toBe('code');
    expect(fileKind('/x/page.html')).toBe('html');
    expect(fileKind('/x/notes.txt')).toBe('text');
    expect(fileKind('/x/a.exe')).toBeUndefined();
  });

  it('loads code exactly as written; minified JSON is indented', async () => {
    const py = path.join(dir, 'flow.py');
    fs.writeFileSync(py, '\uFEFFdef reynolds(rho, v, L, mu):\n    return rho * v * L / mu\n');
    const docs = new DocumentService();
    const info = await docs.describeFile(py);
    expect(info.kind).toBe('code');
    expect(await docs.load(info.docId)).toEqual({ kind: 'code', text: 'def reynolds(rho, v, L, mu):\n    return rho * v * L / mu\n' });
    const big = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}` })) });
    expect(codeText('/x/data.json', big).split('\n').length).toBeGreaterThan(200);
    expect(codeText('/x/data.yaml', big)).toBe(big);
    expect(codeText('/x/broken.json', `${big.slice(0, -1)}`)).toBe(big.slice(0, -1));
  });

  it('shows lines grouped into blocks at blank lines, escaped', () => {
    const html = codeHtml('a = 1\nb = "<x>"\n\n\nc = 3\n');
    expect(html.match(/class="code-block"/g)).toHaveLength(2);
    expect(html.match(/class="code-line"/g)).toHaveLength(5);
    expect(html).toContain('b = "&lt;x&gt;"\n');
    expect(html).not.toContain('<x>');
  });
});

describe('saving results to a chosen folder', () => {
  const md = (root: string, text: string) => {
    fs.mkdirSync(path.join(root, 'output'), { recursive: true });
    fs.writeFileSync(path.join(root, 'output', 'result.md'), text);
  };

  it('makes names that are valid everywhere', () => {
    expect(safeName('a/b:c*?"<>|d')).toBe('a_b_c_d');
    expect(safeName('  ..  ')).toBe('untitled');
    expect(safeName('CON')).toBe('_CON');
    expect(safeName('x'.repeat(200)).length).toBe(80);
  });

  it('copies a result per document; the same result once, a different one next to it', () => {
    const out = path.join(dir, 'out');
    const job = path.join(dir, 'job');
    md(job, 'first');
    const o = { dir: out, outputRoot: job, output: 'markdown' as const, docTitle: 'Fluids: notes', term: 'Reynolds number', skill: 'Quick' };
    const a = exportResult(o);
    expect(a).toBe(path.join(out, 'Fluids_ notes', 'Reynolds number - Quick.md'));
    expect(fs.readFileSync(a, 'utf8')).toBe('first');
    expect(exportResult(o)).toBe(a);
    md(job, 'second');
    expect(exportResult(o)).toBe(path.join(out, 'Fluids_ notes', 'Reynolds number - Quick (2).md'));
    expect(fs.readFileSync(a, 'utf8')).toBe('first');
  });

  it('an HTML result with its own files is copied as a folder', () => {
    const job = path.join(dir, 'job');
    fs.mkdirSync(path.join(job, 'output', 'img'), { recursive: true });
    fs.writeFileSync(path.join(job, 'output', 'index.html'), '<!doctype html><html><body><img src="img/a.png"></body></html>');
    fs.writeFileSync(path.join(job, 'output', 'img', 'a.png'), 'png');
    const target = exportResult({ dir: path.join(dir, 'out'), outputRoot: job, output: 'html', docTitle: 'D', term: 'pump', skill: 'Anatomy' });
    expect(fs.readFileSync(path.join(target, 'img', 'a.png'), 'utf8')).toBe('png');
    expect(fs.existsSync(path.join(target, 'index.html'))).toBe(true);
  });

  it('a skill can use its own folder or not be saved', () => {
    const s = { outputDir: '/all', skillOverrides: { a: { outputDir: '/a' }, b: { outputDir: '' }, c: {} } };
    expect(outputDirFor(s, 'a')).toBe('/a');
    expect(outputDirFor(s, 'b')).toBe('');
    expect(outputDirFor(s, 'c')).toBe('/all');
    expect(outputDirFor(s, 'd')).toBe('/all');
  });

  it('the renderer can clear a folder or send back a stored one, never set a new path', async () => {
    const cur = mergeSettings({ outputDir: '/chosen', skillOverrides: { eli5: { outputDir: '/eli5' } } });
    expect(() => assertOutputDirs(cur, vSettingsPatch({ outputDir: '/elsewhere' }))).toThrow(/Choose/);
    expect(() => assertOutputDirs(cur, vSettingsPatch({ skillOverrides: { eli5: { outputDir: '/other' } } }))).toThrow(/Choose/);
    expect(() => assertOutputDirs(cur, vSettingsPatch({ skillOverrides: { 'quick-gloss': { outputDir: '/new' } } }))).toThrow(/Choose/);
    await expect(authorizeSettingsPatch(cur, { outputDir: '/elsewhere' }, async () => true)).rejects.toThrow(/Choose/);
    expect(() => assertOutputDirs(cur, vSettingsPatch({ outputDir: '', skillOverrides: { eli5: { outputDir: '/eli5' }, 'quick-gloss': { outputDir: '' } } }))).not.toThrow();
    expect(() => vSettingsPatch({ outputDir: 'relative/path' })).toThrow(/path/);
  });

  it('finished runs (and cache hits) are copied; the job reports where', async () => {
    const out = path.join(dir, 'results');
    const h = setup(dir);
    h.store.setSettings({ outputDir: out, skillOverrides: { 'quick-gloss': { outputDir: '' } } });
    const done = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(done.status).toBe('done');
    expect(done.savedTo).toBe(path.join(out, 'D', 'Reynolds number - ELI5.md'));
    expect(fs.readFileSync(done.savedTo!, 'utf8')).toBe(done.text);
    expect(h.jobs.savedCopy(done.id)).toBe(done.savedTo);
    const hit = await h.jobs.start(req('eli5'));
    expect(hit).toMatchObject({ cached: true, savedTo: done.savedTo });
    expect(fs.readdirSync(path.join(out, 'D'))).toHaveLength(1);
    // Turned off for this skill.
    expect((await settle(h.jobs, (await h.jobs.start(req('quick-gloss'))).id)).savedTo).toBeUndefined();
  });

  it('a failed copy is reported, the result itself stays usable', async () => {
    const blocker = path.join(dir, 'file-not-folder');
    fs.writeFileSync(blocker, 'x');
    const h = setup(dir, { outputDir: blocker });
    const done = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(done.status).toBe('done');
    expect(done.savedTo).toBeUndefined();
    expect(done.saveError).toMatch(/Not saved to the output folder/);
  });
});

describe('quick explanation when a card is created', () => {
  it('is on by default for the quick skill', async () => {
    expect(defaultSettings().autoQuick).toBe(true);
    const h = setup(dir);
    const j = await settle(h.jobs, (await h.jobs.start(req('quick-gloss', { origin: 'auto' }))).id);
    expect(j.status).toBe('done');
  });

  it('only the quick skill starts by itself, and only while the setting is on', async () => {
    const h = setup(dir);
    await expect(h.jobs.start(req('eli5', { origin: 'auto' }))).rejects.toThrow(/explicit click/);
    await expect(h.jobs.start(req('fake-figure', { origin: 'auto' }))).rejects.toThrow(/explicit click/);
    h.store.setSettings({ autoQuick: false });
    await expect(h.jobs.start(req('quick-gloss', { origin: 'auto' }))).rejects.toThrow(/explicit click/);
  });

  it('never opens an approval dialog: a quick skill of your own waits for a click', async () => {
    const h = setup(dir);
    h.registry.save({ name: 'my-quick', description: 'Mine.', body: 'Explain.', glossa: { runner: 'direct', output: 'markdown' } });
    h.store.setSettings({ quickSkill: 'my-quick' });
    await expect(h.jobs.start(req('my-quick', { origin: 'auto' }))).rejects.toThrow(/needs your approval first/);
    expect(h.approvals).toHaveLength(0);
    // A click asks; once approved (per version on Pi) the automatic start runs too.
    h.store.setSettings({ defaults: { ...h.store.getSettings().defaults, agent: { ...h.store.getSettings().defaults.agent, harnessId: 'pi' } } });
    await settle(h.jobs, (await h.jobs.start(req('my-quick'))).id);
    expect(h.approvals).toHaveLength(1);
    expect((await settle(h.jobs, (await h.jobs.start(req('my-quick', { origin: 'auto', force: true }))).id)).status).toBe('done');
  });

  it('shows the one-time agent notice once; declined, later automatic starts do not ask again', async () => {
    let asked = 0;
    const h = setup(dir, { agentsEnabled: false }, { confirmAgents: async () => (asked++, false) });
    await expect(h.jobs.start(req('quick-gloss', { origin: 'auto' }))).rejects.toThrow(/agents are turned off/);
    await expect(h.jobs.start(req('quick-gloss', { origin: 'auto', force: true }))).rejects.toThrow(/agents are turned off/);
    expect(asked).toBe(1);
    // A click still asks.
    await expect(h.jobs.start(req('quick-gloss'))).rejects.toThrow(/agents are turned off/);
    expect(asked).toBe(2);
  });
});
