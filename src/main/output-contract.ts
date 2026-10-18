// What a finished job must leave behind. A job is only "done" (or "partial")
// when its output file passes validate().

import path from 'node:path';
import type { OutputKind, RunnerKind } from '../shared/types';
import { readFileSafe, writeFileAtomic } from './fs-safe';

export interface OutputSpec {
  /** Path relative to the job folder. */
  file: string;
  contentType: string;
  maxBytes: number;
  /** Runners that can produce this kind. */
  runners: RunnerKind[];
}

export const OUTPUT_SPECS: Record<OutputKind, OutputSpec> = {
  markdown: { file: 'output/result.md', contentType: 'text/markdown; charset=utf-8', maxBytes: 2 * 1024 * 1024, runners: ['direct', 'agent'] },
  // A direct model call returns text, not a page with assets; HTML needs an agent skill.
  html: { file: 'output/index.html', contentType: 'text/html; charset=utf-8', maxBytes: 25 * 1024 * 1024, runners: ['agent'] },
};

/** Why a skill/output combination cannot run, or undefined when it can. */
export function unsupportedCombination(runner: RunnerKind, output: OutputKind): string | undefined {
  return OUTPUT_SPECS[output].runners.includes(runner)
    ? undefined
    : 'HTML output needs an agent skill. A direct skill returns Markdown; switch the output to Markdown or the runner to Agent.';
}

export type OutputCheck = { ok: true; file: string; bytes: number } | { ok: false; reason: string };

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function validateOutput(jobDir: string, kind: OutputKind): OutputCheck {
  const spec = OUTPUT_SPECS[kind];
  let buf: Buffer;
  try {
    buf = readFileSafe(jobDir, spec.file, { maxBytes: spec.maxBytes });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' ? 'missing' : `unreadable: ${(err as Error).message}` };
  }
  let text: string;
  try {
    text = utf8.decode(buf);
  } catch {
    return { ok: false, reason: 'not valid UTF-8 text' };
  }
  if (!text.trim()) return { ok: false, reason: 'empty' };
  if (kind === 'html' && !/<(!doctype|html|body|svg|div|main|canvas)\b/i.test(text)) return { ok: false, reason: 'not an HTML page' };
  return { ok: true, file: path.join(jobDir, spec.file), bytes: buf.length };
}

export function readOutputText(jobDir: string, kind: OutputKind, maxChars = 50_000): string | undefined {
  try {
    const t = readFileSafe(jobDir, OUTPUT_SPECS[kind].file, { maxBytes: OUTPUT_SPECS[kind].maxBytes }).toString('utf8');
    return t.length > maxChars ? t.slice(0, maxChars) : t;
  } catch {
    return undefined;
  }
}

export function writeOutput(jobDir: string, kind: OutputKind, content: string): void {
  writeFileAtomic(path.join(jobDir, OUTPUT_SPECS[kind].file), content);
}

export const OUTPUT_FILES: Record<OutputKind, string> = {
  markdown: OUTPUT_SPECS.markdown.file,
  html: OUTPUT_SPECS.html.file,
};
