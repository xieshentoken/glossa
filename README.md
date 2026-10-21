# Glossa

A desktop reader that explains difficult terms in place. Open a PDF, a Word
document, Markdown/text, source code (Python, JSON, YAML, JavaScript …) or a web
page. Point at a term, press **Alt+Q** and adjust the selection with the arrow
keys: the card that opens starts the **Quick** explanation at once (Settings →
General can turn that off), and its other skills run when clicked.
Each pick gets its own card; earlier cards stay. A card keeps every skill run
started from it, can be dragged, resized, minimized and closed, and belongs to
its document: switching documents shows that document's cards.

A web address ending in `.pdf` (or an arXiv PDF link, or a PDF link clicked on a page) opens in
the PDF reader. Claude Code and Codex sessions open as conversations: a session's `.jsonl`
file, or `claude --resume <id>`, `codex resume <id>` or a session ID typed in the address bar.

Plan and roadmap: [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md).

## Run

```bash
npm install
npx install-electron        # only if npm blocked Electron's download script
npm start                   # build + launch
```

On macOS, double-click [`启动 Glossa.command`](../../启动%20Glossa.command) in the
project root. It opens this v2 folder using its own Electron runtime. After changing
source code, run `npm run build` before using the launcher.

Without an API key you can try everything with **Settings → Models & effort →
Offline demo (no AI)**. For real answers add a key in **Settings → Model
connections**. Keys are saved only when the OS offers protected storage
(Keychain, Credential Manager, or a Linux secret service). Otherwise they are kept
for the current session only.

### Configure a model connection

1. Open **Settings → Model connections → Add connection**.
2. Choose Anthropic, OpenAI, DeepSeek, GLM (China or Z.AI), Kimi, grok, or Gemini.
   Give the connection a name and enter its API key. Each provider can have several
   independently named keys. For **Custom**, also enter the API base URL; the
   default protocol is OpenAI Chat Completions, with other protocols under the
   expandable API protocol control.
3. Click **Test connection & get models**, then choose a model and its effort.
   Capability information comes from the API when available, otherwise reviewed
   first-party documentation. Unknown effort uses **Provider default** and sends
   no effort parameter. Thinking-only providers show an on/off control.
4. Choose whether to use the connection for quick explanations, skill explanations,
   both, or neither. Click **Verify & save**. This makes one short request with the
   selected model and effort, which may incur a small charge; failed or incomplete
   tests do not replace the saved configuration. No document text is sent for testing.

An endpoint without a model-list API offers documented candidates or manual model
ID entry. Those candidates are not claimed to be available to your key until the
selected combination passes verification. Editing the address or key invalidates
the previous test. Cancel discards the draft. Test credentials expire after ten
minutes and are not persisted until saving succeeds.

OpenCode Go appears as a reserved preset. Its [official usage guidance](https://opencode.ai/docs/go/#where-can-i-use-it)
requires coding-agent traffic; use in this reader has not been confirmed, so this
preset does not send credentials or requests. GLM presets use the ordinary API
endpoints, not Coding Plan subscription endpoints.

**Models & effort** still assigns connections separately to quick explanations and
skills. A saved connection supplies its model and effort. Existing manual settings,
Ollama, offline demo, and per-skill overrides remain available.

**What is sent:** by default, the term, its sentence and its paragraph
(Settings → General → *Context sent with each lookup*). Sending whole documents
needs a confirmation the app shows itself. Each card shows where a request goes (`endpoint · model · scope`).

## Packaging (macOS)

```bash
npm run package:mac         # build, then release/Glossa-<version>-mac-arm64.tar.gz and -mac-x64.tar.gz
```

Each archive holds `Glossa.app` (Apple silicon or Intel) and `How to open Glossa.txt`.
The app icon is `build/icon.icns`, made from `build/icon.png` (the logo `logo.png` in the
macOS rounded-square shape) with `node scripts/make-icns.mjs` (needs ImageMagick).
Only the built-in Pi agent's packages are shipped from `node_modules`; everything else is
bundled in `dist/`. `node scripts/package.mjs --platform linux` packages the same layout for
Linux, and `GLOSSA_SMOKE_APP=release/Glossa-linux-arm64/glossa node scripts/smoke.mjs` runs
the smoke test against it.

Apple silicon only runs signed code. Without an Apple Developer ID the app is signed
**ad hoc** with [`rcodesign`](https://github.com/indygreg/apple-platform-rs) (set `RCODESIGN`
or put it on `PATH`; without it the script says NOT SIGNED). It is not notarized, so the first
launch needs **System Settings → Privacy & Security → Open Anyway** (or
`xattr -dr com.apple.quarantine /Applications/Glossa.app`). A `.dmg` needs macOS
(`hdiutil create -volname Glossa -srcfolder Glossa.app -format UDZO Glossa.dmg`).

## Using it

| Action | Keys |
|---|---|
| Pick the word under the mouse | `Alt+Q` (change in Settings) |
| Grow / shrink the end of the term | `→` / `←` |
| Grow / shrink the start | `Shift+←` / `Shift+→` |
| Explain / cancel | `Enter` or click the highlight / `Esc` |
| Run a skill of the focused card / close the card | `1`–`9` / `Esc` |
| Show the focused card's term in the document | `Alt+L` (change in Settings), or the ◎ button on the card |
| Capture an area (text, a picture, a formula, a video frame) to explain | `Alt+A` (change in Settings), or the ⛶ button in the top bar; drag, `Esc` cancels |
| Open file · Settings · Close tab | `Ctrl/Cmd+O` · `Ctrl/Cmd+,` · `Ctrl/Cmd+W` |

With text already selected, the hotkey explains the selection at once.

**Several documents side by side:** the panel buttons in the top bar switch between one panel,
two (left and right) and three (left, middle and right). Each panel scrolls on its own; its header
chooses which open document it shows, and clicking a tab or opening a file uses the selected panel.
Term lookup works in every panel (Alt+Q picks where the mouse is), and explanation cards float over
all panels. **Pinch to zoom** (two fingers on a trackpad or touchscreen, or Ctrl+scroll) scales the
panel under the fingers; Ctrl+= / Ctrl+− / Ctrl+0 zoom the selected panel, never the whole window.

**Cards:** rename a card with its ✎ button (the rest of the title bar moves the card). A finished
explanation can be shown rendered (Markdown, or HTML when the answer is HTML) or as plain text with the
button in its status bar. A run started by mistake stops with the Stop button in the card; the Tasks
panel has Stop all.

**Show in document:** the ◎ button in a card's title bar (or `Alt+L`, for the card used last, also
while a web page has the keyboard) scrolls the card's document back to the exact place the term was
picked and highlights it for a few seconds, keeping it clear of the card where there is room. A card
remembers the term's text with what surrounds it and its position (and its page in a PDF), so the
right occurrence is found even when the same word appears many times. Cards saved by older versions
are found by their sentence.

**Capturing an area:** `Alt+A` (or the ⛶ button) dims the reading area; drag over anything shown in a
document or web page, including scanned pages, figures, formulas and video frames. Glossa takes a picture of
that area and reads whatever text the document has there (PDF text, document or web text); a card opens with
both and Quick starts at once. When the area held only text, only the text is sent, and any model can answer.
Otherwise the picture goes along (the card says "· picture" under *Sends to*), which needs a model that can
read images; a model Pi knows to be text-only gets the text alone, or a clear error when there is none. The
card's ◎ finds the area again: its text, or where it was (its PDF page, its place in the document or page).
Pictures are kept in the app's data folder while a card uses them.

**Web pages and the keyboard:** Alt+Q works on the web page under the mouse even when Glossa itself has the
keyboard (for example right after a card opened, which takes it): Glossa hands the key to the page, and the
page takes the keyboard for ←/→ and Enter. Previously this did nothing until the page was clicked; YouTube
descriptions and titles were the common case.

**Source code and data files** (`.py`, `.js`/`.ts`, `.json`, `.yaml`/`.yml`, `.toml`, `.sh`, `.c`/`.cpp`,
`.java`, `.go`, `.rs`, `.sql`, `.csv`, `Dockerfile`, `Makefile` and many more) open as numbered,
monospaced lines; indentation is kept, minified JSON is indented. Lines are grouped at blank lines,
and that block is the "paragraph" sent with a term. Local `.html` files show as the page, with a
**Show source** button for their code. Code files up to 8 MB.

**Saving results:** Settings → General → *Save results to* picks a folder (in the system dialog).
Every finished result is then also copied there as `<document>/<term> - <skill>.md` (or `.html`; an
HTML result with its own files becomes a folder). The same result is not written twice; a different
one gets " (2)". Each skill can use the default folder, its own folder, or not be saved (Settings →
Skills → Engine for this skill). The card links to the copy.

**Formulas:** answers can contain LaTeX — `$…$` inline, `$$…$$` (or `\[…\]`) on their own line — and
cards show them typeset (KaTeX 0.19, rendered ahead of time into the script-free result page; also while the
answer streams in). Prices such as "$5 and $10" and anything in code stay text. Models are asked to write
formulas this way. The plain-text view and saved copies keep the LaTeX source.

**Card size:** every card opens at the same size (480×460) and keeps it whatever skill runs in it, Markdown or
HTML; only you change it (drag the corner, maximize / restore), and your size stays when you switch skills.

**Progress:** a run in progress shows a thin amber bar at the top of its result: a sliding segment while it
waits in the queue, then a bar that grows while it works. Models report no percentage, so this is an estimate
(time so far and, for short answers, how much of the answer has arrived); it never fills by itself. A finished
run fills it, green, and it fades; red on failure. With reduced motion set in the system, it does not animate.

**Usage limits:** Settings → Models & effort → *Usage limits* sets, per connection (that is, per API key), a
daily or monthly limit in dollars and/or tokens, and shows what was used so far. Dollars count where the model's
price is known (catalogued models on their official endpoint); tokens always. At 80% the card says so; at the
limit nothing new runs on that connection, the automatic Quick explanation included, and the card says why and
when it resets. Each Pi run is also held to the dollars left. Cached answers still show. Only Glossa's own use is
counted: **also set a spending limit in your provider's console**, which covers other apps and a leaked key.

**Appearance:** System, Light, Dark or **Paper** (the theme button in the top bar cycles through them, or
Settings → General). Paper dresses the interface and the cards, answers included, as fine paper: warm ivory,
ink, a deep ochre accent, a faint grain, warm shadows and serif titles and answers. Opened documents keep
their own look.
System follows the operating system. Documents get a dark page in the dark theme; PDF pages can
be dimmed too (off by default, it inverts their colours).

## Skills

Every skill runs with an agent: the **built-in Pi agent** ([earendil-works/pi](https://github.com/earendil-works/pi),
SDK 1.3.0, bundled; no global Pi or Node.js needed) with one of your model connections, or an
external CLI agent (Codex, OpenCode, your own command) for skills that work in a folder.

Skills use the Agent Skills folder format (`SKILL.md` + files), the same format
Pi, Codex and OpenCode use. Glossa reads an optional `glossa:` block in the
frontmatter:

```yaml
---
name: analogy
description: Explains a term with one everyday analogy.
glossa:
  runner: direct          # direct = short answer (Pi answers in its final message); agent = works in a job folder
  output: markdown        # or html
  label: { en: Analogy, de: Analogie, fr: Analogie, zh: 类比 }
---
Instructions for the model…
```

- **Built in:** `quick-gloss` (a short answer, the **Quick** button) and `eli5`. Quick starts by itself
  when a card is created (Settings → General); every other skill runs when clicked.
- **Anatomy** ([wheresryan22/anatomy](https://github.com/wheresryan22/anatomy)):
  **Settings → Skills → Install** clones it. It works in a job folder that contains
  the skill and the lookup context, by default with the built-in Pi agent (skills that
  call `node` get Electron itself as Node.js), and Glossa shows `output/index.html`
  when the run finishes. Expect minutes to an hour per figure.
- **The first click shows a notice** that skills run with an agent. Pi gets every
  tool without limits (read, write, edit, shell, search) and there is **no OS-level
  sandbox** (see the status file). After that, built-in skills run when clicked; a
  skill you added asks once per version on Pi (per run, or "don't ask again", on an
  external CLI). The only start without a click is Quick on a new card: it is a short
  answer (never a job folder), and it never opens an approval dialog; a quick skill of
  your own waits for its first click and approval.
- HTML output needs a skill that works in a job folder. A short-answer skill set to
  HTML is refused with an explanation.
- **Your own:** create them in Settings, or **Import folder** for any existing skill.

Each skill can override the connection or agent, model and effort.

## Engine settings

- **Providers:** Anthropic (official SDK, streaming, prompt caching of the document,
  `effort`, server-side fallback on supported models) and OpenAI-compatible endpoints.
  Keys are stored with Electron `safeStorage`; Settings warns when the OS keychain is
  unavailable.
- **Built-in Pi agent:** runs each job in its own Electron utility process with
  in-memory settings, sessions and credentials; it does not read `~/.pi`, discovers no
  extensions or project files, and turns off Pi's version check, catalog refresh and
  install telemetry. The key travels to the process in a message, never in its
  environment. The budget is enforced from Pi's usage reports when the model's price
  is known (catalogued models on their official endpoint).
- **External CLI agents:** command templates with `{model} {effort} {budget} {workspace}
  {skillDir} {prompt}`. They are never run through a shell. They receive only an
  allow-listed environment (`PATH`, `HOME`, locale, proxy settings, and the variables
  listed per harness). Commands that switch off the agent's own permission checks
  are refused.
  - **Check installation** runs `--version` and `--help` (no model call) and lists
    any flags the CLI does not know.
  - Verification status: Codex and OpenCode are unverified presets.
  - The budget is only enforced when the command passes `{budget}` to a CLI flag
    that enforces it. *Max tokens* limits answer length, not cost.

## Develop

```bash
npm run typecheck
npm test                 # unit tests (Vitest)
npm run smoke            # builds, then drives the real app headlessly
```

The smoke test launches the app twice on the same data folder.
- **First launch:**
  - opens Markdown, PDF (including an 80-page one) and web documents;
  - picks terms with real keyboard and mouse events (English and Chinese);
  - keeps three cards on one document and each document's cards apart, runs Quick and ELI5 from the
    card's buttons on the built-in Pi agent (clicking a skill again returns to its run), a folder skill
    on Pi and through a fake harness CLI, and checks that Pi's worker processes exit;
  - checks the output protocol's CSP, the denied web permissions, IPC validation and the agent gate;
  - checks a single-page-app route change and a settings change made through the UI;
  - captures areas: a PDF line (text and picture, found again from the last page), lines of code (text only,
    no picture sent), web text and a web figure; Esc cancels a capture;
  - on a web page, Alt+Q while a card holds the keyboard is handed to the page under the mouse;
  - opens a Python file as numbered code, turns on the automatic Quick explanation in Settings and
    checks it starts and its result is copied to the output folder, finds the term again with the
    card's button and with Alt+L (code, and on page 2 of the 80-page PDF from its last page), and
    shows a local HTML file as page and source.
- **Second launch:** checks that cards are restored as left (including a minimized one), that a
  new Quick run is served from the cache, and that a deleted result shows a clear error.

These checks run the real Pi SDK with Glossa's offline demo model, and a fake agent
CLI. They are not tests against real models. Options:

- `GLOSSA_SMOKE_SHOTS=dir` saves screenshots; `GLOSSA_SMOKE_THEME=light` takes them in the light theme.
- `GLOSSA_SMOKE_WEB_URL=https://…` tests a real page; by default the test serves
  a local fixture page.
- `GLOSSA_NO_SANDBOX=1` passes `--no-sandbox`, for containers without the Chromium SUID sandbox.
- `GLOSSA_SMOKE_NO_LOOPBACK=1` skips the model connection steps, which need a local HTTP server, on
  machines that refuse loopback connections; they are logged as NOT RUN. The web page steps always run:
  their fixture page is served at `https://fixture.glossa.test/` inside the web view's own session.

On bare Linux machines that lack Chromium's system libraries (`libnss3`,
`libnspr4`, `libasound2`), put the `.so` files in `.devlibs/`. The smoke script adds
that folder to `LD_LIBRARY_PATH`.

`node scripts/bench/open-hash.mjs [MB]` measures how long opening a large
(synthetic) file blocks the main process.

## Layout

```
src/shared/     platform-free logic: segmentation, term capture, prompts, skills, i18n, types
src/main/       Electron main: store, documents, skills registry, jobs, providers, agent runners, protocols
src/worker/     the built-in Pi agent's worker process
src/preload/    app bridge (window.glossa) and the web-page preload (term picking in <webview>)
src/renderer/   React UI: readers (PDF / HTML / web), term cards, settings
builtin-skills/ quick-gloss, eli5
test/           unit tests + fixtures (fake agent CLI, PDF generator, sample docs)
```

## Security model (short)

- Results render in `<iframe sandbox>` from `glossa-out://`, with a no-network CSP.
  Markdown results allow no scripts; HTML results allow inline scripts only. Result
  files are read without following links (symbolic or hard). A job is only "done"
  when its result file passes the output contract.
- Document HTML (Word, Markdown, local HTML) is sanitized before display. Web pages
  run in an isolated `<webview>` in their own session, where every permission
  request and check, device access, screen capture and download is refused.
- Every IPC argument is checked at runtime. Skill names, job ids and paths are
  confined to the app's folders, and imported skills may not contain links.
- Document text is labelled as untrusted data in every prompt.
- Every job is an agent job and needs: the one-time agent notice accepted, an explicit
  click (the one exception: the quick skill on a new card, a short answer, which never shows an
  approval dialog), and (except built-in skills on Pi) approval in a main-process dialog.
- Output folders are only set from a main-process folder dialog; the renderer can clear
  one but not name a new path. Copies use file names valid on every system. Jobs run
  in their own folder with an allow-listed environment and do not load the user's own
  Pi, MCP or CLI settings. Pi's tools are deliberately unrestricted. Jobs are **not**
  sandboxed by the OS: an agent can read what your user account can read.
