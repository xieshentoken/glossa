import { useEffect, useRef, useState } from 'react';
import { MIN_CARD } from '../../shared/cards';
import { fitRect, maximized, snapMove, snapResize, type Bounds } from '../../shared/card-geometry';
import { effortLabel } from '../../shared/connection-copy';
import { agentRecipient, directRecipient } from '../../shared/data-scope';
import { EXPLAIN_LANGS } from '../../shared/defaults';
import { selectedDirect } from '../../shared/engine-selection';
import type { T } from '../../shared/i18n';
import { modelInfo } from '../../shared/model-catalog';
import { skillLabel } from '../../shared/skills';
import type { CardTask, Effort, JobState, JobStatus, Rect, Settings, SkillInfo, TermCard as Card, Theme } from '../../shared/types';
import { useDragRect } from '../lib/drag';
import { langName } from '../lib/lang';
import type { RunOptions } from '../lib/useTermCards';
import { Icon } from './Icon';
import { MiniMarkdown } from './MiniMarkdown';

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** One picked term: skill buttons that start runs, and the runs' results. */
export function TermCard(props: {
  card: Card;
  jobs: Record<string, JobState>;
  /** Enabled skills, in order. */
  skills: SkillInfo[];
  settings: Settings;
  /** The theme shown, for result pages. */
  theme: Theme;
  t: T;
  focused: boolean;
  zIndex: number;
  /** Size of the reading area; the card is kept inside it. */
  area: Bounds;
  /** Other cards shown on this document, for snapping. */
  others: Rect[];
  onFocus: () => void;
  onChange: (c: Card, persist: boolean) => void;
  onRun: (skill: SkillInfo, o: RunOptions) => void;
  onRerun: (task: CardTask) => void;
  onCancel: (task: CardTask) => void;
  onClose: () => void;
}) {
  const { card, settings, t } = props;
  const lang = settings.uiLang;
  const [showAdv, setShowAdv] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<Effort | ''>('');
  const [hover, setHover] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  const isMax = card.window === 'maximized';
  const active = card.tasks.find((x) => x.id === card.activeTask) ?? card.tasks.at(-1);
  const activeJob = active ? props.jobs[active.jobId] : undefined;
  // Model and effort choices follow the skill under the pointer (or the first one).
  const shownSkill = props.skills.find((s) => s.name === hover) ?? props.skills[0];
  const direct = selectedDirect(settings, shownSkill?.name ?? '', model ? { model } : undefined);
  const provider = settings.providers.find((p) => p.id === direct.providerId);
  const effortOptions: Effort[] = shownSkill?.runner === 'direct' && provider?.selection ? ['default', ...modelInfo(provider, direct.model).efforts] : ['low', 'medium', 'high', 'xhigh', 'max'];

  useEffect(() => {
    // A new card takes the keyboard; restored cards do not.
    if (props.focused) ref.current?.focus();
    // Once, when the card appears.
  }, []);

  const runOptions = (): RunOptions => ({ model: model.trim() || undefined, effort: effort || undefined });
  const lastStatus = (skill: string) => {
    const task = card.tasks.findLast((x) => x.skill === skill);
    return task ? props.jobs[task.jobId]?.status : undefined;
  };

  // The saved rect stays as placed; what is shown always fits the current area.
  const rect: Rect = isMax ? maximized(props.area) : fitRect(card.rect, props.area);
  const bounds = () => props.area;
  const setRect = (r: Rect, persist: boolean) => props.onChange({ ...card, rect: r }, persist);
  const move = useDragRect({ rect, bounds, snap: (r) => snapMove(r, props.others, props.area), onChange: (r) => setRect(r, false), onEnd: (r) => setRect(r, true) });
  const resize = useDragRect({
    rect,
    bounds,
    mode: 'resize',
    min: MIN_CARD,
    snap: (r) => snapResize(r, props.others, props.area, MIN_CARD),
    onChange: (r) => setRect(r, false),
    onEnd: (r) => setRect(r, true),
  });
  // Maximizing keeps the normal rect, so restoring returns to it.
  const setWindow = (w: Card['window']) => props.onChange({ ...card, window: w }, true);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inField = (e.target as HTMLElement).closest('input, select, textarea');
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    } else if (!inField && /^[1-9]$/.test(e.key) && props.skills[Number(e.key) - 1]) {
      e.preventDefault();
      props.onRun(props.skills[Number(e.key) - 1], runOptions());
    }
  };

  // Runs of the skill shown, when it ran more than once (another term, language or model).
  const sameSkillRuns = active ? card.tasks.filter((x) => x.skill === active.skill) : [];

  return (
    <div
      ref={ref}
      className={`card term-card ${isMax ? 'maximized' : ''}`}
      tabIndex={-1}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: props.zIndex }}
      onPointerDownCapture={props.onFocus}
      onFocusCapture={props.onFocus}
      onKeyDown={onKeyDown}
      data-testid="term-card"
      data-window={card.window}
      data-status={activeJob?.status}
    >
      <div className="card-head" onPointerDown={isMax ? undefined : move} onDoubleClick={(e) => !(e.target as HTMLElement).closest('input, button') && setWindow(isMax ? 'normal' : 'maximized')}>
        <input
          className="term-input"
          value={card.term}
          onChange={(e) => props.onChange({ ...card, term: e.target.value }, true)}
          aria-label={t('term')}
        />
        <button className="icon" title={t('minimize')} aria-label={t('minimize')} onClick={() => setWindow('minimized')}>
          <Icon name="minimize" />
        </button>
        <button className="icon" title={t(isMax ? 'restore' : 'maximize')} aria-label={t(isMax ? 'restore' : 'maximize')} onClick={() => setWindow(isMax ? 'normal' : 'maximized')}>
          <Icon name={isMax ? 'restore' : 'maximize'} size={15} />
        </button>
        <button className="icon" title={t('close')} aria-label={t('close')} onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </div>
      {card.context.sentence && (
        <div className="context-line" title={card.context.sentence}>
          {card.context.sentence}
        </div>
      )}
      {/* A skill button shows its run, or starts one: it is both the action and the tab. */}
      <div className="skills-row" role="group" aria-label={t('chooseSkill')}>
        {props.skills.map((s, i) => {
          const status = lastStatus(s.name);
          return (
            <button
              key={s.name}
              className={`chip ${active?.skill === s.name ? 'on' : ''}`}
              aria-pressed={active?.skill === s.name}
              title={s.description}
              data-skill={s.name}
              onMouseEnter={() => setHover(s.name)}
              onFocus={() => setHover(s.name)}
              onClick={() => props.onRun(s, runOptions())}
            >
              {i < 9 && <kbd>{i + 1}</kbd>}
              {skillLabel(s, lang)}
              {s.runner === 'agent' && <Icon name="clock" size={13} title={t('slowSkill')} />}
              {status && <span className={`chip-status s-${status}`} aria-label={t(status === 'done' ? 'done' : status === 'error' ? 'failed' : status)} />}
            </button>
          );
        })}
      </div>
      {sameSkillRuns.length > 1 && (
        <div className="task-tabs" role="tablist">
          {sameSkillRuns.map((x) => {
            const s = props.jobs[x.jobId]?.status ?? 'queued';
            return (
              <button key={x.id} role="tab" aria-selected={x.id === active?.id} className={`task-tab s-${s} ${x.id === active?.id ? 'on' : ''}`} onClick={() => props.onChange({ ...card, activeTask: x.id }, true)}>
                <StatusIcon status={s} small />
                {x.request.context.term} · {x.request.explainLang === 'ui' ? t('sameAsUi') : langName(x.request.explainLang, lang)}
              </button>
            );
          })}
        </div>
      )}
      {active ? (
        <TaskView key={active.id} task={active} job={activeJob} theme={props.theme} t={t} onRerun={() => props.onRerun(active)} onCancel={() => props.onCancel(active)} />
      ) : (
        <div className="card-body empty">{t('pickSkillHint')}</div>
      )}
      {showAdv && (
        <div className="card-options">
          <label>
            {t('answerIn')}
            <select value={card.explainLang} onChange={(e) => props.onChange({ ...card, explainLang: e.target.value }, true)}>
              {EXPLAIN_LANGS.map((l) => (
                <option key={l} value={l}>
                  {l === 'ui' ? t('sameAsUi') : langName(l, lang)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('model')}
            <input value={model} placeholder={t('inherit')} onChange={(e) => { setModel(e.target.value); setEffort(provider?.selection && e.target.value.trim() ? 'default' : ''); }} />
          </label>
          <label>
            {t('effort')}
            <select value={effort} onChange={(e) => setEffort(e.target.value as Effort | '')}>
              <option value="">{t('inherit')}</option>
              {effortOptions.map((x) => (
                <option key={x} value={x}>{effortLabel(lang, x, provider?.selection ? modelInfo(provider, direct.model).thinking : undefined)}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {/* Where a request goes stays visible: endpoint · model · scope. */}
      <div className="card-foot">
        {shownSkill && (
          <span className="recipient" data-testid="recipient" title={recipientFor(shownSkill, settings, model.trim())}>
            {t('sendsTo')}: {recipientFor(shownSkill, settings, model.trim())}
          </span>
        )}
        <button className={`icon ${showAdv ? 'on' : ''}`} title={t('advanced')} aria-label={t('advanced')} aria-expanded={showAdv} onClick={() => setShowAdv((v) => !v)}>
          <Icon name="more" />
        </button>
      </div>
      {!isMax && <div className="resize-handle" onPointerDown={resize} />}
    </div>
  );
}

/** Status of a run as a small round icon. */
export function StatusIcon({ status, small }: { status: JobStatus; small?: boolean }) {
  const glyph =
    status === 'done' ? <Icon name="check" /> : status === 'error' ? '!' : status === 'partial' ? '~' : status === 'cancelled' ? <Icon name="minimize" /> : null;
  return <span className={`status-icon s-${status} ${small ? 'small' : ''} ${status === 'running' ? 'spin' : ''}`}>{glyph}</span>;
}

function TaskView(props: { task: CardTask; job?: JobState; theme: Theme; t: T; onRerun: () => void; onCancel: () => void }) {
  const { job, t } = props;
  const status = job?.status ?? 'queued';
  const [now, setNow] = useState(Date.now());
  const working = status === 'running' || status === 'queued';

  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [working]);

  const viewable = status === 'done' || status === 'partial';
  const errorText = job?.outputMissing ? t('outputMissing') : (job?.error ?? '');
  const statusText = working
    ? `${t(status)} · ${elapsed(now - (job?.startedAt ?? now))}${job?.progress ? ` · ${job.progress}` : ''}`
    : status === 'done'
      ? `${t('done')}${job?.cached ? ` · ${t('cachedResult')}` : ''}`
      : status === 'partial'
        ? `${t('partial')} (${job?.partialReason === 'length' ? t('partialLength') : t('partialInterrupted')})`
        : status === 'error'
          ? t(job?.interrupted ? 'interrupted' : 'failed')
          : t('cancelled');

  return (
    <div className={`task-view s-${status}`} data-testid="task-view" data-status={status} data-skill={props.task.skill} data-job={props.task.jobId}>
      <div className="task-status">
        <StatusIcon status={status} />
        <div className="pill-text">
          <div className="pill-sub" title={job?.recipient ?? job?.engineLabel}>
            {statusText}
            {viewable && (job?.recipient ?? job?.engineLabel) ? ` · ${job?.recipient ?? job?.engineLabel}` : ''}
            {job?.costUsd ? ` · ${t('cost')} $${job.costUsd.toFixed(2)}` : ''}
          </div>
        </div>
        {working ? (
          <button className="icon" title={t('cancelJob')} aria-label={t('cancelJob')} onClick={props.onCancel}>
            <Icon name="stop" size={17} />
          </button>
        ) : (
          <button className="icon" title={t('rerun')} aria-label={t('rerun')} onClick={props.onRerun}>
            <Icon name="retry" size={15} />
          </button>
        )}
      </div>
      {viewable && job && (
        <iframe
          className="card-body"
          title={job.term}
          sandbox={job.output === 'html' ? 'allow-scripts' : ''}
          src={`glossa-out://${job.id}/?theme=${props.theme}&v=${job.finishedAt ?? 0}`}
        />
      )}
      {status === 'error' && (
        <div className="card-body error-body">
          <p className="error-text">{errorText}</p>
          <button onClick={props.onRerun}>
            <Icon name="retry" size={15} />
            {t('rerun')}
          </button>
        </div>
      )}
      {working && (
        <div className="card-body stream">
          {job?.text ? <MiniMarkdown text={job.text} /> : <span className="muted pulse">{job?.progress || t(status)}…</span>}
        </div>
      )}
    </div>
  );
}

/** Mirrors the main process: where this request goes, with which model and how much context. */
function recipientFor(skill: SkillInfo, s: Settings, modelOverride: string): string {
  if (skill.runner === 'agent') {
    const e = { ...s.defaults.agent, ...s.skillOverrides[skill.name]?.agent };
    const h = s.harnesses.find((x) => x.id === e.harnessId);
    const scope = s.dataScope === 'document' ? 'paragraph' : s.dataScope;
    if (h?.kind === 'pi') {
      // The built-in agent sends to one of the user's connections.
      const p = s.providers.find((x) => x.id === (e.providerId || s.defaults.direct.providerId));
      return p ? directRecipient(p, modelOverride || e.model || p.selection?.model || s.defaults.direct.model, scope) : '?';
    }
    return h ? agentRecipient(h, modelOverride || e.model, scope) : '?';
  }
  const e = selectedDirect(s, skill.name);
  const p = s.providers.find((x) => x.id === e.providerId);
  return p ? directRecipient(p, modelOverride || e.model, s.dataScope) : '?';
}
