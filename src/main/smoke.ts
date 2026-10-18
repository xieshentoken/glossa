// End-to-end smoke test, run inside the real app when GLOSSA_SMOKE=1
// (see scripts/smoke.mjs). Uses the offline demo provider and a fake agent CLI.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { runConnectionSmoke } from './connection-smoke';
import path from 'node:path';
import { net, session, webContents as allContents, type BrowserWindow } from 'electron';
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
  // Fixture web page, served from this process.
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><head><title>Plants</title></head><body><main>
<h1>How plants eat</h1><p>Leaves capture light through photosynthesis, turning carbon dioxide and water into sugar.</p>
</main></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = process.env.GLOSSA_SMOKE_WEB_URL || `http://127.0.0.1:${(server.address() as { port: number }).port}/plants`;
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
  const cardTerms = () => js<string[]>(`${CARDS}.map((c) => c.querySelector('.term-input').value)`);
  /** The term of the card a pick just created (earlier cards stay). */
  const newCardTerm = async (before: number) => {
    await waitFor('new card', `${CARDS}.length > ${before}`);
    return js<string>(`${LAST}.querySelector('.term-input').value`);
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
  const dragCard = async (card: string, dx: number, dy: number) => {
    const p = await js<{ x: number; y: number }>(`(() => { const h = (${card}).querySelector('.card-head').getBoundingClientRect(); return { x: Math.round(h.left + 5), y: Math.round(h.top + h.height / 2) }; })()`);
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
  for (const name of ['Quick', 'ELI5', 'Anatomy']) if (!(await clickSkill(name, qCard))) throw new Error(`no ${name} button`);
  const tabStates = `[...${qCard}.querySelectorAll('.skills-row .chip-status')].map((x) => [...x.classList].find((c) => c.startsWith('s-'))).join()`;
  await waitFor('two running, one waiting', `${tabStates} === 's-running,s-running,s-queued'`, 8000).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${await js<string>(tabStates)}`);
  });
  await shoot('5a-queue');
  // Stop one from the task panel: the others go on and the waiting one starts.
  await js(`document.querySelector('[data-testid=tasks-button]').click()`);
  await waitFor('task panel', `document.querySelectorAll('[data-testid=task-row][data-status=running]').length === 2`);
  await js(`[...document.querySelectorAll('[data-testid=task-row]')].find((r) => r.textContent.includes('Laminar') && r.textContent.includes('Quick')).querySelector('button[title=Stop]').click()`);
  await waitFor('queue moved on', `${tabStates} === 's-cancelled,s-running,s-running'`, 8000);
  await shoot('5b-task-panel');
  log('queue: two running, third waiting; stopping one from the task panel started the third');
  // Close the card while two runs are going: they finish anyway.
  await js(`${qCard}.querySelector('.card-head button[title=Close]').click()`);
  await waitFor('card closed', `${CARDS}.length === 1`);
  await waitFor('closed card runs finished', `(() => { const rows = [...document.querySelectorAll('[data-testid=task-row]')].filter((r) => r.textContent.includes('Laminar')); return rows.length === 3 && rows.filter((r) => r.dataset.status === 'done').length === 2; })()`, 20000);
  // Open brings the closed card back with its result.
  await js(`[...document.querySelectorAll('[data-testid=task-row]')].find((r) => r.textContent.includes('Laminar') && r.textContent.includes('Anatomy')).querySelector('button.link').click()`);
  await waitFor('card back from the task panel', `${CARDS}.length === 2 && !document.querySelector('[data-testid=tasks-panel]')`);
  await doneResult('anatomy', LAST, 10000);
  if ((await js<string>(`${LAST}.querySelector('.term-input').value`)) !== 'Laminar') throw new Error('task panel opened the wrong card');
  const resultHeight = await js<number>(`${LAST}.querySelector('[data-testid=task-view] iframe').getBoundingClientRect().height`);
  if (resultHeight < 200) throw new Error(`reopened card too small for its result (${resultHeight}px)`);
  log('closing a card kept its runs going; the task panel brought it back with the Anatomy result');
  await shoot('5c-reopened');

  // --- a run still going when the app ends is interrupted, not resumed (checked on the next launch) ---
  process.env.GLOSSA_PI_DEMO_DELAY_MS = '600000';
  await clickSkill('ELI5', `${CARDS}[0]`);
  await waitFor('long run started', `${CARDS}[0].querySelector('[data-testid=task-view][data-skill=eli5][data-status=running]')`, 8000);
  const longJob = await js<string>(`${CARDS}[0].querySelector('[data-testid=task-view][data-skill=eli5]').dataset.job`);
  delete process.env.GLOSSA_PI_DEMO_DELAY_MS;
  deps.store.setSettings({ skillOverrides: {} });

  // Machines that refuse loopback connections cannot serve the fixture page or the
  // test model endpoint; GLOSSA_SMOKE_NO_LOOPBACK=1 skips those steps and says so.
  const noLoopback = process.env.GLOSSA_SMOKE_NO_LOOPBACK === '1';
  if (noLoopback) log('NOT RUN: web page, route change and web permission steps (GLOSSA_SMOKE_NO_LOOPBACK)');
  else {
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
    await waitFor('card on new route', `${LAST}?.querySelector('.term-input')?.value === 'microscopic'`);
    const ctx2 = await js<string>(`${LAST}.querySelector('.context-line')?.textContent ?? ''`);
    log('spa route: new document', spaDoc.docId.slice(0, 8), 'context:', ctx2.slice(0, 80));
    if (!ctx2.includes('macroscopic state')) throw new Error('stale context after route change');

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
  }

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
    return r;
  })()`);
  log('ipc checks', JSON.stringify(ipc));
  if (!/Invalid job id/.test(ipc.badId) || !/unexpected field agentTrust/.test(ipc.trust) || !/explicit click/.test(ipc.agentNoOrigin) || !/explicit click/.test(ipc.agentAuto) || !/Invalid/.test(ipc.cards)) {
    throw new Error('IPC checks failed');
  }
  fs.writeFileSync(stateFile, JSON.stringify({ docId: rec.docId, eli5: saved[0].tasks[1].jobId, agent: agentCard.jobId, long: longJob }));

  // --- theme: the top-bar toggle cycles System → Light → Dark and the page follows at once ---
  const themeSeen: string[] = [];
  const BG = { light: 'rgb(245, 245, 247)', dark: 'rgb(20, 21, 24)' };
  for (let i = 0; i < 3; i++) {
    await js(`document.querySelector('[data-testid=theme-toggle]').click()`);
    await sleep(400);
    const pref = deps.store.getSettings().theme;
    const shown = await js<string>(`matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`);
    const bg = await js<string>(`getComputedStyle(document.body).backgroundColor`);
    themeSeen.push(`${pref}→${shown}`);
    if ((pref !== 'system' && shown !== pref) || bg !== BG[shown as 'light' | 'dark']) throw new Error(`theme ${pref}: shown ${shown}, background ${bg}`);
  }
  if (new Set(themeSeen.map((x) => x.split('→')[0])).size !== 3) throw new Error(`theme toggle did not cycle: ${themeSeen.join(', ')}`);
  log('theme toggle:', themeSeen.join(', '));

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
  if (noLoopback) log('NOT RUN: model connection steps (GLOSSA_SMOKE_NO_LOOPBACK)');
  else await runConnectionSmoke(win, deps.store, shoot);
  for (const [i, name] of [[1, 'providers'], [2, 'models'], [3, 'harnesses'], [4, 'skills']] as const) {
    await js(`document.querySelectorAll('.settings-nav button')[${i}].click()`);
    await shoot(`6-settings-${name}`);
  }
  await js(`document.querySelector('.modal-head button').click()`);

  server.close();
  log('ALL PASSED');
  return 0;
}
