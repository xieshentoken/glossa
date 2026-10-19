import { useEffect, useRef, useState } from 'react';
import type { T } from '../../shared/i18n';
import { cleanExtracted, guessLang } from '../../shared/text';
import type { DocInfo } from '../../shared/types';
import { api } from '../api';
import { areaIn, locateIn, type ReaderHandle } from '../lib/locate';
import { sanitizeHtml } from '../lib/sanitize';
import { CodeView } from './CodeView';
import { Icon } from './Icon';

type State = { html: string; lang?: string; source?: string } | { code: string } | { error: string };

/** Word, Markdown, plain text and local HTML, converted to sanitized HTML; source code as numbered lines. */
/** `zoom` scales the page (pinch-to-zoom); text reflows within the scaled column. */
export function HtmlReader(props: {
  doc: DocInfo;
  t: T;
  zoom: number;
  onText: (text: string, title?: string, lang?: string) => void;
  onHandle?: (h: ReaderHandle | null) => void;
}) {
  const { doc, t } = props;
  const [state, setState] = useState<State | null>(null);
  // Local HTML files: the page, or its source.
  const [showSource, setShowSource] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onText = useRef(props.onText);
  onText.current = props.onText;

  useEffect(() => {
    let cancelled = false;
    api.docs
      .load(doc.docId)
      .then((res) => {
        if (cancelled) return;
        if (res.kind === 'code') {
          setState({ code: res.text });
          // Indentation matters in code: the text is passed on as it is.
          onText.current(res.text);
          return;
        }
        if (res.kind !== 'html') throw new Error('Unexpected document type');
        const s = sanitizeHtml(res.html);
        const lang = s.lang ?? guessLang(res.text ?? s.html.replace(/<[^>]+>/g, ' '));
        setState({ html: s.html, lang, source: doc.kind === 'html' ? res.html : undefined });
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

  const onHandle = props.onHandle;
  useEffect(() => {
    if (!onHandle) return;
    onHandle({ locate: async (loc, avoid) => locateIn(scrollRef.current, loc, avoid), area: async (rect) => areaIn(scrollRef.current, rect) });
    return () => onHandle(null);
  }, [onHandle]);

  if (!state) return <div className="doc-message">{t('loading')}</div>;
  if ('error' in state) return <div className="doc-message">{t('loadFailed')}: {state.error}</div>;
  if ('code' in state) {
    return (
      <div className="doc-scroll doc-surface code-scroll" ref={scrollRef}>
        <CodeView text={state.code} zoom={props.zoom} />
      </div>
    );
  }
  const article = (
    <article
      ref={articleRef}
      className="html-doc"
      data-kind={doc.kind}
      lang={state.lang}
      style={{ zoom: props.zoom }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href') ?? '';
        if (/^https?:/.test(href)) void api.app.openExternal(href);
      }}
      dangerouslySetInnerHTML={{ __html: state.html }}
    />
  );
  if (state.source === undefined) {
    return (
      <div className="doc-scroll doc-surface" ref={scrollRef}>
        {article}
      </div>
    );
  }
  return (
    <div className="html-reader">
      <div className="doc-toolbar">
        <button aria-pressed={showSource} onClick={() => setShowSource((v) => !v)} data-testid="html-source-toggle">
          <Icon name={showSource ? 'text' : 'code'} size={15} />
          {t(showSource ? 'showPage' : 'showSource')}
        </button>
      </div>
      <div className={`doc-scroll doc-surface ${showSource ? 'code-scroll' : ''}`} ref={scrollRef}>
        {showSource ? <CodeView text={state.source} zoom={props.zoom} /> : article}
      </div>
    </div>
  );
}
