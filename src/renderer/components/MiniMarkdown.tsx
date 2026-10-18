// Tiny Markdown subset for streaming text (bold, italic, code, lists, paragraphs).
// Builds React elements, never HTML strings, so model output cannot inject markup.

import type { ReactNode } from 'react';

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
          const items = lines.map((l, li) => <li key={li}>{inline(l.replace(/^\s*([-*]|\d+[.)])\s+/, ''), `${bi}-${li}`)}</li>);
          return ordered ? <ol key={bi}>{items}</ol> : <ul key={bi}>{items}</ul>;
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(b);
        if (heading) return <p key={bi} className="md-h">{inline(heading[1], `${bi}`)}</p>;
        return (
          <p key={bi}>
            {lines.flatMap((l, li) => (li ? [<br key={`br${li}`} />, ...inline(l, `${bi}-${li}`)] : inline(l, `${bi}-${li}`)))}
          </p>
        );
      })}
    </>
  );
}
