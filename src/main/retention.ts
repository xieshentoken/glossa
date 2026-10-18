// Removes old job folders the app created and no longer needs. Only touches
// <userData>/jobs/<id> folders with a job id name; never user documents.

import fs from 'node:fs';
import path from 'node:path';

const JOB_DIR_RE = /^[a-z0-9-]{8,64}$/;

export interface RetentionOptions {
  jobsDir: string;
  /** Jobs still referenced by a card, the cache, or a running/shared job. */
  keep: Set<string>;
  maxAgeDays: number;
  /** Keep at most this many unreferenced finished jobs (newest first). */
  maxUnreferenced: number;
  now?: number;
}

export function cleanJobs(o: RetentionOptions): { removed: string[]; kept: number } {
  if (!fs.existsSync(o.jobsDir)) return { removed: [], kept: 0 };
  const now = o.now ?? Date.now();
  const candidates: { id: string; mtime: number }[] = [];
  for (const id of fs.readdirSync(o.jobsDir)) {
    if (!JOB_DIR_RE.test(id) || o.keep.has(id)) continue;
    const p = path.join(o.jobsDir, id);
    const st = fs.lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    let status = '';
    try {
      status = JSON.parse(fs.readFileSync(path.join(p, 'job.json'), 'utf8')).status;
    } catch {
      // no metadata: treat as finished leftovers
    }
    if (status === 'running' || status === 'queued') continue;
    candidates.push({ id, mtime: st.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  candidates.forEach((c, i) => {
    const old = now - c.mtime > o.maxAgeDays * 86_400_000;
    if (old || i >= o.maxUnreferenced) {
      fs.rmSync(path.join(o.jobsDir, c.id), { recursive: true, force: true });
      removed.push(c.id);
    }
  });
  return { removed, kept: candidates.length - removed.length };
}
