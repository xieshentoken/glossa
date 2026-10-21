// End-to-end smoke test, run inside the real app when GLOSSA_SMOKE=1
// (see scripts/smoke.mjs). Uses the offline demo provider and a fake agent CLI.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { runConnectionSmoke } from './connection-smoke';
import path from 'node:path';
import { dialog, net, session, webContents as allContents, type BrowserWindow } from 'electron';
import { WEB_PARTITION } from './web-security';
import { piWorkers } from './runners/pi';
import { PI_HARNESS } from '../shared/defaults';
import { trustToken } from './agent-policy';
import type { DocumentService } from './documents';
import type { JobManager } from './jobs';
import type { SkillRegistry } from './skills';
import type { Store } from './store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(win: BrowserWindow, deps: { store: Store; jobs: JobManager; skills: SkillRegistry; docs: DocumentService }): Promise<number> {
  const dir = process.env.GLOSSA_SMOKE_DIR!;
  // Fixture web page. Served inside the web view's own session at an https address, so the web
  // steps need no loopback connection (refused on some machines); other addresses load normally.
  const FIXTURE_HOST = 'fixture.glossa.test';
  const fixturePage = `<!doctype html><html lang="en"><head><title>Plants</title></head><body><main>
<h1>How plants eat</h1><p>Leaves capture light through photosynthesis, turning carbon dioxide and water into sugar.</p>
</main></body></html>`;
  const fixturePdf = (file: string, headers: Record<string, string> = {}) =>
    new Response(new Uint8Array(fs.readFileSync(path.join(dir, file))), { headers: { 'content-type': 'application/pdf', ...headers } });
  session.fromPartition(WEB_PARTITION).protocol.handle('https', (req) => {
    const u = new URL(req.url);
    if (u.host !== FIXTURE_HOST) return net.fetch(req, { bypassCustomProtocolHandlers: true });
    if (u.pathname === '/papers/boundary.pdf') return fixturePdf('web.pdf');
    // A PDF behind an address without .pdf, as journals serve them.
    if (u.pathname === '/article/7/download') return fixturePdf('web2.pdf', { 'content-disposition': 'attachment; filename="Form drag.pdf"' });
    if (u.pathname === '/long') return new Response(fs.readFileSync(path.join(dir, 'long.md'), 'utf8').split('\n\n').slice(1).map((x) => `<p>${x}</p>`).join('\n').replace(/^/, '<!doctype html><html lang="en"><head><title>Long page</title></head><body style="max-width:700px;margin:auto;font:16px/1.6 sans-serif">') + '</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response(fixturePage, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const url = process.env.GLOSSA_SMOKE_WEB_URL || `https://${FIXTURE_HOST}/plants`;
  const wc = win.webContents;
  const log = (...a: unknown[]) => console.log('[smoke]', ...a);
  const js = <T = unknown>(code: string): Promise<T> => wc.executeJavaScript(code, true);
  const waitFor = async <T>(what: string, code: string, ms = 15000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await js<T>(code).catch(() => undefined);
      if (v) return v;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const key = (keyCode: string, modifiers: ('shift' | 'alt')[] = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const textRect = (scope: string, needle: string) => `(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    if (!root) return null;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(${JSON.stringify(needle)});
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${needle.length});
      const b = r.getBoundingClientRect();
      if (b.width > 0) return { x: Math.round(b.left + Math.min(4, b.width / 2)), y: Math.round(b.top + b.height / 2) };
    }
    return null;
  })()`;
  const pickWithMouse = async (scope: string, needle: string) => {
    const p = await waitFor<{ x: number; y: number }>(`text "${needle}"`, textRect(scope, needle));
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    await sleep(50);
    key('Q', ['alt']);
    await waitFor('highlight', `!!document.querySelector('[data-glossa-overlay]')`, 3000);
  };
  const shotDir = process.env.GLOSSA_SMOKE_SHOTS;
  const shoot = async (name: string) => {
    if (!shotDir) return;
    wc.invalidate();
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await sleep(500);
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, `${name}.png`), (await wc.capturePage()).toPNG());
  };
  // Cards of the active document; the newest is last.
  const CARDS = `[...document.querySelectorAll('.card-layer [data-testid=term-card]')]`;
  const LAST = `${CARDS}.at(-1)`;
  const cardTerms = () => js<string[]>(`${CARDS}.map((c) => c.dataset.term)`);
  /** The term of the card a pick just created (earlier cards stay). */
  const newCardTerm = async (before: number) => {
    await waitFor('new card', `${CARDS}.length > ${before}`);
    return js<string>(`${LAST}.dataset.term`);
  };
  const clickSkill = (text: string, card = LAST) =>
    js(`(() => { const b = [...(${card}?.querySelectorAll('.skills-row button') ?? [])].find(b => b.textContent.includes(${JSON.stringify(text)})); b?.click(); return !!b; })()`);
  const dockTerms = () => js<string[]>(`[...document.querySelectorAll('[data-testid=dock-item] .dock-term')].map((x) => x.textContent)`);
  /** A card's box relative to the reading area. */
  const box = (card: string) =>
    js<{ x: number; y: number; w: number; h: number }>(`(() => {
      const a = document.querySelector('.reader-area').getBoundingClientRect();
      const r = (${card}).getBoundingClientRect();
      return { x: r.left - a.left, y: r.top - a.top, w: r.width, h: r.height };
    })()`);
  const close1 = (a: number, b: number) => Math.abs(a - b) <= 1;
  /** Drags a card by its title bar with real mouse events. */
  const dragCard = async (card: string, dx: number, dy: number, handle = '.card-head') => {
    const p = await js<{ x: number; y: number }>(`(() => { const h = (${card}).querySelector('${handle}').getBoundingClientRect(); return { x: Math.round(h.left + Math.min(5, h.width / 2)), y: Math.round(h.top + h.height / 2) }; })()`);
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x + (dx * i) / 6), y: Math.round(p.y + (dy * i) / 6), modifiers: ['leftbuttondown'] });
      await sleep(30);
    }
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(p.x + dx), y: Math.round(p.y + dy), button: 'left', clickCount: 1 });
    await sleep(150);
  };
  /** Result address of a finished run of `skill` shown in a card. */
  const doneResult = (skill: string, card = LAST, ms = 15000) =>
    waitFor<string>(`${skill} done`, `${card}?.querySelector('[data-testid=task-view][data-skill=${skill}][data-status=done] iframe')?.src`, ms).catch(async (err: Error) => {
      const shown = await js<string>(`${card}?.querySelector('[data-testid=task-view]')?.textContent ?? '(no run shown)'`).catch(() => '?');
      throw new Error(`${err.message}; the card shows: ${shown}`);
    });

  // --- setup ------------------------------------------------------------------
  const s = deps.store.getSettings();
  deps.store.setSettings({
    agentsEnabled: true,
    uiLang: 'en',
    // The flow below checks what each click starts; the automatic quick explanation has its own section.
    autoQuick: false,
    outputDir: '',
    // Screenshots of the light theme: GLOSSA_SMOKE_THEME=light.
    ...(process.env.GLOSSA_SMOKE_THEME === 'light' || process.env.GLOSSA_SMOKE_THEME === 'dark' ? { theme: process.env.GLOSSA_SMOKE_THEME } : {}),
    defaults: {
      quick: { providerId: 'demo', model: 'fake', effort: 'low', maxTokens: 1024 },
      direct: { providerId: 'demo', model: 'fake', effort: 'medium', maxTokens: 4000 },
      agent: { harnessId: 'fake-agent', model: 'test-model', effort: 'low', budgetUsd: 1, timeoutMinutes: 2 },
    },
    harnesses: [
      ...s.harnesses.filter((h) => h.id !== 'fake-agent'),
      {
        id: 'fake-agent',
        label: 'Fake agent',
        command: `node ${JSON.stringify(path.join(dir, 'fake-agent.mjs'))} --model {model} --effort {effort}`,
        parser: 'claude-stream-json',
        skillDirs: ['.claude/skills'],
      },
    ],
  });
  deps.skills.importFolder(path.join(dir, 'skills', 'fake-figure'), true);
  // Main-side test setup: approve the test skill once, as "remember" in the approval dialog would.
  // The product path (dialog shown by the main process) is not bypassed for any other skill.
  const fig = deps.skills.list(deps.store.getSettings()).find((x) => x.name === 'fake-figure')!;
  const harness = deps.store.getSettings().harnesses.find((h) => h.id === 'fake-agent')!;
  deps.store.setTrust('fake-figure', trustToken(deps.skills.contentHash(fig), harness));
  const piTrust = trustToken(deps.skills.contentHash(fig), PI_HARNESS);
  win.setContentSize(1280, 820);
  wc.reload();
  await sleep(300);
  await waitFor('app', `!!window.__glossaTest && !!window.__glossaCapture`);
  // Behaviour, not motion: a hidden window advances animations unreliably, so they are switched off here.
  await wc.insertCSS('*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; }');
  win.focus();
  wc.focus();
  const stateFile = path.join(deps.store.dir, 'smoke-state.json');
  if (process.env.GLOSSA_SMOKE_PHASE === '2') return phaseTwo();

  // Second launch on the same data: cards come back, the quick explanation is
  // served from the cache with its text, and a deleted result shows a way back.
  async function phaseTwo(): Promise<number> {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { docId: string; eli5: string; agent: string; long: string };
    await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'sample.md'))})`);
    await waitFor('restored cards', `${CARDS}.length === 1 && ${CARDS}[0].dataset.status && document.querySelector('[data-testid=dock-item].s-done')`);
    const restored = { docked: await dockTerms(), shown: await cardTerms(), status: await js<string>(`${CARDS}[0].dataset.status`) };
    log('restored cards', JSON.stringify(restored), '(agent result', st.agent, 'was deleted between launches)');
    const missing = await js<string>(`${CARDS}[0].querySelector('.error-text')?.textContent ?? ''`);
    if (restored.docked.join() !== 'heat transfer coefficient' || restored.shown.join() !== '对流换热' || restored.status !== 'error' || !/missing or damaged/.test(missing)) {
      throw new Error('restore states wrong');
    }
    // Phase 1 narrowed the scope in Settings; the cached answer was made with 'paragraph'.
    deps.store.setSettings({ dataScope: 'paragraph' });
    await pickWithMouse('.reader.active .html-doc', 'coefficient');
    key('Left', ['shift']);
    key('Left', ['shift']);
    key('Return');
    if ((await newCardTerm(1)) !== 'heat transfer coefficient') throw new Error('pick after restart failed');
    await clickSkill('Quick');
    const cachedSrc = await doneResult('quick-gloss');
    const cachedStatus = await js<string>(`${LAST}.querySelector('.task-status').textContent`);
    const cachedBody = await (await net.fetch(cachedSrc)).text();
    if (!/From cache/.test(cachedStatus) || !cachedBody.includes('offline sample explanation (quick-gloss')) throw new Error(`cached quick result: ${cachedStatus}`);
    log('quick explanation served from the cache after restart');
    await shoot('7-restored');
    // The run that was going when the app ended is interrupted, shown as such, and was not started again.
    const startedBefore = piWorkers().started.length;
    if (startedBefore !== 0) throw new Error(`expected no Pi run besides the cached one, saw ${startedBefore}`);
    await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'sample.pdf'))})`);
    await waitFor('pdf cards', `${CARDS}.some((c) => c.querySelector('[data-testid=task-view][data-job="${st.long}"]'))`, 15000);
    const shownLong = await js<string>(`${CARDS}.map((c) => c.querySelector('[data-testid=task-view][data-job="${st.long}"]')).find(Boolean).textContent`);
    const longState = deps.jobs.get(st.long);
    if (!longState?.interrupted || longState.status !== 'error' || !/Interrupted/.test(shownLong) || piWorkers().started.length) {
      throw new Error(`interrupted run: ${JSON.stringify(longState)} | ${shownLong}`);
    }
    log('a run going when the app ended is shown as interrupted and was not resumed');
    log('ALL PASSED (phase 2)');
    return 0;
  }

  await shoot('0-welcome');

  // --- zoom keeps what is under the pointer in place ------------------------------
  /** The character under a point, as its offset in the text of `doc` (null off text). */
  const charAt = (doc: string, x: number, y: number) => `((document) => {
    const root = document.querySelector(${JSON.stringify(doc)});
    const c = document.caretRangeFromPoint(${x}, ${y});
    if (!c || c.startContainer.nodeType !== 3 || !root.contains(c.startContainer)) return null;
    const pre = document.createRange(); pre.setStart(root, 0); pre.setEnd(c.startContainer, c.startOffset);
    return pre.toString().length;
  })(document)`;
  /** How far (in lines) that character's line is from the point now: 0 = still under it. */
  const lineOff = (doc: string, offset: number, y: number) => `((document) => {
    const root = document.querySelector(${JSON.stringify(doc)});
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let left = ${offset};
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (left < n.data.length) {
        const r = document.createRange(); r.setStart(n, left); r.setEnd(n, Math.min(n.data.length, left + 1));
        const b = r.getBoundingClientRect();
        return ${y} >= b.top && ${y} <= b.bottom ? 0 : Math.round(((${y} < b.top ? b.top - ${y} : ${y} - b.bottom) / b.height) * 100) / 100 * (${y} < b.top ? -1 : 1);
      }
      left -= n.data.length;
    }
    return null;
  })(document)`;
  /** A point on a line of text about a third down the panel (`view`: an expression for the panel's box). */
  const pointOnText = (doc: string, view: string) => `((document) => {
    const v = ${view};
    const y0 = v.top + v.height * 0.35;
    const w = document.createTreeWalker(document.querySelector(${JSON.stringify(doc)}), NodeFilter.SHOW_TEXT);
    let best = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.data.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const b of r.getClientRects()) {
        if (b.width < 60 || b.left < v.left || b.left + 40 > Math.min(v.left + v.width, innerWidth) || b.top < v.top || b.bottom > Math.min(v.top + v.height, innerHeight)) continue;
        const d = Math.abs(b.top + b.height / 2 - y0);
        if (!best || d < best.d) best = { d, x: Math.round(b.left + 30), y: Math.round(b.top + b.height / 2) };
      }
    }
    return best;
  })(document)`;
  /** Ctrl+wheel steps as a trackpad pinch sends them: all in one task, or `gap` ms apart. */
  const pinchSteps = (x: number, y: number, steps: readonly number[], gap: number) => `new Promise((done) => {
    const target = document.elementFromPoint(${x}, ${y});
    const steps = ${JSON.stringify(steps)};
    let i = 0;
    const step = () => {
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: steps[i], ctrlKey: true, clientX: ${x}, clientY: ${y}, bubbles: true, cancelable: true }));
      if (++i < steps.length) ${gap} ? setTimeout(step, ${gap}) : step();
      else done(true);
    };
    step();
  })`;
  /** Zoom in and out, at once and spread over time. */
  const PINCHES = [
    { steps: [-40, -40, -40, -40, -40, -40], gap: 0 },
    { steps: [40, 40, 40, 40], gap: 0 },
    { steps: [-25, -25, -25, -25, -25], gap: 12 },
    { steps: [30, 30, 30], gap: 40 },
    { steps: [-100], gap: 0 },
  ] as const;
  /** Where a point is on a PDF page: page number and fractions of the page (pages do not reflow). */
  const pageSpotAt = (x: number, y: number) => `(() => {
    const page = document.elementsFromPoint(${x}, ${y}).map((e) => e.closest('.reader.active .pdf-page')).find(Boolean);
    if (!page) return null;
    const b = page.getBoundingClientRect();
    return { n: page.dataset.page, fx: (${x} - b.left) / b.width, fy: (${y} - b.top) / b.height };
  })()`;
  /** How far (px, [across, down]) that spot of its page is from the point now. */
  const pageSpotOff = (spot: { n: string; fx: number; fy: number }, x: number, y: number) => `(() => {
    const b = document.querySelector('.reader.active .pdf-page[data-page="${spot.n}"]').getBoundingClientRect();
    return [Math.round(b.left + ${spot.fx} * b.width - ${x}), Math.round(b.top + ${spot.fy} * b.height - ${y})];
  })()`;
  /**
   * Pinches over text. After each: for text, how many lines the character that was under the pointer
   * is from it (0 = still under it; text that reflows can move a word to the next line); for PDF
   * pages, how many pixels the spot of the page that was under the pointer is from it.
   */
  /** `cssPerScreen`: CSS pixels of the document per screen pixel (a web page's own zoom), 1 in the app. */
  const zoomCheck = async (label: string, run: (code: string) => Promise<unknown>, doc: string, view: string, zoomNow: () => Promise<number>, settle: number, pages = false, cssPerScreen = async () => 1) => {
    const offs: (number | null)[] = [];
    const zooms: number[] = [];
    for (const pinch of PINCHES) {
      let p = null as { x: number; y: number } | null;
      for (let i = 0; i < 100 && !p; i++) {
        p = (await run(pointOnText(doc, view))) as typeof p;
        if (!p) await sleep(100);
      }
      if (!p) throw new Error(`zoom ${label}: no text in view`);
      const at = pages ? ((await run(pageSpotAt(p.x, p.y))) as { n: string; fx: number; fy: number }) : ((await run(charAt(doc, p.x, p.y))) as number | null);
      const before = await zoomNow();
      const k0 = await cssPerScreen();
      await run(pinchSteps(p.x, p.y, pinch.steps, pinch.gap));
      await sleep(settle);
      const now = await zoomNow();
      // The same screen point, in the document's coordinates now.
      const k = (await cssPerScreen()) / k0;
      const q = { x: p.x * k, y: p.y * k };
      if (now === before) throw new Error(`zoom ${label}: the pinch did not zoom (${before})`);
      zooms.push(now);
      offs.push(at === null ? null : ((await run(pages ? pageSpotOff(at as { n: string; fx: number; fy: number }, q.x, q.y) : lineOff(doc, at as number, q.y))) as number | null));
    }
    log(`zoom ${label}: ${pages ? 'px [across, down]' : 'lines'} off`, JSON.stringify(offs), 'zooms', zooms.join(' '));
    return offs;
  };
  const panelZoom = () => js<number>(`Number(document.querySelector('.reader.active').dataset.zoom)`);
  const PANEL_VIEW = `document.querySelector('.reader.active .doc-scroll').getBoundingClientRect()`;
  /** Zooming (pinches as a trackpad sends them, the PDF toolbar, Ctrl+0) keeps what is under the pointer in place. */
  const zoomSteps = async () => {
    // One panel, so that every check runs on a full-width reader.
    await js(`document.querySelectorAll('.layout-switch [role=radio]')[0].click()`);
    await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'long.md'))})`);
    await waitFor('long md', `document.querySelectorAll('.reader.active .html-doc p').length > 100`);
    await js(`(() => { const s = document.querySelector('.reader.active .doc-scroll'); s.scrollTop = s.scrollHeight * 0.45; })()`);
    await sleep(300);
    // Text reflows in a narrower or wider column: a word may go to the next line, never further.
    const md = await zoomCheck('markdown', js, '.reader.active .html-doc', PANEL_VIEW, panelZoom, 300);
    if (md.some((o) => o === null || Math.abs(o) > 1)) throw new Error(`markdown zoom moved the text: ${JSON.stringify(md)}`);

    await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'long.pdf'))})`);
    await waitFor('long pdf', `document.querySelectorAll('.reader.active .pdf-page').length === 80`, 20000);
    await js(`(() => { const s = document.querySelector('.reader.active .doc-scroll'); s.scrollTop = s.scrollHeight * 0.5; })()`);
    await waitFor('pdf text', `document.querySelectorAll('.reader.active .textLayer span').length > 0`, 20000);
    await sleep(500);
    // Down the page nothing moves; across, a page narrower than the panel stays centred as it grows.
    const pdfOffs = (await zoomCheck('pdf', js, '.reader.active .pdf-pages', PANEL_VIEW, panelZoom, 1200, true)) as unknown as [number, number][];
    if (pdfOffs.some((o) => !o || Math.abs(o[1]) > 3)) throw new Error(`pdf zoom moved the pages: ${JSON.stringify(pdfOffs)}`);
    // The toolbar and Ctrl+0 keep the middle of the panel.
    const mid = await js<{ x: number; y: number }>(`(() => { const b = ${PANEL_VIEW}; return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    for (const [how, act] of [
      ['toolbar +', () => js(`document.querySelector('.reader.active button[title="Zoom in"]').click()`)],
      ['Ctrl+0', async () => void wc.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] })],
    ] as const) {
      const spot = (await js(pageSpotAt(mid.x, mid.y))) as { n: string; fx: number; fy: number };
      const z0 = await panelZoom();
      await act();
      await sleep(1200);
      const off = (await js(pageSpotOff(spot, mid.x, mid.y))) as [number, number];
      if ((await panelZoom()) === z0 || Math.abs(off[1]) > 3) throw new Error(`pdf ${how}: zoom ${z0}→${await panelZoom()}, moved ${JSON.stringify(off)}`);
      log(`pdf ${how}: zoom ${z0}→${await panelZoom()}, middle of the panel moved [across, down]`, JSON.stringify(off));
    }

    await js(`window.__glossaTest.openUrl('https://${FIXTURE_HOST}/long')`);
    const g = await (async () => {
      for (let i = 0; i < 150; i++) {
        const x = allContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().endsWith('/long'));
        if (x && !x.isLoading()) return x;
        await sleep(100);
      }
      throw new Error('long page did not load');
    })();
    await g.executeJavaScript('window.scrollTo(0, document.documentElement.scrollHeight * 0.45)');
    await sleep(300);
    const web = await zoomCheck('web', (c) => g.executeJavaScript(c), 'body', `({ top: 0, left: 0, width: innerWidth, height: innerHeight })`, panelZoom, 900, false, async () => 1 / (await g.executeJavaScript('window.devicePixelRatio')));
    if (web.some((o) => o === null || Math.abs(o) > 1)) throw new Error(`web zoom moved the page: ${JSON.stringify(web)}`);
  };
  // GLOSSA_ZOOM_DIAG=1: only the zoom checks (quick to run while working on zoom).
  if (process.env.GLOSSA_ZOOM_DIAG) {
    await zoomSteps();
    return 0;
  }

  // --- Markdown document: hotkey, span adjust, quick gloss, ELI5 ------------------
  await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'sample.md'))})`);
  await waitFor('markdown doc', `document.querySelector('.reader.active .html-doc')?.textContent.includes('heat transfer coefficient')`);
  await pickWithMouse('.reader.active .html-doc', 'coefficient');
  key('Left', ['shift']);
  key('Left', ['shift']);
  key('Return');
  const term1 = await newCardTerm(0);
  if (term1 !== 'heat transfer coefficient') throw new Error(`span adjust picked "${term1}"`);
  log('picked', term1);
  // Nothing runs until a skill is clicked.
  if (await js<number>(`${LAST}.querySelectorAll('[data-testid=task-view]').length`)) throw new Error('a run started without a click');
  await shoot('1-card');
  if (!(await clickSkill('Quick'))) throw new Error('no Quick button');
  const quickBody = await (await net.fetch(await doneResult('quick-gloss'))).text();
  if (!quickBody.includes('offline sample explanation (quick-gloss')) throw new Error('quick result wrong');
  log('quick explanation from its button');
  if (!(await clickSkill('ELI5'))) throw new Error('no ELI5 button');
  const src = await doneResult('eli5');
  await shoot('2-card-results');
  // Clicking a skill that already ran goes back to that run instead of starting another.
  await clickSkill('Quick');
  await waitFor('back to quick', `${LAST}.querySelector('[data-testid=task-view]')?.dataset.skill === 'quick-gloss'`);
  // Skill buttons are also the result tabs: two of them now carry a run.
  const ran = await js<number>(`${LAST}.querySelectorAll('.skills-row .chip-status').length`);
  if (ran !== 2) throw new Error(`expected 2 runs on the card, got ${ran}`);
  const res = await net.fetch(src);
  const body = await res.text();
  if (res.status !== 200 || !body.includes('offline sample explanation (eli5') || !res.headers.get('content-security-policy')?.includes("default-src 'none'")) {
    throw new Error(`output protocol: ${res.status} ${body.slice(0, 200)}`);
  }
  log('ELI5 result served with CSP', src);

  // --- Export as HTML: the save dialog answers as a user would (main side) -----------
  const exportDir = path.join(dir, 'exported');
  fs.mkdirSync(exportDir, { recursive: true });
  const showSave = dialog.showSaveDialog;
  const exportTo = async (name: string, card = LAST) => {
    let asked: Electron.SaveDialogOptions | undefined;
    (dialog as { showSaveDialog: unknown }).showSaveDialog = async (_w: unknown, o: Electron.SaveDialogOptions) => ((asked = o), { canceled: false, filePath: path.join(exportDir, name) });
    try {
      await js(`${card}.querySelector('[data-testid=export-html]').click()`);
      const shown = await waitFor<string>('exported', `${card}.querySelector('[data-testid=exported-to]')?.title`);
      return { shown, asked: asked! };
    } finally {
      (dialog as { showSaveDialog: unknown }).showSaveDialog = showSave;
    }
  };
  await clickSkill('ELI5');
  await waitFor('back to eli5', `${LAST}.querySelector('[data-testid=task-view]')?.dataset.skill === 'eli5'`);
  const eli5Export = await exportTo('eli5.html');
  const eli5Page = fs.readFileSync(path.join(exportDir, 'eli5.html'), 'utf8');
  if (!eli5Page.startsWith('<!doctype html>') || !eli5Page.includes('offline sample explanation (eli5') || !eli5Page.includes('max-width: 46rem')) throw new Error(`exported ELI5 page: ${eli5Page.slice(0, 200)}`);
  if (path.basename(eli5Export.asked.defaultPath ?? '') !== 'heat transfer coefficient - ELI5.html') throw new Error(`export suggested ${eli5Export.asked.defaultPath}`);
  log('ELI5 exported as a standalone page;', eli5Export.shown);

  // --- agent skill on a Chinese term, in a second card ---------------------------
  // The first card would cover the text below it: minimize it first.
  await js(`${CARDS}[0].querySelector('.card-head button[title=Minimize]').click()`);
  await waitFor('minimized into the dock', `${CARDS}.length === 0 && document.querySelectorAll('[data-testid=dock-item]').length === 1`);
  await pickWithMouse('.reader.active .html-doc', '对流');
  key('Right');
  key('Right');
  key('Return');
  const term2 = await newCardTerm(0);
  log('picked', term2);
  if (!term2.startsWith('对流换')) throw new Error(`CJK pick gave "${term2}"`);
  if (!(await clickSkill('Figure (test)'))) throw new Error('no agent skill button');
  await doneResult('fake-figure', LAST, 30000);
  const agentJob = await js<string>(`${LAST}.querySelector('.task-status').textContent`);
  log('agent card:', agentJob);

  // --- a third card; the earlier ones keep their own terms -------------------------
  // The second card is moved off the heading first, as a reader would.
  await dragCard(LAST, 400, 300);
  await pickWithMouse('.reader.active .html-doc', 'basics');
  key('Return');
  const term3card = await newCardTerm(1);
  const terms = [...(await dockTerms()), ...(await cardTerms())];
  log('cards on one document', JSON.stringify(terms));
  if (terms.length !== 3 || terms[0] !== term1 || terms[1] !== term2 || term3card !== 'basics') throw new Error('cards replaced each other');
  await shoot('3-three-cards');
  await js(`${LAST}.querySelector('.card-head button[title=Close]').click()`);
  await waitFor('third card closed', `${CARDS}.length === 1`);
  // The dock brings a minimized card back where it was; minimizing puts it back.
  const docked = await box(`${CARDS}[0]`);
  await js(`document.querySelector('[data-testid=dock-item]').click()`);
  await waitFor('restored from the dock', `${CARDS}.length === 2 && !document.querySelector('[data-testid=dock-item]')`);
  if ((await cardTerms())[0] !== term1) throw new Error('dock restored the wrong card');
  await js(`${CARDS}[0].querySelector('.card-head button[title=Minimize]').click()`);
  await waitFor('back in the dock', `${CARDS}.length === 1 && document.querySelectorAll('[data-testid=dock-item]').length === 1`);
  if (JSON.stringify(await box(`${CARDS}[0]`)) !== JSON.stringify(docked)) throw new Error('other card moved');
  log('dock: minimize and restore');

  // --- persistence ---------------------------------------------------------------
  await sleep(700);
  const docs = deps.store.recentDocs();
  const rec = deps.store.getDoc(docs.find((d) => d.kind === 'markdown')!.docId)!;
  const saved = rec.termCards ?? [];
  if (saved.length !== 2 || rec.cards) throw new Error(`expected 2 saved cards, got ${saved.length}`);
  if (saved[0].window !== 'minimized' || saved[0].tasks.map((x) => x.skill).join() !== 'quick-gloss,eli5') throw new Error('first card not saved as shown');
  const agentCard = saved[1].tasks[0];
  const html = fs.readFileSync(deps.jobs.outputFile(agentCard.jobId)!, 'utf8');
  if (!html.includes(term2)) throw new Error('agent output lacks the term');
  const agentRes = await net.fetch(`glossa-out://${agentCard.jobId}/`);
  if (!agentRes.headers.get('content-security-policy')?.includes("connect-src 'none'")) throw new Error('agent output CSP missing');
  log('cards persisted; agent output ok');

  // --- PDF ------------------------------------------------------------------------
  await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'sample.pdf'))})`);
  await waitFor('pdf text layer', `[...document.querySelectorAll('.reader.active .textLayer span')].some(s => s.textContent.includes('Reynolds'))`, 20000);
  await pickWithMouse('.reader.active .textLayer', 'Reynolds');
  key('Return');
  const term3 = await newCardTerm(0);
  const sentence3 = await js<string>(`${LAST}.querySelector('.context-line')?.textContent`);
  log('pdf picked', term3, '|', sentence3);
  if (term3 !== 'Reynolds' || !sentence3.includes('number')) throw new Error('pdf pick failed');
  await shoot('4-pdf');
  // Switching documents shows each document's own cards.
  await js(`[...document.querySelectorAll('.tab')].find((x) => x.textContent.includes('Heat transfer') || x.title.endsWith('sample.md')).click()`);
  await waitFor('markdown cards back', `${CARDS}.length === 1`);
  if ((await cardTerms()).join() !== term2 || (await dockTerms()).join() !== term1) throw new Error('cards mixed between documents');
  await js(`[...document.querySelectorAll('.tab')].find((x) => x.title.endsWith('sample.pdf')).click()`);
  await waitFor('pdf card back', `${CARDS}.length === 1`);
  if ((await cardTerms())[0] !== 'Reynolds' || (await dockTerms()).length) throw new Error('pdf card lost');
  log('document switch keeps cards apart');

  // --- window operations with real mouse input ----------------------------------
  await pickWithMouse('.reader.active .textLayer', 'Laminar');
  key('Return');
  if ((await newCardTerm(1)) !== 'Laminar') throw new Error('second pdf card');
  // The reader sizes cards freely (resize handle, real mouse); the size they chose stays when another skill runs.
  const original = await box(`${CARDS}[0]`);
  for (const c of [`${CARDS}[0]`, LAST]) {
    const b = await box(c);
    await dragCard(c, -60, 240 - b.h, '.resize-handle');
  }
  const chosen = await box(`${CARDS}[0]`);
  if (chosen.h !== 240 || chosen.w !== original.w - 60) throw new Error(`resize: ${JSON.stringify({ original, chosen })}`);
  await clickSkill('Quick', `${CARDS}[0]`);
  await doneResult('quick-gloss', `${CARDS}[0]`);
  const afterRun = await box(`${CARDS}[0]`);
  if (afterRun.w !== chosen.w || afterRun.h !== chosen.h) throw new Error(`running a skill resized the card: ${JSON.stringify({ chosen, afterRun })}`);
  log('cards resized by hand to', `${chosen.w}×${chosen.h}`, 'keep that size when a skill runs');
  const p1 = await box(`${CARDS}[0]`);
  let p2 = await box(LAST);
  // Dropped 10px below the first card and 6px to the right: snaps under it with the gap, edges lined up.
  await dragCard(LAST, p1.x + 6 - p2.x, p1.y + p1.h + 10 - p2.y);
  p2 = await box(LAST);
  if (!close1(p2.x, p1.x) || !close1(p2.y, p1.y + p1.h + 8)) throw new Error(`card did not snap: ${JSON.stringify({ p1, p2 })}`);
  await dragCard(LAST, 0, 30);
  const p2free = await box(LAST);
  if (!close1(p2free.y, p2.y + 30)) throw new Error(`snap did not let go: ${JSON.stringify({ p2, p2free })}`);
  // Near the area's left edge it snaps to the margin.
  await dragCard(LAST, 13 - p2free.x, 0);
  const p2edge = await box(LAST);
  if (!close1(p2edge.x, 8)) throw new Error(`edge snap: ${JSON.stringify(p2edge)}`);
  log('snapping: under another card with a gap, released when dragged away, area edge');
  await js(`${LAST}.querySelector('.card-head button[title=Maximize]').click()`);
  await waitFor('maximized', `${LAST}.classList.contains('maximized')`);
  const mx = await box(LAST);
  const areaSize = await js<{ w: number; h: number }>(`(() => { const a = document.querySelector('.reader-area').getBoundingClientRect(); return { w: a.width, h: a.height }; })()`);
  if (!close1(mx.x, 0) || !close1(mx.y, 0) || !close1(mx.w, areaSize.w) || !close1(mx.h, areaSize.h)) throw new Error(`maximize: ${JSON.stringify({ mx, areaSize })}`);
  await shoot('4b-maximized');
  await js(`${LAST}.querySelector('.card-head button[title=Restore]').click()`);
  await waitFor('restored', `!${LAST}.classList.contains('maximized')`);
  if (JSON.stringify(await box(LAST)) !== JSON.stringify(p2edge)) throw new Error('restore did not return to the old place');
  // A smaller window keeps every card inside; the old places come back with the size.
  const firstBefore = await box(`${CARDS}[0]`);
  win.setContentSize(820, 560);
  await waitFor('cards inside the smaller area', `(() => { const a = document.querySelector('.reader-area').getBoundingClientRect(); return a.width < 900 && ${CARDS}.every((c) => { const r = c.getBoundingClientRect(); return r.left >= a.left && r.top >= a.top && r.right <= a.right + 0.5 && r.bottom <= a.bottom + 0.5; }); })()`);
  await shoot('4c-small-window');
  win.setContentSize(1280, 820);
  await waitFor('area back', `document.querySelector('.reader-area').getBoundingClientRect().width > 1200`);
  await sleep(100);
  if (JSON.stringify(await box(`${CARDS}[0]`)) !== JSON.stringify(firstBefore)) throw new Error('card did not return after the window grew again');
  log('maximize / restore and window resize keep cards inside');

  // --- long PDF: rendered pages are bounded, far pages are released ------------
  await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'long.pdf'))})`);
  await waitFor('long pdf', `document.querySelectorAll('.reader.active .pdf-page').length === 80`, 20000);
  let maxLive = 0;
  for (let i = 0; i <= 40; i++) {
    await js(`(() => { const s = document.querySelector('.reader.active .doc-scroll'); s.scrollTop = s.scrollHeight * ${i} / 40; })()`);
    await sleep(120);
    maxLive = Math.max(maxLive, await js<number>(`[...document.querySelectorAll('.reader.active .pdf-page canvas')].filter((c) => c.width > 0).length`));
  }
  await sleep(500);
  const liveAtEnd = await js<number>(`[...document.querySelectorAll('.reader.active .pdf-page canvas')].filter((c) => c.width > 0).length`);
  const lastRendered = await js<boolean>(`!!document.querySelector('.reader.active .pdf-page[data-page="80"] canvas')`);
  log('long pdf: pages 80, max live canvases while scrolling', maxLive, ', live at end', liveAtEnd, ', last page rendered', lastRendered);
  if (!lastRendered || liveAtEnd >= 80 || maxLive >= 80) throw new Error('pdf pages were not released');
  key('Escape');
  // Input events and executeJavaScript are not ordered: without a pause the tab switch below can come
  // first, and the late Escape then closes the card that takes the keyboard when the PDF's cards return.
  await sleep(200);

  // --- a skill that works in its job folder, on the built-in Pi agent -------------
  // (Quick and ELI5 above already ran on it, as short answers.)
  deps.store.setSettings({ skillOverrides: { 'fake-figure': { agent: { harnessId: 'pi', providerId: 'demo' } } } });
  deps.store.setTrust('fake-figure', piTrust);
  await js(`[...document.querySelectorAll('.tab')].find((x) => x.title.endsWith('sample.pdf')).click()`);
  await waitFor('pdf cards', `${CARDS}.length === 2`);
  const before = piWorkers().started.length;
  if (!(await clickSkill('Figure (test)', `${CARDS}[0]`))) throw new Error('no figure button on the pdf card');
  const piFigure = await doneResult('fake-figure', `${CARDS}[0]`, 30000);
  const piJobId = new URL(piFigure).host;
  const piJob = deps.jobs.get(piJobId)!;
  const piHtml = fs.readFileSync(deps.jobs.outputFile(piJobId)!, 'utf8');
  if (!piJob.engineLabel.startsWith('Pi · ') || !piHtml.includes('<h1>Reynolds</h1>')) throw new Error(`pi workspace run: ${piJob.engineLabel}`);
  // Skills that need Node.js get Electron itself as `node`.
  const shim = path.join(deps.jobs.jobDir(piJobId), 'work', '.glossa-bin', 'node');
  const shimRun = spawnSync(shim, ['-e', 'console.log(process.versions.electron)'], { encoding: 'utf8', timeout: 20000 });
  if (shimRun.stdout.trim() !== process.versions.electron) throw new Error(`node shim: ${shimRun.stdout} ${shimRun.stderr}`);
  log('built-in Pi worked in its job folder:', piJob.engineLabel, '| node shim runs Electron', shimRun.stdout.trim());
  // Each run's worker process ends with its job (checked with the operating system).
  const pids = piWorkers().started;
  if (pids.length <= before) throw new Error('no Pi worker process was started');
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && (piWorkers().live.length || pids.some(alive)); i++) await sleep(100);
  if (piWorkers().live.length || pids.some(alive)) throw new Error(`Pi worker processes still running: ${pids.filter(alive).join(', ')}`);
  log(`Pi worker processes ended with their jobs (${pids.length} started this session)`);
  deps.store.setSettings({ skillOverrides: {} });
  deps.store.setTrust('fake-figure', trustToken(deps.skills.contentHash(fig), harness));

  // --- several runs at once: two run, the third waits; closing a card does not stop them -----
  process.env.GLOSSA_PI_DEMO_DELAY_MS = '3000';
  deps.store.setSettings({ skillOverrides: { anatomy: { agent: { harnessId: 'pi', providerId: 'demo' } } } });
  const qCard = LAST; // the Laminar card
  const sizeBefore = await box(qCard);
  for (const name of ['Quick', 'ELI5', 'Anatomy']) if (!(await clickSkill(name, qCard))) throw new Error(`no ${name} button`);
  const tabStates = `[...${qCard}.querySelectorAll('.skills-row .chip-status')].map((x) => [...x.classList].find((c) => c.startsWith('s-'))).join()`;
  await waitFor('two running, one waiting', `${tabStates} === 's-running,s-running,s-queued'`, 8000).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${await js<string>(tabStates)}`);
  });
  // The waiting run's bar shows "not started" (the card shows its last-clicked run, Anatomy).
  await waitFor('waiting bar', `!!${qCard}.querySelector('[data-testid=task-view][data-skill=anatomy] [data-testid=run-progress].waiting')`, 4000);
  await shoot('5a-queue');
  // Stop one from the task panel: the others go on and the waiting one starts.
  await js(`document.querySelector('[data-testid=tasks-button]').click()`);
  await waitFor('task panel', `document.querySelectorAll('[data-testid=task-row][data-status=running]').length === 2`);
  await js(`[...document.querySelectorAll('[data-testid=task-row]')].find((r) => r.textContent.includes('Laminar') && r.textContent.includes('Quick')).querySelector('button[title=Stop]').click()`);
  await waitFor('queue moved on', `${tabStates} === 's-cancelled,s-running,s-running'`, 8000);
  // Running now: the bar grows (an estimate; it never fills by itself).
  const bar = `Number(${qCard}.querySelector('[data-testid=task-view][data-skill=anatomy] [data-testid=run-progress]')?.dataset.progress || 0)`;
  const b1 = await waitFor<number>('running bar', bar, 4000);
  await sleep(1200);
  const b2 = await js<number>(bar);
  if (!(b1 > 0 && b2 > b1 && b2 < 0.9)) throw new Error(`progress bar: ${b1} → ${b2}`);
  log('progress bar: waiting segment in the queue, then growing', b1.toFixed(3), '→', b2.toFixed(3));
  await shoot('5b-task-panel');
  log('queue: two running, third waiting; stopping one from the task panel started the third');
  // Switching between skills (Markdown and HTML results) never resizes the card.
  for (const name of ['Quick', 'ELI5', 'Anatomy']) {
    await clickSkill(name, qCard);
    await sleep(150);
    const b = await box(qCard);
    if (b.w !== sizeBefore.w || b.h !== sizeBefore.h) throw new Error(`card resized by ${name}: ${JSON.stringify({ sizeBefore, b })}`);
  }
  log('card size stays', `${sizeBefore.w}×${sizeBefore.h}`, 'across Quick, ELI5 and Anatomy');
  // Close the card while two runs are going: they finish anyway.
  await js(`${qCard}.querySelector('.card-head button[title=Close]').click()`);
  await waitFor('card closed', `${CARDS}.length === 1`);
  await waitFor('closed card runs finished', `(() => { const rows = [...document.querySelectorAll('[data-testid=task-row]')].filter((r) => r.textContent.includes('Laminar')); return rows.length === 3 && rows.filter((r) => r.dataset.status === 'done').length === 2; })()`, 20000);
  // Open brings the closed card back with its result.
  await js(`[...document.querySelectorAll('[data-testid=task-row]')].find((r) => r.textContent.includes('Laminar') && r.textContent.includes('Anatomy')).querySelector('button.link').click()`);
  await waitFor('card back from the task panel', `${CARDS}.length === 2 && !document.querySelector('[data-testid=tasks-panel]')`);
  await doneResult('anatomy', LAST, 10000);
  if ((await js<string>(`${LAST}.dataset.term`)) !== 'Laminar') throw new Error('task panel opened the wrong card');
  const resultHeight = await js<number>(`${LAST}.querySelector('[data-testid=task-view] iframe').getBoundingClientRect().height`);
  if (resultHeight < 200) throw new Error(`reopened card too small for its result (${resultHeight}px)`);
  log('closing a card kept its runs going; the task panel brought it back with the Anatomy result');
  await shoot('5c-reopened');

  // --- multi-column reading: panels left / middle / right ---------------------------
  await js(`document.querySelector('[data-testid=layout-3]').click()`);
  await waitFor('three panels', `document.querySelectorAll('.reader.shown').length === 3`);
  const panelInfo = () =>
    js<{ region: string; left: number; width: number; zoom: number; title: string; active: boolean }[]>(`(() => {
      const a = document.querySelector('.reader-area').getBoundingClientRect();
      return [...document.querySelectorAll('.reader.shown')].map((r) => {
        const b = r.getBoundingClientRect();
        return { region: r.dataset.region, left: Math.round(b.left - a.left), width: Math.round(b.width), zoom: Number(r.dataset.zoom),
          title: r.querySelector('[data-testid=panel-doc]').selectedOptions[0].textContent, active: r.classList.contains('active') };
      }).sort((x, y) => x.left - y.left);
    })()`);
  const areaW = await js<number>(`document.querySelector('.reader-area').getBoundingClientRect().width`);
  let three = await panelInfo();
  log('three panels', JSON.stringify(three.map((p) => `${p.region}:${p.title}@${p.left}`)));
  if (three.map((p) => p.region).join() !== 'left,middle,right' || three.some((p, i) => Math.abs(p.left - (areaW * i) / 3) > 2 || Math.abs(p.width - areaW / 3) > 2)) {
    throw new Error('panels not placed left / middle / right');
  }
  // Every shown document's cards are there; move them to the dock to read freely.
  const floating = await js<string[]>(`${CARDS}.map((c) => c.dataset.term)`);
  if (!floating.includes('对流换热') || !floating.includes('Reynolds') || !floating.includes('Laminar')) throw new Error(`cards of shown documents: ${floating}`);
  for (let i = 0; i < floating.length; i++) await js(`${CARDS}[0].querySelector('.card-head button[title=Minimize]').click()`);
  await waitFor('cards docked', `${CARDS}.length === 0`);
  // Pick a term in the right panel (the long PDF): Alt+Q works where the mouse is.
  // An earlier step left it at the very end, below the last page's text.
  await js(`document.querySelector('.reader[data-region=right] .doc-scroll').scrollTop -= 500`);
  const rightPoint = await waitFor<{ x: number; y: number } | null>('visible word in the right panel', `(() => {
    const panel = document.querySelector('.reader[data-region=right] .doc-scroll').getBoundingClientRect();
    for (const span of document.querySelectorAll('.reader[data-region=right] .textLayer span')) {
      const i = span.textContent.indexOf('Viscosity');
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(span.firstChild, i); r.setEnd(span.firstChild, i + 9);
      const b = r.getBoundingClientRect();
      if (b.width > 0 && b.top > panel.top + 10 && b.bottom < panel.bottom - 10 && b.left > panel.left) return { x: Math.round(b.left + 4), y: Math.round(b.top + b.height / 2) };
    }
    return null;
  })()`, 15000).catch(async (e: Error) => {
    const dbg = await js<string>(`(() => { const r = document.querySelector('.reader[data-region=right]'); const s = r.querySelector('.doc-scroll'); const sp = [...r.querySelectorAll('.textLayer span')]; const b = s.getBoundingClientRect();
      const vis = sp.map((x) => [x.textContent.slice(0, 20), Math.round(x.getBoundingClientRect().left), Math.round(x.getBoundingClientRect().top)]).slice(0, 6);
      return JSON.stringify({ tab: r.dataset.tab, title: r.querySelector('select').selectedOptions[0].textContent, pages: r.querySelectorAll('.pdf-page').length, canv: r.querySelectorAll('canvas').length, spans: sp.length, top: s.scrollTop, h: s.scrollHeight, left: s.scrollLeft, w: s.scrollWidth, box: [b.left, b.top, b.width, b.height], vis }); })()`);
    throw new Error(`${e.message}: ${dbg}`);
  });
  if (!rightPoint) throw new Error('no visible word in the right panel');
  wc.sendInputEvent({ type: 'mouseMove', x: rightPoint.x, y: rightPoint.y });
  await sleep(50);
  key('Q', ['alt']);
  await waitFor('highlight', `!!document.querySelector('[data-glossa-overlay]')`, 3000);
  key('Return');
  if ((await newCardTerm(0)) !== 'Viscosity') throw new Error('pick in the right panel failed');
  three = await panelInfo();
  if (!three[2].active) throw new Error('the panel of the pick did not become active');
  await sleep(500);
  const longId = deps.store.recentDocs().find((d) => d.source.endsWith('long.pdf'))!.docId;
  if (!deps.store.getDoc(longId)?.termCards?.some((c) => c.term === 'Viscosity')) throw new Error('card not saved with the right panel’s document');
  log('term lookup in the right panel; the card belongs to its document');

  // Zoom: Ctrl+wheel (trackpad pinch) on the left panel, a two-finger touch pinch on the middle one.
  const centre = (region: string) =>
    js<{ x: number; y: number }>(`(() => { const b = document.querySelector('.reader[data-region=${region}] .reader-body').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  const lc = await centre('left');
  wc.sendInputEvent({ type: 'mouseWheel', x: lc.x, y: lc.y, deltaX: 0, deltaY: 120, wheelTicksY: 1, modifiers: ['control'] } as Electron.MouseWheelInputEvent);
  await waitFor('left panel zoomed', `Number(document.querySelector('.reader[data-region=left]').dataset.zoom) !== 1`);
  const mc = await centre('middle');
  const touch = (type: string, id: number, x: number) =>
    js(`document.querySelector('.reader[data-region=middle] .reader-body').dispatchEvent(new PointerEvent('${type}', { bubbles: true, cancelable: true, pointerId: ${id}, pointerType: 'touch', isPrimary: ${id === 11}, clientX: ${x}, clientY: ${mc.y} }))`);
  await touch('pointerdown', 11, mc.x - 50);
  await touch('pointerdown', 12, mc.x + 50);
  await touch('pointermove', 12, mc.x + 150); // fingers spread: 100 → 200 px
  await touch('pointerup', 12, mc.x + 150);
  await touch('pointerup', 11, mc.x - 50);
  await waitFor('middle panel pinched', `Number(document.querySelector('.reader[data-region=middle]').dataset.zoom) === 2`);
  three = await panelInfo();
  log('zoom per panel', JSON.stringify(three.map((p) => `${p.region}:${p.zoom}`)));
  if (three[0].zoom === 1 || three[1].zoom !== 2 || three[2].zoom !== 1) throw new Error('zoom did not stay with its panel');
  // Ctrl+0 and Ctrl+= go to the active panel (the middle one, touched last), not the whole window.
  wc.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
  await waitFor('Ctrl+0 resets the active panel', `Number(document.querySelector('.reader[data-region=middle]').dataset.zoom) === 1`);
  wc.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
  await waitFor('Ctrl+= zooms the active panel', `Number(document.querySelector('.reader[data-region=middle]').dataset.zoom) > 1`);
  if (wc.getZoomFactor() !== 1) throw new Error('the window itself was zoomed');
  log('pinch, Ctrl+wheel and Ctrl+= / Ctrl+0 zoom only their panel');

  // The card title is renamed with its edit button; the title itself is part of the drag handle.
  const vCard = `${CARDS}.find((c) => c.dataset.term === 'Viscosity')`;
  await js(`${vCard}.querySelector('.edit-term').click()`);
  await waitFor('rename field', `!!${vCard}.querySelector('input.term-input')`);
  await js(`(() => { const i = ${vCard}.querySelector('input.term-input'); i.value = 'Viscosity (fluids)'; i.blur(); })()`);
  await waitFor('renamed', `${CARDS}.some((c) => c.dataset.term === 'Viscosity (fluids)')`);
  // Stop right in the card after an accidental click, and Stop all in the task panel.
  const v2 = `${CARDS}.find((c) => c.dataset.term === 'Viscosity (fluids)')`;
  process.env.GLOSSA_PI_DEMO_DELAY_MS = '600000';
  await clickSkill('Quick', v2);
  await waitFor('stop button while working', `!!${v2}.querySelector('[data-testid=stop-run]')`, 8000);
  await js(`${v2}.querySelector('[data-testid=stop-run]').click()`);
  await waitFor('stopped from the card', `${v2}.querySelector('[data-testid=task-view]')?.dataset.status === 'cancelled'`, 8000);
  await clickSkill('ELI5', v2);
  await waitFor('second run working', `${v2}.querySelector('[data-testid=task-view][data-skill=eli5]')?.dataset.status === 'running'`, 8000);
  await js(`document.querySelector('[data-testid=tasks-button]').click()`);
  await waitFor('stop all', `!!document.querySelector('[data-testid=stop-all]')`);
  await js(`document.querySelector('[data-testid=stop-all]').click()`);
  await waitFor('stopped by Stop all', `${v2}.querySelector('[data-testid=task-view]')?.dataset.status === 'cancelled'`, 8000);
  await js(`document.querySelector('[data-testid=tasks-button]').click()`);
  delete process.env.GLOSSA_PI_DEMO_DELAY_MS;
  log('rename with the edit button; Stop in the card and Stop all');

  // Back from the dock; the HTML result can be read as plain text and rendered again.
  for (const term of floating) await js(`[...document.querySelectorAll('[data-testid=dock-item]')].find((d) => d.querySelector('.dock-term').textContent === ${JSON.stringify(term)})?.click()`);
  await waitFor('cards back', `${CARDS}.length === 4`);
  const rCard = `${CARDS}.find((c) => c.dataset.term === 'Reynolds')`;
  await js(`${rCard}.querySelector('[data-testid=view-toggle]').click()`);
  const plainShown = await waitFor<string>('plain view', `${rCard}.querySelector('[data-testid=plain-text]')?.textContent.includes('Reynolds') && ${rCard}.querySelector('[data-testid=plain-text]').textContent`);
  if (/<h1|<p>/.test(plainShown)) throw new Error('plain view shows markup');
  await shoot('8-three-panels');
  await js(`${rCard}.querySelector('[data-testid=view-toggle]').click()`);
  await waitFor('rendered again', `!!${rCard}.querySelector('[data-testid=task-view] iframe')`);
  log('HTML result toggled to plain text and back');

  await js(`document.querySelector('[data-testid=layout-2]').click()`);
  await waitFor('two panels', `document.querySelectorAll('.reader.shown').length === 2`);
  const two = await panelInfo();
  if (two.map((p) => p.region).join() !== 'left,right') throw new Error('two panels are not left and right');
  await shoot('8b-two-panels');
  await js(`[...document.querySelectorAll('.tab')].find((x) => x.title.endsWith('sample.pdf')).click()`);
  await js(`document.querySelector('[data-testid=layout-1]').click()`);
  await waitFor('one panel again', `document.querySelectorAll('.reader.shown').length === 1 && document.querySelector('.reader.shown').dataset.tab === document.querySelector('.reader.active').dataset.tab`);
  if (!(await js<string>(`document.querySelector('.reader.active [data-testid=panel-doc]') === null && document.querySelector('.tab.on').title`)).endsWith('sample.pdf')) throw new Error('one-panel layout lost the document');
  log('two panels left / right, back to one panel with the same document');

  // --- source code, the quick explanation on its own, results saved, "show in document" ---------
  const code = Array.from({ length: 160 }, (_, i) => `    total_${i} = compute(${i})  # step ${i}`);
  code.splice(0, 0, 'def drag(rho, v, area, cd):', '    # Aerodynamic drag on a moving body, from its kinematic viscosity.');
  fs.writeFileSync(path.join(dir, 'flow.py'), `import math\n\n${code.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'page.html'), '<!doctype html><html><head><title>Local page</title></head><body><p>Bernoulli’s principle links speed and pressure.</p></body></html>');
  const outDir = path.join(deps.store.dir, 'saved-results');
  // The folder dialog cannot be driven here: set as the dialog would (main side).
  deps.store.setSettings({ outputDir: outDir });
  await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'flow.py'))})`);
  await waitFor('code document', `document.querySelector('.reader.active .code-doc')?.textContent.includes('kinematic viscosity')`);
  const codeInfo = await js<{ kind: string; lines: number; first: string }>(`(() => ({
    kind: document.querySelector('.tab.on .tab-kind').textContent,
    lines: document.querySelectorAll('.reader.active .code-line').length,
    first: document.querySelector('.reader.active .code-line').textContent,
  }))()`);
  // Line numbers are drawn by CSS, so they are not part of the text that is picked or sent.
  if (codeInfo.kind !== 'PY' || codeInfo.lines !== 164 || codeInfo.first !== 'import math\n') throw new Error(`code view: ${JSON.stringify(codeInfo)}`);
  // Turned on in Settings → General, as a user would.
  const toggleAutoQuick = async (on: boolean) => {
    await js(`document.querySelector('.topbar button.icon[title=Settings]').click()`);
    await waitFor('settings', `!!document.querySelector('[data-testid=auto-quick]')`);
    await js(`document.querySelector('[data-testid=auto-quick]').click()`);
    // A controlled checkbox: it shows the new state once the main process has stored it.
    await waitFor('auto quick shown', `document.querySelector('[data-testid=auto-quick]').checked === ${on}`, 3000);
    if (deps.store.getSettings().autoQuick !== on) throw new Error('auto quick setting not stored');
    await js(`document.querySelector('.modal-head button').click()`);
  };
  await toggleAutoQuick(true);
  await pickWithMouse('.reader.active .code-doc', 'viscosity');
  key('Return');
  if ((await newCardTerm(0)) !== 'viscosity') throw new Error('code pick');
  // No click: the quick explanation starts with the card.
  await doneResult('quick-gloss');
  const autoRuns = await js<string[]>(`[...${LAST}.querySelectorAll('.skills-row .chip-status')].map((x) => x.closest('button').dataset.skill)`);
  const savedLink = await waitFor<string>('saved link', `${LAST}.querySelector('[data-testid=saved-to]')?.title`);
  const savedFile = path.join(outDir, 'flow.py', 'viscosity - Quick.md');
  if (autoRuns.join() !== 'quick-gloss' || !savedLink.endsWith(savedFile) || !fs.readFileSync(savedFile, 'utf8').includes('offline sample explanation (quick-gloss')) {
    throw new Error(`auto quick / saved copy: ${JSON.stringify({ autoRuns, savedLink })}`);
  }
  log('code file opened as numbered lines; Alt+Q started Quick by itself; result saved to', savedFile);
  await shoot('9-code-auto');
  /** The highlight is drawn and the term is inside its panel's visible part (and, if asked, clear of the card). */
  const SCROLL = '.reader.active .doc-scroll';
  const located = () =>
    waitFor<{ hit: boolean; inView: boolean; clear: boolean }>(
      'highlight',
      `(() => {
        const o = document.querySelector('[data-glossa-locate] div');
        if (!o) return null;
        const h = o.getBoundingClientRect();
        const s = document.querySelector('${SCROLL}').getBoundingClientRect();
        const c = ${LAST}.getBoundingClientRect();
        const clear = h.bottom < c.top || h.top > c.bottom || h.right < c.left || h.left > c.right;
        return { hit: h.width > 0, inView: h.top >= s.top && h.bottom <= s.bottom, clear };
      })()`,
      8000,
    );
  const clearHighlight = () => js(`document.querySelectorAll('[data-glossa-locate]').forEach((x) => x.remove())`);
  const scrollTo = (where: 'top' | 'bottom') => js(`(() => { const s = document.querySelector('${SCROLL}'); s.scrollTop = ${where === 'top' ? 0 : 's.scrollHeight'}; })()`);
  await scrollTo('bottom');
  await sleep(100);
  if (await js(textRect('.reader.active .code-doc', 'kinematic viscosity')).then((p) => p && (p as { y: number }).y > 0 && (p as { y: number }).y < 800)) throw new Error('term still in view after scrolling away');
  await js(`${LAST}.querySelector('[data-testid=locate-term]').click()`);
  const byButton = await located();
  if (!byButton.hit || !byButton.inView || !byButton.clear) throw new Error(`locate by button: ${JSON.stringify(byButton)}`);
  await shoot('9b-located');
  await clearHighlight();
  await scrollTo('bottom');
  await sleep(100);
  // The hotkey also works with the keyboard in the document: it is for the card last used.
  await js(`document.querySelector('.reader.active .code-doc').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  key('L', ['alt']);
  const byKey = await located();
  if (!byKey.hit || !byKey.inView) throw new Error(`locate by Alt+L: ${JSON.stringify(byKey)}`);
  log('"show in document" by button and by Alt+L scrolled back to the term and highlighted it, clear of the card');
  await clearHighlight();
  // A long PDF: every page has the same sentence; the card goes back to its own page.
  await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'long.pdf'))})`);
  await waitFor('long pdf', `document.querySelectorAll('.reader.active .pdf-page').length === 80`, 20000);
  await js(`(() => { const s = document.querySelector('${SCROLL}'); const p = document.querySelector('.reader.active .pdf-page[data-page="2"]'); s.scrollTop += p.getBoundingClientRect().top - s.getBoundingClientRect().top; })()`);
  await waitFor('page 2 text', `[...document.querySelectorAll('.reader.active .pdf-page[data-page="2"] .textLayer span')].some((s) => s.textContent.includes('Viscosity'))`, 20000);
  await pickWithMouse('.reader.active .pdf-page[data-page="2"] .textLayer', 'Viscosity');
  key('Return');
  if ((await newCardTerm(0)) !== 'Viscosity') throw new Error('pdf pick on page 2');
  await sleep(500);
  const pdfLoc = deps.store.getDoc(deps.store.recentDocs().find((d) => d.source.endsWith('long.pdf'))!.docId)?.termCards?.at(-1)?.locator;
  if (pdfLoc?.page !== 2) throw new Error(`pdf locator: ${JSON.stringify(pdfLoc)}`);
  await scrollTo('bottom');
  await sleep(300);
  await js(`${LAST}.querySelector('[data-testid=locate-term]').click()`);
  const inPdf = await located();
  const onPage = await js<boolean>(`(() => { const h = document.querySelector('[data-glossa-locate] div').getBoundingClientRect(); const p = document.querySelector('.reader.active .pdf-page[data-page="2"]').getBoundingClientRect(); return h.top >= p.top && h.bottom <= p.bottom; })()`);
  if (!inPdf.hit || !inPdf.inView || !onPage) throw new Error(`locate in pdf: ${JSON.stringify({ inPdf, onPage, pdfLoc })}`);
  log('PDF: from page 80 back to the term on page 2, highlighted', JSON.stringify(pdfLoc));
  await shoot('9c-located-pdf');
  await clearHighlight();
  // --- capturing an area: text of a PDF page with its picture; found again; plain text alone ---------
  /** Drags with real mouse events in the app window (the capture overlay gets them, over web pages too). */
  const dragArea = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await waitFor('capture overlay', `!!document.querySelector('[data-testid=area-capture]')`, 3000);
    wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y });
    wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 5; i++) {
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(a.x + ((b.x - a.x) * i) / 5), y: Math.round(a.y + ((b.y - a.y) * i) / 5), modifiers: ['leftbuttondown'] });
      await sleep(30);
    }
    wc.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  };
  /** A client box of the given text in the app window, or of an element (`needle` = null). */
  const boxOf = (scope: string, needle: string | null) =>
    js<{ left: number; top: number; right: number; bottom: number }>(`(() => {
      const root = document.querySelector(${JSON.stringify(scope)});
      let b = root.getBoundingClientRect();
      if (${JSON.stringify(needle)}) {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(${JSON.stringify(needle)}); if (i < 0) continue;
          const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${JSON.stringify(needle ?? '')}.length); b = r.getBoundingClientRect(); break; }
      }
      return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) };
    })()`);
  const savedCards = (source: string) => deps.store.getDoc(deps.store.recentDocs().find((d) => d.source.endsWith(source))!.docId)?.termCards ?? [];
  await js(`${LAST}.querySelector('.card-head button[title=Close]').click()`);
  await js(`(() => { const s = document.querySelector('${SCROLL}'); const p = document.querySelector('.reader.active .pdf-page[data-page="2"]'); s.scrollTop += p.getBoundingClientRect().top - s.getBoundingClientRect().top - 40; })()`);
  await waitFor('page 2 text', `[...document.querySelectorAll('.reader.active .pdf-page[data-page="2"] .textLayer span')].some((s) => s.textContent.includes('resists'))`, 20000);
  const pdfCardsBefore = await js<number>(`${CARDS}.length`);
  key('A', ['alt']);
  const sentence = await boxOf('.reader.active .pdf-page[data-page="2"] .textLayer', 'Viscosity resists the relative motion');
  await dragArea({ x: sentence.left - 4, y: sentence.top - 4 }, { x: sentence.right + 4, y: sentence.bottom + 4 });
  await newCardTerm(pdfCardsBefore);
  const areaTerm = await js<string>(`${LAST}.dataset.term`);
  // Quick starts by itself here too; the PDF page is drawn, so its picture goes along.
  const areaBody = await (await net.fetch(await doneResult('quick-gloss'))).text();
  const pic = await waitFor<number>('area picture', `${LAST}.querySelector('[data-testid=area-picture] img')?.naturalWidth`);
  await sleep(500);
  const pdfArea = savedCards('long.pdf').at(-1)!;
  // What leaves the computer is said on the card before any run: the picture too.
  if (!(await js<string>(`${LAST}.querySelector('[data-testid=recipient]').textContent`)).endsWith('· picture')) throw new Error('card does not say the picture is sent');
  if (!areaTerm.startsWith('Viscosity resists the relative motion') || !areaBody.includes('with 1 picture') || !pic || !pdfArea.capture?.send || pdfArea.locator?.page !== 2 || !pdfArea.locator.region) {
    throw new Error(`pdf area: ${JSON.stringify({ areaTerm, areaBody: areaBody.slice(0, 200), pic, capture: pdfArea.capture, locator: pdfArea.locator })}`);
  }
  log('area on a PDF page: card with its text', JSON.stringify(areaTerm.slice(0, 50)), '+ picture', `${pdfArea.capture.w}×${pdfArea.capture.h}`, '; Quick ran with the picture');
  await shoot('10-area-pdf');
  await scrollTo('bottom');
  await sleep(300);
  await js(`${LAST}.querySelector('[data-testid=locate-term]').click()`);
  const areaFound = await located();
  if (!areaFound.hit || !areaFound.inView) throw new Error(`locate area: ${JSON.stringify(areaFound)}`);
  log('the area card finds its place again from the last page');
  await clearHighlight();
  await js(`${LAST}.querySelector('.card-head button[title=Close]').click()`);
  // Plain text (a code file): its text is enough, no picture is sent; started from the top-bar button.
  await js(`[...document.querySelectorAll('.tab')].find((x) => x.title.endsWith('flow.py')).click()`);
  await waitFor('code again', `!!document.querySelector('.reader.active .code-doc')`);
  await scrollTo('top');
  await sleep(150);
  const codeCardsBefore = await js<number>(`${CARDS}.length`);
  await js(`document.querySelector('[data-testid=capture-area]').click()`);
  const l1 = await boxOf('.reader.active .code-doc', 'def drag');
  const l2 = await boxOf('.reader.active .code-doc', 'kinematic viscosity.');
  await dragArea({ x: l1.left - 6, y: l1.top - 3 }, { x: l2.right + 6, y: l2.bottom + 3 });
  await newCardTerm(codeCardsBefore);
  const codeBody = await (await net.fetch(await doneResult('quick-gloss'))).text();
  await sleep(500);
  const codeArea = savedCards('flow.py').at(-1)!;
  if (!/^def drag\(rho, v, area, cd\): # Aerodynamic drag/.test(codeArea.term) || codeArea.capture?.send !== false || codeBody.includes('picture')) {
    throw new Error(`code area: ${JSON.stringify({ term: codeArea.term, capture: codeArea.capture, codeBody: codeBody.slice(0, 160) })}`);
  }
  log('area on plain text: the lines it covers, sent as text only:', JSON.stringify(codeArea.context.sentence));
  await js(`${LAST}.querySelector('.card-head button[title=Close]').click()`);
  // Esc during a capture leaves nothing behind.
  key('A', ['alt']);
  await waitFor('capture overlay', `!!document.querySelector('[data-testid=area-capture]')`, 3000);
  key('Escape');
  await waitFor('capture cancelled', `!document.querySelector('[data-testid=area-capture]')`, 3000);
  if ((await js<number>(`${CARDS}.length`)) !== codeCardsBefore) throw new Error('a cancelled capture made a card');
  // Local HTML: the page or its source.
  await js(`window.__glossaTest.openPath(${JSON.stringify(path.join(dir, 'page.html'))})`);
  await waitFor('html page', `document.querySelector('.reader.active .html-doc')?.textContent.includes('Bernoulli')`);
  await js(`document.querySelector('.reader.active [data-testid=html-source-toggle]').click()`);
  await waitFor('html source', `document.querySelector('.reader.active .code-doc')?.textContent.includes('<title>Local page</title>')`);
  await js(`document.querySelector('.reader.active [data-testid=html-source-toggle]').click()`);
  await waitFor('html page again', `!!document.querySelector('.reader.active .html-doc')`);
  log('local HTML shown as a page and as its source');
  // Back to how the next steps expect it: Quick by click, nothing saved, the PDF shown.
  for (const name of ['page.html', 'flow.py']) await js(`[...document.querySelectorAll('.tab')].find((x) => x.title.endsWith(${JSON.stringify(name)})).querySelector('button').click()`);
  await toggleAutoQuick(false);
  deps.store.setSettings({ outputDir: '' });
  await js(`[...document.querySelectorAll('.tab')].find((x) => x.title.endsWith('sample.pdf')).click()`);
  await waitFor('sample pdf again', `document.querySelector('.tab.on')?.title.endsWith('sample.pdf') && ${CARDS}.length > 0`);

  // --- a run still going when the app ends is interrupted, not resumed (checked on the next launch) ---
  process.env.GLOSSA_PI_DEMO_DELAY_MS = '600000';
  await clickSkill('ELI5', `${CARDS}[0]`);
  await waitFor('long run started', `${CARDS}[0].querySelector('[data-testid=task-view][data-skill=eli5][data-status=running]')`, 8000);
  const longJob = await js<string>(`${CARDS}[0].querySelector('[data-testid=task-view][data-skill=eli5]').dataset.job`);
  // Before the first words, a short answer's bar stays under half.
  const thinking = await waitFor<number>('long run bar', `Number(${CARDS}[0].querySelector('[data-testid=task-view][data-skill=eli5] [data-testid=run-progress]')?.dataset.progress || 0)`, 4000);
  if (!(thinking > 0 && thinking < 0.5)) throw new Error(`thinking bar at ${thinking}`);
  await shoot('5d-progress');
  delete process.env.GLOSSA_PI_DEMO_DELAY_MS;
  deps.store.setSettings({ skillOverrides: {} });

  // Machines that refuse loopback connections cannot serve the fixture page or the
  // test model endpoint; GLOSSA_SMOKE_NO_LOOPBACK=1 skips those steps and says so.
  const noLoopback = process.env.GLOSSA_SMOKE_NO_LOOPBACK === '1';
  {
    // --- web page in <webview> ---------------------------------------------------
    await js(`window.__glossaTest.openUrl(${JSON.stringify(url)})`);
    const guest = await (async () => {
      const end = Date.now() + 15000;
      for (;;) {
        const g = allContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(url));
        if (g && !g.isLoading()) return g;
        if (Date.now() > end) throw new Error('webview did not load');
        await sleep(100);
      }
    })();
    await sleep(300);
    // The fixture page uses "photosynthesis"; an external page uses its first long word.
    const needle = await guest.executeJavaScript(
      `(document.body.innerText.includes('photosynthesis') ? 'photosynthesis' : (document.querySelector('p')?.innerText.match(/\\p{L}{7,}/u) ?? [''])[0])`,
    );
    const gp = needle && (await guest.executeJavaScript(textRect('body', needle)));
    if (!gp) {
      const dbg = await guest.executeJavaScript(`({ href: location.href, html: document.documentElement.outerHTML.slice(0, 200) })`);
      throw new Error(`word not found in web page ${JSON.stringify(dbg)}`);
    }
    await js(`document.querySelector('.reader.active webview').send('glossa:pickAt', ${JSON.stringify(gp)})`);
    const term4 = await newCardTerm(0);
    log('web picked', term4, 'from', url);
    if (term4 !== needle) throw new Error(`web pick gave "${term4}", expected "${needle}"`);
    await shoot('5-web');
    key('Escape');

    // --- single-page-app route change and late content ------------------------------
    const oldDocId = deps.store.recentDocs().find((d) => d.kind === 'web')!.docId;
    await guest.executeJavaScript(`(() => {
      history.pushState({}, '', '/glossa-spa-route');
      const p = document.querySelector('p') ?? document.body.appendChild(document.createElement('p'));
      p.textContent = 'Entropy measures how many microscopic arrangements fit one macroscopic state.';
    })()`);
    const spaDoc = await (async () => {
      const end = Date.now() + 15000;
      for (;;) {
        const d = deps.store.recentDocs().find((x) => x.source.endsWith('/glossa-spa-route'));
        if (d && deps.docs.text(d.docId)?.includes('microscopic arrangements')) return d;
        if (Date.now() > end) throw new Error('route change / late text not picked up');
        await sleep(100);
      }
    })();
    if (spaDoc.docId === oldDocId) throw new Error('route change kept the old document identity');
    const gp2 = await guest.executeJavaScript(textRect('body', 'microscopic'));
    await js(`document.querySelector('.reader.active webview').send('glossa:pickAt', ${JSON.stringify(gp2)})`);
    await waitFor('card on new route', `${LAST}?.dataset.term === 'microscopic'`);
    const ctx2 = await js<string>(`${LAST}.querySelector('.context-line')?.textContent ?? ''`);
    log('spa route: new document', spaDoc.docId.slice(0, 8), 'context:', ctx2.slice(0, 80));
    if (!ctx2.includes('macroscopic state')) throw new Error('stale context after route change');

    // --- PDFs on the web: a typed .pdf address, and a PDF link clicked on the page ----
    const webTab = await js<string>(`document.querySelector('.tab.on').title`);
    await js(`(() => { const f = document.querySelector('form.urlbar'); f.querySelector('input').value = 'https://${FIXTURE_HOST}/papers/boundary.pdf'; f.requestSubmit(); })()`);
    // The tab is titled from the PDF's own metadata once loaded, like a local PDF; its source is the address.
    const pdfShown = (address: string, word: string) =>
      waitFor('web pdf in the pdf reader', `document.querySelector('.tab.on')?.title === ${JSON.stringify(`https://${FIXTURE_HOST}`)} + ${JSON.stringify(address)} && [...document.querySelectorAll('.reader.active .textLayer span')].some((s) => s.textContent.includes(${JSON.stringify(word)}))`, 20000).catch(async (err: Error) => {
        const seen = await js<string>(`document.querySelector('.tab.on')?.textContent + ' | ' + (document.querySelector('.error-bar')?.textContent ?? '') + ' | ' + (document.querySelector('.reader.active')?.textContent ?? '').slice(0, 200)`);
        throw new Error(`${err.message}; shown: ${seen}`);
      });
    await pdfShown('/papers/boundary.pdf', 'viscosity');
    const webPdfKind = await js<string>(`document.querySelector('.tab.on .tab-kind').textContent`);
    if (webPdfKind !== 'PDF') throw new Error(`web pdf shown as ${webPdfKind}`);
    await pickWithMouse('.reader.active .textLayer', 'viscosity');
    key('Return');
    if ((await newCardTerm(0)) !== 'viscosity') throw new Error('term not picked in the web pdf');
    if (deps.store.recentDocs().find((d) => d.source === `https://${FIXTURE_HOST}/papers/boundary.pdf`)?.kind !== 'pdf') throw new Error('web pdf not recorded as a pdf with its address');
    await shoot('13-web-pdf');
    key('Escape');
    await js(`[...document.querySelectorAll('.tab')].find((x) => x.title === ${JSON.stringify(webTab)}).click()`);
    await guest.executeJavaScript(`(() => { const a = document.createElement('a'); a.href = '/article/7/download'; a.textContent = 'Full paper'; document.body.append(a); a.click(); })()`);
    await pdfShown('/article/7/download', 'wake');
    if (!guest.getURL().endsWith('/glossa-spa-route')) throw new Error(`the page navigated away: ${guest.getURL()}`);
    if (fs.readdirSync(path.join(deps.store.dir, 'web-pdfs')).length !== 2) throw new Error('web pdf copies missing');
    await js(`[...document.querySelectorAll('.tab')].find((x) => x.title === ${JSON.stringify(webTab)}).click()`);
    await waitFor('back on the web page', `document.querySelector('.tab.on')?.title === ${JSON.stringify(webTab)}`);
    log('web pdfs: typed .pdf address and a clicked PDF link open in the PDF reader; term picked; page stays');

    // --- web page permissions in the real <webview> session -----------------------
    const perms = await guest.executeJavaScript(`(async () => ({
      geo: (await navigator.permissions.query({ name: 'geolocation' })).state,
      notif: Notification.permission,
      micState: (await navigator.permissions.query({ name: 'microphone' })).state,
      camState: (await navigator.permissions.query({ name: 'camera' })).state,
      // Informational: on a machine without devices this fails before any permission check.
      getUserMedia: await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => e.name),
    }))()`);
    log('web permissions', JSON.stringify(perms));
    if (perms.geo !== 'denied' || perms.notif !== 'denied' || perms.micState !== 'denied' || perms.camState !== 'denied' || perms.getUserMedia === 'granted') {
      throw new Error('web permissions not denied');
    }
    if (guest.session !== session.fromPartition(WEB_PARTITION)) throw new Error('webview is not in the locked-down partition');

    // --- the pick hotkey while the app has the keyboard (a card took it), mouse over the page ---
    // As on YouTube: the new card holds the keyboard; Alt+Q over the page used to do nothing.
    await js(`${LAST}.focus()`);
    if (!(await js<boolean>(`!!document.activeElement?.closest('[data-testid=term-card]')`))) throw new Error('card does not have the keyboard');
    const gp3 = await guest.executeJavaScript(textRect('body', 'arrangements'));
    guest.sendInputEvent({ type: 'mouseMove', x: gp3.x, y: gp3.y });
    await sleep(300);
    const webCards = await js<number>(`${CARDS}.length`);
    key('Q', ['alt']);
    for (let i = 0; i < 30 && !(await guest.executeJavaScript(`!!document.querySelector('[data-glossa-overlay]')`)); i++) await sleep(100);
    if (!(await guest.executeJavaScript(`!!document.querySelector('[data-glossa-overlay]')`))) throw new Error('Alt+Q with the app holding the keyboard did not reach the page');
    // The page took the keyboard: Enter confirms there.
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    if ((await newCardTerm(webCards)) !== 'arrangements') throw new Error('forwarded pick gave the wrong term');
    log('Alt+Q with the keyboard in a card: forwarded to the page under the mouse, card created');

    // --- capturing an area of a web page: text alone; a picture with its picture ---------------
    await guest.executeJavaScript(`(() => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '160'); svg.setAttribute('height', '90'); svg.id = 'fig';
      svg.innerHTML = '<rect width="160" height="90" fill="#2a6"/><circle cx="80" cy="45" r="30" fill="#fd0"/>';
      document.querySelector('main').append(svg);
    })()`);
    await sleep(200);
    const wv = await js<{ left: number; top: number }>(`(() => { const r = document.querySelector('.reader.active webview').getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
    const inGuest = (sel: string) => guest.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; })()`) as Promise<{ left: number; top: number; right: number; bottom: number }>;
    const toHost = (b: { left: number; top: number; right: number; bottom: number }, pad: number) => [
      { x: Math.round(wv.left + b.left - pad), y: Math.round(wv.top + b.top - pad) },
      { x: Math.round(wv.left + b.right + pad), y: Math.round(wv.top + b.bottom + pad) },
    ] as const;
    // Started from the page: Alt+A while it has the keyboard is forwarded to the app.
    guest.focus();
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['alt'] });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['alt'] });
    const [pa, pb] = toHost(await inGuest('p'), 3);
    let before = await js<number>(`${CARDS}.length`);
    await dragArea(pa, pb);
    await newCardTerm(before);
    await sleep(500);
    const webDoc = deps.store.recentDocs().find((d) => d.source.endsWith('/glossa-spa-route'))!;
    const textArea = deps.store.getDoc(webDoc.docId)!.termCards!.at(-1)!;
    if (!textArea.term.startsWith('Entropy measures how many microscopic arrangements') || textArea.capture?.send !== false) throw new Error(`web text area: ${JSON.stringify(textArea)}`);
    const [fa, fb] = toHost(await inGuest('#fig'), 2);
    key('A', ['alt']);
    before = await js<number>(`${CARDS}.length`);
    await dragArea(fa, fb);
    if ((await newCardTerm(before)) !== 'Picture') throw new Error('web picture area term');
    await clickSkill('Quick');
    const figBody = await (await net.fetch(await doneResult('quick-gloss'))).text();
    await sleep(500);
    const figArea = deps.store.getDoc(webDoc.docId)!.termCards!.at(-1)!;
    if (!figBody.includes('with 1 picture') || !figArea.capture?.send || !figArea.locator?.region) throw new Error(`web picture area: ${JSON.stringify({ figBody: figBody.slice(0, 160), figArea })}`);
    await shoot('10b-area-web');
    // Found again on the page by where it was.
    await guest.executeJavaScript(`(() => { const d = document.createElement('div'); d.style.height = '3000px'; document.body.append(d); scrollTo(0, 3000); })()`);
    await sleep(200);
    await js(`${LAST}.querySelector('[data-testid=locate-term]').click()`);
    let webLocated = false;
    for (let i = 0; i < 40 && !webLocated; i++) {
      webLocated = await guest.executeJavaScript(`(() => { const o = document.querySelector('[data-glossa-locate] div'); if (!o) return false; const h = o.getBoundingClientRect(); return h.top >= 0 && h.bottom <= innerHeight; })()`);
      if (!webLocated) await sleep(100);
    }
    if (!webLocated) {
      const why = await js<string>(`document.querySelector('.error-bar')?.textContent ?? '(no error shown)'`);
      throw new Error(`web picture area not found again: ${why} | locator ${JSON.stringify(figArea.locator)} | scrollY ${await guest.executeJavaScript('scrollY')}`);
    }
    log('web page areas: text alone (no picture sent), a figure with its picture; found again after scrolling away');
  }

  // --- a connection's usage limit: reached, nothing new starts on it --------------------
  deps.store.usage.record('demo', { tokens: 50, priced: false });
  deps.store.setSettings({ usageLimits: { demo: { period: 'day', usd: 0, tokens: 10 } } });
  const limitedCards = await js<number>(`${CARDS}.length`);
  await js(`document.querySelector('[data-testid=error-bar]')?.remove()`);
  await clickSkill('ELI5');
  const limitMsg = await waitFor<string>('usage limit message', `document.querySelector('.error-bar')?.textContent`, 5000);
  if (!/reached its usage limit for this day/.test(limitMsg) || (await js<number>(`${CARDS}.length`)) !== limitedCards) throw new Error(`usage limit: ${limitMsg}`);
  deps.store.setSettings({ usageLimits: {} });
  await js(`document.querySelector('.error-bar button')?.click()`);
  log('usage limit reached: the run was refused with', JSON.stringify(limitMsg.slice(0, 90)));

  // --- IPC: runtime validation and the agent gate, through the real bridge -------
  const ipc = await js<Record<string, string>>(`(async () => {
    const r = {};
    const err = async (p) => p.then(() => 'resolved', (e) => String(e.message));
    r.badId = await err(window.glossa.jobs.get('../x'));
    r.trust = await err(window.glossa.settings.set({ agentTrust: { 'fake-figure': 'x' } }));
    const req = { docId: '${rec.docId}', skill: 'fake-figure', explainLang: 'en', context: { term: 't', sentence: 's', paragraph: '', docTitle: 'd', docSource: 's' } };
    r.agentNoOrigin = await err(window.glossa.jobs.start(req));
    r.agentAuto = await err(window.glossa.jobs.start({ ...req, origin: 'auto' }));
    r.cards = await err(window.glossa.docs.saveCards('${rec.docId}', [{ id: 'x' }]));
    r.outputDir = await err(window.glossa.settings.set({ outputDir: '/tmp/not-chosen-in-a-dialog' }));
    return r;
  })()`);
  log('ipc checks', JSON.stringify(ipc));
  if (!/Invalid job id/.test(ipc.badId) || !/unexpected field agentTrust/.test(ipc.trust) || !/explicit click/.test(ipc.agentNoOrigin) || !/explicit click/.test(ipc.agentAuto) || !/Invalid/.test(ipc.cards) || !/Choose/.test(ipc.outputDir)) {
    throw new Error('IPC checks failed');
  }
  fs.writeFileSync(stateFile, JSON.stringify({ docId: rec.docId, eli5: saved[0].tasks[1].jobId, agent: agentCard.jobId, long: longJob }));

  // --- theme: the top-bar toggle cycles System → Light → Dark and the page follows at once ---
  const themeSeen: string[] = [];
  const BG = { light: 'rgb(245, 245, 247)', dark: 'rgb(20, 21, 24)', paper: 'rgb(236, 229, 216)' };
  for (let i = 0; i < 4; i++) {
    await js(`document.querySelector('[data-testid=theme-toggle]').click()`);
    await sleep(400);
    const pref = deps.store.getSettings().theme;
    const shown = await js<string>(`matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`);
    const bg = await js<string>(`getComputedStyle(document.body).backgroundColor`);
    themeSeen.push(`${pref}→${shown}`);
    // Paper is light underneath (dialogs, scrollbars), with its own colours on top.
    const expected = pref === 'paper' ? BG.paper : BG[shown as 'light' | 'dark'];
    if ((pref === 'paper' ? shown !== 'light' : pref !== 'system' && shown !== pref) || bg !== expected) throw new Error(`theme ${pref}: shown ${shown}, background ${bg}`);
    if (pref === 'paper') await paperChecks();
  }
  if (new Set(themeSeen.map((x) => x.split('→')[0])).size !== 4) throw new Error(`theme toggle did not cycle: ${themeSeen.join(', ')}`);

  /** In the paper theme: cards and their answers on paper, formulas rendered with KaTeX's own fonts. */
  async function paperChecks() {
    const card = `[...document.querySelectorAll('.card-layer [data-testid=term-card]')].find((c) => c.querySelector('[data-testid=task-view][data-status=done] iframe'))`;
    const jobId = await waitFor<string>('a card with a finished answer', `${card}?.querySelector('[data-testid=task-view]').dataset.job`);
    // This test's own result file gets a formula (the offline model writes none).
    fs.writeFileSync(deps.jobs.outputFile(jobId)!, 'The **Reynolds number** compares inertia and viscosity:\n\n$$Re = \\frac{\\rho\\, v\\, L}{\\mu}$$\n\nTurbulence usually starts above $Re \\approx 2300$ in a pipe; prices like $5 and $10 stay text.\n');
    const src = await js<string>(`(() => { const f = ${card}.querySelector('iframe'); f.src = f.src.replace(/&r=\\d+$/, '') + '&r=' + Date.now(); return f.src; })()`);
    if (!src.includes('theme=paper')) throw new Error(`card answer not on paper: ${src}`);
    const page = await (await net.fetch(src)).text();
    const katexCss = await net.fetch(new URL('_katex/katex.min.css', src).toString());
    const cssText = await katexCss.text();
    const fontFile = /url\((fonts\/KaTeX_Main-Regular\.woff2)\)/.exec(cssText)?.[1];
    const font = fontFile ? await net.fetch(new URL(`_katex/${fontFile}`, src).toString()) : undefined;
    if (!/class="katex-display"/.test(page) || (page.match(/class="katex"/g) ?? []).length < 2 || page.includes('$5') === false || !page.includes('#fbf8f1') || katexCss.status !== 200 || font?.status !== 200) {
      throw new Error(`formulas: display ${/katex-display/.test(page)}, css ${katexCss.status}, font ${font?.status}`);
    }
    const look = await js<{ card: string; title: string }>(`(() => { const c = ${card}; return { card: getComputedStyle(c).backgroundColor, title: getComputedStyle(c.querySelector('.term-title')).fontFamily }; })()`);
    if (look.card !== 'rgb(251, 248, 241)' || !/Iowan|Palatino|Georgia|serif/.test(look.title)) throw new Error(`paper card look: ${JSON.stringify(look)}`);
    await sleep(600);
    await shoot('11-paper-formula');
    await js(`document.querySelector('.topbar button.icon[title=Settings]').click()`);
    await waitFor('settings', `!!document.querySelector('.modal.settings')`);
    await sleep(300);
    await shoot('11b-paper-settings');
    await js(`document.querySelector('.modal-head button').click()`);
    log('paper theme: cards on paper, answer rendered on paper with 2 formulas (KaTeX css and fonts served by the app), prices left as text');
  }
  log('theme toggle:', themeSeen.join(', '));

  // --- a Claude Code session opened from the address bar --------------------------
  const sid = '7d1c2a9e-4b3f-4c55-9a0e-2f6b8c1d3e4a';
  const sessionFile = path.join(dir, 'claude-config', 'projects', '-work-app', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    [
      { type: 'user', sessionId: sid, cwd: '/work/app', timestamp: '2026-10-18T08:00:00Z', message: { role: 'user', content: 'Explain the Reynolds number in the solver<system-reminder>hidden</system-reminder>' } },
      { type: 'assistant', sessionId: sid, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'reynolds' } }] } },
      { type: 'user', sessionId: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'solver.py:12: re = rho * v * L / mu' }] } },
      { type: 'assistant', sessionId: sid, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'The solver uses the **kinematic viscosity** to decide when flow turns turbulent.' }] } },
    ].map((x) => JSON.stringify(x)).join('\n'),
  );
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude-config');
  const typeAddress = (text: string) =>
    js(`(() => { const f = document.querySelector('form.urlbar'); f.querySelector('input').value = ${JSON.stringify(text)}; f.requestSubmit(); })()`);
  await typeAddress(`claude --resume ${sid}`);
  await waitFor('session document', `document.querySelector('.reader.active .html-doc[data-kind=session]')?.textContent.includes('kinematic viscosity')`);
  const sessionShown = await js<{ kind: string; title: string; turns: string[]; tools: number; hidden: boolean }>(`(() => {
    const doc = document.querySelector('.reader.active .html-doc');
    return {
      kind: document.querySelector('.tab.on .tab-kind').textContent,
      title: document.querySelector('.tab.on').textContent,
      turns: [...doc.querySelectorAll('section > h2')].map((h) => h.textContent),
      tools: doc.querySelectorAll('details').length,
      hidden: doc.textContent.includes('hidden'),
    };
  })()`);
  if (sessionShown.kind !== 'CHAT' || sessionShown.turns.join() !== 'You,Claude' || sessionShown.tools !== 1 || sessionShown.hidden || !sessionShown.title.includes('Explain the Reynolds number')) throw new Error(`session view: ${JSON.stringify(sessionShown)}`);
  // Terms are picked in a session like in any document.
  const sessionCards = await js<number>(`${CARDS}.length`);
  await pickWithMouse('.reader.active .html-doc', 'kinematic');
  key('Return');
  const sessionTerm = await newCardTerm(sessionCards);
  if (!sessionTerm.startsWith('kinematic')) throw new Error(`session pick gave "${sessionTerm}"`);
  await shoot('12-session');
  key('Escape');
  await typeAddress('11111111-2222-3333-4444-555555555555');
  const missing = await waitFor<string>('missing session error', `document.querySelector('.error-bar')?.textContent`);
  if (!missing.includes('No Claude Code or Codex session')) throw new Error(`missing session: ${missing}`);
  await js(`document.querySelector('.error-bar button')?.click()`);
  log('Claude Code session opened from "claude --resume <id>": turns, folded tool call, term picked; unknown id explained');

  // --- zoom keeps the reading position ------------------------------------------------
  await zoomSteps();
  log('zoom keeps what is under the pointer in place: markdown, pdf (pinch, toolbar, Ctrl+0), web page');

  // --- settings window ----------------------------------------------------------
  key('Escape');
  await js(`document.querySelector('.topbar button.icon[title=Settings]').click()`);
  await waitFor('settings', `!!document.querySelector('.modal.settings')`);
  // Narrowing the data scope through the real UI → validated IPC → stored, no dialog needed.
  await js(`(() => { const sel = document.querySelector('[data-testid=data-scope]'); sel.value = 'sentence'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  for (let i = 0; i < 50 && deps.store.getSettings().dataScope !== 'sentence'; i++) await sleep(50);
  if (deps.store.getSettings().dataScope !== 'sentence') throw new Error('settings change from the UI was not stored');
  const errBar = await js<string>(`document.querySelector('.error-bar')?.textContent ?? ''`);
  if (errBar) throw new Error(`settings UI error: ${errBar}`);
  log('settings UI change stored through validated IPC');
  await shoot('6-settings-general');
  if (noLoopback) log('NOT RUN: model connection steps (GLOSSA_SMOKE_NO_LOOPBACK)');
  else await runConnectionSmoke(win, deps.store, shoot);
  for (const [i, name] of [[1, 'providers'], [2, 'models'], [3, 'harnesses'], [4, 'skills']] as const) {
    await js(`document.querySelectorAll('.settings-nav button')[${i}].click()`);
    await shoot(`6-settings-${name}`);
    if (name === 'models' && !(await js<boolean>(`!!document.querySelector('[data-testid=usage-limits] tr[data-provider=anthropic] [data-testid=limit-usd-anthropic]')`))) throw new Error('usage limits table missing');
  }
  // A skill's own engine and output folder.
  await js(`document.querySelector('.skills-table tr button[title="Engine for this skill"]').click()`);
  await waitFor('skill output folder', `!!document.querySelector('[data-testid=skill-output-quick-gloss]')`);
  await shoot('6-settings-skill-engine');
  await js(`document.querySelector('.modal-head button').click()`);

  log('ALL PASSED');
  return 0;
}
