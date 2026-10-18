// Turn harness stdout into short progress lines and a final result.

import path from 'node:path';
import type { StreamParser } from '../../shared/types';

export interface ParsedLine {
  progress?: string;
  result?: string;
  costUsd?: number;
  isError?: boolean;
}

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown> };

function short(s: string, n = 90): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function toolLine(b: Block): string {
  const input = b.input ?? {};
  const file = typeof input.file_path === 'string' ? path.basename(input.file_path) : '';
  switch (b.name) {
    case 'Bash':
      return `$ ${short(String(input.command ?? ''), 80)}`;
    case 'Write':
      return `Writing ${file}`;
    case 'Edit':
      return `Editing ${file}`;
    case 'Read':
      return `Reading ${file}`;
    case 'Glob':
    case 'Grep':
      return `Searching ${short(String(input.pattern ?? ''), 60)}`;
    case 'Skill':
      return `Loading skill ${String(input.skill ?? input.name ?? '')}`;
    default:
      return String(b.name ?? 'tool');
  }
}

/** One line of Claude Code `--output-format stream-json`. */
export function parseClaudeStreamJson(line: string): ParsedLine {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line);
  } catch {
    return {};
  }
  if (evt.type === 'system' && evt.subtype === 'init') {
    return { progress: `Started${evt.model ? ` (${String(evt.model)})` : ''}` };
  }
  if (evt.type === 'assistant') {
    const content = ((evt.message as { content?: Block[] } | undefined)?.content ?? []) as Block[];
    for (let i = content.length - 1; i >= 0; i--) {
      const b = content[i];
      if (b.type === 'tool_use') return { progress: toolLine(b) };
      if (b.type === 'text' && b.text?.trim()) return { progress: short(b.text) };
    }
    return {};
  }
  if (evt.type === 'result') {
    return {
      result: typeof evt.result === 'string' ? evt.result : undefined,
      costUsd: typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : undefined,
      isError: evt.is_error === true || (typeof evt.subtype === 'string' && evt.subtype !== 'success'),
      progress: 'Finished',
    };
  }
  return {};
}

export function parsePlain(line: string): ParsedLine {
  const t = line.trim();
  return t ? { progress: short(t) } : {};
}

export function lineParser(kind: StreamParser): (line: string) => ParsedLine {
  return kind === 'claude-stream-json' ? parseClaudeStreamJson : parsePlain;
}
