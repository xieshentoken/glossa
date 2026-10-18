import { useEffect, useState } from 'react';
import type { T } from '../../shared/i18n';
import type { JobState } from '../../shared/types';
import { Icon } from './Icon';
import { StatusIcon } from './TermCard';

const ACTIVE = new Set(['running', 'queued']);

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Every run of this session, wherever its card is: running ones first. */
export function TaskPanel(props: {
  jobs: JobState[];
  docTitle: (docId: string) => string;
  skillLabel: (name: string) => string;
  t: T;
  onStop: (jobId: string) => void;
  onOpen: (jobId: string) => void;
  onClose: () => void;
}) {
  const { t } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const active = props.jobs.filter((j) => ACTIVE.has(j.status)).sort((a, b) => a.startedAt - b.startedAt);
  const done = props.jobs
    .filter((j) => !ACTIVE.has(j.status))
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
    .slice(0, 40);
  const state = (j: JobState) =>
    j.status === 'running' || j.status === 'queued'
      ? `${t(j.status)} · ${elapsed(now - j.startedAt)}`
      : j.status === 'error'
        ? t(j.interrupted ? 'interrupted' : 'failed')
        : j.status === 'partial'
          ? t('partial')
          : t(j.status);

  return (
    <div className="task-panel card" data-testid="tasks-panel" onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
      <div className="card-head">
        <strong className="pill-text">{t('tasks')}</strong>
        <button className="icon" title={t('close')} aria-label={t('close')} onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </div>
      {active.length + done.length === 0 && <p className="muted small task-empty">{t('noTasks')}</p>}
      <ul className="task-list">
        {[...active, ...done].map((j) => (
          <li key={j.id} className={`task-row s-${j.status}`} data-testid="task-row" data-status={j.status} data-job={j.id}>
            <StatusIcon status={j.status} small />
            <div className="pill-text">
              <div className="pill-title">
                <strong>{j.term}</strong> <span className="muted">· {props.skillLabel(j.skill)}</span>
              </div>
              <div className="pill-sub">
                {state(j)} · {props.docTitle(j.docId)}
              </div>
            </div>
            {ACTIVE.has(j.status) && (
              <button className="icon" title={t('cancelJob')} aria-label={t('cancelJob')} onClick={() => props.onStop(j.id)}>
                <Icon name="stop" size={17} />
              </button>
            )}
            <button className="link" onClick={() => props.onOpen(j.id)}>{t('openTask')}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
