// Opening documents. The renderer can only load files the user picked
// (tracked in `allowed`), never arbitrary paths.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { marked } from 'marked';
import type { LoadedDoc } from '../shared/api';
import type { DocInfo, DocKind } from '../shared/types';
import { readSessionFile, sessionPage, sniffSessionFile } from './sessions';

/** Source code and data files, shown as numbered lines. */
export const CODE_EXTS = [
  'py', 'pyi', 'ipynb', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml', 'xsd',
  'css', 'scss', 'sass', 'less', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'go', 'rs', 'swift', 'm', 'mm',
  'rb', 'php', 'pl', 'pm', 'lua', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'cljs', 'elm', 'fs', 'fsx', 'ml', 'nim', 'zig', 'v',
  'sql', 'graphql', 'gql', 'proto', 'tf', 'hcl', 'cmake', 'mk', 'dockerfile', 'tex', 'bib', 'rst', 'csv', 'tsv', 'log', 'diff', 'patch', 'jsonl', 'ndjson',
];

export const FILE_KINDS: Record<string, DocKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.html': 'html',
  '.htm': 'html',
  ...Object.fromEntries(CODE_EXTS.map((e) => [`.${e}`, 'code' as const])),
};

/** Code files known by name rather than extension. */
const CODE_NAMES = new Set(['dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'cmakelists.txt', 'gemfile', 'rakefile', 'procfile', 'vagrantfile', 'jenkinsfile', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig', '.env', '.npmrc', '.bashrc', '.zshrc', '.profile']);

export function fileKind(file: string): DocKind | undefined {
  const name = path.basename(file).toLowerCase();
  return CODE_NAMES.has(name) ? 'code' : FILE_KINDS[path.extname(name)];
}

/** Code is shown line by line in the page; larger files would make the reader unusable. */
export const MAX_CODE_BYTES = 8 * 1024 * 1024;

/** Minified JSON (very long lines) is shown indented; anything else exactly as written. */
export function codeText(file: string, raw: string): string {
  const ext = path.extname(file).toLowerCase();
  if ((ext === '.json' || ext === '.ipynb') && raw.length > 2000 && raw.split('\n').length < raw.length / 400) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // not valid JSON: shown as it is
    }
  }
  return raw;
}

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
  /** Local copies of documents whose source is a web address (downloaded PDFs). */
  private copies = new Map<string, string>();

  async describeFile(file: string): Promise<DocInfo> {
    const kind = fileKind(file);
    if (!kind) throw new Error(`Unsupported file type: ${path.extname(file) || file}`);
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error('Not a file');
    if (st.size > MAX_DOC_BYTES) throw new Error(`The file is too large (${Math.round(st.size / 1048576)} MB).`);
    // A Claude Code or Codex session is shown as a conversation; other JSON Lines as code.
    const session = path.extname(file).toLowerCase() === '.jsonl' ? await sniffSessionFile(file) : undefined;
    const info: DocInfo = {
      docId: await hashFile(file),
      kind: session ? 'session' : kind,
      title: session?.title ?? path.basename(file),
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

  /** A PDF downloaded from `url` (see web-pdf.ts); the address stays its source. */
  async describeDownloadedPdf(url: string, file: string, title: string): Promise<DocInfo> {
    const info: DocInfo = { docId: await hashFile(file), kind: 'pdf', title, source: url, openedAt: Date.now() };
    this.copies.set(info.docId, file);
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
        return { kind: 'pdf', data: new Uint8Array(await fs.promises.readFile(this.copies.get(docId) ?? info.source)) };
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
      case 'code': {
        const st = await fs.promises.stat(info.source);
        if (st.size > MAX_CODE_BYTES) throw new Error(`This file is too large to show as code (${Math.round(st.size / 1048576)} MB, at most ${MAX_CODE_BYTES / 1048576} MB).`);
        return { kind: 'code', text: codeText(info.source, (await fs.promises.readFile(info.source, 'utf8')).replace(/^\uFEFF/, '')) };
      }
      case 'session': {
        const session = await sniffSessionFile(info.source);
        if (!session) throw new Error('This file is no longer a Claude Code or Codex session.');
        return { kind: 'html', ...(await sessionPage(await readSessionFile(info.source, session.agent))) };
      }
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
