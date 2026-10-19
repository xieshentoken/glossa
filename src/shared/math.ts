// LaTeX formulas in answers: $…$ and \(…\) inline, $$…$$ and \[…\] on their
// own. Rendered with KaTeX to static HTML (no scripts), in the result viewer
// and while an answer streams in. Code (fenced or `inline`) is left alone, and
// prices such as "$5 and $10" are not formulas (Pandoc's rule: no space just
// inside the dollars, no digit right after the closing one).

import katex from 'katex';

export type MathPart = { text: string } | { tex: string; display: boolean };

const CLOSERS: [string, string, boolean][] = [
  ['$$', '$$', true],
  ['\\[', '\\]', true],
  ['\\(', '\\)', false],
];

/** Splits Markdown into text and formulas. */
export function splitMath(md: string): MathPart[] {
  const out: MathPart[] = [];
  let text = '';
  let i = 0;
  const push = (p: MathPart) => {
    if (text) out.push({ text });
    text = '';
    out.push(p);
  };
  while (i < md.length) {
    // Code is never math: fenced blocks (at a line start) and `spans`.
    if (md.startsWith('```', i) && (i === 0 || md[i - 1] === '\n')) {
      const end = md.indexOf('\n```', i + 3);
      const stop = end < 0 ? md.length : md.indexOf('\n', end + 4) < 0 ? md.length : md.indexOf('\n', end + 4);
      text += md.slice(i, stop);
      i = stop;
      continue;
    }
    if (md[i] === '`') {
      const run = /^`+/.exec(md.slice(i))![0];
      const end = md.indexOf(run, i + run.length);
      const stop = end < 0 ? i + run.length : end + run.length;
      text += md.slice(i, stop);
      i = stop;
      continue;
    }
    if (md[i] === '\\' && md[i + 1] === '$') {
      text += '\\$';
      i += 2;
      continue;
    }
    const block = CLOSERS.find(([open]) => md.startsWith(open, i));
    if (block) {
      const [open, close, display] = block;
      const end = md.indexOf(close, i + open.length);
      if (end > i + open.length) {
        push({ tex: md.slice(i + open.length, end).trim(), display });
        i = end + close.length;
        continue;
      }
    }
    if (md[i] === '$' && md[i + 1] !== '$' && md[i + 1] && !/\s/.test(md[i + 1])) {
      // The closing $: not after a space, not before a digit, on the same paragraph.
      let j = i + 1;
      while (j < md.length) {
        if (md[j] === '\\') j += 2;
        else if (md[j] === '\n' && md[j + 1] === '\n') break;
        else if (md[j] === '$') break;
        else j++;
      }
      if (md[j] === '$' && !/\s/.test(md[j - 1]) && !/\d/.test(md[j + 1] ?? '')) {
        push({ tex: md.slice(i + 1, j), display: false });
        i = j + 1;
        continue;
      }
    }
    text += md[i++];
  }
  if (text) out.push({ text });
  return out;
}

/** A formula as HTML. A formula KaTeX cannot read is shown as its source, marked. Never runs scripts or loads anything. */
export function renderMath(tex: string, display: boolean): string {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', trust: false, strict: 'ignore', maxSize: 50, maxExpand: 500 });
}

export const hasMath = (md: string) => splitMath(md).some((p) => 'tex' in p);

/**
 * Markdown with each formula replaced by a placeholder that Markdown leaves as
 * plain text, and the formulas' HTML to put back after Markdown is rendered.
 */
export function protectMath(md: string): { md: string; restore: (html: string) => string } {
  const rendered: string[] = [];
  const text = splitMath(md)
    .map((p) => {
      if ('text' in p) return p.text;
      rendered.push(renderMath(p.tex, p.display));
      const ph = `GLOSSAMATH${rendered.length - 1}Z`;
      return p.display ? `\n\n${ph}\n\n` : ph;
    })
    .join('');
  return {
    md: text,
    restore: (html) =>
      html
        // A formula alone in a paragraph is displayed as a block, not inside a <p>.
        .replace(/<p>GLOSSAMATH(\d+)Z<\/p>/g, (_m, n: string) => rendered[Number(n)] ?? '')
        .replace(/GLOSSAMATH(\d+)Z/g, (_m, n: string) => rendered[Number(n)] ?? ''),
  };
}
