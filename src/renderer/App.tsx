import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { translator } from '../shared/i18n';
import { fitRect } from '../shared/card-geometry';
import { skillLabel } from '../shared/skills';
import { createTermCapture, type TermCapture } from '../shared/term-capture';
import type { DocInfo, JobRequest, JobState, PickedTerm, Settings as SettingsT, SkillInfo, TermCard as Card, ThemePref } from '../shared/types';
import { api } from './api';
import { HtmlReader } from './components/HtmlReader';
import { PdfReader } from './components/PdfReader';
import { Settings } from './components/Settings';
import { TaskPanel } from './components/TaskPanel';
import { Icon, type IconName } from './components/Icon';
import { StatusIcon, TermCard } from './components/TermCard';
import { WebReader } from './components/WebReader';
import { useShownTheme } from './lib/theme';
import { uid } from './lib/uid';
import { useTermCards } from './lib/useTermCards';

interface Tab {
  tabId: string;
  doc: DocInfo;
  lang?: string;
}

export function App() {
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [preloadUrl, setPreloadUrl] = useState('');
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [recent, setRecent] = useState<DocInfo[]>([]);
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  // The request behind every run started this session, so a closed card can come back.
  const requests = useRef<Record<string, JobRequest>>({});
  const [error, setError] = useState('');
  const [area, setArea] = useState({ w: 800, h: 600 });
  const areaRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<TermCapture | null>(null);

  const t = useMemo(() => translator(settings?.uiLang ?? 'en'), [settings?.uiLang]);
  const activeTab = tabs.find((x) => x.tabId === active) ?? null;
  const activeRef = useRef(activeTab);
  activeRef.current = activeTab;

  // --- startup ---------------------------------------------------------------
  useEffect(() => {
    void (async () => {
      const [s, sk, pre, rec] = await Promise.all([api.settings.get(), api.skills.list(), api.app.webviewPreload(), api.docs.recent()]);
      setSettings(s);
      setSkills(sk);
      setPreloadUrl(pre);
      setRecent(rec);
    })();
    const off = api.jobs.onEvent((j) => setJobs((m) => ({ ...m, [j.id]: { ...m[j.id], ...j } })));
    const offTab = api.app.onOpenInTab((url) => void openUrl(url));
    return () => {
      off();
      offTab();
    };
    // Subscriptions are set up once for the app's lifetime.
  }, []);

  // Cards are kept inside the reading area as it changes size.
  const booted = !!settings;
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setArea({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [booted]);

  // The theme itself is applied by the main process (nativeTheme → prefers-color-scheme).
  const shownTheme = useShownTheme();
  useEffect(() => {
    if (!settings) return;
    document.documentElement.lang = settings.uiLang;
    document.documentElement.dataset.pdfDim = settings.pdfDim ? '1' : '';
  }, [settings?.uiLang, settings?.pdfDim]);

  const updateSettings = useCallback(async (patch: Partial<SettingsT>) => {
    try {
      setSettings(await api.settings.set(patch));
    } catch (err) {
      // Declined confirmations and invalid values come back as errors; the old value stays.
      setError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (\w+: )?/, ''));
      setSettings(await api.settings.get());
    }
  }, []);

  // --- documents ---------------------------------------------------------------
  const guard = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (\w+: )?/, ''));
    }
  };

  const bounds = useCallback(() => {
    const r = areaRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 800, h: r?.height ?? 600 };
  }, []);

  const startJob = useCallback(async (req: JobRequest): Promise<JobState | null> => {
    const job = await api.jobs.start(req);
    requests.current[job.id] = req;
    // Progress events can arrive before this reply; they are newer than the state it carries.
    setJobs((m) => ({ ...m, [job.id]: { ...job, ...m[job.id] } }));
    return job;
  }, []);

  const cards = useTermCards({ start: startJob, bounds, guard });
  const loadDocCards = cards.load;

  const loadCards = useCallback(async (docId: string) => {
    const list = await loadDocCards(docId);
    const states = await Promise.all(list.flatMap((c) => c.tasks.map((x) => api.jobs.get(x.jobId))));
    setJobs((m) => {
      const next = { ...m };
      for (const s of states) if (s) next[s.id] = { ...s, ...m[s.id] };
      return next;
    });
  }, [loadDocCards]);

  const addTab = useCallback(
    (doc: DocInfo) => {
      setTabs((ts) => {
        const existing = ts.find((x) => x.doc.docId === doc.docId);
        if (existing) {
          setActive(existing.tabId);
          return ts;
        }
        const tab = { tabId: uid(), doc };
        setActive(tab.tabId);
        return [...ts, tab];
      });
      void loadCards(doc.docId);
    },
    [loadCards],
  );

  const openFiles = () => guard(async () => (await api.docs.openFiles()).forEach(addTab));
  const openUrl = (url: string) => guard(async () => addTab(await api.docs.openUrl(url)));
  const reopen = (info: DocInfo) => guard(async () => addTab(await api.docs.reopen(info)));

  const closeTab = (tabId: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((x) => x.tabId === tabId);
      const closing = ts[i];
      // Free the extracted text unless another tab shows the same document.
      if (closing && !ts.some((x) => x.tabId !== tabId && x.doc.docId === closing.doc.docId)) void api.docs.close(closing.doc.docId);
      const next = ts.filter((x) => x.tabId !== tabId);
      if (active === tabId) setActive(next[Math.min(i, next.length - 1)]?.tabId ?? null);
      return next;
    });
    void api.docs.recent().then(setRecent);
  };

  const onDocText = (tab: Tab) => (text: string, title?: string, lang?: string) => {
    void api.docs.setText(tab.doc.docId, text, title);
    setTabs((ts) =>
      ts.map((x) => (x.tabId === tab.tabId ? { ...x, lang: lang ?? x.lang, doc: title ? { ...x.doc, title } : x.doc } : x)),
    );
  };

  const onWebNavigate = (tab: Tab) => (url: string) =>
    guard(async () => {
      const doc = await api.docs.openUrl(url);
      setTabs((ts) => ts.map((x) => (x.tabId === tab.tabId ? { ...x, doc } : x)));
      void loadCards(doc.docId);
    });

  // --- term picking ---------------------------------------------------------------
  const createCard = cards.create;
  const explainLang = settings?.explainLang ?? 'ui';
  const onPick = useCallback(
    (picked: PickedTerm) => {
      const tab = activeRef.current;
      const area = areaRef.current?.getBoundingClientRect();
      if (!tab || !area) return;
      const anchor = { x: picked.rect.x - area.left, y: picked.rect.y - area.top, height: picked.rect.height };
      createCard(tab.doc.docId, picked, anchor, explainLang);
    },
    [createCard, explainLang],
  );

  useEffect(() => {
    if (!settings) return;
    if (!captureRef.current) {
      captureRef.current = createTermCapture({
        doc: document,
        hotkey: settings.hotkey,
        hint: t('captureHint'),
        root: () => areaRef.current?.querySelector('.reader.active .doc-surface') ?? null,
        docMeta: () => {
          const tab = activeRef.current;
          return { title: tab?.doc.title ?? '', source: tab?.doc.source ?? '', lang: tab?.lang };
        },
        onConfirm: onPick,
      });
      (window as unknown as { __glossaCapture: TermCapture }).__glossaCapture = captureRef.current;
    } else {
      captureRef.current.setHotkey(settings.hotkey);
      captureRef.current.setHint(t('captureHint'));
    }
  }, [settings?.hotkey, t, onPick, settings]);

  // --- keyboard & drop ---------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openFiles();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setShowSettings(true);
      } else if (mod && e.key.toLowerCase() === 'w' && activeRef.current) {
        e.preventDefault();
        closeTab(activeRef.current.tabId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    void guard(async () => {
      for (const f of files) {
        const p = api.app.pathForFile(f);
        if (p) addTab(await api.docs.openPath(p));
      }
    });
  };

  // Automation hooks for the smoke test.
  useEffect(() => {
    (window as unknown as { __glossaTest: object }).__glossaTest = {
      openPath: async (p: string) => addTab(await api.docs.openPath(p)),
      openUrl: (u: string) => openUrl(u),
    };
  });

  if (!settings) return <div className="boot">…</div>;
  const enabledSkills = skills.filter((s) => s.enabled);
  const docId = activeTab?.doc.docId;
  const docCards: Card[] = docId ? (cards.byDoc[docId] ?? []) : [];
  const shown = docCards.filter((c) => c.window !== 'minimized');
  const docked = docCards.filter((c) => c.window === 'minimized');
  const label = (name: string) => {
    const s = skills.find((x) => x.name === name);
    return s ? skillLabel(s, settings.uiLang) : name;
  };
  const allJobs = Object.values(jobs);
  const activeJobs = allJobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const docTitle = (id: string) => tabs.find((x) => x.doc.docId === id)?.doc.title ?? recent.find((d) => d.docId === id)?.title ?? '—';
  /** Show a run's card, opening its document first when needed. */
  const openTask = (jobId: string) =>
    guard(async () => {
      const job = jobs[jobId];
      if (!job) return;
      const request = requests.current[jobId] ?? Object.values(cards.byDoc).flat().flatMap((c) => c.tasks).find((x) => x.jobId === jobId)?.request;
      const tab = tabs.find((x) => x.doc.docId === job.docId);
      if (tab) setActive(tab.tabId);
      else {
        const info = recent.find((d) => d.docId === job.docId) ?? (await api.docs.recent()).find((d) => d.docId === job.docId);
        if (!info) throw new Error(t('docGone'));
        const doc = await api.docs.reopen(info);
        addTab(doc);
        await loadCards(doc.docId);
      }
      cards.reveal(job.docId, jobId, request, job.output);
      setShowTasks(false);
    });

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="topbar">
        <div className="tabs" role="tablist">
          {tabs.map((tab) => (
            <div
              key={tab.tabId}
              role="tab"
              aria-selected={tab.tabId === active}
              className={`tab ${tab.tabId === active ? 'on' : ''}`}
              title={tab.doc.source}
              onClick={() => setActive(tab.tabId)}
            >
              <span className="tab-kind">{kindIcon(tab.doc.kind)}</span>
              <span className="tab-title">{tab.doc.title}</span>
              {/* Two tabs with the same title also show where each comes from. */}
              {tabs.some((x) => x.tabId !== tab.tabId && x.doc.title === tab.doc.title) && <span className="tab-hint">{whereFrom(tab.doc, 'file')}</span>}
              <button
                className="icon"
                title={t('close')}
                aria-label={t('close')}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.tabId);
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
        <form
          className="urlbar"
          onSubmit={(e) => {
            e.preventDefault();
            const input = (e.currentTarget.elements.namedItem('url') as HTMLInputElement) ?? null;
            if (input?.value.trim()) {
              void openUrl(input.value.trim());
              input.value = '';
            }
          }}
        >
          <input name="url" placeholder={t('openUrlPlaceholder')} spellCheck={false} />
        </form>
        <div className="topbar-actions">
          <button onClick={() => void openFiles()}>
            <Icon name="open" />
            {t('openFile')}
          </button>
          <button className={`tasks-button ${activeJobs ? 'busy' : ''}`} onClick={() => setShowTasks((v) => !v)} aria-expanded={showTasks} data-testid="tasks-button">
            <Icon name="tasks" />
            {t('tasks')}
            {activeJobs > 0 && <span className="badge">{activeJobs}</span>}
          </button>
          <button
            className="icon"
            title={`${t('theme')}: ${t(THEME_LABEL[settings.theme])}`}
            aria-label={`${t('theme')}: ${t(THEME_LABEL[settings.theme])}`}
            onClick={() => void updateSettings({ theme: NEXT_THEME[settings.theme] })}
            data-testid="theme-toggle"
          >
            <Icon name={THEME_ICON[settings.theme]} />
          </button>
          <button className="icon" title={t('settings')} aria-label={t('settings')} onClick={() => setShowSettings(true)}>
            <Icon name="settings" />
          </button>
        </div>
      </header>
      {error && (
        <div className="error-bar" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
          <button className="icon" title={t('close')} aria-label={t('close')} onClick={() => setError('')}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <main className="reader-area" ref={areaRef}>
        {tabs.length === 0 && <Welcome t={t} lang={settings.uiLang} hotkey={settings.hotkey} recent={recent} onOpen={openFiles} onReopen={reopen} />}
        {tabs.map((tab) => (
          <div key={tab.tabId} className={`reader ${tab.tabId === active ? 'active' : ''}`}>
            {tab.doc.kind === 'web' ? (
              <WebReader
                doc={tab.doc}
                t={t}
                preloadUrl={preloadUrl}
                hotkey={settings.hotkey}
                onPick={onPick}
                onText={onDocText(tab)}
                onNavigate={onWebNavigate(tab)}
              />
            ) : tab.doc.kind === 'pdf' ? (
              <PdfReader doc={tab.doc} t={t} onText={onDocText(tab)} />
            ) : (
              <HtmlReader doc={tab.doc} t={t} onText={onDocText(tab)} />
            )}
          </div>
        ))}
        {docId && (
          <div className="card-layer">
            {shown.map((card, i) => (
              <TermCard
                key={card.id}
                card={card}
                jobs={jobs}
                skills={enabledSkills}
                settings={settings}
                theme={shownTheme}
                t={t}
                focused={card.id === cards.focused}
                zIndex={card.id === cards.focused ? 1000 : 10 + i}
                area={area}
                others={shown.filter((c) => c.id !== card.id && c.window === 'normal').map((c) => fitRect(c.rect, area))}
                onFocus={() => cards.setFocused(card.id)}
                onChange={(c, persist) => cards.update(docId, c.id, () => c, persist)}
                onRun={(skill, o) => void cards.run(docId, card.id, skill, o)}
                onRerun={(task) => void cards.rerun(docId, card.id, task)}
                onCancel={(task) => void api.jobs.cancel(task.jobId)}
                onClose={() => cards.close(docId, card.id)}
              />
            ))}
          </div>
        )}
        {docId && docked.length > 0 && (
          <div className="card-dock" data-testid="card-dock">
            {docked.map((card) => {
              const task = card.tasks.find((x) => x.id === card.activeTask) ?? card.tasks.at(-1);
              const job = task ? jobs[task.jobId] : undefined;
              return (
                <button
                  key={card.id}
                  className={`dock-item ${job ? `s-${job.status}` : ''}`}
                  data-testid="dock-item"
                  title={`${t('restore')}: ${card.context.sentence}`}
                  onClick={() => {
                    cards.update(docId, card.id, (c) => ({ ...c, window: 'normal' }));
                    cards.setFocused(card.id);
                  }}
                >
                  {job && <StatusIcon status={job.status} small />}
                  <span className="dock-term">{card.term}</span>
                  {task && <span className="muted">· {label(task.skill)}</span>}
                </button>
              );
            })}
          </div>
        )}
      </main>
      {showTasks && (
        <TaskPanel
          jobs={allJobs}
          docTitle={docTitle}
          skillLabel={label}
          t={t}
          onStop={(id) => void api.jobs.cancel(id)}
          onOpen={(id) => void openTask(id)}
          onClose={() => setShowTasks(false)}
        />
      )}
      {showSettings && (
        <Settings
          settings={settings}
          skills={skills}
          t={t}
          onChange={updateSettings}
          onSaved={setSettings}
          onSkills={setSkills}
          onClose={() => {
            setShowSettings(false);
            void api.skills.list().then(setSkills);
          }}
        />
      )}
    </div>
  );
}

function kindIcon(kind: DocInfo['kind']): string {
  return { web: 'WEB', pdf: 'PDF', docx: 'DOC', markdown: 'MD', text: 'TXT', html: 'HTML' }[kind];
}

const THEME_LABEL = { system: 'themeSystem', light: 'light', dark: 'dark' } as const;
const THEME_ICON: Record<ThemePref, IconName> = { system: 'system', light: 'sun', dark: 'moon' };
const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

/** Where a document comes from: host of a web page, or the folder (or file name) of a file. */
function whereFrom(d: DocInfo, part: 'folder' | 'file' = 'folder'): string {
  if (d.kind === 'web') {
    try {
      return new URL(d.source).host;
    } catch {
      return d.source;
    }
  }
  const parts = d.source.split(/[\\/]/).filter(Boolean);
  return (part === 'file' ? parts.at(-1) : parts.at(-2)) ?? '';
}

function Welcome(props: {
  t: ReturnType<typeof translator>;
  lang: string;
  hotkey: string;
  recent: DocInfo[];
  onOpen: () => void;
  onReopen: (d: DocInfo) => void;
}) {
  const { t } = props;
  const when = new Intl.DateTimeFormat(props.lang, { month: 'short', day: 'numeric' });
  return (
    <div className="welcome">
      <h1>{t('welcomeTitle')}</h1>
      <p className="lead">{t('welcomeBody', { hotkey: props.hotkey })}</p>
      <ul className="keys">
        {t('welcomeKeys')
          .split(' · ')
          .map((k) => (
            <li key={k}>{k}</li>
          ))}
      </ul>
      <div className="dropzone">
        <button className="primary big" onClick={props.onOpen}>
          <Icon name="open" size={18} />
          {t('openFile')}
        </button>
        <span className="muted">{t('dropHint')}</span>
      </div>
      <h3>{t('recent')}</h3>
      {props.recent.length === 0 ? (
        <p className="muted">{t('noRecent')}</p>
      ) : (
        <ul className="recent">
          {props.recent.map((d) => (
            <li key={d.docId}>
              <button onClick={() => props.onReopen(d)} title={d.source}>
                <span className="tab-kind">{kindIcon(d.kind)}</span>
                <span className="recent-text">
                  <span className="recent-title">{d.title}</span>
                  <span className="recent-where">{whereFrom(d)}</span>
                </span>
                <span className="recent-when">{when.format(d.openedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
