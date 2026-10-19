// Usage limits per connection (per API key), and the estimate behind a run's progress bar.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PiTask } from '../src/main/runners/pi';
import { dayKey, monthKey, UsageStore, usageRatio } from '../src/main/usage';
import { vSettingsPatch } from '../src/main/validate';
import { estimateProgress } from '../src/shared/progress';
import { req, settle, setup, tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('usage ledger', () => {
  it('adds runs to the day and the month, and resets with the period', () => {
    let now = new Date(2026, 9, 18, 12);
    const u = new UsageStore(path.join(dir, 'usage.json'), () => now);
    const limits = { usageLimits: { a: { period: 'day' as const, usd: 1, tokens: 0 }, b: { period: 'month' as const, usd: 0, tokens: 1000 } } };
    u.record('a', { usd: 0.4, tokens: 300, priced: true });
    u.record('a', { tokens: 200, priced: false });
    expect(u.status(limits, 'a')).toMatchObject({ usd: 0.4, tokens: 500, runs: 2, unpriced: 1, period: 'day', ratio: 0.4 });
    expect(u.status(limits, 'a').resetsAt).toBe(new Date(2026, 9, 19).getTime());
    expect(u.remainingUsd(limits, 'a')).toBeCloseTo(0.6);
    u.record('b', { tokens: 900, priced: false });
    expect(u.status(limits, 'b').ratio).toBeCloseTo(0.9);
    expect(u.remainingUsd(limits, 'b')).toBeUndefined();
    // Saved, and read back by a new store.
    expect(new UsageStore(path.join(dir, 'usage.json'), () => now).status(limits, 'a').usd).toBeCloseTo(0.4);
    now = new Date(2026, 9, 19, 9);
    expect(u.status(limits, 'a')).toMatchObject({ usd: 0, runs: 0 });
    expect(u.status(limits, 'b').tokens).toBe(900);
    now = new Date(2026, 10, 1, 9);
    expect(u.status(limits, 'b').tokens).toBe(0);
    expect(dayKey(now)).toBe('2026-11-01');
    expect(monthKey(now)).toBe('2026-11');
  });

  it('uses the larger share of the dollar and token limits; no limit, no ratio', () => {
    expect(usageRatio({ usd: 2, tokens: 900 }, { period: 'month', usd: 10, tokens: 1000 })).toBeCloseTo(0.9);
    expect(usageRatio({ usd: 2, tokens: 900 }, { period: 'month', usd: 0, tokens: 0 })).toBeUndefined();
    expect(usageRatio({ usd: 2, tokens: 900 }, undefined)).toBeUndefined();
  });

  it('limits are checked settings', () => {
    expect(vSettingsPatch({ usageLimits: { anthropic: { period: 'day', usd: 2.5, tokens: 0 } } }).usageLimits).toEqual({ anthropic: { period: 'day', usd: 2.5, tokens: 0 } });
    expect(() => vSettingsPatch({ usageLimits: { anthropic: { period: 'week', usd: 1, tokens: 0 } } })).toThrow(/limit period/);
    expect(() => vSettingsPatch({ usageLimits: { anthropic: { period: 'day', usd: -1, tokens: 0 } } })).toThrow(/dollar limit/);
    expect(() => vSettingsPatch({ usageLimits: { '../x': { period: 'day', usd: 1, tokens: 0 } } })).toThrow(/provider id/);
  });
});

describe('runs and usage limits', () => {
  const pricedRunner = (usd: number, tokens: number) => {
    const tasks: PiTask[] = [];
    return { tasks, piRunner: async (o: { task: PiTask }) => (tasks.push(o.task), { text: 'An answer.', stop: 'complete' as const, costUsd: usd, tokens, priced: true }) };
  };

  it('every Pi run is counted for its connection, and a run is held to the dollars left', async () => {
    const r = pricedRunner(0.3, 1200);
    const h = setup(dir, { usageLimits: { demo: { period: 'month', usd: 1, tokens: 0 } } }, { piRunner: r.piRunner });
    await settle(h.jobs, (await h.jobs.start(req('quick-gloss'))).id);
    expect(h.store.usage.status(h.store.getSettings(), 'demo')).toMatchObject({ usd: 0.3, tokens: 1200, runs: 1 });
    // Short answers had no budget; now they get what is left.
    expect(r.tasks[0].budgetUsd).toBeCloseTo(1);
    await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(r.tasks[1].budgetUsd).toBeCloseTo(0.7);
  });

  it('at the limit nothing new starts on that connection, the automatic Quick included; cached answers still show', async () => {
    const r = pricedRunner(0.6, 100);
    const h = setup(dir, { usageLimits: { demo: { period: 'day', usd: 1, tokens: 0 } } }, { piRunner: r.piRunner });
    await settle(h.jobs, (await h.jobs.start(req('quick-gloss'))).id);
    const second = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    // 80% or more: the card says so.
    expect(second.usageNote).toMatch(/Offline demo.*100% of this day's usage limit used/);
    await expect(h.jobs.start(req('quick-gloss', { force: true }))).rejects.toThrow(/reached its usage limit for this day \(\$1\.20 of \$1\.00\).*Usage limits, or wait until/);
    await expect(h.jobs.start(req('quick-gloss', { origin: 'auto', force: true }))).rejects.toThrow(/usage limit/);
    expect(await h.jobs.start(req('quick-gloss'))).toMatchObject({ cached: true });
    expect(r.tasks).toHaveLength(2);
    // Raising the limit lets runs start again.
    h.store.setSettings({ usageLimits: { demo: { period: 'day', usd: 5, tokens: 0 } } });
    expect((await settle(h.jobs, (await h.jobs.start(req('quick-gloss', { force: true }))).id)).status).toBe('done');
  });

  it('a token limit works where prices are unknown; other connections are not affected', async () => {
    const h = setup(dir, { usageLimits: { demo: { period: 'month', usd: 0, tokens: 1000 } } }, { piRunner: async () => ({ text: 'x', stop: 'complete' as const, tokens: 1000, priced: false }) });
    await settle(h.jobs, (await h.jobs.start(req('quick-gloss'))).id);
    expect(h.store.usage.status(h.store.getSettings(), 'demo')).toMatchObject({ unpriced: 1, ratio: 1 });
    await expect(h.jobs.start(req('eli5'))).rejects.toThrow(/1,000 of 1,000 tokens/);
    expect(h.store.usage.status(h.store.getSettings(), 'anthropic').runs).toBe(0);
  });

  it('a run that ends badly still counts what it used', async () => {
    const h = setup(dir, {}, { piRunner: async () => ({ text: '', stop: 'error' as const, error: 'overloaded', costUsd: 0.05, tokens: 40, priced: true }) });
    expect((await settle(h.jobs, (await h.jobs.start(req('quick-gloss'))).id)).status).toBe('error');
    expect(h.store.usage.status(h.store.getSettings(), 'demo')).toMatchObject({ usd: 0.05, tokens: 40, runs: 1 });
  });
});

describe('progress estimate', () => {
  const at = (o: Partial<Parameters<typeof estimateProgress>[0]>) => estimateProgress({ status: 'running', runner: 'direct', elapsedMs: 0, textLength: 0, ...o })!;

  it('waits, grows, never finishes by itself, and fills when done', () => {
    expect(estimateProgress({ status: 'queued', runner: 'direct', elapsedMs: 9000, textLength: 0 })).toBeNull();
    expect(at({ elapsedMs: 0 })).toBeCloseTo(0.06);
    expect(at({ elapsedMs: 3000 })).toBeGreaterThan(at({ elapsedMs: 1000 }));
    // Thinking stays under half; the first words move it past.
    expect(at({ elapsedMs: 600_000 })).toBeLessThan(0.5);
    expect(at({ elapsedMs: 1000, textLength: 1 })).toBeGreaterThanOrEqual(0.5);
    expect(at({ textLength: 5000 })).toBeLessThan(0.95);
    expect(at({ runner: 'agent', elapsedMs: 3_600_000 })).toBeLessThan(0.91);
    expect(at({ runner: 'agent', elapsedMs: 60_000 })).toBeGreaterThan(at({ runner: 'agent', elapsedMs: 10_000 }));
    for (const status of ['done', 'partial', 'error', 'cancelled'] as const) expect(estimateProgress({ status, runner: 'direct', elapsedMs: 0, textLength: 0 })).toBe(1);
  });
});
