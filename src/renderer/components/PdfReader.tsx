import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { T } from '../../shared/i18n';
import { cleanExtracted } from '../../shared/text';
import type { DocInfo } from '../../shared/types';
import { api } from '../api';
import { Icon } from './Icon';

GlobalWorkerOptions.workerSrc = workerUrl;
const asset = (p: string) => new URL(`./pdfjs/${p}`, location.href).href;
const RENDER_CONCURRENCY = 2;
/** Text extraction stops here; the main process trims to what it may send anyway. */
const MAX_EXTRACT_CHARS = 1_000_000;

export function PdfReader(props: { doc: DocInfo; t: T; onText: (text: string, title?: string) => void }) {
  const { doc, t } = props;
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState(1.25);
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
    host.replaceChildren();
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
      const vp = first.getViewport({ scale });
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

  if (error) return <div className="doc-message">{t('loadFailed')}: {error}</div>;
  return (
    <div className="pdf-reader">
      <div className="doc-toolbar">
        <button className="icon" title={t('pdfZoomOut')} aria-label={t('pdfZoomOut')} onClick={() => setScale((s) => Math.max(0.5, +(s - 0.15).toFixed(2)))}>
          <Icon name="minimize" />
        </button>
        <span className="zoom">{Math.round(scale * 100)}%</span>
        <button className="icon" title={t('pdfZoomIn')} aria-label={t('pdfZoomIn')} onClick={() => setScale((s) => Math.min(4, +(s + 0.15).toFixed(2)))}>
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
