// Coding-agent sessions shown as a conversation:
//
//   Claude Code  ~/.claude/projects/<project>/<session id>.jsonl
//   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl
//
// A session is also found from what the user types in the address bar: a resume
// command (`claude --resume <id>`, `codex resume <id>`) or a bare session id.
// Prompts and answers are shown in full; tool calls are folded and shortened.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { marked } from 'marked';
import { escapeHtml } from './documents';

export type SessionAgent = 'claude-code' | 'codex';

const AGENT_NAMES: Record<SessionAgent, { label: string; speaker: string }> = {
  'claude-code': { label: 'Claude Code', speaker: 'Claude' },
  codex: { label: 'Codex', speaker: 'Codex' },
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseLine(line: string): Json | undefined {
  if (!line.trim()) return undefined;
  try {
    const o = JSON.parse(line) as unknown;
    return isObj(o) ? o : undefined;
  } catch {
    return undefined;
  }
}

/** Which agent wrote these lines (the start of a .jsonl file), if any. */
export function sniffSession(head: string): SessionAgent | undefined {
  // The last line may be cut off; it simply does not parse.
  for (const line of head.split('\n').slice(0, 50)) {
    const o = parseLine(line);
    if (!o) continue;
    if ((o.type === 'user' || o.type === 'assistant') && typeof o.sessionId === 'string' && isObj(o.message)) return 'claude-code';
    if (['session_meta', 'response_item', 'turn_context', 'event_msg'].includes(str(o.type)) && isObj(o.payload)) return 'codex';
    // Codex before mid-2025: a header line, then bare response items.
    if (o.type === 'message' && (o.role === 'user' || o.role === 'assistant') && Array.isArray(o.content)) return 'codex';
  }
  return undefined;
}

/** The agent that wrote a file and the session's heading, from its first megabyte. */
export async function sniffSessionFile(file: string): Promise<{ agent: SessionAgent; title: string } | undefined> {
  const fh = await fs.promises.open(file, 'r');
  let head: string;
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
  const agent = sniffSession(head);
  return agent && { agent, title: sessionHeading(parseSession(head, agent)) };
}

type Item =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; at?: string }
  | { kind: 'tool'; name: string; input: string; brief: string; id?: string; output?: string; error?: boolean };

export interface Transcript {
  agent: SessionAgent;
  title: string;
  items: Item[];
  cwd?: string;
  model?: string;
  started?: string;
}

/** Tool input and output beyond this are cut; the conversation itself never is. */
export const TOOL_TEXT_MAX = 4000;

function clip(s: string, max = TOOL_TEXT_MAX): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

function pretty(v: unknown): string {
  if (typeof v === 'string') {
    try {
      return pretty(JSON.parse(v));
    } catch {
      return v;
    }
  }
  // Codex wraps command output as { output, metadata }; a single text field is shown as that text.
  if (isObj(v) && typeof v.output === 'string') return v.output;
  if (isObj(v) && Object.keys(v).length === 1 && typeof Object.values(v)[0] === 'string') return Object.values(v)[0] as string;
  return JSON.stringify(v, null, 2) ?? '';
}

/** One line saying what a tool call does: its command, file, pattern or query. */
function briefOf(input: unknown): string {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      // plain text input
    }
  }
  let line = '';
  if (Array.isArray(v)) line = v.map(String).join(' ');
  else if (isObj(v)) {
    const c = v.command ?? v.cmd;
    // ["bash", "-lc", "<script>"] is the script.
    if (Array.isArray(c)) line = c.length === 3 && /sh$/.test(String(c[0])) && c[1] === '-lc' ? String(c[2]) : c.map(String).join(' ');
    else line = [c, v.description, v.file_path, v.path, v.pattern, v.query, v.url, v.prompt].map(str).find(Boolean) ?? '';
  } else line = str(v);
  line = line.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** Text the user did not type: reminders and command plumbing added by Claude Code. */
function cleanClaudeUser(text: string): string {
  return text
    .replace(/<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-(name|args)>([\s\S]*?)<\/command-\1>/g, '$2 ')
    .trim();
}

/** Context Codex adds as user messages (environment, AGENTS.md), not typed by the user. */
const CODEX_INJECTED = /^\s*(<environment_context>|<user_instructions>|<INSTRUCTIONS>|# AGENTS\.md instructions)/;

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isObj(b) ? (typeof b.text === 'string' ? b.text : b.type === 'image' || b.type === 'input_image' ? '[image]' : '') : ''))
    .filter(Boolean)
    .join('\n\n');
}

/** Reads a session line by line; feed every line, then call done(). */
export function sessionParser(agent: SessionAgent) {
  const t: Transcript = { agent, title: '', items: [] };
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  let summary = '';
  const say = (role: 'user' | 'assistant', text: string, at?: string) => {
    if (text.trim()) t.items.push({ kind: 'message', role, text: text.trim(), at });
  };
  const call = (name: string, input: unknown, id?: string) => {
    const item = { kind: 'tool' as const, name: name || 'tool', input: clip(pretty(input)), brief: briefOf(input), id };
    t.items.push(item);
    if (id) tools.set(id, item);
  };
  const result = (id: string, output: unknown, error?: boolean) => {
    const item = tools.get(id);
    if (!item) return;
    item.output = clip(typeof output === 'string' || isObj(output) ? pretty(output) : blocksText(output));
    if (error) item.error = true;
  };

  const claude = (o: Json) => {
    if (o.type === 'summary' && typeof o.summary === 'string') summary ||= o.summary;
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta || !isObj(o.message)) return;
    t.cwd ||= str(o.cwd) || undefined;
    t.started ||= str(o.timestamp) || undefined;
    const m = o.message;
    if (o.type === 'assistant' && str(m.model) && !str(m.model).startsWith('<')) t.model = str(m.model);
    const at = str(o.timestamp) || undefined;
    if (typeof m.content === 'string') return say(o.type, o.type === 'user' ? cleanClaudeUser(m.content) : m.content, at);
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (!isObj(b)) continue;
      if (b.type === 'text') say(o.type, o.type === 'user' ? cleanClaudeUser(str(b.text)) : str(b.text), at);
      else if (b.type === 'tool_use') call(str(b.name), b.input, str(b.id));
      else if (b.type === 'tool_result') result(str(b.tool_use_id), b.content, b.is_error === true);
    }
  };

  const codexItem = (p: Json, at?: string) => {
    const type = str(p.type);
    if (type === 'message') {
      if (p.role !== 'user' && p.role !== 'assistant') return;
      const text = blocksText(p.content);
      if (p.role === 'user' && CODEX_INJECTED.test(text)) return;
      say(p.role, text, at);
    } else if (type === 'function_call') call(str(p.name), p.arguments, str(p.call_id));
    else if (type === 'custom_tool_call') call(str(p.name), p.input, str(p.call_id));
    else if (type === 'local_shell_call') call('shell', isObj(p.action) ? p.action.command : p.action, str(p.call_id));
    else if (type === 'web_search_call') call('web_search', isObj(p.action) ? (p.action.query ?? p.action) : '', str(p.id));
    else if (type.endsWith('_call_output')) result(str(p.call_id), p.output);
  };
  const codex = (o: Json) => {
    const at = str(o.timestamp) || undefined;
    if (o.type === 'session_meta' && isObj(o.payload)) {
      t.cwd ||= str(o.payload.cwd) || undefined;
      t.started ||= str(o.payload.timestamp) || at;
    } else if (o.type === 'turn_context' && isObj(o.payload)) {
      t.model = str(o.payload.model) || t.model;
      t.cwd ||= str(o.payload.cwd) || undefined;
    } else if (o.type === 'response_item' && isObj(o.payload)) codexItem(o.payload, at);
    else if (!('payload' in o) && typeof o.type === 'string') codexItem(o, at);
    else if (!o.type && typeof o.id === 'string' && typeof o.timestamp === 'string') t.started ||= o.timestamp;
  };

  return {
    add(line: string) {
      const o = parseLine(line);
      if (o) (agent === 'claude-code' ? claude : codex)(o);
    },
    done(): Transcript {
      const first = t.items.find((x) => x.kind === 'message' && x.role === 'user');
      const prompt = first?.kind === 'message' ? first.text.split('\n').find((l) => l.trim())?.trim() ?? '' : '';
      const title = summary || prompt;
      t.title = title.length > 80 ? `${title.slice(0, 79)}…` : title;
      return t;
    },
  };
}

export function parseSession(text: string, agent: SessionAgent): Transcript {
  const p = sessionParser(agent);
  for (const line of text.split('\n')) p.add(line);
  return p.done();
}

export async function readSessionFile(file: string, agent: SessionAgent): Promise<Transcript> {
  const p = sessionParser(agent);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) p.add(line);
  return p.done();
}

/** "Claude Code: <first prompt>", the document's title. */
export function sessionHeading(t: Transcript): string {
  const label = AGENT_NAMES[t.agent].label;
  return t.title ? `${label}: ${t.title}` : `${label} session`;
}

/** The conversation as a page (sanitized again in the reader) and as plain text (what skills see). */
export async function sessionPage(t: Transcript): Promise<{ html: string; text: string }> {
  const names = AGENT_NAMES[t.agent];
  const heading = sessionHeading(t);
  const when = t.started && !Number.isNaN(Date.parse(t.started)) ? new Date(t.started).toLocaleString() : '';
  const meta = [`${names.label} session`, t.cwd, t.model, when].filter(Boolean).map((s) => escapeHtml(s!)).join(' · ');
  const out: string[] = [`<title>${escapeHtml(heading)}</title>`, `<h1>${escapeHtml(t.title || `${names.label} session`)}</h1>`, `<p><small>${meta}</small></p>`];
  const text: string[] = [t.title];
  let speaker: 'user' | 'assistant' | undefined;
  for (const item of t.items) {
    // A tool call belongs to the assistant's turn.
    const role = item.kind === 'message' ? item.role : 'assistant';
    if (role !== speaker) {
      if (speaker) out.push('</section>');
      out.push(`<section><h2>${role === 'user' ? 'You' : names.speaker}</h2>`);
      speaker = role;
    }
    if (item.kind === 'message') {
      out.push(await marked.parse(item.text));
      text.push(`${role === 'user' ? 'You' : names.speaker}: ${item.text}`);
      continue;
    }
    const brief = item.brief;
    out.push(
      `<details><summary>${escapeHtml(item.name)}${brief ? ` · <code>${escapeHtml(brief)}</code>` : ''}${item.error ? ' · <strong>error</strong>' : ''}</summary>` +
        `<pre><code>${escapeHtml(item.input)}</code></pre>` +
        (item.output !== undefined ? `<pre><code>${escapeHtml(item.output || '(no output)')}</code></pre>` : '') +
        '</details>',
    );
  }
  if (speaker) out.push('</section>');
  if (!t.items.length) out.push('<p><em>This session has no messages yet.</em></p>');
  return { html: out.join('\n'), text: text.filter(Boolean).join('\n\n') };
}

// --- finding a session from what was typed ------------------------------------------

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A session asked for in the address bar: a resume command or a bare session id. */
export function sessionRef(input: string): { agent?: SessionAgent; id: string } | undefined {
  const s = input.trim();
  let m = new RegExp(`^claude\\b.*?(?:--resume|-r|--session-id)(?:=|\\s+)["']?(${UUID})["']?`, 'i').exec(s);
  if (m) return { agent: 'claude-code', id: m[1].toLowerCase() };
  m = new RegExp(`^codex\\b.*?\\bresume\\b.*?["']?(${UUID})["']?`, 'i').exec(s);
  if (m) return { agent: 'codex', id: m[1].toLowerCase() };
  m = new RegExp(`^["']?(${UUID})["']?$`, 'i').exec(s);
  return m ? { id: m[1].toLowerCase() } : undefined;
}

export interface SessionDirs {
  claude: string[];
  codex: string[];
}

/** Where the agents keep their sessions (CLAUDE_CONFIG_DIR and CODEX_HOME move them). */
export function sessionDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): SessionDirs {
  const uniq = (xs: (string | false | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x).map((x) => path.resolve(x)))];
  const codexHomes = uniq([env.CODEX_HOME, path.join(home, '.codex')]);
  return {
    claude: uniq([env.CLAUDE_CONFIG_DIR && path.join(env.CLAUDE_CONFIG_DIR, 'projects'), path.join(home, '.claude', 'projects')]),
    codex: codexHomes.flatMap((h) => [path.join(h, 'sessions'), path.join(h, 'archived_sessions')]),
  };
}

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The file of a session, or an error that says where it was looked for. */
export function findSessionFile(ref: { agent?: SessionAgent; id: string }, dirs: SessionDirs = sessionDirs()): string {
  if (ref.agent !== 'codex') {
    for (const root of dirs.claude) {
      for (const d of entries(root)) {
        const f = path.join(root, d.name, `${ref.id}.jsonl`);
        if (d.isDirectory() && fs.existsSync(f)) return f;
      }
    }
  }
  if (ref.agent !== 'claude-code') {
    // sessions/YYYY/MM/DD/rollout-…-<id>.jsonl; archived sessions are flat.
    const walk = (dir: string, depth: number): string | undefined => {
      for (const d of entries(dir)) {
        const p = path.join(dir, d.name);
        if (d.isFile() && d.name.startsWith('rollout-') && d.name.toLowerCase().endsWith(`${ref.id}.jsonl`)) return p;
        if (d.isDirectory() && depth > 0) {
          const hit = walk(p, depth - 1);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    for (const root of dirs.codex) {
      const hit = walk(root, 3);
      if (hit) return hit;
    }
  }
  const where = [...(ref.agent === 'codex' ? [] : dirs.claude), ...(ref.agent === 'claude-code' ? [] : dirs.codex)];
  const who = ref.agent ? AGENT_NAMES[ref.agent].label : 'Claude Code or Codex';
  throw new Error(`No ${who} session ${ref.id} was found on this computer (looked in ${where.join(', ')}).`);
}
