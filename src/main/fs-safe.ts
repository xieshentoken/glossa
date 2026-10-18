// File access confined to an allowed root: no "..", no absolute paths, no
// symbolic links on the way, no hard-linked files. Used for job outputs, skill
// imports and agent workspaces, which may contain files written by a model.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

/** Resolve `rel` (URL-style, may be percent-encoded) under `root`, refusing anything that leaves it. */
export function resolveInside(root: string, rel: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    throw new UnsafePathError('Malformed path');
  }
  if (decoded.includes('\0')) throw new UnsafePathError('NUL in path');
  const parts = decoded.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new UnsafePathError('Parent segments are not allowed');
  if (/^[a-zA-Z]:/.test(parts[0] ?? '')) throw new UnsafePathError('Drive paths are not allowed');
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + path.sep)) throw new UnsafePathError('Path leaves its folder');
  return full;
}

/** True when `child` is `root` or inside it, comparing real paths. */
export function isInsideReal(root: string, child: string): boolean {
  const r = fs.realpathSync(root);
  const c = fs.realpathSync(child);
  return c === r || c.startsWith(r + path.sep);
}

/** Every component from root to `full` must exist and be a real directory/file, not a link. */
function assertNoLinks(root: string, full: string): void {
  const base = path.resolve(root);
  const rel = path.relative(base, full);
  let cur = base;
  if (fs.lstatSync(cur).isSymbolicLink()) throw new UnsafePathError('Root is a symbolic link');
  for (const part of rel ? rel.split(path.sep) : []) {
    cur = path.join(cur, part);
    if (fs.lstatSync(cur).isSymbolicLink()) throw new UnsafePathError(`Symbolic link refused: ${part}`);
  }
}

export interface SafeReadOptions {
  maxBytes: number;
}

/**
 * Read a regular file under `root` without following links. The final open uses
 * O_NOFOLLOW; on Linux the opened descriptor's real path is checked too, which
 * closes the race where a directory is swapped for a link between check and open.
 * Elsewhere the per-component check runs before the open, with a small window left.
 */
export function readFileSafe(root: string, rel: string, opts: SafeReadOptions): Buffer {
  const full = resolveInside(root, rel);
  assertNoLinks(root, full);
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new UnsafePathError('Not a regular file');
    if (st.nlink > 1) throw new UnsafePathError('Hard-linked files are refused');
    if (st.size > opts.maxBytes) throw new UnsafePathError(`File too large (${st.size} bytes)`);
    if (process.platform === 'linux') {
      const real = fs.readlinkSync(`/proc/self/fd/${fd}`);
      const r = fs.realpathSync(root);
      if (!real.startsWith(r + path.sep)) throw new UnsafePathError('File resolved outside its folder');
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === st.size ? buf : buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

/** Like readFileSafe, but returns undefined for missing or refused files. */
export function tryReadFileSafe(root: string, rel: string, opts: SafeReadOptions): Buffer | undefined {
  try {
    return readFileSafe(root, rel, opts);
  } catch {
    return undefined;
  }
}

export interface CopyOptions {
  skip?: Set<string>;
  maxFiles?: number;
  maxBytes?: number;
}

/**
 * Copy a directory tree of regular files and folders. Symbolic links, hard-linked
 * files, sockets and devices make the whole copy fail (nothing is half-imported:
 * the tree is checked before anything is written).
 */
export function copyTreeSafe(src: string, dest: string, opts: CopyOptions = {}): { files: number; bytes: number } {
  const skip = opts.skip ?? new Set(['.git', 'node_modules', '.DS_Store']);
  const maxFiles = opts.maxFiles ?? 5000;
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  const plan: { rel: string; dir: boolean }[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    const abs = path.join(src, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) throw new UnsafePathError(`Symbolic link refused: ${rel || '.'}`);
    if (st.isDirectory()) {
      plan.push({ rel, dir: true });
      for (const name of fs.readdirSync(abs).sort()) if (!skip.has(name)) walk(path.join(rel, name));
      return;
    }
    if (!st.isFile()) throw new UnsafePathError(`Special file refused: ${rel}`);
    if (st.nlink > 1) throw new UnsafePathError(`Hard-linked file refused: ${rel}`);
    bytes += st.size;
    plan.push({ rel, dir: false });
    if (plan.length > maxFiles) throw new UnsafePathError(`Too many files (over ${maxFiles})`);
    if (bytes > maxBytes) throw new UnsafePathError(`Folder too large (over ${maxBytes} bytes)`);
  };
  walk('');
  for (const item of plan) {
    const to = item.rel ? resolveInside(dest, item.rel) : dest;
    if (item.dir) fs.mkdirSync(to, { recursive: true });
    else fs.copyFileSync(path.join(src, item.rel), to, fs.constants.COPYFILE_EXCL);
  }
  return { files: plan.filter((p) => !p.dir).length, bytes };
}

/** Write via a temporary file and rename, so readers never see a half-written file. */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

/** Content hash of a directory tree (relative paths + bytes), refusing links. */
export function hashTree(dir: string, skip = new Set(['.git', 'node_modules', '.DS_Store'])): string {
  const h = crypto.createHash('sha256');
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) throw new UnsafePathError(`Symbolic link refused: ${rel}`);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) if (!skip.has(name)) walk(path.join(rel, name));
    } else if (st.isFile()) {
      h.update(`F ${rel.split(path.sep).join('/')} ${st.size}\n`);
      h.update(fs.readFileSync(abs));
    }
  };
  walk('');
  return h.digest('hex');
}
