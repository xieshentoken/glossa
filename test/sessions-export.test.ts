// Claude Code and Codex sessions as documents, and exporting a card's result as HTML.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentService } from '../src/main/documents';
import { exportHtml, inlineKatexCss } from '../src/main/output-export';
import { findSessionFile, parseSession, sessionDirs, sessionPage, sessionRef, sniffSession } from '../src/main/sessions';
import { ROOT, tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SID = '0fe14a24-16e5-4ef5-aaef-9e1a3b5ccfbf';
const lines = (...xs: object[]) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';

const CLAUDE = lines(
  { type: 'file-history-snapshot', messageId: 'm0', snapshot: {} },
  { type: 'user', sessionId: SID, cwd: '/work/app', timestamp: '2026-10-18T08:00:00Z', message: { role: 'user', content: 'Why does the <b>build</b> fail?\n<system-reminder>internal note</system-reminder>' } },
  { type: 'user', sessionId: SID, isMeta: true, message: { role: 'user', content: 'Caveat: meta line' } },
  { type: 'assistant', sessionId: SID, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thoughts' }] } },
  { type: 'assistant', sessionId: SID, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Let me look at the **log**.' }] } },
  { type: 'assistant', sessionId: SID, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run build', description: 'Build' } }] } },
  { type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'error TS2304 <script>alert(1)</script>', is_error: true }] } },
  { type: 'assistant', sessionId: SID, isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
  { type: 'assistant', sessionId: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'A type is missing.' }] } },
);

const CODEX = lines(
  { timestamp: '2026-10-18T09:00:00Z', type: 'session_meta', payload: { id: SID, timestamp: '2026-10-18T09:00:00Z', cwd: '/work/cli', originator: 'codex_cli_rs' } },
  { timestamp: '2026-10-18T09:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/work/cli</cwd>\n</environment_context>' }] } },
  { timestamp: '2026-10-18T09:00:01Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer rules' }] } },
  { timestamp: '2026-10-18T09:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files' }] } },
  { timestamp: '2026-10-18T09:00:02Z', type: 'turn_context', payload: { cwd: '/work/cli', model: 'gpt-5.5-codex' } },
  { timestamp: '2026-10-18T09:00:03Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] } },
  { timestamp: '2026-10-18T09:00:03Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'], workdir: '/work/cli' }), call_id: 'c1' } },
  { timestamp: '2026-10-18T09:00:04Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'a.txt\nb.txt\n', metadata: { exit_code: 0 } }) } },
  { timestamp: '2026-10-18T09:00:05Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Two files.' } },
  { timestamp: '2026-10-18T09:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'There are two files.' }] } },
);

describe('agent sessions', () => {
  it('tells Claude Code, Codex (current and early format) and other JSON Lines apart', () => {
    expect(sniffSession(CLAUDE)).toBe('claude-code');
    expect(sniffSession(CODEX)).toBe('codex');
    expect(sniffSession(lines({ id: SID, timestamp: '2025-04-01', instructions: '' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }))).toBe('codex');
    expect(sniffSession(lines({ a: 1 }, { b: 2 }))).toBeUndefined();
    // A cut-off last line does not matter.
    expect(sniffSession(CLAUDE.slice(0, CLAUDE.length - 30))).toBe('claude-code');
  });

  it('reads a Claude Code session: prompts and answers, tool calls with results, no reminders, thinking, meta or subagent lines', () => {
    const t = parseSession(CLAUDE, 'claude-code');
    expect(t.title).toBe('Why does the <b>build</b> fail?');
    expect(t.cwd).toBe('/work/app');
    expect(t.model).toBe('claude-opus-5-5');
    const msgs = t.items.filter((x) => x.kind === 'message').map((x) => x.kind === 'message' && `${x.role}: ${x.text}`);
    expect(msgs).toEqual(['user: Why does the <b>build</b> fail?', 'assistant: Let me look at the **log**.', 'assistant: A type is missing.']);
    const tool = t.items.find((x) => x.kind === 'tool');
    expect(tool).toMatchObject({ name: 'Bash', brief: 'npm run build', error: true });
    expect(tool?.kind === 'tool' && tool.output).toContain('TS2304');
    expect(JSON.stringify(t)).not.toMatch(/internal note|secret thoughts|subagent chatter|Caveat/);
  });

  it('reads a Codex session: injected context and developer messages left out, shell output unwrapped', () => {
    const t = parseSession(CODEX, 'codex');
    expect(t.title).toBe('List the files');
    expect(t.model).toBe('gpt-5.5-codex');
    expect(t.cwd).toBe('/work/cli');
    const msgs = t.items.filter((x) => x.kind === 'message').map((x) => x.kind === 'message' && x.text);
    // The answer once (from the response item, not again from the event).
    expect(msgs).toEqual(['List the files', 'There are two files.']);
    expect(t.items.find((x) => x.kind === 'tool')).toMatchObject({ name: 'shell', brief: 'ls -la', output: 'a.txt\nb.txt\n' });
  });

  it('shows turns as sections and folds tool calls; tool text is escaped and long output cut', async () => {
    const t = parseSession(CLAUDE, 'claude-code');
    const big = parseSession(
      lines(
        { type: 'assistant', sessionId: SID, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/a' } }] } },
        { type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'y'.repeat(10_000) }] }] } },
      ),
      'claude-code',
    );
    const page = await sessionPage(t);
    expect(page.html).toContain('<title>Claude Code: Why does the &lt;b&gt;build&lt;/b&gt; fail?</title>');
    expect(page.html.match(/<section>/g)).toHaveLength(2);
    expect(page.html).toContain('<h2>You</h2>');
    expect(page.html).toContain('<h2>Claude</h2>');
    expect(page.html).toContain('<summary>Bash · <code>npm run build</code> · <strong>error</strong></summary>');
    expect(page.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.html).not.toContain('<script>');
    // What skills see: the conversation, not the tools.
    expect(page.text).toContain('You: Why does the');
    expect(page.text).toContain('Claude: A type is missing.');
    expect(page.text).not.toContain('npm run build');
    expect((await sessionPage(big)).html).toContain('… (6000 more characters)');
  });

  it('understands resume commands and bare session ids typed in the address bar', () => {
    expect(sessionRef(`claude --resume ${SID}`)).toEqual({ agent: 'claude-code', id: SID });
    expect(sessionRef(`claude -r "${SID.toUpperCase()}"`)).toEqual({ agent: 'claude-code', id: SID });
    expect(sessionRef(`claude --model opus --resume=${SID}`)).toEqual({ agent: 'claude-code', id: SID });
    expect(sessionRef(`codex resume ${SID}`)).toEqual({ agent: 'codex', id: SID });
    expect(sessionRef(`codex exec resume ${SID} "continue"`)).toEqual({ agent: 'codex', id: SID });
    expect(sessionRef(` ${SID} `)).toEqual({ id: SID });
    // Web addresses stay web addresses, even with an id in them.
    expect(sessionRef(`https://example.com/${SID}`)).toBeUndefined();
    expect(sessionRef('claude.ai/code')).toBeUndefined();
    expect(sessionRef('claude --resume')).toBeUndefined();
  });

  it('finds the session file in the Claude Code and Codex folders (CLAUDE_CONFIG_DIR, CODEX_HOME honoured)', () => {
    const dirs = sessionDirs({ CLAUDE_CONFIG_DIR: path.join(dir, 'cc'), CODEX_HOME: path.join(dir, 'cx') }, path.join(dir, 'home'));
    expect(dirs.claude).toEqual([path.join(dir, 'cc', 'projects'), path.join(dir, 'home', '.claude', 'projects')]);
    const cc = path.join(dir, 'cc', 'projects', '-work-app', `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(cc), { recursive: true });
    fs.writeFileSync(cc, CLAUDE);
    const other = '11111111-2222-3333-4444-555555555555';
    const cx = path.join(dir, 'cx', 'sessions', '2026', '10', '18', `rollout-2026-10-18T09-00-00-${other}.jsonl`);
    fs.mkdirSync(path.dirname(cx), { recursive: true });
    fs.writeFileSync(cx, CODEX);
    expect(findSessionFile({ id: SID }, dirs)).toBe(cc);
    expect(findSessionFile({ agent: 'claude-code', id: SID }, dirs)).toBe(cc);
    expect(findSessionFile({ id: other }, dirs)).toBe(cx);
    expect(findSessionFile({ agent: 'codex', id: other }, dirs)).toBe(cx);
    expect(() => findSessionFile({ agent: 'codex', id: SID }, dirs)).toThrow(/No Codex session 0fe14a24.* was found .*cx/);
    expect(() => findSessionFile({ id: '99999999-2222-3333-4444-555555555555' }, dirs)).toThrow(/No Claude Code or Codex session/);
  });

  it('opens a session .jsonl as a conversation and any other .jsonl as code', async () => {
    const docs = new DocumentService();
    const s = path.join(dir, `${SID}.jsonl`);
    fs.writeFileSync(s, CLAUDE);
    const plain = path.join(dir, 'data.jsonl');
    fs.writeFileSync(plain, lines({ a: 1 }));
    const info = await docs.describeFile(s);
    expect(info.kind).toBe('session');
    expect(info.title).toBe('Claude Code: Why does the <b>build</b> fail?');
    const loaded = await docs.load(info.docId);
    expect(loaded.kind).toBe('html');
    expect(loaded.kind === 'html' && loaded.html).toContain('<h2>Claude</h2>');
    expect(loaded.kind === 'html' && loaded.text).toContain('A type is missing.');
    expect((await docs.describeFile(plain)).kind).toBe('code');
  });
});

describe('exporting a result as HTML', () => {
  const result = (files: Record<string, string>) => {
    const root = path.join(dir, 'job');
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), body);
    }
    return root;
  };
  const katexDir = path.join(ROOT, 'node_modules', 'katex', 'dist');

  it('writes a Markdown answer (ELI5) as a standalone page in the theme shown, formulas with KaTeX inlined', async () => {
    const outputRoot = result({ 'output/result.md': 'Like a **river**: $Re = \\frac{\\rho v L}{\\mu}$.' });
    const target = path.join(dir, 'out', 'Reynolds - ELI5');
    fs.mkdirSync(path.dirname(target));
    const written = await exportHtml({ outputRoot, output: 'markdown', target, theme: 'paper', lang: 'en', title: 'Reynolds', katexDir });
    expect(written).toBe(`${target}.html`);
    const page = fs.readFileSync(written, 'utf8');
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<strong>river</strong>');
    expect(page).toContain('class="katex"');
    expect(page).toContain('max-width: 46rem');
    expect(page).toContain('feTurbulence');
    // Nothing points back into the app.
    expect(page).not.toContain('_katex/');
    expect(page).toContain('url(data:font/woff2;base64,');
    expect(page).not.toMatch(/url\(fonts\//);
  });

  it('inlines every KaTeX font and drops the other formats', () => {
    const css = inlineKatexCss(katexDir);
    expect(css).not.toMatch(/\.woff\)|\.ttf\)/);
    expect(css.match(/data:font\/woff2/g)?.length).toBeGreaterThan(15);
  });

  it('copies a single-file HTML result (Anatomy) as it is, and one with files as a folder', async () => {
    const one = result({ 'output/index.html': '<html><script>draw()</script></html>' });
    const a = await exportHtml({ outputRoot: one, output: 'html', target: path.join(dir, 'a.html'), theme: 'light', lang: 'en', title: 't', katexDir });
    expect(fs.readFileSync(a, 'utf8')).toBe('<html><script>draw()</script></html>');
    fs.rmSync(path.join(dir, 'job'), { recursive: true });

    const many = result({ 'output/index.html': '<img src="fig.png">', 'output/fig.png': 'PNG' });
    const b = await exportHtml({ outputRoot: many, output: 'html', target: path.join(dir, 'b.html'), theme: 'light', lang: 'en', title: 't', katexDir });
    expect(b).toBe(path.join(dir, 'b', 'index.html'));
    expect(fs.readFileSync(path.join(dir, 'b', 'fig.png'), 'utf8')).toBe('PNG');
    // An existing folder is not overwritten.
    const c = await exportHtml({ outputRoot: many, output: 'html', target: path.join(dir, 'b.html'), theme: 'light', lang: 'en', title: 't', katexDir });
    expect(c).toBe(path.join(dir, 'b (2)', 'index.html'));
  });

  it('refuses a relative path', async () => {
    const root = result({ 'output/result.md': 'x' });
    await expect(exportHtml({ outputRoot: root, output: 'markdown', target: 'rel.html', theme: 'light', lang: 'en', title: 't', katexDir })).rejects.toThrow(/absolute/);
  });
});
