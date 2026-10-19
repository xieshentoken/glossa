// Tiny Markdown subset for streaming text (bold, italic, code, lists, paragraphs,
// LaTeX formulas). Builds React elements, never HTML strings, so model output
// cannot inject markup; the only HTML used is KaTeX's own rendering of a formula,
// which escapes its input and allows no links or scripts (trust: false).

import type { ReactNode } from 'react';
import { renderMath, splitMath } from '../../shared/math';

function Formula(props: { tex: string; display: boolean }) {
  const html = renderMath(props.tex, props.display);
  return props.display ? <span className="md-math" dangerouslySetInnerHTML={{ __html: html }} /> : <span dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Text with formulas: each text part as inline Markdown (lines joined with <br>), each formula rendered. */
function withMath(text: string, key: string, lines: boolean): ReactNode[] {
  return splitMath(text).flatMap((p, pi) => {
    const k = `${key}-m${pi}`;
    if ('tex' in p) return [<Formula key={k} tex={p.tex} display={p.display} />];
    if (!lines) return inline(p.text, k);
    return p.text.split('\n').flatMap((l, li) => (li ? [<br key={`${k}-br${li}`} />, ...inline(l, `${k}-${li}`)] : inline(l, `${k}-${li}`)));
  });
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MiniMarkdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, bi) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*([-*]|\d+[.)])\s+/.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]);
          const items = lines.map((l, li) => <li key={li}>{withMath(l.replace(/^\s*([-*]|\d+[.)])\s+/, ''), `${bi}-${li}`, false)}</li>);
          return ordered ? <ol key={bi}>{items}</ol> : <ul key={bi}>{items}</ul>;
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(b);
        if (heading) return <p key={bi} className="md-h">{withMath(heading[1], `${bi}`, false)}</p>;
        return <p key={bi}>{withMath(b, `${bi}`, true)}</p>;
      })}
    </>
  );
}
