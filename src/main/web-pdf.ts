// PDFs on the web open in the PDF reader, not as a page. The file is downloaded
// in the web pages' session (same cookies, same rules) to <userData>/web-pdfs and
// opened from there; reopening downloads it again. Old copies are removed.
//
// A web address is taken for a PDF when its path ends in .pdf, when it is an arXiv
// PDF link, or when the web view tried to download it as a PDF (a link clicked on a page).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-safe';

/** Largest PDF downloaded. */
export const MAX_WEB_PDF_BYTES = 200 * 1024 * 1024;
/** Downloaded copies older than this are removed. */
const KEEP_DAYS = 7;

export type Fetch = (url: string) => Promise<Response>;

export class WebPdfs {
  /** Addresses the web view tried to download as PDFs. */
  private known = new Set<string>();

  constructor(
    private dir: string,
    private fetchImpl: Fetch,
  ) {}

  remember(url: string): void {
    this.known.add(url);
  }

  isPdf(url: string): boolean {
    return this.known.has(url) || looksLikePdfUrl(url);
  }

  /** The PDF behind an address, saved locally; undefined when the address is not a PDF after all (a page about it, a sign-in page). */
  async download(url: string): Promise<{ file: string; title: string } | undefined> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`The PDF could not be downloaded (HTTP ${res.status}).`);
    const type = res.headers.get('content-type') ?? '';
    if (/text\/html|application\/xhtml/i.test(type)) {
      await res.body?.cancel();
      return undefined;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_WEB_PDF_BYTES) throw tooLarge(declared);
    const data = await readCapped(res);
    if (!isPdfData(data)) return undefined;
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune();
    const file = path.join(this.dir, `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 32)}.pdf`);
    writeFileAtomic(file, data);
    return { file, title: pdfTitle(res.url || url, res.headers.get('content-disposition')) };
  }

  private prune(now = Date.now()): void {
    for (const f of fs.readdirSync(this.dir)) {
      const p = path.join(this.dir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > KEEP_DAYS * 86_400_000) fs.rmSync(p, { force: true });
      } catch {
        // already gone
      }
    }
  }
}

export function looksLikePdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return /\.pdf$/i.test(decodeURIComponent(u.pathname)) || (/(^|\.)arxiv\.org$/i.test(u.hostname) && /^\/pdf\//.test(u.pathname));
  } catch {
    return false;
  }
}

/** PDF data starts with "%PDF-" (readers accept a little junk before it). */
export function isPdfData(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, 1024)).includes('%PDF-');
}

function tooLarge(bytes: number): Error {
  return new Error(`The PDF is too large (${Math.round(bytes / 1048576)} MB, at most ${MAX_WEB_PDF_BYTES / 1048576} MB).`);
}

async function readCapped(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_WEB_PDF_BYTES) {
      await reader.cancel();
      throw tooLarge(size);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The file name the server gives, else the last part of the address. */
export function pdfTitle(url: string, disposition?: string | null): string {
  const star = disposition && /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition)?.[1];
  const plain = disposition && /filename\s*=\s*"?([^";]+)"?/.exec(disposition)?.[1];
  let name = '';
  try {
    name = star ? decodeURIComponent(star) : (plain ?? '');
  } catch {
    name = plain ?? '';
  }
  if (!name) {
    try {
      const u = new URL(url);
      name = decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1) ?? '') || u.hostname;
    } catch {
      name = url;
    }
  }
  name = name.trim().replace(/[\\/]/g, '_');
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}
