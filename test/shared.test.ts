import { describe, expect, it } from 'vitest';
import { mergeSettings } from '../src/shared/defaults';
import { hotkeyFromEvent, matchHotkey, parseHotkey } from '../src/shared/hotkey';
import { missingKeys } from '../src/shared/i18n';
import { buildAgentTask, buildDirectPrompt, contextFile, documentExcerpt, termMessage } from '../src/shared/prompts';
import { cleanTerm, growEnd, growStart, sentenceAt, shrinkEnd, shrinkStart, wordAt } from '../src/shared/segment';
import { ANATOMY_TASK, parseSkillMd, serializeSkillMd, skillFromParsed } from '../src/shared/skills';
import { buildCommand, renderTemplate, splitArgs } from '../src/shared/template';
import { cleanExtracted, guessLang } from '../src/shared/text';
import type { SkillInfo, TermContext } from '../src/shared/types';

const slice = (t: string, s: { start: number; end: number } | null) => (s ? t.slice(s.start, s.end) : null);

describe('segment', () => {
  const en = 'The heat transfer coefficient depends on the flow.';
  it('finds the word under an offset', () => {
    expect(slice(en, wordAt(en, en.indexOf('transfer') + 2, 'en'))).toBe('transfer');
  });
  it('snaps to a nearby word from whitespace or punctuation', () => {
    // A caret right after a word belongs to that word.
    expect(slice(en, wordAt(en, en.indexOf(' coefficient'), 'en'))).toBe('transfer');
    const t = 'see  (Reynolds)';
    expect(slice(t, wordAt(t, t.indexOf('('), 'en'))).toBe('Reynolds');
  });
  it('grows and shrinks by whole words', () => {
    let s = wordAt(en, en.indexOf('heat'), 'en')!;
    s = growEnd(en, s, 'en');
    s = growEnd(en, s, 'en');
    expect(slice(en, s)).toBe('heat transfer coefficient');
    expect(slice(en, shrinkEnd(en, s, 'en'))).toBe('heat transfer');
    expect(slice(en, shrinkStart(en, s, 'en'))).toBe('transfer coefficient');
    const c = wordAt(en, en.indexOf('coefficient'), 'en')!;
    expect(slice(en, growStart(en, c, 'en'))).toBe('transfer coefficient');
  });
  it('never shrinks below one word or grows across paragraphs', () => {
    const t = 'alpha\n\nbeta';
    const a = wordAt(t, 0, 'en')!;
    expect(shrinkEnd(t, a, 'en')).toEqual(a);
    expect(growEnd(t, a, 'en')).toEqual(a);
  });
  it('segments Chinese without spaces', () => {
    const zh = '对流换热系数描述了流体与固体表面之间的换热能力';
    const w = slice(zh, wordAt(zh, 0, 'zh'))!;
    expect(w.length).toBeGreaterThanOrEqual(2);
    expect(zh.startsWith(w)).toBe(true);
    const grown = slice(zh, growEnd(zh, wordAt(zh, 0, 'zh')!, 'zh'))!;
    expect(grown.length).toBeGreaterThan(w.length);
  });
  it('keeps German compounds whole', () => {
    const de = 'Der Wärmeübergangskoeffizient ist hoch.';
    expect(slice(de, wordAt(de, 8, 'de'))).toBe('Wärmeübergangskoeffizient');
  });
  it('finds the sentence', () => {
    const t = 'First one. The Reynolds number matters here. Last.';
    const s = sentenceAt(t, t.indexOf('Reynolds'), 'en');
    expect(t.slice(s.start, s.end).trim()).toBe('The Reynolds number matters here.');
  });
  it('cleans terms', () => {
    expect(cleanTerm('“coefficient,”')).toBe('coefficient');
    expect(cleanTerm("l'énergie")).toBe('énergie');
    expect(cleanTerm('(CNN)')).toBe('CNN');
    expect(cleanTerm('f(x)')).toBe('f(x)');
    expect(cleanTerm("Newton's")).toBe('Newton');
    expect(cleanTerm('《对流换热》')).toBe('对流换热');
  });
});

describe('text', () => {
  it('rejoins hyphenated line breaks and expands ligatures', () => {
    expect(cleanExtracted('Wärme-\nübergang and eﬃcient')).toBe('Wärmeübergang and efficient');
    expect(cleanExtracted('Name-\nBased')).toBe('Name-\nBased');
  });
  it('guesses languages', () => {
    expect(guessLang('对流换热系数描述了流体与固体表面之间的换热能力')).toBe('zh');
    expect(guessLang('Die Wärme ist nicht mit der Temperatur zu verwechseln und das ist wichtig.')).toBe('de');
    expect(guessLang('Le transfert de chaleur est une notion pour les ingénieurs et des étudiants.')).toBe('fr');
    expect(guessLang('The heat is transferred to the fluid and that is the point.')).toBe('en');
    expect(guessLang('ひらがなとカタカナの文章です')).toBe('ja');
  });
});

describe('template', () => {
  it('splits like a shell, without expansion', () => {
    expect(splitArgs(`a "b c" 'd e' f\\ g "x\\"y" $HOME`)).toEqual(['a', 'b c', 'd e', 'f g', 'x"y', '$HOME']);
    expect(() => splitArgs('a "b')).toThrow();
  });
  it('substitutes per argument and drops empty flags', () => {
    expect(buildCommand('run --model {model} --budget {budget} {prompt}', { model: 'm', budget: '', prompt: 'a b; rm -rf /' })).toEqual([
      'run',
      '--model',
      'm',
      'a b; rm -rf /',
    ]);
  });
  it('builds a command with quoted, multi-word arguments', () => {
    const command =
      'claude -p --output-format stream-json --model {model} --effort {effort} --max-budget-usd {budget} ' +
      '--allowedTools "Read Write Edit Glob Grep Bash(node *) Bash(npm *)"';
    const argv = buildCommand(command, { model: 'claude-opus-5-5', effort: 'medium', budget: '5' });
    expect(argv.slice(0, 2)).toEqual(['claude', '-p']);
    expect(argv).toContain('--effort');
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('5');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toMatch(/^Read Write Edit Glob Grep Bash\(node \*\)/);
    expect(argv).not.toContain('WebFetch');
  });
  it('renders {{vars}}', () => {
    expect(renderTemplate('Hi {{ name }} {{missing}}!', { name: 'A' })).toBe('Hi A !');
  });
});

describe('hotkey', () => {
  it('parses and matches by key code', () => {
    const hk = parseHotkey('Alt+Q');
    expect(matchHotkey({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: 'KeyQ' }, hk)).toBe(true);
    expect(matchHotkey({ altKey: true, ctrlKey: true, shiftKey: false, metaKey: false, code: 'KeyQ' }, hk)).toBe(false);
    expect(parseHotkey('Ctrl+Shift+F2')?.code).toBe('F2');
    expect(parseHotkey('Alt+Hyper')).toBeNull();
  });
  it('records from events, requiring a modifier', () => {
    expect(hotkeyFromEvent({ altKey: false, ctrlKey: true, shiftKey: true, metaKey: false, code: 'KeyE' })).toBe('Ctrl+Shift+E');
    expect(hotkeyFromEvent({ altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, code: 'KeyE' })).toBeNull();
  });
});

const skill = (over: Partial<SkillInfo> = {}): SkillInfo => ({
  name: 'eli5',
  description: 'd',
  dir: '/x',
  source: 'builtin',
  runner: 'direct',
  output: 'markdown',
  label: { en: 'ELI5' },
  body: 'Explain simply.',
  enabled: true,
  order: 0,
  ...over,
});
const ctx: TermContext = {
  term: 'Reynolds number',
  sentence: 'The Reynolds number compares inertial and viscous forces.',
  paragraph: 'The Reynolds number compares inertial and viscous forces. Above a critical value flow is turbulent.',
  heading: 'Flow',
  docTitle: 'Fluids',
  docSource: '/tmp/f.pdf',
  termLang: 'en',
};

describe('prompts', () => {
  it('puts the cached document before the skill and the term last', () => {
    const p = buildDirectPrompt({ skill: skill(), ctx, explainLang: 'German (de)', docText: 'FULL DOC' });
    expect(p.system).toHaveLength(3);
    expect(p.system[1].cache).toBe(true);
    expect(p.system[1].text).toContain('FULL DOC');
    expect(p.system[2].text).toContain('Explain simply.');
    expect(p.user).toContain('Term: Reynolds number');
    expect(p.user).toContain('Answer language: German (de)');
    expect(p.user).toContain('Section: Flow');
  });
  it('omits the document block when not sent', () => {
    expect(buildDirectPrompt({ skill: skill(), ctx, explainLang: 'en' }).system).toHaveLength(2);
  });
  it('keeps a window around the term in very long documents', () => {
    const doc = 'x'.repeat(5000) + ctx.sentence + 'y'.repeat(5000);
    const ex = documentExcerpt(doc, ctx.term, ctx.sentence, 2000);
    expect(ex).toContain(ctx.sentence.slice(0, 40));
    expect(ex.length).toBeLessThan(2100);
  });
  it('writes a profile line only when given', () => {
    expect(termMessage(ctx, 'en', '')).not.toContain('profile');
    expect(termMessage(ctx, 'en', 'biologist')).toContain('Reader profile: biologist');
  });
  it('builds the Anatomy task', () => {
    const task = buildAgentTask({
      skill: skill({ name: 'anatomy', runner: 'agent', output: 'html', task: ANATOMY_TASK }),
      ctx: { ...ctx, term: 'say "hi"' },
      explainLang: 'Chinese (zh)',
      theme: 'dark',
      outputFile: 'output/index.html',
    });
    expect(task).toContain(`explain the term "say 'hi'"`);
    expect(task).toContain('Size: Figure');
    expect(task).toContain('copy the final page to output/index.html');
    expect(task).toContain('Chinese (zh)');
  });
  it('marks context.md as untrusted data', () => {
    expect(contextFile(ctx, 'en')).toMatch(/untrusted document data[\s\S]*Term: Reynolds number/);
  });
});

describe('skills', () => {
  it('parses Glossa metadata and round-trips', () => {
    const md = `---\nname: my-skill\ndescription: Does things.\nglossa:\n  runner: agent\n  output: html\n  label:\n    en: Mine\n    zh: 我的\n---\n\nBody here.\n`;
    const p = parseSkillMd(md);
    expect(p.glossa).toMatchObject({ runner: 'agent', output: 'html', label: { en: 'Mine', zh: '我的' } });
    expect(parseSkillMd(serializeSkillMd(p))).toEqual(p);
  });
  it('applies the Anatomy preset to the upstream SKILL.md (no glossa key)', () => {
    const md = `---\nname: anatomy\ndescription: Build crafted isometric figures.\nlicense: MIT\nmetadata:\n  opencode/slash: "true"\n---\n\n# Anatomy\n`;
    const s = skillFromParsed(parseSkillMd(md), '/skills/anatomy', 'user', 3);
    expect(s).toMatchObject({ runner: 'agent', output: 'html', preset: 'anatomy', timeoutMinutes: 75 });
    expect(s.task).toBe(ANATOMY_TASK);
  });
  it('defaults unknown skills to direct markdown', () => {
    const s = skillFromParsed(parseSkillMd('---\nname: x\ndescription: y\n---\nz'), '/x', 'user', 0);
    expect(s).toMatchObject({ runner: 'direct', output: 'markdown', label: { en: 'x' } });
  });
  it('rejects bad names and missing frontmatter', () => {
    expect(() => parseSkillMd('---\nname: Bad Name\ndescription: y\n---\n')).toThrow(/Invalid skill name/);
    expect(() => parseSkillMd('no frontmatter')).toThrow();
  });
});

describe('settings', () => {
  it('keeps user values and adds new defaults', () => {
    const m = mergeSettings({ hotkey: 'Ctrl+E', providers: [{ id: 'x', kind: 'openai', label: 'X' }] } as never);
    expect(m.hotkey).toBe('Ctrl+E');
    expect(m.providers.map((p) => p.id)).toEqual(['x', 'anthropic', 'openai', 'ollama', 'demo']);
    expect(m.defaults.quick.model).toBe('claude-haiku-5-5');
  });
});

describe('i18n', () => {
  it('has every string in German, French and Chinese', () => {
    expect(missingKeys('de')).toEqual([]);
    expect(missingKeys('fr')).toEqual([]);
    expect(missingKeys('zh')).toEqual([]);
  });
});
