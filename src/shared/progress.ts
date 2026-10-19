// How far a run has likely got, for the bar on its card. Models report no
// percentage, so this is an estimate from what is known: how long it has run,
// whether the answer has started to arrive and how much of it. It slows down as
// it goes and never reaches the end by itself; only a finished run fills the bar.

export interface ProgressInput {
  status: 'queued' | 'running' | 'done' | 'partial' | 'error' | 'cancelled';
  /** Short answer ('direct') or a task in a job folder ('agent'). */
  runner: 'direct' | 'agent';
  elapsedMs: number;
  /** Characters of the answer streamed so far (short answers). */
  textLength: number;
}

/** Fraction 0–1, or null while waiting in the queue (shown as "not started"). */
export function estimateProgress(p: ProgressInput): number | null {
  if (p.status === 'queued') return null;
  if (p.status !== 'running') return 1;
  const ease = (x: number, scale: number) => 1 - Math.exp(-x / scale);
  if (p.runner === 'agent') return 0.04 + 0.86 * ease(p.elapsedMs, 120_000);
  // A short answer: thinking until the first words (up to half), then the words themselves.
  if (p.textLength === 0) return 0.06 + 0.38 * ease(p.elapsedMs, 5_000);
  return 0.5 + 0.42 * ease(p.textLength, 500);
}
