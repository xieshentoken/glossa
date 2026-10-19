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
import type { CardTask, Effort, JobState, JobStatus, Rect, Settings, SkillInfo, TermCard as Card, ViewTheme } from '../../shared/types';
import { useDragRect } from '../lib/drag';
import { langName } from '../lib/lang';
import type { RunOptions } from '../lib/useTermCards';
import { Icon } from './Icon';
import { MiniMarkdown } from './MiniMarkdown';
import { RunProgress } from './RunProgress';
import { htmlAnswer, htmlAnswerParts } from '../../shared/html-answer';
import { api } from '../api';

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
  theme: ViewTheme;
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
  /** Scrolls the document to the term and highlights it. */
  onLocate: () => void;
}) {
  const { card, settings, t } = props;
  const lang = settings.uiLang;
  const [showAdv, setShowAdv] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<Effort | ''>('');
  const [hover, setHover] = useState<string>();
  // The title is plain text (part of the drag handle) until Rename is clicked.
  const [renaming, setRenaming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isMax = card.window === 'maximized';
  const active = card.tasks.find((x) => x.id === card.activeTask) ?? card.tasks.at(-1);
  const activeJob = active ? props.jobs[active.jobId] : undefined;
  // Model and effort choices follow the skill under the pointer (or the first one).
  const shownSkill = props.skills.find((s) => s.name === hover) ?? props.skills[0];
  // Every skill on the built-in Pi agent uses the skill-answer connection; only a CLI agent differs.
  const direct = selectedDirect(settings, shownSkill?.name ?? '', model ? { model } : undefined);
  const provider = settings.providers.find((p) => p.id === direct.providerId);
  const onCli = !!shownSkill && cliHarness(shownSkill, settings) !== undefined;
  const effortOptions: Effort[] = !onCli && provider?.selection ? ['default', ...modelInfo(provider, direct.model).efforts] : ['low', 'medium', 'high', 'xhigh', 'max'];

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
      data-term={card.term}
      data-window={card.window}
      data-status={activeJob?.status}
    >
      <div className="card-head" onPointerDown={isMax ? undefined : move} onDoubleClick={(e) => !(e.target as HTMLElement).closest('input, button') && setWindow(isMax ? 'normal' : 'maximized')}>
        {renaming ? (
          <input
            className="term-input"
            autoFocus
            defaultValue={card.term}
            aria-label={t('term')}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== card.term) props.onChange({ ...card, term: v }, true);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              else if (e.key === 'Escape') {
                // Escape leaves renaming; it does not close the card.
                e.stopPropagation();
                (e.target as HTMLInputElement).value = card.term;
                setRenaming(false);
              }
            }}
          />
        ) : (
          <>
            <span className="term-title" title={card.term}>{card.term}</span>
            <button className="icon edit-term" title={t('editTerm')} aria-label={t('editTerm')} onClick={() => setRenaming(true)}>
              <Icon name="edit" size={14} />
            </button>
            <span className="head-grip" />
          </>
        )}
        <button
          className="icon locate-term"
          title={`${t('locateTerm')} (${settings.locateHotkey})`}
          aria-label={t('locateTerm')}
          aria-keyshortcuts={settings.locateHotkey.replace(/Ctrl/g, 'Control')}
          onClick={props.onLocate}
          data-testid="locate-term"
        >
          <Icon name="locate" size={15} />
        </button>
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
      {card.capture && <AreaPicture id={card.capture.id} t={t} />}
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
          <span className="recipient" data-testid="recipient" title={recipientFor(shownSkill, settings, model.trim(), card.capture?.send)}>
            {t('sendsTo')}: {recipientFor(shownSkill, settings, model.trim(), card.capture?.send)}
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

/** The picture of a captured area; click to see it larger. */
function AreaPicture(props: { id: string; t: T }) {
  const [src, setSrc] = useState<string>();
  const [large, setLarge] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.capture.picture(props.id).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [props.id]);
  if (!src) return null;
  return (
    <button className={`area-picture ${large ? 'large' : ''}`} onClick={() => setLarge((v) => !v)} aria-pressed={large} title={props.t('capturedArea')} data-testid="area-picture">
      <img src={src} alt={props.t('capturedArea')} />
    </button>
  );
}

/** Status of a run as a small round icon. */
export function StatusIcon({ status, small }: { status: JobStatus; small?: boolean }) {
  const glyph =
    status === 'done' ? <Icon name="check" /> : status === 'error' ? '!' : status === 'partial' ? '~' : status === 'cancelled' ? <Icon name="minimize" /> : null;
  return <span className={`status-icon s-${status} ${small ? 'small' : ''} ${status === 'running' ? 'spin' : ''}`}>{glyph}</span>;
}

function TaskView(props: { task: CardTask; job?: JobState; theme: ViewTheme; t: T; onRerun: () => void; onCancel: () => void }) {
  const { job, t } = props;
  const status = job?.status ?? 'queued';
  const [now, setNow] = useState(Date.now());
  const working = status === 'running' || status === 'queued';
  // Rendered (Markdown or HTML, in the script-free viewer) or the explanation as plain text.
  const [plain, setPlain] = useState(false);
  // The page written by Export, or why it failed.
  const [exported, setExported] = useState<{ path?: string; error?: string }>();
  const plainText = usePlainText(plain && (status === 'done' || status === 'partial') ? job : undefined);

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
      <RunProgress job={job} t={t} />
      <div className="task-status">
        <StatusIcon status={status} />
        <div className="pill-text">
          <div className="pill-sub" title={job?.recipient ?? job?.engineLabel}>
            {statusText}
            {viewable && (job?.recipient ?? job?.engineLabel) ? ` · ${job?.recipient ?? job?.engineLabel}` : ''}
            {job?.costUsd ? ` · ${t('cost')} $${job.costUsd.toFixed(2)}` : ''}
          </div>
          {viewable && job?.savedTo && (
            <button className="link saved-to" title={`${t('savedTo')}: ${job.savedTo}`} onClick={() => void api.jobs.showSaved(job.id)} data-testid="saved-to">
              {t('savedTo')}: {job.savedTo.split(/[\\/]/).slice(-2).join('/')}
            </button>
          )}
          {exported?.path && (
            <div className="pill-sub exported" title={`${t('exportedTo')}: ${exported.path}`} data-testid="exported-to">
              {t('exportedTo')}: {exported.path.split(/[\\/]/).slice(-2).join('/')}
            </div>
          )}
          {exported?.error && <div className="pill-sub error-text" title={exported.error}>{t('exportFailed')}: {exported.error}</div>}
          {job?.usageNote && <div className="pill-sub usage-note" data-testid="usage-note">{job.usageNote}</div>}
          {viewable && job?.saveError && <div className="pill-sub error-text" title={job.saveError}>{t('notSaved')}</div>}
        </div>
        {viewable && (
          <button
            className={`icon ${plain ? 'on' : ''}`}
            title={t(plain ? 'showRendered' : 'showPlain')}
            aria-label={t(plain ? 'showRendered' : 'showPlain')}
            aria-pressed={plain}
            data-testid="view-toggle"
            onClick={() => setPlain((v) => !v)}
          >
            <Icon name={plain ? 'code' : 'text'} size={15} />
          </button>
        )}
        {viewable && job && (
          <button
            className="icon"
            title={t('exportHtml')}
            aria-label={t('exportHtml')}
            data-testid="export-html"
            onClick={() =>
              void api.jobs.exportHtml(job.id, props.theme).then(
                (p) => p && setExported({ path: p }),
                (err: Error) => setExported({ error: String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (\w+: )?/, '') }),
              )
            }
          >
            <Icon name="export" size={15} />
          </button>
        )}
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
      {viewable && job && plain && (
        <div className="card-body plain-text" data-testid="plain-text">
          {plainText ?? <span className="muted pulse">{t('loading')}</span>}
        </div>
      )}
      {viewable && job && !plain && (
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
      {working && (
        // Started by mistake? Stop is right here, not only in the small status icon.
        <div className="stop-bar">
          <button onClick={props.onCancel} data-testid="stop-run">
            <Icon name="stop" size={15} />
            {t('stopRun')}
          </button>
        </div>
      )}
    </div>
  );
}

/** A finished result as readable text: Markdown as written; HTML (an HTML answer or an HTML result) as its text. */
function usePlainText(job: JobState | undefined): string | undefined {
  const [text, setText] = useState<string>();
  const id = job?.id;
  const known = job?.output === 'markdown' ? job.text : undefined;
  useEffect(() => {
    setText(undefined);
    if (!id) return;
    let alive = true;
    const show = (raw: string, output: JobState['output']) => {
      const html = output === 'html' ? raw : htmlAnswer(raw);
      // DOMParser builds an inert document: nothing in it runs or loads.
      const value = html ? (new DOMParser().parseFromString(htmlAnswerParts(html).body, 'text/html').body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim() : raw.trim();
      if (alive) setText(value);
    };
    if (known !== undefined) show(known, 'markdown');
    else void api.jobs.outputText(id).then((r) => r && show(r.text, r.output));
    return () => {
      alive = false;
    };
  }, [id, known]);
  return text;
}

/** The external CLI a skill runs on, if any (built-in skills always run on the built-in Pi agent). */
function cliHarness(skill: SkillInfo, s: Settings) {
  if (skill.runner !== 'agent' || skill.source === 'builtin') return undefined;
  const id = s.skillOverrides[skill.name]?.agent?.harnessId || s.defaults.agent.harnessId;
  const h = s.harnesses.find((x) => x.id === id);
  return h && h.kind !== 'pi' ? h : undefined;
}

/** Mirrors the main process: where this request goes, with which model and how much context. */
function recipientFor(skill: SkillInfo, s: Settings, modelOverride: string, picture?: boolean): string {
  const r = recipientOf(skill, s, modelOverride);
  return picture ? `${r} · picture` : r;
}

function recipientOf(skill: SkillInfo, s: Settings, modelOverride: string): string {
  // Agents never get the whole document; short answers follow the data scope.
  const scope = skill.runner === 'agent' && s.dataScope === 'document' ? 'paragraph' : s.dataScope;
  const cli = cliHarness(skill, s);
  if (cli) return agentRecipient(cli, modelOverride || { ...s.defaults.agent, ...s.skillOverrides[skill.name]?.agent }.model, scope);
  const e = selectedDirect(s, skill.name);
  const p = s.providers.find((x) => x.id === e.providerId);
  return p ? directRecipient(p, modelOverride || e.model, scope) : '?';
}
