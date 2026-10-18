// P1-3: cleanup only touches unreferenced, finished, app-owned job folders.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanJobs } from '../src/main/retention';
import { tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const job = (id: string, status: string, ageDays: number) => {
  const p = path.join(dir, id);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'job.json'), JSON.stringify({ id, status }));
  const t = new Date(Date.now() - ageDays * 86_400_000);
  fs.utimesSync(p, t, t);
};

it('removes old and excess unreferenced jobs, keeps referenced, running and foreign entries', () => {
  job('old-unref-0001', 'done', 90);
  job('old-kept-00001', 'done', 90);
  job('old-running-01', 'running', 90);
  job('new-unref-0001', 'done', 1);
  job('new-unref-0002', 'done', 2);
  job('new-unref-0003', 'done', 3);
  fs.mkdirSync(path.join(dir, 'Not A Job'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'linked-job-01'));
  const r = cleanJobs({ jobsDir: dir, keep: new Set(['old-kept-00001']), maxAgeDays: 60, maxUnreferenced: 2 });
  expect(r.removed.sort()).toEqual(['new-unref-0003', 'old-unref-0001']);
  for (const keep of ['old-kept-00001', 'old-running-01', 'new-unref-0001', 'new-unref-0002', 'Not A Job', 'notes.txt', 'outside', 'linked-job-01']) {
    expect(fs.existsSync(path.join(dir, keep))).toBe(true);
  }
});
