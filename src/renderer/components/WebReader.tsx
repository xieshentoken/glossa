import { useEffect, useRef, useState } from 'react';
import type { T } from '../../shared/i18n';
import type { DocInfo, PickedTerm } from '../../shared/types';
import type { AreaInfo, ReaderHandle } from '../lib/locate';
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
  locateHotkey: string;
  captureHotkey: string;
  onPick: (p: PickedTerm) => void;
  /** Glossa's locate or capture hotkey, pressed while the page has the keyboard. */
  onHotkey: (kind: 'locate' | 'capture') => void;
  /** The mouse entered or left the page (the app forwards its pick hotkey here then). */
  onPointer: (inside: boolean) => void;
  onHandle?: (h: ReaderHandle | null) => void;
  /** Page zoom of this panel; pinches inside the page are reported to onZoomBy. */
  zoom: number;
  onZoomBy: (factor: number, x: number, y: number) => void;
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
  // Requests waiting for the page's answer.
  const waiting = useRef(new Map<number, (r: unknown) => void>());
  /** The zoom the page last said it applied itself. */
  const pageZoom = useRef(0);
  const config = () => ({ hotkey: cb.current.hotkey, hint: cb.current.t('captureHint'), locateHotkey: cb.current.locateHotkey, captureHotkey: cb.current.captureHotkey });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !props.preloadUrl) return;
    const wv = document.createElement('webview') as WebviewEl;
    wv.setAttribute('partition', 'persist:web');
    wv.setAttribute('preload', props.preloadUrl);
    wv.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
    wv.setAttribute('src', doc.source);
    wv.className = 'webview';
    const sendConfig = () => wv.send('glossa:config', config());
    wv.addEventListener('dom-ready', sendConfig);
    wv.addEventListener('dom-ready', () => (wv as unknown as { setZoomFactor(f: number): void }).setZoomFactor(cb.current.zoom));
    wv.addEventListener('ipc-message', ((e: Event & { channel: string; args: unknown[] }) => {
      if (e.channel === 'glossa:pick') {
        const p = e.args[0] as PickedTerm;
        const box = wv.getBoundingClientRect();
        cb.current.onPick({ ...p, rect: { ...p.rect, x: p.rect.x + box.left, y: p.rect.y + box.top } });
      } else if (e.channel === 'glossa:zoom') {
        const z = e.args[0] as { factor: number; x: number; y: number };
        const box = wv.getBoundingClientRect();
        if (Number.isFinite(z.factor) && z.factor > 0) cb.current.onZoomBy(z.factor, z.x + box.left, z.y + box.top);
      } else if (e.channel === 'glossa:zoomed') {
        pageZoom.current = Number(e.args[0]);
      } else if (e.channel === 'glossa:located' || e.channel === 'glossa:areaText') {
        const r = e.args[0] as { id: number };
        waiting.current.get(r.id)?.(r);
        waiting.current.delete(r.id);
      } else if (e.channel === 'glossa:hotkey' && (e.args[0] === 'locate' || e.args[0] === 'capture')) {
        cb.current.onHotkey(e.args[0]);
      } else if (e.channel === 'glossa:pointer') {
        cb.current.onPointer(e.args[0] === true);
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
    const wv = viewRef.current as (WebviewEl & { setZoomFactor(f: number): void }) | null;
    if (!wv) return;
    // The page zooms itself, keeping the spot under the pinch (or its middle) in place.
    try {
      wv.send('glossa:zoomTo', { zoom: props.zoom });
    } catch {
      // not attached yet; dom-ready applies the zoom
    }
    // In case the page could not (still loading, or without the preload): the zoom from here, shortly after.
    // Not when it did: setting it again would lay the page out once more, without the anchor.
    const id = setTimeout(() => {
      if (Math.abs(pageZoom.current - cb.current.zoom) < 1e-3) return;
      try {
        wv.setZoomFactor(cb.current.zoom);
      } catch {
        // not attached yet; dom-ready applies it
      }
    }, 500);
    return () => clearTimeout(id);
  }, [props.zoom]);

  useEffect(() => {
    try {
      viewRef.current?.send('glossa:config', config());
    } catch {
      // not ready yet; dom-ready sends it
    }
  }, [props.hotkey, props.locateHotkey, props.captureHotkey, t]);

  const onHandle = props.onHandle;
  useEffect(() => {
    if (!onHandle) return;
    let next = 0;
    /** Sends a request to the page and waits for its answer (`fallback` after 4 s, or when the page is not ready). */
    const ask = <R,>(channel: string, payload: object, fallback: R) =>
      new Promise<R>((resolve) => {
        const wv = viewRef.current;
        if (!wv) return resolve(fallback);
        const id = ++next;
        const timer = setTimeout(() => {
          waiting.current.delete(id);
          resolve(fallback);
        }, 4000);
        waiting.current.set(id, (r) => {
          clearTimeout(timer);
          resolve(r as R);
        });
        try {
          wv.send(channel, { id, ...payload });
        } catch {
          waiting.current.get(id)?.(fallback);
          waiting.current.delete(id);
        }
      });
    /** A client rect of the app as the page's own CSS pixels (the panel zoom scales them). */
    const inPage = (r: { top: number; bottom: number; left: number; right: number }) => {
      const box = viewRef.current!.getBoundingClientRect();
      const z = cb.current.zoom || 1;
      return { top: (r.top - box.top) / z, bottom: (r.bottom - box.top) / z, left: (r.left - box.left) / z, right: (r.right - box.left) / z };
    };
    onHandle({
      locate: async (loc, avoid) => (await ask<{ ok?: boolean }>('glossa:locate', { loc, avoid: avoid && viewRef.current ? inPage(avoid) : undefined }, { ok: false })).ok === true,
      area: async (rect) => {
        type Reply = { text?: string; pictures?: boolean; locator?: AreaInfo['locator']; region?: AreaInfo['locator']['region'] };
        const r: Reply = viewRef.current ? await ask<Reply>('glossa:areaText', { rect: inPage(rect) }, {}) : {};
        return { text: r.text ?? '', pictures: r.pictures !== false, locator: { ...(r.locator ?? { quote: '', prefix: '', suffix: '' }), ...(r.region ? { region: r.region } : {}) } };
      },
      pickHere: () => {
        const wv = viewRef.current;
        if (!wv) return;
        // The page takes the keyboard, so ←/→ and Enter adjust and confirm there.
        wv.focus();
        try {
          wv.send('glossa:pickHere');
        } catch {
          // not ready
        }
      },
    });
    return () => onHandle(null);
  }, [onHandle]);

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
