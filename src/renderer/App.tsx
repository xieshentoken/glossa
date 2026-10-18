import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { translator } from '../shared/i18n';
import { fitRect } from '../shared/card-geometry';
import { dropTab, placeTab, REGIONS, resizePanels, showTab, type PanelCount, type Panels } from '../shared/panels';
import { matchHotkey, parseHotkey } from '../shared/hotkey';
import { clampZoom } from '../shared/pinch';
import { skillLabel } from '../shared/skills';
import { createTermCapture, type TermCapture } from '../shared/term-capture';
import { locatorFromContext } from '../shared/term-locate';
import type { DocInfo, JobRequest, JobState, PickedTerm, Settings as SettingsT, SkillInfo, TermCard as Card, ThemePref } from '../shared/types';
import { api } from './api';
import { HtmlReader } from './components/HtmlReader';
import { PdfReader } from './components/PdfReader';
import { Settings } from './components/Settings';
import { TaskPanel } from './components/TaskPanel';
import { Icon, type IconName } from './components/Icon';
import { StatusIcon, TermCard } from './components/TermCard';
import { WebReader } from './components/WebReader';
import { EmptyPanel, PanelHead, ReaderFrame } from './components/Panels';
import type { ReaderHandle } from './lib/locate';
import { AreaCapture } from './components/AreaCapture';
import { truncate } from '../shared/text';
import type { Box } from '../shared/term-locate';
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
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Multi-column reading: 1, 2 or 3 panels (left / middle / right), each showing one open document.
  const [layout, setLayoutState] = useState(() => {
    const n = Number(localStorage.getItem('glossa.panels'));
    const count = (n === 2 || n === 3 ? n : 1) as PanelCount;
    return { panels: Array<string | null>(count).fill(null) as Panels, active: 0 };
  });
  const layoutRef = useRef(layout);
  const setLayout = (l: { panels: Panels; active: number }) => {
    layoutRef.current = l;
    setLayoutState(l);
  };
  const panels = layout.panels;
  const active = panels[layout.active] ?? null;
  // Zoom per document (pinch, Ctrl+wheel, Ctrl+= − 0), 1 = 100%.
  const [zoom, setZoomState] = useState<Record<string, number>>({});
  const zoomRef = useRef(zoom);
  const zoomAnchor = useRef<{ tabId: string; x: number; y: number; cx: number; cy: number; k: number } | null>(null);
  // The panel under the mouse: Alt+Q picks there.
  const pointerTab = useRef<string | null>(null);
  const captureTab = useRef<string | null>(null);
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
  // What each open document's reader can do for the app (find a term again, read a captured area), by tab.
  const handles = useRef<Record<string, ReaderHandle>>({});
  const handleSetters = useRef<Record<string, (h: ReaderHandle | null) => void>>({});
  const handleFor = (tabId: string) =>
    (handleSetters.current[tabId] ??= (h) => {
      if (h) handles.current[tabId] = h;
      else delete handles.current[tabId];
    });
  // The web page the mouse is over, if any: the pick hotkey goes there when the app has the keyboard.
  const webPointer = useRef<string | null>(null);
  const [capturing, setCapturing] = useState(false);

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

  /** Show a document: in its panel if it is shown already, otherwise in the active panel. */
  const show = useCallback((tabId: string) => setLayout(showTab(layoutRef.current.panels, layoutRef.current.active, tabId)), []);

  const addTab = useCallback(
    (doc: DocInfo) => {
      const existing = tabsRef.current.find((x) => x.doc.docId === doc.docId);
      if (existing) show(existing.tabId);
      else {
        const tab = { tabId: uid(), doc };
        tabsRef.current = [...tabsRef.current, tab];
        setTabs(tabsRef.current);
        // A new document fills an empty panel first, then the active one.
        const { panels: ps, active: a } = layoutRef.current;
        const into = ps[a] && ps.includes(null) ? ps.indexOf(null) : a;
        setLayout({ panels: placeTab(ps, into, tab.tabId), active: into });
      }
      void loadCards(doc.docId);
    },
    [loadCards, show],
  );

  const openFiles = () => guard(async () => (await api.docs.openFiles()).forEach(addTab));
  const openUrl = (url: string) => guard(async () => addTab(await api.docs.openUrl(url)));
  const reopen = (info: DocInfo) => guard(async () => addTab(await api.docs.reopen(info)));

  const closeTab = (tabId: string) => {
    const ts = tabsRef.current;
    const closing = ts.find((x) => x.tabId === tabId);
    // Free the extracted text unless another tab shows the same document.
    if (closing && !ts.some((x) => x.tabId !== tabId && x.doc.docId === closing.doc.docId)) void api.docs.close(closing.doc.docId);
    setLayout({ ...layoutRef.current, panels: dropTab(layoutRef.current.panels, tabId, ts.map((x) => x.tabId)) });
    tabsRef.current = ts.filter((x) => x.tabId !== tabId);
    setTabs(tabsRef.current);
    void api.docs.recent().then(setRecent);
  };

  /** 1, 2 or 3 panels; documents already shown stay, new panels get other open documents. */
  const setPanelCount = (n: PanelCount) => {
    localStorage.setItem('glossa.panels', String(n));
    setLayout(resizePanels(layoutRef.current.panels, layoutRef.current.active, n, tabsRef.current.map((x) => x.tabId)));
  };

  const setZoomFor = (tabId: string, z: number) => {
    zoomRef.current = { ...zoomRef.current, [tabId]: clampZoom(z) };
    setZoomState(zoomRef.current);
  };
  /** One pinch step on a panel, keeping the point under the fingers in place. */
  const zoomBy = (tabId: string, factor: number, x?: number, y?: number) => {
    const old = zoomRef.current[tabId] ?? 1;
    const z = clampZoom(old * factor);
    if (z === old) return;
    const scroller = areaRef.current?.querySelector<HTMLElement>(`.reader[data-tab="${tabId}"] .doc-scroll`);
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const cx = (x ?? r.left + r.width / 2) - r.left;
      const cy = (y ?? r.top + r.height / 2) - r.top;
      zoomAnchor.current = { tabId, x: scroller.scrollLeft + cx, y: scroller.scrollTop + cy, cx, cy, k: z / old };
    }
    setZoomFor(tabId, z);
  };
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    zoomAnchor.current = null;
    const scroller = a && areaRef.current?.querySelector<HTMLElement>(`.reader[data-tab="${a.tabId}"] .doc-scroll`);
    if (!a || !scroller) return;
    scroller.scrollLeft = a.x * a.k - a.cx;
    scroller.scrollTop = a.y * a.k - a.cy;
  }, [zoom]);
  useEffect(
    () =>
      api.app.onZoomKey((dir) => {
        const tabId = layoutRef.current.panels[layoutRef.current.active];
        if (!tabId) return;
        if (dir === 'reset') setZoomFor(tabId, 1);
        else zoomBy(tabId, dir === 'in' ? 1.15 : 1 / 1.15);
      }),
    [],
  );

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
  const runOnCard = cards.run;
  const explainLang = settings?.explainLang ?? 'ui';
  // The quick explanation starts with the card (a short-answer skill only; the main process checks again).
  const autoSkill = settings?.autoQuick ? skills.find((s) => s.enabled && s.name === settings.quickSkill && s.runner === 'direct') : undefined;
  const onPick = useCallback(
    (picked: PickedTerm, tabId?: string | null) => {
      const tab = tabsRef.current.find((x) => x.tabId === (tabId ?? captureTab.current)) ?? activeRef.current;
      const area = areaRef.current?.getBoundingClientRect();
      if (!tab || !area) return;
      // The panel the term came from becomes the active one.
      if (layoutRef.current.panels.includes(tab.tabId)) show(tab.tabId);
      const anchor = { x: picked.rect.x - area.left, y: picked.rect.y - area.top, height: picked.rect.height };
      const card = createCard(tab.doc.docId, picked, anchor, explainLang);
      if (autoSkill) void runOnCard(tab.doc.docId, card.id, autoSkill, {}, 'auto', card);
      return card;
    },
    [createCard, runOnCard, explainLang, show, autoSkill],
  );
  // The capture in the app's readers is created once; it always calls the current onPick.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!settings) return;
    if (!captureRef.current) {
      captureRef.current = createTermCapture({
        doc: document,
        hotkey: settings.hotkey,
        hint: t('captureHint'),
        // The document under the mouse, in whichever panel it is shown.
        root: () => {
          const shownIds = layoutRef.current.panels;
          const id = pointerTab.current && shownIds.includes(pointerTab.current) ? pointerTab.current : activeRef.current?.tabId;
          captureTab.current = id ?? null;
          return id ? (areaRef.current?.querySelector(`.reader[data-tab="${id}"] .doc-surface`) ?? null) : null;
        },
        docMeta: () => {
          const tab = tabsRef.current.find((x) => x.tabId === captureTab.current) ?? activeRef.current;
          return { title: tab?.doc.title ?? '', source: tab?.doc.source ?? '', lang: tab?.lang };
        },
        onConfirm: (p) => onPickRef.current(p),
        // Nothing to pick in the app itself: the mouse may be over a web page that did not have the keyboard.
        onMiss: () => {
          const id = webPointer.current;
          if (id && layoutRef.current.panels.includes(id)) handles.current[id]?.pickHere?.();
        },
      });
      (window as unknown as { __glossaCapture: TermCapture }).__glossaCapture = captureRef.current;
    } else {
      captureRef.current.setHotkey(settings.hotkey);
      captureRef.current.setHint(t('captureHint'));
    }
  }, [settings?.hotkey, t, settings]);

  // --- capturing an area ------------------------------------------------------------
  const startCapture = () => {
    if (layoutRef.current.panels.some((id) => id && tabsRef.current.some((x) => x.tabId === id))) setCapturing(true);
  };
  const startCaptureRef = useRef(startCapture);
  startCaptureRef.current = startCapture;
  /**
   * The reader dragged over `rect`: a picture of it is taken (the window as shown, web pages and video
   * included), its text is read where the document has text, and a card opens with both.
   */
  const onArea = (rect: Box) =>
    guard(async () => {
      setCapturing(false);
      const area = areaRef.current?.getBoundingClientRect();
      if (!area) return;
      const r = { left: Math.max(rect.left, area.left), top: Math.max(rect.top, area.top), right: Math.min(rect.right, area.right), bottom: Math.min(rect.bottom, area.bottom) };
      // The panel under the middle of the area.
      const mid = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
      const tabId = layoutRef.current.panels.find((id) => {
        const b = id && areaRef.current?.querySelector(`.reader[data-tab="${id}"]`)?.getBoundingClientRect();
        return b && mid.x >= b.left && mid.x <= b.right && mid.y >= b.top && mid.y <= b.bottom;
      });
      const tab = tabsRef.current.find((x) => x.tabId === tabId);
      if (!tab) return;
      // The overlay is gone from the screen before the picture is taken.
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const [shot, info] = await Promise.all([
        api.capture.area({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }),
        handles.current[tab.tabId]?.area(r) ?? Promise.resolve({ text: '', pictures: true, locator: { quote: '', prefix: '', suffix: '' } }),
      ]);
      const text = info.text.trim();
      const label = text ? truncate(text.replace(/\s+/g, ' '), 300) : t('areaPicture');
      onPickRef.current(
        {
          context: {
            term: label,
            sentence: truncate(text, 1200),
            paragraph: truncate(text, 2400),
            docTitle: tab.doc.title,
            docSource: tab.doc.source,
            docLang: tab.lang,
          },
          rect: { x: r.right, y: r.top, width: 0, height: r.bottom - r.top },
          locator: info.locator,
          // Text alone is enough when nothing but text was there; otherwise the picture goes along.
          capture: { ...shot, send: info.pictures || !text },
        },
        tab.tabId,
      );
    });

  // --- keyboard & drop ---------------------------------------------------------
  /** Scrolls a card's document to its term and highlights it; the card stays where it is (a maximized one is restored). */
  const locateCard = (docId: string, card: Card) =>
    guard(async () => {
      const tab = tabsRef.current.find((x) => x.doc.docId === docId && layoutRef.current.panels.includes(x.tabId));
      const box = areaRef.current?.getBoundingClientRect();
      if (!tab || !box) return;
      show(tab.tabId);
      cards.setFocused(card.id);
      if (card.window !== 'normal') cards.update(docId, card.id, (c) => ({ ...c, window: 'normal' }));
      const r = fitRect(card.rect, { w: box.width, h: box.height });
      const avoid = { left: box.left + r.x, top: box.top + r.y, right: box.left + r.x + r.w, bottom: box.top + r.y + r.h };
      const loc = card.locator ?? locatorFromContext(card.term, card.context);
      const ok = await handles.current[tab.tabId]?.locate(loc, avoid);
      if (!ok) throw new Error(t('locateFailed', { term: card.term }));
    });
  /** The card the locate hotkey is for: the focused one, or the only one shown. */
  const locateFocused = () => {
    const shownIds = new Set(layoutRef.current.panels.map((id) => tabsRef.current.find((x) => x.tabId === id)?.doc.docId));
    const list = Object.entries(cards.byDoc).filter(([docId]) => shownIds.has(docId)).flatMap(([docId, l]) => l.map((card) => ({ docId, card })));
    const hit = list.find((x) => x.card.id === cards.focused) ?? (list.length === 1 ? list[0] : undefined);
    if (hit) void locateCard(hit.docId, hit.card);
  };
  const locateFocusedRef = useRef(locateFocused);
  locateFocusedRef.current = locateFocused;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (settings && !showSettings && matchHotkey(e, parseHotkey(settings.locateHotkey))) {
        e.preventDefault();
        locateFocused();
      } else if (settings && !showSettings && matchHotkey(e, parseHotkey(settings.captureHotkey))) {
        e.preventDefault();
        startCapture();
      } else if (mod && e.key.toLowerCase() === 'o') {
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
  // Cards of every document shown in a panel; they float over the whole reading area.
  const shownDocs = [...new Set(panels.map((id) => tabs.find((x) => x.tabId === id)?.doc.docId).filter((d): d is string => !!d))];
  const docCards: { docId: string; card: Card }[] = shownDocs.flatMap((docId) => (cards.byDoc[docId] ?? []).map((card) => ({ docId, card })));
  const shown = docCards.filter((x) => x.card.window !== 'minimized');
  const docked = docCards.filter((x) => x.card.window === 'minimized');
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
      if (tab) show(tab.tabId);
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
              className={`tab ${tab.tabId === active ? 'on' : ''} ${tab.tabId !== active && panels.includes(tab.tabId) ? 'shown' : ''}`}
              title={tab.doc.source}
              onClick={() => show(tab.tabId)}
            >
              <span className="tab-kind">{kindIcon(tab.doc)}</span>
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
        <div className="layout-switch" role="radiogroup" aria-label={t('layoutThree')}>
          {([1, 2, 3] as PanelCount[]).map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={panels.length === n}
              className={`icon ${panels.length === n ? 'on' : ''}`}
              title={t(n === 1 ? 'layoutOne' : n === 2 ? 'layoutTwo' : 'layoutThree')}
              aria-label={t(n === 1 ? 'layoutOne' : n === 2 ? 'layoutTwo' : 'layoutThree')}
              onClick={() => setPanelCount(n)}
              data-testid={`layout-${n}`}
            >
              <Icon name={n === 1 ? 'layout1' : n === 2 ? 'layout2' : 'layout3'} />
            </button>
          ))}
        </div>
        <div className="topbar-actions">
          <button onClick={() => void openFiles()}>
            <Icon name="open" />
            {t('openFile')}
          </button>
          <button
            className="icon"
            title={`${t('captureArea')} (${settings.captureHotkey})`}
            aria-label={t('captureArea')}
            disabled={!panels.some((id) => id !== null)}
            onClick={startCapture}
            data-testid="capture-area"
          >
            <Icon name="scan" />
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
        {tabs.map((tab) => {
          const slot = panels.indexOf(tab.tabId);
          const z = zoom[tab.tabId] ?? 1;
          return (
            <ReaderFrame
              key={tab.tabId}
              tab={tab}
              slot={slot}
              count={panels.length}
              active={tab.tabId === active}
              zoom={z}
              onActivate={() => slot !== layoutRef.current.active && setLayout({ ...layoutRef.current, active: slot })}
              onPointerInside={() => (pointerTab.current = tab.tabId)}
              onZoomBy={(f, x, y) => zoomBy(tab.tabId, f, x, y)}
              head={
                <PanelHead
                  t={t}
                  region={REGIONS[panels.length as PanelCount][slot]}
                  tabs={tabs}
                  tabId={tab.tabId}
                  zoom={z}
                  onChoose={(id) => setLayout({ panels: placeTab(layoutRef.current.panels, slot, id), active: slot })}
                  onResetZoom={() => setZoomFor(tab.tabId, 1)}
                />
              }
            >
              {tab.doc.kind === 'web' ? (
                <WebReader
                  doc={tab.doc}
                  t={t}
                  preloadUrl={preloadUrl}
                  hotkey={settings.hotkey}
                  locateHotkey={settings.locateHotkey}
                  zoom={z}
                  onZoomBy={(f, x, y) => zoomBy(tab.tabId, f, x, y)}
                  onPick={(p) => onPick(p, tab.tabId)}
                  captureHotkey={settings.captureHotkey}
                  onHotkey={(kind) => (kind === 'locate' ? locateFocusedRef.current() : startCaptureRef.current())}
                  onPointer={(inside) => {
                    if (inside) {
                      webPointer.current = tab.tabId;
                      pointerTab.current = tab.tabId;
                    } else if (webPointer.current === tab.tabId) webPointer.current = null;
                  }}
                  onHandle={handleFor(tab.tabId)}
                  onText={onDocText(tab)}
                  onNavigate={onWebNavigate(tab)}
                />
              ) : tab.doc.kind === 'pdf' ? (
                <PdfReader doc={tab.doc} t={t} zoom={z} onZoom={(nz) => setZoomFor(tab.tabId, nz)} onText={onDocText(tab)} onHandle={handleFor(tab.tabId)} />
              ) : (
                <HtmlReader doc={tab.doc} t={t} zoom={z} onText={onDocText(tab)} onHandle={handleFor(tab.tabId)} />
              )}
            </ReaderFrame>
          );
        })}
        {tabs.length > 0 &&
          panels.map((p, i) =>
            p === null ? (
              <EmptyPanel
                key={`empty-${i}`}
                t={t}
                slot={i}
                count={panels.length}
                active={i === layout.active}
                tabs={tabs}
                onActivate={() => setLayout({ ...layoutRef.current, active: i })}
                onChoose={(id) => setLayout({ panels: placeTab(layoutRef.current.panels, i, id), active: i })}
              />
            ) : null,
          )}
        {shown.length > 0 && (
          <div className="card-layer">
            {shown.map(({ docId, card }, i) => (
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
                others={shown.filter((x) => x.card.id !== card.id && x.card.window === 'normal').map((x) => fitRect(x.card.rect, area))}
                onFocus={() => cards.setFocused(card.id)}
                onChange={(c, persist) => cards.update(docId, c.id, () => c, persist)}
                onRun={(skill, o) => void cards.run(docId, card.id, skill, o)}
                onRerun={(task) => void cards.rerun(docId, card.id, task)}
                onCancel={(task) => void api.jobs.cancel(task.jobId)}
                onClose={() => cards.close(docId, card.id)}
                onLocate={() => void locateCard(docId, card)}
              />
            ))}
          </div>
        )}
        {docked.length > 0 && (
          <div className="card-dock" data-testid="card-dock">
            {docked.map(({ docId, card }) => {
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
      {capturing && <AreaCapture t={t} onDone={(r) => void onArea(r)} onCancel={() => setCapturing(false)} />}
      {showTasks && (
        <TaskPanel
          jobs={allJobs}
          docTitle={docTitle}
          skillLabel={label}
          t={t}
          onStop={(id) => void api.jobs.cancel(id)}
          onStopAll={() => {
            for (const j of allJobs) if (j.status === 'running' || j.status === 'queued') void api.jobs.cancel(j.id);
          }}
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

function kindIcon(d: Pick<DocInfo, 'kind' | 'source'>): string {
  if (d.kind === 'code') {
    // The file's own type: PY, JSON, YAML …
    const name = d.source.split(/[\\/]/).at(-1) ?? '';
    const ext = name.includes('.') && !name.startsWith('.') ? name.split('.').at(-1)! : name.replace(/^\./, '');
    return ext.slice(0, 4).toUpperCase() || 'CODE';
  }
  return { web: 'WEB', pdf: 'PDF', docx: 'DOC', markdown: 'MD', text: 'TXT', html: 'HTML' }[d.kind];
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
                <span className="tab-kind">{kindIcon(d)}</span>
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
