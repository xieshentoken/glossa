import { useEffect, useRef, useState } from 'react';
import type { T } from '../../shared/i18n';
import { estimateProgress } from '../../shared/progress';
import type { JobState } from '../../shared/types';

/**
 * A thin bar at the top of a run: a sliding segment while it waits, an amber
 * bar that grows while it works, filled and fading out (green, or red on
 * failure) when it ends. Not shown for runs that had already ended when the
 * card opened.
 */
export function RunProgress(props: { job?: JobState; t: T }) {
  const { job, t } = props;
  const status = job?.status ?? 'queued';
  // Unknown (still loading) is not working: a finished run reopened later must not animate.
  const working = !!job && (status === 'running' || status === 'queued');
  // Only a run seen working gets the finishing animation.
  const seenWorking = useRef(working);
  if (working) seenWorking.current = true;
  const [now, setNow] = useState(Date.now());
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!working) return;
    setGone(false);
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [working]);
  useEffect(() => {
    if (working || !seenWorking.current) return;
    const id = setTimeout(() => setGone(true), 1400);
    return () => clearTimeout(id);
  }, [working]);

  if (!seenWorking.current || gone) return null;
  const p = estimateProgress({
    status,
    runner: job?.runner ?? 'direct',
    elapsedMs: Math.max(0, now - (job?.startedAt ?? now)),
    textLength: job?.text?.length ?? 0,
  });
  const end = status === 'done' || status === 'partial' ? 'ok' : status === 'error' ? 'err' : status === 'cancelled' ? 'stop' : '';
  return (
    <div
      className={`run-progress ${p === null ? 'waiting' : ''} ${end ? `ended ${end}` : ''}`}
      role="progressbar"
      aria-label={t(status === 'queued' ? 'queued' : working ? 'working' : status === 'error' ? 'failed' : 'done')}
      data-testid="run-progress"
      data-progress={p === null ? '' : p.toFixed(3)}
    >
      <span className="run-progress-fill" style={p === null ? undefined : { transform: `scaleX(${p})` }} />
    </div>
  );
}
