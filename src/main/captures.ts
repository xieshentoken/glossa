// Pictures of captured document areas (the "capture an area" card). Stored in
// <userData>/captures/<sha256>.png: the id is the content hash, so the same
// picture is stored once and a cache key can name it. Only the main process
// reads or writes them; the renderer gets an id and a data URL to show.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './cache';
import { writeFileAtomic } from './fs-safe';

const ID_RE = /^[a-f0-9]{64}$/;
/** Longest side sent to a model; larger captures are scaled down before saving. */
export const MAX_CAPTURE_SIDE = 1600;

export class CaptureStore {
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id: string): string {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid picture id');
    return path.join(this.dir, `${id}.png`);
  }

  save(png: Buffer): string {
    const id = sha256(png);
    const file = this.file(id);
    if (!fs.existsSync(file)) writeFileAtomic(file, png);
    return id;
  }

  has(id: string): boolean {
    try {
      return fs.statSync(this.file(id)).isFile();
    } catch {
      return false;
    }
  }

  read(id: string): Buffer {
    return fs.readFileSync(this.file(id));
  }

  dataUrl(id: string): string | undefined {
    return this.has(id) ? `data:image/png;base64,${this.read(id).toString('base64')}` : undefined;
  }

  /** Removes pictures no card or job uses any more, once they are a day old (a card may be on its way). */
  prune(keep: Set<string>, now = Date.now()): string[] {
    const removed: string[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      const id = f.replace(/\.png$/, '');
      if (!ID_RE.test(id) || keep.has(id)) continue;
      const p = path.join(this.dir, f);
      if (now - fs.statSync(p).mtimeMs > 86_400_000) {
        fs.rmSync(p, { force: true });
        removed.push(id);
      }
    }
    return removed;
  }
}
