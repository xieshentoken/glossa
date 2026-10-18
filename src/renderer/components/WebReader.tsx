import { useEffect, useRef, useState } from 'react';
import type { T } from '../../shared/i18n';
import type { DocInfo, PickedTerm } from '../../shared/types';
import { Icon } from './Icon';

type WebviewEl = HTMLElement & {
  send(channel: string, ...args: unknown[]): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
};

const stripHash = (u: string) => u.replace(/#.*$/, '');

/** A web page in an isolated <webview>; term picking runs in its preload. */
export function WebReader(props: {
  doc: DocInfo;
  t: T;
  preloadUrl: string;
  hotkey: string;
  onPick: (p: PickedTerm) => void;
  onText: (text: string, title?: string, lang?: string) => void;
  onNavigate: (url: string) => void;
}) {
  const { doc, t } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<WebviewEl | null>(null);
  const cb = useRef(props);
  cb.current = props;
  const [url, setUrl] = useState(doc.source);
  const [nav, setNav] = useState({ back: false, fwd: false });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !props.preloadUrl) return;
    const wv = document.createElement('webview') as WebviewEl;
    wv.setAttribute('partition', 'persist:web');
    wv.setAttribute('preload', props.preloadUrl);
    wv.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
    wv.setAttribute('src', doc.source);
    wv.className = 'webview';
    const sendConfig = () => wv.send('glossa:config', { hotkey: cb.current.hotkey, hint: cb.current.t('captureHint') });
    wv.addEventListener('dom-ready', sendConfig);
    wv.addEventListener('ipc-message', ((e: Event & { channel: string; args: unknown[] }) => {
      if (e.channel === 'glossa:pick') {
        const p = e.args[0] as PickedTerm;
        const box = wv.getBoundingClientRect();
        cb.current.onPick({ ...p, rect: { ...p.rect, x: p.rect.x + box.left, y: p.rect.y + box.top } });
      } else if (e.channel === 'glossa:doc') {
        const d = e.args[0] as { text: string; title: string; lang?: string; source: string };
        if (stripHash(d.source) === stripHash(cb.current.doc.source)) cb.current.onText(d.text, d.title, d.lang);
      }
    }) as EventListener);
    const onNav = ((e: Event & { url: string; isMainFrame?: boolean }) => {
      if (e.isMainFrame === false) return;
      setUrl(e.url);
      setNav({ back: wv.canGoBack(), fwd: wv.canGoForward() });
      if (stripHash(e.url) !== stripHash(cb.current.doc.source)) cb.current.onNavigate(e.url);
    }) as EventListener;
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    host.appendChild(wv);
    viewRef.current = wv;
    return () => {
      wv.remove();
      viewRef.current = null;
    };
    // The webview is created once per tab; navigation updates the tab's doc without recreating it.
  }, [props.preloadUrl]);

  useEffect(() => {
    try {
      viewRef.current?.send('glossa:config', { hotkey: props.hotkey, hint: t('captureHint') });
    } catch {
      // not ready yet; dom-ready sends it
    }
  }, [props.hotkey, t]);

  return (
    <div className="web-reader">
      <div className="doc-toolbar">
        <button className="icon" title={t('back')} aria-label={t('back')} disabled={!nav.back} onClick={() => viewRef.current?.goBack()}>
          <Icon name="back" />
        </button>
        <button className="icon" title={t('forward')} aria-label={t('forward')} disabled={!nav.fwd} onClick={() => viewRef.current?.goForward()}>
          <Icon name="forward" />
        </button>
        <button className="icon" title={t('reload')} aria-label={t('reload')} onClick={() => viewRef.current?.reload()}>
          <Icon name="retry" size={15} />
        </button>
        <span className="url muted">{url}</span>
      </div>
      <div className="web-host" ref={hostRef} />
    </div>
  );
}
