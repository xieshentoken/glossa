// Opening documents. The renderer can only load files the user picked
// (tracked in `allowed`), never arbitrary paths.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { marked } from 'marked';
import type { LoadedDoc } from '../shared/api';
import type { DocInfo, DocKind } from '../shared/types';

export const FILE_KINDS: Record<string, DocKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.html': 'html',
  '.htm': 'html',
};

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Largest document the reader opens. */
export const MAX_DOC_BYTES = 512 * 1024 * 1024;

/** Hash a file by streaming it, so large documents do not block the main process. */
export async function hashFile(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https addresses can be opened');
  u.hash = '';
  return u.toString();
}

export class DocumentService {
  private allowed = new Map<string, DocInfo>();
  private texts = new Map<string, string>();

  async describeFile(file: string): Promise<DocInfo> {
    const kind = FILE_KINDS[path.extname(file).toLowerCase()];
    if (!kind) throw new Error(`Unsupported file type: ${path.extname(file) || file}`);
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error('Not a file');
    if (st.size > MAX_DOC_BYTES) throw new Error(`The file is too large (${Math.round(st.size / 1048576)} MB).`);
    const info: DocInfo = {
      docId: await hashFile(file),
      kind,
      title: path.basename(file),
      source: file,
      openedAt: Date.now(),
    };
    this.allowed.set(info.docId, info);
    return info;
  }

  describeUrl(input: string): DocInfo {
    const url = normalizeUrl(input);
    const u = new URL(url);
    const info: DocInfo = { docId: sha256(url), kind: 'web', title: u.hostname + u.pathname, source: url, openedAt: Date.now() };
    this.allowed.set(info.docId, info);
    return info;
  }

  /** Re-open a recent document. */
  async reopen(info: DocInfo): Promise<DocInfo> {
    if (info.kind === 'web') return this.describeUrl(info.source);
    if (!fs.existsSync(info.source)) throw new Error(`File not found: ${info.source}`);
    return this.describeFile(info.source);
  }

  info(docId: string): DocInfo | undefined {
    return this.allowed.get(docId);
  }

  async load(docId: string): Promise<LoadedDoc> {
    const info = this.allowed.get(docId);
    if (!info) throw new Error('This document was not opened in this session');
    switch (info.kind) {
      case 'web':
        return { kind: 'web', url: info.source };
      case 'pdf':
        return { kind: 'pdf', data: new Uint8Array(await fs.promises.readFile(info.source)) };
      case 'docx': {
        const buf = await fs.promises.readFile(info.source);
        const [{ value: html }, { value: text }] = await Promise.all([
          mammoth.convertToHtml({ buffer: buf }),
          mammoth.extractRawText({ buffer: buf }),
        ]);
        return { kind: 'html', html, text };
      }
      case 'markdown': {
        const md = await fs.promises.readFile(info.source, 'utf8');
        return { kind: 'html', html: await marked.parse(md), text: md };
      }
      case 'html':
        return { kind: 'html', html: await fs.promises.readFile(info.source, 'utf8') };
      case 'text': {
        const txt = await fs.promises.readFile(info.source, 'utf8');
        const html = txt
          .split(/\n{2,}/)
          .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
          .join('\n');
        return { kind: 'html', html, text: txt };
      }
    }
  }

  /** Store extracted text. Returns false when nothing changed (same text as before). */
  setText(docId: string, text: string): boolean {
    if (!this.allowed.has(docId)) return false;
    if (this.texts.get(docId) === text) return false;
    this.texts.set(docId, text);
    return true;
  }

  /** Forget extracted text of documents no longer open. */
  release(docId: string): void {
    this.texts.delete(docId);
  }

  text(docId: string): string | undefined {
    return this.texts.get(docId);
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
