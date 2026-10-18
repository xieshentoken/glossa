import { useMemo } from 'react';

const MAX_BLOCK_LINES = 60;
const MAX_BLOCK_CHARS = 4000;

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/**
 * Source as numbered lines. Lines are grouped into blocks at blank lines (and
 * every 60 lines at most): a block is the "paragraph" a picked term is sent with.
 * Line numbers are CSS counters, so they are not part of the text.
 */
export function codeHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const out: string[] = [];
  let block: string[] = [];
  let chars = 0;
  let blankRun = false;
  const flush = () => {
    if (block.length) out.push(`<div class="code-block">${block.join('')}</div>`);
    block = [];
    chars = 0;
  };
  for (const line of lines) {
    const blank = !line.trim();
    if ((blankRun && !blank) || block.length >= MAX_BLOCK_LINES || chars > MAX_BLOCK_CHARS) flush();
    blankRun = blank;
    block.push(`<span class="code-line">${esc(line)}\n</span>`);
    chars += line.length;
  }
  flush();
  return out.join('');
}

export function CodeView(props: { text: string; zoom: number }) {
  const html = useMemo(() => codeHtml(props.text), [props.text]);
  return <div className="code-doc" style={{ zoom: props.zoom }} translate="no" dangerouslySetInnerHTML={{ __html: html }} />;
}
