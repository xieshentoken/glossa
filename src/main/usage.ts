// What each model connection (that is, each API key) has used, per day and per
// month, and the limits set for it (Settings → Models & effort → Usage limits).
// Counted from what Pi reports after each run: dollars where the model's price
// is known, tokens always. Only Glossa's own use is counted; a limit set in the
// provider's console is the one that also covers other apps and leaked keys.

import type { Settings, UsageLimit, UsageStatus, UsageTotals } from '../shared/types';
import { readJson, writeJson } from './store';

type Ledger = Record<string, Record<string, UsageTotals>>;

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const periodKey = (period: UsageLimit['period'], d: Date) => (period === 'day' ? dayKey(d) : monthKey(d));
const nextPeriod = (period: UsageLimit['period'], d: Date) =>
  (period === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) : new Date(d.getFullYear(), d.getMonth() + 1, 1)).getTime();

const empty = (): UsageTotals => ({ usd: 0, tokens: 0, runs: 0, unpriced: 0 });

export function usageRatio(t: Pick<UsageTotals, 'usd' | 'tokens'>, limit: UsageLimit | undefined): number | undefined {
  if (!limit || (!limit.usd && !limit.tokens)) return undefined;
  return Math.max(limit.usd ? t.usd / limit.usd : 0, limit.tokens ? t.tokens / limit.tokens : 0);
}

export class UsageStore {
  private ledger: Ledger;

  constructor(
    readonly file: string,
    private now: () => Date = () => new Date(),
  ) {
    this.ledger = readJson<Ledger>(file, {});
  }

  /** Adds one run's use to today's and this month's totals. */
  record(providerId: string, use: { usd?: number; tokens?: number; priced: boolean }): void {
    const d = this.now();
    const p = (this.ledger[providerId] ??= {});
    for (const key of [dayKey(d), monthKey(d)]) {
      const t = (p[key] ??= empty());
      t.usd += use.usd ?? 0;
      t.tokens += use.tokens ?? 0;
      t.runs += 1;
      if (!use.priced) t.unpriced += 1;
    }
    // Keep about two months of days and a year of months.
    const keep = new Set<string>();
    for (let i = 0; i < 62; i++) keep.add(dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i)));
    for (let i = 0; i < 12; i++) keep.add(monthKey(new Date(d.getFullYear(), d.getMonth() - i, 1)));
    for (const k of Object.keys(p)) if (!keep.has(k)) delete p[k];
    writeJson(this.file, this.ledger);
  }

  status(settings: Pick<Settings, 'usageLimits'>, providerId: string): UsageStatus {
    const limit = settings.usageLimits[providerId];
    const period = limit?.period ?? 'month';
    const d = this.now();
    const t = this.ledger[providerId]?.[periodKey(period, d)] ?? empty();
    return { ...t, providerId, period, resetsAt: nextPeriod(period, d), limit, ratio: usageRatio(t, limit) };
  }

  /** Dollars left in the period, when a dollar limit is set. */
  remainingUsd(settings: Pick<Settings, 'usageLimits'>, providerId: string): number | undefined {
    const s = this.status(settings, providerId);
    return s.limit?.usd ? Math.max(0, s.limit.usd - s.usd) : undefined;
  }
}
