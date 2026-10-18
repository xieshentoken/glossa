// Real renderer + preload + IPC + local HTTP fixture. Never uses a user's keys.
import http from 'node:http';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';

export async function runConnectionSmoke(win: BrowserWindow, store: Store, shoot: (name: string) => Promise<void>): Promise<void> {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const consoleErrors: string[] = [];
  const onConsole = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
    if (event.level === 'error' && event.sourceId.startsWith('glossa://app/')) consoleErrors.push(event.message);
  };
  win.webContents.on('console-message', onConsole);
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer glossa-fixture-key') { res.writeHead(401); res.end('bad key'); return; }
    if (req.url === '/v1/models') {
      calls.push({ path: req.url });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [
        { id: 'fixture-model', capabilities: { reasoning_effort: ['low', 'high'] } },
        { id: 'fixture-plain', capabilities: { effort: { supported: false } } },
      ] }));
    } else if (req.url === '/v1/chat/completions') {
      let text = ''; for await (const chunk of req) text += chunk;
      calls.push({ path: req.url, body: JSON.parse(text) });
      res.setHeader('content-type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const wait = async (what: string, expression: string) => {
    const end = Date.now() + 10_000;
    do { if (await js(expression)) return; await new Promise((r) => setTimeout(r, 50)); } while (Date.now() < end);
    throw new Error(`Connection smoke: timeout ${what}`);
  };
  const click = (id: string) => js(`document.querySelector('[data-testid="${id}"]').click()`);
  const set = (id: string, value: string, tag = 'input') => js(`(() => {
    const el = document.querySelector('[data-testid="${id}"]');
    Object.getOwnPropertyDescriptor(${tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('${tag === 'select' ? 'change' : 'input'}', { bubbles: true }));
  })()`);
  const log = (s: string) => console.log('[smoke] connections:', s);
  try {
    await js(`document.querySelectorAll('.settings-nav button')[1].click()`);
    await wait('connections pane', `!!document.querySelector('[data-testid=connection-add]')`);
    await click('connection-add');
    await wait('editor', `!!document.querySelector('[data-testid=connection-editor]')`);
    const presets = await js<string[]>(`[...document.querySelector('[data-testid=connection-preset]').options].map(o=>o.value)`);
    if (presets.length !== 10 || !presets.includes('glm-cn') || !presets.includes('zai')) throw new Error('Connection preset list incomplete');
    await set('connection-preset', 'opencode-go', 'select');
    await wait('Go pending', `document.querySelector('[data-testid=connection-test]').disabled && !document.querySelector('[data-testid=connection-key]')`);
    await shoot('7-connections-go-pending');
    await set('connection-preset', 'custom', 'select');
    await set('connection-name', 'Smoke connection'); await set('connection-url', url); await set('connection-key', 'wrong-key');
    await click('connection-test');
    await wait('wrong key error', `document.querySelector('[data-testid=connection-error]')?.textContent.includes('401')`);
    if (store.getSettings().providers.some((p) => p.label === 'Smoke connection')) throw new Error('Failed test persisted a draft');
    await set('connection-key', 'glossa-fixture-key'); await click('connection-test');
    await wait('model list', `document.querySelector('[data-testid=connection-model]')?.options.length === 2`);
    await set('connection-model', 'fixture-model', 'select');
    const levels = await js<string[]>(`[...document.querySelector('[data-testid=connection-effort]').options].map(o=>o.value)`);
    if (levels.join(',') !== 'default,low,high') throw new Error(`Wrong effort options: ${levels}`);
    await set('connection-model', 'fixture-plain', 'select');
    const plain = await js<number>(`document.querySelector('[data-testid=connection-effort]').options.length`);
    if (plain !== 1) throw new Error('Plain model has unsupported effort options');
    await set('connection-model', 'fixture-model', 'select'); await set('connection-effort', 'high', 'select');
    if (store.getSettings().providers.some((p) => p.label === 'Smoke connection')) throw new Error('Discovery persisted a draft');
    await shoot('8-connections-model-effort');
    const originalSize = win.getSize();
    win.setSize(1024, 768);
    const overflows = await js<boolean>(`(() => { const p = document.querySelector('.settings-pane'); return p.scrollWidth > p.clientWidth + 1; })()`);
    if (overflows) throw new Error('Model editor overflows its desktop pane');
    await shoot('8b-connections-compact');
    win.setSize(originalSize[0], originalSize[1]);
    // Changing a connection input invalidates the result and removes Save.
    await set('connection-url', url + '/');
    await wait('invalidation', `!document.querySelector('[data-testid=connection-save]')`);
    await click('connection-test'); await wait('retest', `!!document.querySelector('[data-testid=connection-save]')`);
    await set('connection-model', 'fixture-model', 'select'); await set('connection-effort', 'high', 'select');
    // Keep the fixture connection out of defaults used by the restart/cache smoke.
    await set('connection-use', 'none', 'select');
    await js(`(() => { const el=document.querySelector('.connection-fields input[type=checkbox]'); if(el?.checked) el.click(); })()`);
    await click('connection-save');
    await wait('saved list', `!!document.querySelector('[data-testid=connections]')`);
    const cfg = store.getSettings().providers.find((p) => p.label === 'Smoke connection');
    if (!cfg?.selection || cfg.selection.model !== 'fixture-model' || cfg.selection.effort !== 'high') throw new Error('Selected configuration was not stored');
    if (store.getKey(cfg.id) !== 'glossa-fixture-key') throw new Error('Session key not available');
    const generation = calls.find((c) => c.body);
    if (generation?.body?.reasoning_effort !== 'high' || generation.body.model !== 'fixture-model') throw new Error('Saved combination differs from actual request');
    const doc = store.recentDocs()[0];
    const job = await js<{ id: string }>(`window.glossa.jobs.start(${JSON.stringify({ docId: doc.docId, skill: 'eli5', explainLang: 'en', origin: 'user', direct: { providerId: cfg.id }, context: { term: 'fixture term', sentence: 'A fixture sentence.', paragraph: 'A fixture paragraph.', docTitle: 'Fixture', docSource: 'fixture' } })})`);
    await wait('explanation with saved connection', `(async () => { const j=await window.glossa.jobs.get(${JSON.stringify(job.id)}); if(j?.status==='error') throw new Error(j.error); return j?.status==='done' && j.text==='OK'; })()`);
    if (calls.filter((c) => c.body?.model === 'fixture-model' && c.body.reasoning_effort === 'high').length !== 2) throw new Error('Explanation did not use the saved model / effort');
    await click('connection-add'); await set('connection-name', 'Cancelled connection'); await click('connection-cancel');
    if (store.getSettings().providers.some((p) => p.label === 'Cancelled connection')) throw new Error('Cancel persisted a draft');
    await shoot('9-connections-saved');
    if (consoleErrors.length) throw new Error(`Model editor console errors: ${consoleErrors.join('; ')}`);
    log('presets / failed key / discovery / effort switch / invalidation / verify-save / explanation / cancel / console / compact layout passed');
  } finally { win.webContents.removeListener('console-message', onConsole); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
