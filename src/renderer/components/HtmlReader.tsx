import { useEffect, useRef, useState } from 'react';
import type { T } from '../../shared/i18n';
import { cleanExtracted, guessLang } from '../../shared/text';
import type { DocInfo } from '../../shared/types';
import { api } from '../api';
import { sanitizeHtml } from '../lib/sanitize';

/** Word, Markdown, plain text and local HTML, converted to sanitized HTML. */
export function HtmlReader(props: { doc: DocInfo; t: T; onText: (text: string, title?: string, lang?: string) => void }) {
  const { doc, t } = props;
  const [state, setState] = useState<{ html: string; lang?: string } | { error: string } | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const onText = useRef(props.onText);
  onText.current = props.onText;

  useEffect(() => {
    let cancelled = false;
    api.docs
      .load(doc.docId)
      .then((res) => {
        if (cancelled) return;
        if (res.kind !== 'html') throw new Error('Unexpected document type');
        const s = sanitizeHtml(res.html);
        const lang = s.lang ?? guessLang(res.text ?? s.html.replace(/<[^>]+>/g, ' '));
        setState({ html: s.html, lang });
        requestAnimationFrame(() => {
          const text = res.text ?? articleRef.current?.innerText ?? '';
          onText.current(cleanExtracted(text), s.title, lang);
        });
      })
      .catch((err) => !cancelled && setState({ error: String(err.message ?? err) }));
    return () => {
      cancelled = true;
    };
  }, [doc.docId]);

  if (!state) return <div className="doc-message">{t('loading')}</div>;
  if ('error' in state) return <div className="doc-message">{t('loadFailed')}: {state.error}</div>;
  return (
    <div className="doc-scroll doc-surface">
      <article
        ref={articleRef}
        className="html-doc"
        lang={state.lang}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest('a');
          if (!a) return;
          e.preventDefault();
          const href = a.getAttribute('href') ?? '';
          if (/^https?:/.test(href)) void api.app.openExternal(href);
        }}
        dangerouslySetInnerHTML={{ __html: state.html }}
      />
    </div>
  );
}
