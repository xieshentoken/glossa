import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { T } from '../../shared/i18n';
import { cleanExtracted } from '../../shared/text';
import { areaText } from '../../shared/area-text';
import { bestMatch, findTerm, flashBoxes, flashRange, normalize, regionRect, scrollToBox, scrollToRange, toRegion } from '../../shared/term-locate';
import type { DocInfo } from '../../shared/types';
import { api } from '../api';
import type { Locate, ReaderHandle } from '../lib/locate';
import { clampZoom } from '../../shared/pinch';
import { Icon } from './Icon';

GlobalWorkerOptions.workerSrc = workerUrl;
const asset = (p: string) => new URL(`./pdfjs/${p}`, location.href).href;
const RENDER_CONCURRENCY = 2;
/** Text extraction stops here; the main process trims to what it may send anyway. */
const MAX_EXTRACT_CHARS = 1_000_000;

/** 100% zoom shows pages at this PDF scale. */
const BASE_SCALE = 1.25;

/**
 * `zoom` (pinch, Ctrl+wheel, the toolbar) applies at once as a CSS zoom of the
 * rendered pages; shortly after it settles the pages are rendered again, sharp.
 */
export function PdfReader(props: {
  doc: DocInfo;
  t: T;
  zoom: number;
  onZoom: (z: number) => void;
  onText: (text: string, title?: string) => void;
  onHandle?: (h: ReaderHandle | null) => void;
}) {
  const { doc, t } = props;
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const target = BASE_SCALE * props.zoom;
  const [scale, setScale] = useState(target);
  // The pages in the panel are rendered at `shown`; until they are rendered again, a CSS zoom on
  // each page (not on the column: its gaps and margins do not grow when pages are rendered again)
  // makes them the size of `target`. Set here and with the pages, never one render early.
  const shown = useRef(scale);
  const targetRef = useRef(target);
  targetRef.current = target;
  useLayoutEffect(() => {
    pagesRef.current?.style.setProperty('--page-zoom', String(target / shown.current));
  }, [target]);
  useEffect(() => {
    if (target === scale) return;
    const id = setTimeout(() => setScale(target), 180);
    return () => clearTimeout(id);
  }, [target, scale]);
  const [error, setError] = useState('');
  const onText = useRef(props.onText);
  onText.current = props.onText;

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | null = null;
    (async () => {
      try {
        const res = await api.docs.load(doc.docId);
        if (res.kind !== 'pdf' || cancelled) throw new Error('Not a PDF');
        task = getDocument({
          data: res.data,
          cMapUrl: asset('cmaps/'),
          cMapPacked: true,
          standardFontDataUrl: asset('standard_fonts/'),
          wasmUrl: asset('wasm/'),
        });
        const loaded = await task.promise;
        if (cancelled) return;
        setPdf(loaded);
        const meta = await loaded.getMetadata().catch(() => null);
        const title = (meta?.info as { Title?: string } | undefined)?.Title?.trim();
        const parts: string[] = [];
        let total = 0;
        for (let i = 1; i <= loaded.numPages && !cancelled && total < MAX_EXTRACT_CHARS; i++) {
          const page = await loaded.getPage(i);
          const tc = await page.getTextContent();
          const t = tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
          parts.push(t);
          total += t.length;
          page.cleanup();
        }
        if (!cancelled) onText.current(cleanExtracted(parts.join('\n\n')), title || undefined);
      } catch (err) {
        if (!cancelled) setError(String((err as Error).message ?? err));
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [doc.docId]);

  useEffect(() => {
    const host = pagesRef.current;
    if (!pdf || !host) return;
    const scroller = host.parentElement;
    const dpr = window.devicePixelRatio || 1;
    // Pages are rendered when near the viewport, at most RENDER_CONCURRENCY at a time,
    // and their canvases are released again when they scroll far away.
    const rendered = new Map<number, { task?: RenderTask }>();
    const queue: { div: HTMLDivElement; n: number }[] = [];
    let active = 0;
    let disposed = false;
    const pump = () => {
      while (!disposed && active < RENDER_CONCURRENCY && queue.length) {
        const next = queue.shift()!;
        if (!rendered.has(next.n)) continue; // released before its turn
        active++;
        void renderPage(next.div, next.n).finally(() => {
          active--;
          pump();
        });
      }
    };
    const release = (div: HTMLDivElement, n: number) => {
      const r = rendered.get(n);
      if (!r) return;
      r.task?.cancel();
      rendered.delete(n);
      for (const c of div.querySelectorAll('canvas')) {
        c.width = 0;
        c.height = 0;
      }
      div.replaceChildren();
    };
    const near = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const div = e.target as HTMLDivElement;
          const n = Number(div.dataset.page);
          if (e.isIntersecting && !rendered.has(n)) {
            rendered.set(n, {});
            queue.push({ div, n });
            pump();
          }
        }
      },
      { root: host.parentElement, rootMargin: '600px 0px' },
    );
    const far = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (!e.isIntersecting) release(e.target as HTMLDivElement, Number((e.target as HTMLElement).dataset.page));
      },
      { root: host.parentElement, rootMargin: '4000px 0px' },
    );
    const renderPage = async (div: HTMLDivElement, n: number) => {
      const slot = rendered.get(n);
      if (!slot || disposed) return;
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      div.replaceChildren(canvas, layer);
      slot.task = page.render({
        canvas,
        canvasContext: canvas.getContext('2d')!,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      try {
        await slot.task.promise;
        if (rendered.get(n) !== slot) return;
        await new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport }).render();
      } catch {
        // cancelled (scrolled away, zoom changed or tab closed)
      } finally {
        page.cleanup();
      }
    };
    (async () => {
      const first = await pdf.getPage(1);
      if (disposed) return;
      const vp = first.getViewport({ scale });
      // Rendering again at a new scale keeps the reading position: the spot of the page in the
      // middle of the panel stays there. The old pages stay until the new ones replace them.
      const keep = scroller ? pageSpot(host, scroller) : undefined;
      host.replaceChildren();
      for (let n = 1; n <= pdf.numPages && !disposed; n++) {
        const div = document.createElement('div');
        div.className = 'pdf-page';
        div.dataset.page = String(n);
        div.style.width = `${vp.width}px`;
        div.style.height = `${vp.height}px`;
        div.style.setProperty('--scale-factor', String(scale));
        div.style.setProperty('--total-scale-factor', String(scale));
        div.style.setProperty('--user-unit', '1');
        host.appendChild(div);
        near.observe(div);
        far.observe(div);
      }
      shown.current = scale;
      host.style.setProperty('--page-zoom', String(targetRef.current / scale));
      const page = keep && host.querySelector<HTMLElement>(`.pdf-page[data-page="${keep.n}"]`);
      if (keep && page && scroller) {
        const b = page.getBoundingClientRect();
        scroller.scrollTop += b.top + keep.fy * b.height - keep.y;
        scroller.scrollLeft += b.left + keep.fx * b.width - keep.x;
      }
    })();
    return () => {
      disposed = true;
      near.disconnect();
      far.disconnect();
      for (const r of rendered.values()) r.task?.cancel();
      rendered.clear();
      queue.length = 0;
    };
  }, [pdf, scale]);

  // Pages are rendered only near the viewport: go to the term's page, wait for its text, then highlight.
  const onHandle = props.onHandle;
  useEffect(() => {
    if (!onHandle || !pdf) return;
    const texts = new Map<number, string>();
    const pageText = async (n: number) => {
      let s = texts.get(n);
      if (s === undefined) {
        const page = await pdf.getPage(n);
        const tc = await page.getTextContent();
        s = normalize(tc.items.map((it) => ('str' in it ? it.str : '')).join(''));
        texts.set(n, s);
      }
      return s;
    };
    /** The page holding the term: the saved one when it still does, else the best match (nearest first on a tie). */
    const findPage = async (loc: Parameters<Locate>[0]) => {
      // A captured area without text: its page.
      if (!loc.quote) return loc.page && loc.page <= pdf.numPages ? loc.page : undefined;
      if (loc.page && loc.page <= pdf.numPages && bestMatch(await pageText(loc.page), loc)) return loc.page;
      let best: { n: number; score: number } | null = null;
      for (let n = 1; n <= pdf.numPages; n++) {
        const m = bestMatch(await pageText(n), { ...loc, index: undefined });
        const nearer = best && loc.page !== undefined && Math.abs(n - loc.page) < Math.abs(best.n - loc.page);
        if (m && (!best || m.score > best.score || (m.score === best.score && nearer))) best = { n, score: m.score };
      }
      return best?.n;
    };
    const locate: Locate = async (loc, avoid) => {
      const n = await findPage(loc);
      const scroller = pagesRef.current?.parentElement;
      if (!n || !scroller) return false;
      const end = Date.now() + 6000;
      let jumped = false;
      while (Date.now() < end) {
        const div = pagesRef.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`);
        if (div && !jumped) {
          scroller.scrollBy({ top: div.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8, behavior: 'instant' });
          jumped = true;
        }
        if (div && !loc.quote && loc.region) {
          // A picture without text: where it was on its page (pages keep their proportions at any zoom).
          const box = () => regionRect(div, loc.region!);
          scrollToBox(div, box, avoid);
          flashBoxes(document, () => [box()], scroller);
          return true;
        }
        const layer = div?.querySelector('.textLayer');
        const range = layer && findTerm(layer, n === loc.page ? loc : { ...loc, index: undefined });
        if (range) {
          scrollToRange(range, avoid);
          flashRange(range, scroller);
          return true;
        }
        await new Promise((r) => setTimeout(r, 60));
      }
      return false;
    };
    onHandle({
      locate,
      // The text of every page under the area; its place is kept on the page under its middle.
      area: async (rect) => {
        const pages = pagesRef.current;
        const mid = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
        const page = [...(pages?.querySelectorAll<HTMLElement>('.pdf-page') ?? [])].find((p) => {
          const b = p.getBoundingClientRect();
          return mid.x >= b.left && mid.x <= b.right && mid.y >= b.top && mid.y <= b.bottom;
        });
        const all = pages ? areaText(pages, rect) : { text: '', pictures: true };
        const layer = page?.querySelector('.textLayer');
        const first = layer ? areaText(layer, rect).locator : undefined;
        const n = Number(page?.dataset.page) || undefined;
        return {
          text: all.text,
          pictures: true,
          locator: { ...(first ?? { quote: '', prefix: '', suffix: '' }), ...(n ? { page: n } : {}), ...(page ? { region: toRegion(page, rect) } : {}) },
        };
      },
    });
    return () => onHandle(null);
  }, [pdf, onHandle]);

  if (error) return <div className="doc-message">{t('loadFailed')}: {error}</div>;
  return (
    <div className="pdf-reader">
      <div className="doc-toolbar">
        <button className="icon" title={t('pdfZoomOut')} aria-label={t('pdfZoomOut')} onClick={() => props.onZoom(clampZoom(props.zoom / 1.15))}>
          <Icon name="minimize" />
        </button>
        <span className="zoom">{Math.round(props.zoom * 100)}%</span>
        <button className="icon" title={t('pdfZoomIn')} aria-label={t('pdfZoomIn')} onClick={() => props.onZoom(clampZoom(props.zoom * 1.15))}>
          <Icon name="plus" />
        </button>
        {pdf ? <span className="muted">{pdf.numPages} p.</span> : <span className="muted">{t('loading')}</span>}
      </div>
      <div className="doc-scroll doc-surface">
        <div className="pdf-pages" ref={pagesRef} />
      </div>
    </div>
  );
}

/** The page at the middle of the panel (or the nearest one) and where the middle is on it. */
function pageSpot(host: HTMLElement, scroller: HTMLElement): { n: number; fx: number; fy: number; x: number; y: number } | undefined {
  const s = scroller.getBoundingClientRect();
  const x = s.left + s.width / 2;
  const y = s.top + s.height / 2;
  let best: { el: HTMLElement; d: number } | undefined;
  for (const el of host.children as HTMLCollectionOf<HTMLElement>) {
    const b = el.getBoundingClientRect();
    const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
    if (!best || d < best.d) best = { el, d };
    if (b.top > y) break;
  }
  if (!best) return undefined;
  const b = best.el.getBoundingClientRect();
  if (!b.width || !b.height) return undefined;
  return { n: Number(best.el.dataset.page), fx: (x - b.left) / b.width, fy: (y - b.top) / b.height, x, y };
}
