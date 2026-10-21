// PDFs on the web: recognised, downloaded in the web session and opened in the PDF reader.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentService } from '../src/main/documents';
import { isPdfData, looksLikePdfUrl, MAX_WEB_PDF_BYTES, pdfTitle, WebPdfs, type Fetch } from '../src/main/web-pdf';
import { lockDownSession, type DownloadLike, type SessionLike } from '../src/main/web-security';
import { makePdf } from './fixtures/make-pdf.mjs';
import { tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const PDF = Buffer.from(makePdf(['Boundary layer', 'Viscous effects near a wall.']));
const serve = (routes: Record<string, { body: BodyInit; type?: string; status?: number; headers?: Record<string, string> }>): Fetch & { calls: string[] } => {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('missing', { status: 404 });
    return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'application/pdf', ...r.headers } });
  };
  return Object.assign(f, { calls });
};

describe('PDF web addresses', () => {
  it('are recognised by a .pdf path or an arXiv PDF link, not by a query or a fragment', () => {
    expect(looksLikePdfUrl('https://example.com/papers/flow.pdf')).toBe(true);
    expect(looksLikePdfUrl('https://example.com/papers/FLOW.PDF?download=1')).toBe(true);
    expect(looksLikePdfUrl('https://example.com/a%20b.pdf')).toBe(true);
    expect(looksLikePdfUrl('https://arxiv.org/pdf/2401.01234v2')).toBe(true);
    expect(looksLikePdfUrl('https://export.arxiv.org/pdf/2401.01234')).toBe(true);
    expect(looksLikePdfUrl('https://arxiv.org/abs/2401.01234')).toBe(false);
    expect(looksLikePdfUrl('https://example.com/view?file=x.pdf')).toBe(false);
    expect(looksLikePdfUrl('https://example.com/page#x.pdf')).toBe(false);
    expect(looksLikePdfUrl('file:///tmp/x.pdf')).toBe(false);
    expect(looksLikePdfUrl('not a url')).toBe(false);
  });

  it('are titled by the server’s file name, else the address', () => {
    expect(pdfTitle('https://x.org/dl?id=3', 'attachment; filename="Heat Transfer.pdf"')).toBe('Heat Transfer.pdf');
    expect(pdfTitle('https://x.org/dl', "attachment; filename*=UTF-8''%E7%83%AD%E4%BC%A0%E5%AF%BC.pdf")).toBe('热传导.pdf');
    expect(pdfTitle('https://x.org/papers/flow%20notes.pdf')).toBe('flow notes.pdf');
    expect(pdfTitle('https://arxiv.org/pdf/2401.01234v2')).toBe('2401.01234v2.pdf');
    expect(pdfTitle('https://x.org/')).toBe('x.org.pdf');
  });

  it('checks the data really is a PDF', () => {
    expect(isPdfData(PDF)).toBe(true);
    expect(isPdfData(Buffer.from('<!doctype html><title>Sign in</title>'))).toBe(false);
  });
});

describe('downloading', () => {
  it('saves the PDF and opens it in the PDF reader, the address staying its source', async () => {
    const url = 'https://example.com/papers/boundary.pdf';
    const pdfs = new WebPdfs(path.join(dir, 'web-pdfs'), serve({ [url]: { body: PDF } }));
    const got = await pdfs.download(url);
    expect(got?.title).toBe('boundary.pdf');
    expect(fs.readFileSync(got!.file).equals(PDF)).toBe(true);
    const docs = new DocumentService();
    const info = await docs.describeDownloadedPdf(url, got!.file, got!.title);
    expect(info).toMatchObject({ kind: 'pdf', source: url, title: 'boundary.pdf' });
    const loaded = await docs.load(info.docId);
    expect(loaded.kind === 'pdf' && Buffer.from(loaded.data).equals(PDF)).toBe(true);
    // The same PDF opened from disk is the same document (its cards are shared).
    const local = path.join(dir, 'boundary.pdf');
    fs.writeFileSync(local, PDF);
    expect((await docs.describeFile(local)).docId).toBe(info.docId);
  });

  it('gives up on pages (a sign-in or landing page at a .pdf address) so they open as web pages', async () => {
    const url = 'https://example.com/locked.pdf';
    const pdfs = new WebPdfs(dir, serve({ [url]: { body: '<!doctype html><p>Sign in</p>', type: 'text/html' } }));
    expect(await pdfs.download(url)).toBeUndefined();
    const sniffed = new WebPdfs(dir, serve({ [url]: { body: 'not a pdf', type: 'application/octet-stream' } }));
    expect(await sniffed.download(url)).toBeUndefined();
  });

  it('reports HTTP errors and refuses PDFs that are too large', async () => {
    const pdfs = new WebPdfs(dir, serve({ 'https://x.org/big.pdf': { body: PDF, headers: { 'content-length': String(MAX_WEB_PDF_BYTES + 1) } } }));
    await expect(pdfs.download('https://x.org/gone.pdf')).rejects.toThrow(/HTTP 404/);
    await expect(pdfs.download('https://x.org/big.pdf')).rejects.toThrow(/too large/);
  });

  it('remembers addresses the web view downloaded as PDFs', () => {
    const pdfs = new WebPdfs(dir, serve({}));
    expect(pdfs.isPdf('https://journal.org/article/123/download')).toBe(false);
    pdfs.remember('https://journal.org/article/123/download');
    expect(pdfs.isPdf('https://journal.org/article/123/download')).toBe(true);
  });

  it('removes copies older than a week', async () => {
    const url = 'https://x.org/new.pdf';
    const store = path.join(dir, 'web-pdfs');
    fs.mkdirSync(store);
    const old = path.join(store, 'old.pdf');
    fs.writeFileSync(old, PDF);
    const longAgo = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(old, longAgo, longAgo);
    await new WebPdfs(store, serve({ [url]: { body: PDF } })).download(url);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readdirSync(store)).toHaveLength(1);
  });
});

describe('a PDF link clicked on a page', () => {
  const session = () => {
    let onDownload: ((e: { preventDefault(): void }, item: DownloadLike) => void) | undefined;
    const ses: SessionLike = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on: (_e, f) => void (onDownload = f) };
    return { ses, download: (item: DownloadLike) => onDownload!({ preventDefault() {} }, item) };
  };

  it('is not downloaded but handed to the reader; other downloads are just refused', () => {
    const s = session();
    const opened: string[] = [];
    lockDownSession(s.ses, undefined, (u) => opened.push(u));
    let cancelled = 0;
    const item = (url: string, mime: string, name: string): DownloadLike => ({ cancel: () => void cancelled++, getURL: () => url, getMimeType: () => mime, getFilename: () => name });
    s.download(item('https://journal.org/a/1/download', 'application/pdf', 'download'));
    s.download(item('https://x.org/f', 'application/octet-stream', 'paper.PDF'));
    s.download(item('https://x.org/setup.zip', 'application/zip', 'setup.zip'));
    s.download(item('data:application/pdf;base64,JVBERi0=', 'application/pdf', 'x.pdf'));
    expect(cancelled).toBe(4);
    expect(opened).toEqual(['https://journal.org/a/1/download', 'https://x.org/f']);
  });
});
