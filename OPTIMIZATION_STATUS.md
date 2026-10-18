# Glossa 稳定化记录（P0 / P1，2026-10-17）

## v2.4 发布检查（2026-10-19，macOS arm64）

- **隐私清理**：移除文档中的机器专属路径；安全测试中的密钥形状字符串改为明确的合成凭据。源码及原远端历史扫描未发现真实凭据或个人主机标识；保留上游作者 / 许可证及有意设计的负面测试。依赖、构建产物、用户配置、密钥、任务结果、截图和本机备份不属于发布内容，相关路径已加入 `.gitignore`。
- **修复**：已验证连接中发现的模型思考强度原先只用于连接测试，实际 Pi 任务仍依赖旧配置标记，可能漏传所选强度；模型映射现读取已保存的能力信息。新增真实 worker + 本地 HTTP 夹具回归，验证指定强度发送、服务商默认不附加该参数。
- **验证 PASS**：类型检查；20 个测试文件 / 258 项；构建；macOS Electron 44.8.0 两次启动冒烟，含阅读器、区域截图、文内定位、多栏缩放、卡片恢复、网页权限、缓存及模型配置完整路径。本轮未跳过本地模型连接步骤，未禁用 Electron 沙箱；使用独立临时用户目录及合成数据。
- **依赖审计 OPEN**：`npm audit` 报告 3 条中危、0 条高危 / 严重，来自同一条 `mammoth → argparse → sprintf-js` 依赖链（[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)，审计时无补丁版本）。检查所装源码：`argparse` 由 Mammoth 的命令行入口使用；Glossa 只调用库的 `convertToHtml` / `extractRawText`，主进程构建未包含该调用。保留锁定依赖，不采用审计建议的破坏性 Mammoth 降级；后续跟进上游修复。
- **边界**：未调用真实模型 / 付费账户，未验证真实密钥的系统钥匙串写入；Windows 未测。静态扫描不能证明不存在任何未知形式的敏感信息。下方各历史记录保留其当时的验证范围。

<!-- round4-checkpoint:start -->
## 第四轮：框选区域解释、网页取词焦点修复（2026-10-18，Linux arm64 无界面副本）

- **YouTube 诊断**：联网加载 `youtube.com/watch?v=aircAruvnKk`（3Blue1Brown，公开视频）。① 把应用的取词代码直接注入页面：简介中取词成功（块为 `DIV#snippet`，216 字），页面无 shadow DOM。② 在应用真实的 webview 中：网页持有键盘时 Alt+Q + Enter 成功（折叠 / 展开的简介、标题均可）；**键盘在 Glossa 窗口（卡片获得焦点）而鼠标在网页上时 Alt+Q 无反应**——即缺陷所在。另发现：此时主窗口的取词在网页面板上会退回整个窗口，可能拾取界面中残留鼠标位置处的文字。诊断脚本保存在 `../.checkpoints/yt-diag/`（不属于应用代码，临时诊断模式已从 `smoke.ts` 移除）。
- **修复**：`term-capture` 的 `root()` 返回 null 时不再退回整个窗口，并报告“未取到”（`onMiss`）；网页 preload 报告鼠标进出页面（`glossa:pointer`），主窗口未取到时把快捷键转交鼠标所在的网页（`glossa:pickHere`，网页随即获得键盘）。定位 / 框选快捷键在网页持有键盘时也会转交回主窗口。
- **框选区域**：`Alt+A` / 顶栏按钮 → 全窗口遮罩拖动框选（Esc / 点击取消）→ 主进程 `capture:area` 只截取应用自己窗口的该矩形（含网页与视频画面，已实测），长边超过 1600 px 缩小，按内容哈希存于 `userData/captures/`（卡片不再引用且超过一天后清理）；各阅读器读取区域内文字（`shared/area-text.ts`：PDF 文本层、文档、代码、网页），按字符框判断是否在区域内。卡片：标题为区域文字（无文字时为“图片”），显示缩略图（点击放大），保存定位信息（首段文字 + 区域位置：PDF 为页内比例，文档为滚动内容比例，网页为页面 CSS 像素）。是否发送图片：区域内有图片 / 画布 / 视频 / SVG（PDF 一律有画布）或没有文字时发送，否则只发送文字。运行：`JobRequest.image` 进入缓存键与“发送至”说明（“· picture”）；简短回答以 Pi `prompt(text, { images })` 附图，任务目录技能与外部 CLI 写入 `area.png` 并在 `context.md` / 任务中说明；提示词说明图片同样是不可信内容。Pi 目录已知不能识图的模型：有文字则只发文字（进度中说明），否则报错，且在任何请求发出之前。
- **冒烟测试的网页步骤不再依赖回环**：夹具页在 webview 自己的会话中以 `https://fixture.glossa.test/` 提供，网页、路由变化、网页权限步骤在本机首次实际运行并通过；`GLOSSA_SMOKE_NO_LOOPBACK` 只跳过模型连接步骤。
- **验证**：`npm run typecheck` PASS；`npm test` 20 个文件 / 257 项 PASS（新增 `test/area-capture.test.ts` 10 项，含真实 Pi worker 附图、已知不能识图模型在发出前被拒）；`npm run build` PASS；Electron 冒烟两次启动 PASS。新增：PDF 第 2 页框选（文字 + 图片，速览自动运行且带图，卡片注明“· picture”，从最后一页定位回原处）；代码框选（只发文字）；Esc 取消不留卡片；网页卡片持有键盘时 Alt+Q 转交网页并生成卡片；网页文字区域（不发图）与 SVG 图形区域（发图，滚走后定位回原处）；网页中按 Alt+A 转交主窗口。截图：`../.checkpoints/feat5-20261018-063525/shots/10-area-pdf.png`、`10b-area-web.png`。
- **NOT RUN**：真实识图模型的回答质量（冒烟使用离线演示模型，只验证图片确实附在请求中）；YouTube 上的修复只在诊断中验证了缺陷与转交路径的原理，冒烟以本地夹具页验证修复本身；模型连接步骤（本机拒绝回环）；macOS / Windows（含高分屏截图尺寸）。
- **快照**：改前 `../.checkpoints/feat5-20261018-063525/before.tar.gz`，完成 `done.tar.gz`。
<!-- round4-checkpoint:end -->

<!-- round3-checkpoint:start -->
## 第三轮：在文档中定位、源代码文件、结果保存位置、自动速览（2026-10-18，Linux arm64 无界面副本）

- **在文档中定位**：取词时为卡片记录定位信息 `TermLocator`（术语原文、前后各约 48 字、去空白后的字符位置；PDF 另记页码），`src/shared/term-locate.ts` 在比较时忽略空白、软连字符与大小写，按前后文匹配度、再按位置距离选出正确的那一处。卡片标题栏 ◎ 按钮与 `Alt+L`（设置 `locateHotkey`；网页获得键盘时由 preload 转发；作用于最近使用的卡片）滚动到术语并高亮约 2.6 秒，尽量避开卡片本身；最大化 / 最小化的卡片先还原。PDF 先跳到所记页码，等该页文本层渲染后再定位；旧卡片没有定位信息时，按句子在所有页中查找。网页经 `glossa:locate` 在 webview 内完成。
- **源代码文件**：新文档类型 `code`，约 100 种扩展名，另按文件名识别 `Dockerfile` / `Makefile` / `.gitignore` 等；带行号（CSS 计数器，不进入文本）的等宽显示，在空行处分块（作为发送的“段落”），保留缩进；压缩的 JSON 自动缩进；上限 8 MB。标签显示文件类型（PY / JSON / YAML…）。本地 `.html` 新增“显示源代码”切换。
- **结果保存位置**：设置 `outputDir` 及每个技能的 `skillOverrides[name].outputDir`（未设 = 默认文件夹，`''` = 不保存）。路径只能由主进程文件夹对话框写入（`settings:chooseOutputDir`）；渲染进程只能清除或原样回传已存值（`assertOutputDirs`）。完成（及缓存命中）的结果复制为 `<文件夹>/<文档>/<术语> - <技能>.md|.html`，带附属文件的 HTML 结果复制为文件夹；内容相同不重复写，不同则加 “ (2)”；复制失败不影响结果本身（`saveError`）。卡片显示“已保存”链接，可在文件管理器中打开。
- **自动速览（默认开启）**：设置 `autoQuick`，推翻阶段 3 “取消自动快速预览”。新卡片创建即以 `origin: 'auto'` 运行 `quickSkill`；主进程只放行“`autoQuick` 开启 + 速览技能 + 简短回答”这一种自动启动；自动启动从不弹出批准对话框（自己的速览技能需先点击批准一次），一次性 Agent 提示被拒后同一会话内不再因自动启动出现。
- **顺带修复**：应用内阅读器的取词回调只在创建时绑定，之后更改解释语言等设置不会生效，现改为始终调用最新回调。两个快捷键相同会互相遮蔽，现由主进程拒绝。冒烟脚本中 Escape 与切换标签之间存在输入顺序竞争（偶发关闭一张卡片，4 次中出现 1 次），已加短暂等待。
- **验证**：`npm run typecheck` PASS；`npm test` 19 个文件 / 247 项 PASS（新增 `test/reader-features.test.ts` 20 项）；`npm run build` PASS；Electron 冒烟（`GLOSSA_SMOKE_NO_LOOPBACK=1 GLOSSA_NO_SANDBOX=1`）两次启动 PASS，最终代码连续多次通过。新增步骤：Python 文件按行显示；在设置界面开启自动速览后，取词即自动运行速览且结果复制到输出文件夹；按钮与 `Alt+L` 均滚回术语并高亮、不被卡片遮挡；80 页 PDF 从最后一页回到第 2 页的术语；本地 HTML 页面 / 源代码切换；IPC 拒绝渲染进程直接设定输出路径。截图：`../.checkpoints/feat4-20261018-031502/shots/`（`9-*`、`6-settings-general`、`6-settings-skill-engine`）。
- **NOT RUN**：网页中的定位（本环境拒绝回环连接，网页步骤整体跳过；代码路径与应用内阅读器共用 `term-locate.ts`）；文件夹对话框本身（无界面环境，冒烟在主进程侧按对话框的结果设定）；macOS / Windows。
- **快照**：改前 `../.checkpoints/feat4-20261018-031502/before.tar.gz`，完成 `../.checkpoints/feat4-20261018-031502/done.tar.gz`（均不含 `node_modules`、`dist`）。
<!-- round3-checkpoint:end -->

<!-- multicard-pi-checkpoint:start -->
## 多卡片与内置 Pi：当前快照（见 [HANDOFF.md](HANDOFF.md)）

### 阶段 1：多卡状态、文档归属、旧数据兼容 —— PASS（2026-10-17，Linux arm64 无界面副本）

- **实现**：新卡片模型 `TermCard`（选词上下文在选词时固定、位置 / 尺寸、窗口状态、多个 skill 运行及当前运行）；每次 Alt+Q 新建卡片，旧卡片保留，新卡片避开已有卡片位置并取得焦点。取消自动快速预览，“速览”改为普通 skill 按钮，点击才执行；同一配置再次点击回到已有运行。卡片按文档保存于 `termCards`；旧版 `cards` 读取时转换，首次保存后移除；启动清理同时保留两种格式引用的任务结果。`PickerCard` / `JobCard` 合并为 `TermCard`，状态与持久化移入 `useTermCards`。
- **关键文件**：`src/shared/cards.ts`、`src/shared/card-geometry.ts`（新）、`src/renderer/components/TermCard.tsx`、`src/renderer/lib/useTermCards.ts`（新）、`src/shared/types.ts`、`src/main/validate.ts`（`vTermCards`）、`src/main/store.ts`、`src/main/main.ts`（清理）、`src/main/smoke.ts`、`App.tsx`、`styles.css`、`i18n.ts`、`README.md`。
- **验证**：`npm run typecheck` PASS；`npm test` 15 个文件 / 199 项 PASS（新增 `test/cards.test.ts` 12 项：旧数据转换、文档隔离、清理引用、IPC 校验、运行去重、位置计算）；`npm run build` PASS；Electron 冒烟两次启动 PASS：同一文档 3 张卡片互不替换、Quick / ELI5 / 替身 Agent 由按钮运行、再次点击不重复运行、切换文档只显示对应卡片、重启后按原状态恢复（含最小化）、新 Quick 运行命中缓存、删除的结果显示错误。截图：`../.checkpoints/20261017-082331/shots-stage1/`。
- **NOT RUN**：本环境拒绝回环连接（同进程 `127.0.0.1` 亦 `ECONNREFUSED`），冒烟中网页、路由变化、网页权限和模型连接步骤以 `GLOSSA_SMOKE_NO_LOOPBACK=1` 跳过并记录为 NOT RUN。Electron 依赖库取自 `~/ext-src/libroot`（`LD_LIBRARY_PATH`），未复制进项目。macOS 双击启动未测。
- **OPEN（后续阶段）**：~~最小化卡片仍停在原位置，可能被大卡片遮住~~（阶段 2 已改为卡片栏）。关闭卡片仍会停止其未完成运行 → 阶段 4 与任务入口一起改为不停止。`autoQuickGloss` 设置项已不再使用，界面开关已移除，字段留待阶段 3 设置迁移删除。冒烟第二次启动原先只比对文本、未真正证明缓存命中，现改为检查“From cache”状态。
- **快照**：改前 `../.checkpoints/20261017-082331/before-multicard.tar.gz`；阶段 1 完成 `../.checkpoints/20261017-082331/stage1.tar.gz`（均不含 `node_modules`）。

### 阶段 2：缩放、最大化 / 还原、最小化栏、吸附 —— PASS（2026-10-17，同一副本）

- **实现**：`card-geometry.ts` 新增 `snapMove` / `snapResize` / `maximized`：12px 内吸附到其他卡片（保留 8px 间距，相邻后对齐边缘）及阅读区域边缘；按指针原始位置计算，拖离超过 12px 自动解除。最大化占满阅读区域，保存的位置不变，还原即回原处；最小化卡片进入当前文档底部卡片栏（显示术语、状态与 skill），点击恢复并聚焦。显示位置始终按当前阅读区域约束（`ResizeObserver`），保存位置不改，窗口变回原尺寸时卡片回到原处。移除未使用的 `restore` 字段。
- **验证**：`npm run typecheck` PASS；`npm test` 15 个文件 / 204 项 PASS（新增吸附、解除、区域边缘、缩放吸附与最小尺寸、最大化 / 区域约束 5 项）；`npm run build` PASS；Electron 冒烟两次启动 PASS，新增真实鼠标事件验证：拖到另一卡片下方 10px 处吸附为 8px 间距并左对齐，再拖 30px 正常分开，靠近区域左缘吸附到 8px；最大化尺寸等于阅读区域、还原回原位置；窗口缩到 820×560 时所有卡片留在区域内，恢复 1280×820 后回原位置；卡片栏最小化 / 恢复；重启后最小化卡片在卡片栏中恢复。截图：`../.checkpoints/20261017-082331/shots-stage2/`。
- **NOT RUN**：同阶段 1（回环相关步骤、macOS 双击启动）。
- **快照**：`../.checkpoints/20261017-082331/stage2.tar.gz`。

### 阶段 3：内置 Pi、模型桥接、指定 skill 加载 —— PASS（替身模型；2026-10-17，同一副本）

- **依赖**：`@earendil-works/pi-coding-agent` **1.3.0**（精确锁定；官方仓库 `earendil-works/pi`，MIT；旧名 `@mariozechner/pi-coding-agent` 在 npm 上已标记弃用并指向新名）。要求 Node ≥ 22.19，Electron 44.8.0 内置 Node 24.22。npm 新的 install-script 白名单未运行 3 个安装脚本（esbuild 已有平台二进制包，未受影响）。
- **实现**：
  - 所有 skill 均经 Pi 执行。`runner: direct` = 简短回答：沿用原提示词（Glossa 说明、获授权时的全文、skill 风格）作为 Pi 追加系统提示，Pi 最终消息即结果并实时流入卡片；`runner: agent` = 在任务目录中运行（skill 复制到 `.pi/skills`，写入 `context.md`，由 Pi 写 `output/…`），上下文仍最多到段落。与改前相比未扩大发送范围。
  - Pi 在独立 Electron utility process（`src/worker/pi-worker.mts`，单独打包为 `dist/main/pi-worker.mjs`，SDK 从 `node_modules` 加载）中运行：内存设置 / 会话 / 凭据；`agentDir` 位于任务目录；不发现扩展、上下文文件或全局 skill，只加载指定 skill；`PI_OFFLINE` / `PI_SKIP_VERSION_CHECK` / `PI_TELEMETRY=0` 且 `enableInstallTelemetry: false`。key 经消息传入，不进环境变量、命令行或日志（日志与错误再做脱敏）。工具：read / write / edit / bash / ls / grep / find，不受限（用户决定）。取消 / 超时先请求 Pi 停止，3 秒后结束进程。
  - 模型桥接（`pi-model.ts`）：按 Glossa 连接的类型 / 地址 / 已测 effort 构造 Pi 模型；`default` 不发送思考参数；不支持的 effort 与 `ultra` 明确拒绝；OpenAI 兼容的 `reasoning_effort` / 长度字段沿用；OpenCode Go 保持禁用；Pi 目录仅用于查价格与上下文窗口（官方地址）。预算在价格已知时按 Pi 用量回报执行，否则只受时间限制（界面说明）。
  - 需要 `node` 的 skill：任务 PATH 末尾提供以 Electron 运行 Node 的 `node` 垫片（已装 Node 时优先用系统 Node；Windows 未实现，标 TODO）。
  - 设置 v4：移除 Claude Code 预设，指向它的默认与逐 skill 配置迁移到 Pi（模型 / effort 取连接默认值）；Codex / OpenCode / 自定义 CLI 保留；记住的批准清空（原 token 绑定 CLI 命令），`agentsEnabled` 保留；移除自动快速预览与文档预热（含设置、授权对话框与界面）。
  - 授权：首次点击弹出一次性说明（主进程对话框），同意后开启；内置 skill 在 Pi 上点击即运行；用户 skill 在 Pi 上每个版本确认一次；外部 CLI 保持原规则（含危险参数拒绝）。仍只允许显式点击。
  - 并发：所有运行进入同一队列（默认 2）。修复：所有运行现在都先授权，两个同时到达的相同请求曾会各自运行，改为授权后再次检查去重。Pi 以文本报告的 401 / 429 也给出原有的友好提示。
- **验证**：`npm run typecheck` PASS；`npm test` 16 个文件 / 214 项 PASS（新增 `test/pi-worker.test.ts` 用真实 Pi SDK 子进程 + 离线演示模型：简短回答流式、任务目录写文件、key 不进环境、取消、提供商错误脱敏、连接→Pi 模型映射，以及 JobManager 经真实 worker 完成内置 skill 与任务目录 skill；队列 2 运行 1 排队、取消后推进；首次说明 / 内置免确认 / 用户 skill 每版本一次；v3→v4 迁移）；`npm run build` PASS；Electron 冒烟两次启动 PASS：Quick / ELI5 在 utility process 中由 Pi 运行，任务目录 skill 由 Pi 写出 HTML，`node` 垫片实际运行 Electron 44.8.0，3 个 Pi 进程在任务结束后按操作系统 PID 确认已退出；外部 CLI 替身路径仍通过。截图：`../.checkpoints/20261017-082331/shots-stage3/`。
- **NOT RUN**：真实服务商调用（任何 Pi 连接，含 Anthropic / OpenAI / Gemini 等）；Anatomy 在 Pi 上的真实运行（阶段 4）；macOS 双击启动与 macOS utility process；Windows（`node` 垫片未实现）；回环相关冒烟步骤（同前）。
- **OPEN**：① 冒烟中若 Pi 任务目录运行（结果为 HTML iframe）紧接在 80 页 PDF 步骤之前，第 80 页渲染比平时慢约 1.2 秒（3/3 次；已排除 `spawnSync` 与 worker 残留，页面最终渲染），步骤顺序已调整，原因未完全定位，推测为本机新开渲染进程的 CPU 竞争。② effort 映射对“开 / 关”式思考的模型（GLM / Kimi）与 Pi 的思考格式未经真实调用验证。③ Pi 的系统提示在 Glossa 说明之前（Pi 默认），简短回答比原直接调用多出 Pi 自身的提示 token。④ Linux 上 worker 需要继承 `LD_LIBRARY_PATH` 才能启动（已加入允许列表）。
- **快照**：`../.checkpoints/20261017-082331/stage3.tar.gz`（不含 `node_modules`；Pi SDK 以 `package.json` / `package-lock.json` 锁定）。

### 阶段 4：skill 按钮、并发与后台任务入口 —— PASS（替身模型；同一副本）

- **实现**：内置按钮依次为 速览 / ELI5 / Anatomy。Anatomy 以官方仓库 `wheresryan22/anatomy` 提交 `e9488296`（MIT，13 MB / 153 个文件，无链接）原样内置于 `builtin-skills/anatomy`，来源见 `builtin-skills/ANATOMY_SOURCE.md`，运行方式沿用现有 Anatomy 预设（任务目录、HTML、75 分钟）。关闭卡片不再停止运行；“停止”为独立按钮。顶栏“任务”面板列出本次会话的全部运行（运行 / 排队在前，显示所属文档、状态、耗时），可停止，可“打开”：卡片仍在则恢复并定位该运行，已关闭则按固定的上下文重建卡片（文档未打开时先重新打开）。应用退出时未完成任务标记为“已中断”并停止 worker，不自动续跑；崩溃后磁盘上仍为运行中的任务同样显示为“已中断”。
- **修复**：① 渲染进程用开始请求的返回值覆盖了更新的进度事件，导致卡片在 Pi 实际运行时显示“等待中”（冒烟时间线确认），改为较新的事件优先。② 从任务面板重建的卡片按结果类型取尺寸，原先 HTML 结果只剩一条细线。③ 删除预热遗留的 `Provider.prewarm` 代码。
- **验证**：`npm test` 16 个文件 / 215 项 PASS（新增：退出时标记中断且不续跑、崩溃遗留记录、内置顺序与 Anatomy 预设）。Electron 冒烟两次启动 PASS：同一卡片点 速览 / ELI5 / Anatomy，界面显示两项运行、一项排队；从任务面板停止一项后排队项开始，其余不受影响；运行中关闭卡片，两项仍完成，任务面板“打开”带回卡片与 Anatomy 结果；第一次启动结束时仍在运行的任务，第二次启动显示“已中断”且没有启动任何 Pi 进程。截图：`../.checkpoints/20261017-082331/shots-stage4/`。
- **NOT RUN**：Anatomy 在真实模型上的完整运行（其脚本、Node 垫片下的 `node` 调用、Chrome 自检）；冒烟中 Anatomy 由离线演示模型代替，只验证了任务目录、复制与结果展示链路。
- **OPEN**：从任务面板重建的已关闭卡片只带回所点的那一项运行，不含该卡片的其他运行；任务面板只列本次会话的运行（以前会话的结果在各自卡片上）。

### 阶段 5：集成回归 —— 本环境 PASS；双击启动 NOT RUN

- `npm run typecheck` PASS；`npm test` 16 个文件 / 215 项 PASS；`npm run build` PASS；Electron 冒烟（`GLOSSA_SMOKE_NO_LOOPBACK=1 GLOSSA_NO_SANDBOX=1`，`LD_LIBRARY_PATH=~/ext-src/libroot/...`）两次启动 PASS。
- 构建标识：`dist/main/main.js` SHA256 `8ed06d8362dbb0623b1648d8c51d8708db687f99e022d56ea371f29de893a209`；`dist/main/pi-worker.mjs` SHA256 `7b3e7dfe3279828fe13633b4f94d320130aad19ed1447da8165f19f4533642c3`。
- **NOT RUN**：macOS 双击脚本启动与原生界面核验（本副本为 Linux arm64 无界面环境，且无双击脚本）；真实服务商调用；网页 / 路由 / 网页权限 / 模型连接冒烟步骤（本环境拒绝回环连接）；Windows。

#### 验收标准对照（HANDOFF §12）

| # | 内容 | 结果 |
|---|---|---|
| 1 | 同一文档连续创建 ≥3 张卡片、互不替换 | PASS（冒烟） |
| 2 | 移动、缩放、最大化 / 还原、最小化 | PASS（冒烟，真实鼠标事件） |
| 3 | 卡片之间及区域边缘吸附、拖离分开 | PASS（单元 + 冒烟） |
| 4 | 切换文档只显示对应卡片、不串上下文 | PASS（冒烟） |
| 5 | 点击 skill 由内置 Pi 运行、无需全局 Pi，结果回到正确卡片 | PASS（离线演示模型）；真实模型 NOT RUN |
| 6 | 两项同时运行、第三项排队；取消一项不影响其他 | PASS（单元 + 冒烟） |
| 7 | 最小化、切换文档或关闭卡片后任务继续，可从任务入口找回 | PASS（冒烟） |
| 8 | 旧设置、卡片、结果兼容；不额外开启 Agent、不扩大数据授权、不泄露 key | PASS（迁移测试；key 不进环境 / 日志 / 错误）。注：按用户决定，所有 skill 改为 Agent 运行，首次点击需接受一次性说明 |
| 9 | 重启恢复卡片与结果，中断任务明确标记、不自动执行 | PASS（冒烟第二次启动） |
| 10 | 类型检查、测试、构建、真实 Electron 双击启动 | 前三项 PASS；双击启动 NOT RUN（需在 macOS 原机进行）；真实服务商与 Anatomy 真实运行单独 NOT RUN |

- **快照**：`../.checkpoints/20261017-082331/stage4-final.tar.gz`（不含 `node_modules`）。

### 界面打磨：浅色 / 深色主题与留白 —— PASS（2026-10-17，同一副本）

- **主题**：设置改为 跟随系统 / 浅色 / 深色（新安装默认跟随系统；已保存的选择不改）。主题由主进程写入 `nativeTheme`，页面经 `prefers-color-scheme` 在首帧即为正确主题（不再先深后浅闪烁），原生对话框、滚动条与窗口底色同步；顶栏新增主题切换按钮。HTML / Word / Markdown 文档在深色下使用深色纸面；PDF 新增“深色下调暗页面”选项（默认关）。答案页颜色与卡片表面一致（去掉深色下的色差缝）。结果与任务按实际显示的主题生成。
- **视觉体系**：`styles.css` 重写为按角色命名的颜色 token（两套主题同名），4px 间距、三档圆角、字号阶梯。对比度经脚本核对：所有文字颜色在其使用的表面上 ≥ 4.5:1（浅色警告由 1.86:1 提至 5.19:1，焦点环由 1.84:1 提至 5.19:1，深色勾选图标由 1.95:1 提至 7.92:1）。
- **组件**：统一 SVG 图标（`Icon.tsx`，Lucide 形状，ISC）替换全部文字符号；术语卡片的 skill 按钮兼作结果标签，仅同一 skill 多次运行时显示子标签，“发送到”常驻页脚，语言 / 模型 / effort 收入选项面板；顶栏重排（同名标签显示文件名）；欢迎页左对齐、按键提示列表、拖放区、最近文档行；设置各页标题 + 说明、卡片式分组、警告提示框、通用页两栏布局、帮助文本限宽；修复模型表最后一列错位（原有问题）。动效 140–160ms，尊重“减少动态效果”。
- **验证**：`npm run typecheck` PASS；`npm test` 16 个文件 / 215 项 PASS；`npm run build` PASS；Electron 冒烟在浅色与深色下各两次启动 PASS，新增顶栏主题切换检查（设置循环、`prefers-color-scheme` 与页面底色随之变化）。冒烟改动：`GLOSSA_SMOKE_THEME=light|dark` 截图开关、欢迎页截图、冒烟中关闭动画（隐藏窗口里动画推进不稳定，只测行为）、两处检查改读 skill 按钮状态点。截图：`../.checkpoints/ui-20261017-210502/{light,dark}/`。
- **NOT RUN**：macOS / Windows 上的原生外观（系统主题实时切换、原生对话框配色）；真实 Anatomy 页面在两种主题下的外观（其页面自带样式，生成后不随主题切换）。
- **快照**：改前 `../.checkpoints/ui-20261017-210502/before-ui-polish.tar.gz`；完成 `../.checkpoints/ui-20261017-210502/ui-polish.tar.gz`。

### 多栏阅读、双指缩放与卡片改进 —— PASS（2026-10-17，同一副本）

- **多栏阅读**：顶栏切换 1 / 2 / 3 栏（单栏占满；双栏为左、右；三栏为左、中、右）。每栏独立滚动，栏头选择显示哪个已打开文档；点标签或打开文件进入当前选中的栏，空栏优先。所有文档始终挂载，布局只移动 / 隐藏其框架，切换布局不重新加载、不丢失位置（网页不重载）。Alt+Q 在鼠标所在的栏取词，卡片归属该栏的文档；所有可见文档的卡片浮于整个阅读区，可拖动、吸附、停靠如前。栏数记在本机（localStorage）。浅色 / 深色均适配。
- **双指缩放**：每栏独立缩放（50%–300%）：触控板双指（Chromium 以 Ctrl+滚轮上报）、触摸屏双指（指针事件）、鼠标 Ctrl+滚轮，以手指位置为锚点。Ctrl+= / − / 0 由主进程拦截后作用于当前栏，窗口本身不再缩放（并锁定窗口级捏合缩放）。HTML / Word / Markdown 用 CSS zoom；PDF 先即时缩放，停止约 180ms 后按新比例重新渲染且保持阅读位置；网页用 webview 缩放，页面内的捏合由 webview preload 捕获上报。
- **卡片**：标题改为文字，点 ✎ 才可重命名（其余标题栏均可拖动）；结果可在“渲染视图”（Markdown，或回答本身是 HTML 时按 HTML 渲染，仍在禁止脚本的查看器中）与“纯文本”之间切换；运行或排队时卡片内显示醒目的“停止”按钮，任务面板新增“全部停止”。
- **Anatomy 统一**：内置 skill 一律由内置 Pi 运行，连接 / 模型 / effort 与其他 skill 相同（Models & effort → 简短回答，或该 skill 自己的选择，或卡片选项）；“任务目录 skill”只保留时间与预算限制，外部 CLI 只用于用户添加且明确选择 CLI 的 skill。原先 Pi 任务目录路径会回退到单独的 Agent 设置（旧默认 `claude-opus-5-5` / 内置 Anthropic 连接），这是 Anatomy 用到 Claude Opus 的来源；设置 v5 迁移清除这部分旧值。另：Pi 只在 Anthropic 订阅令牌（`sk-ant-oat…`）时附加“Claude Code”身份，普通 API key 不会。
- **修复**：PDF 页宽于栏宽时左侧被裁且无法滚动（flex 居中溢出），改为 `align-items: safe center`。
- **验证**：`npm run typecheck` PASS；`npm test` 18 个文件 / 227 项 PASS（新增布局分配、捏合 / 滚轮缩放、HTML 回答识别与渲染、Anatomy 统一与 v5 迁移）；`npm run build` PASS；Electron 冒烟浅色 / 深色各两次启动 PASS，新增：三栏左 / 中 / 右位置、右栏取词且卡片存入该文档、左栏 Ctrl+滚轮（真实输入）与中栏双指触摸缩放互不影响、Ctrl+0 / Ctrl+= 只作用于当前栏且窗口缩放仍为 1、✎ 重命名、卡片内停止与全部停止、HTML 结果纯文本 / 渲染切换、双栏左 / 右、回到单栏保留文档。截图：`../.checkpoints/cols-20261017-214946/{light,dark}/`。
- **NOT RUN**：真实触控板 / 触摸屏硬件上的捏合手感与灵敏度（冒烟用合成触摸指针事件与 Ctrl+滚轮）；网页栏内的捏合（回环受限，网页步骤未运行）；macOS / Windows。
- **OPEN**：卡片为浮动窗口，切换到多栏时原先按单栏摆放的卡片可能盖住其他栏，需要时可最小化或拖开；栏宽固定均分，暂不支持拖动调整栏宽。
- **快照**：改前 `../.checkpoints/cols-20261017-214946/before.tar.gz`；完成 `../.checkpoints/cols-20261017-214946/done.tar.gz`。

<!-- multicard-pi-checkpoint:end -->

<!-- model-config-checkpoint:start -->
## 模型连接改造 checkpoint（2026-10-17 22:20 CST）

- **阶段 1 PASS**：双击脚本启动 `glossa v2/glossa`，使用 v2 独立的 macOS Electron 44.8.0；脚本语法、可执行权限及正式进程参数已核对。旧版项目保留。
- **阶段 2 PASS**：命名连接 / 多 key、10 个服务商入口（GLM 国内与 Z.AI 分开，含保留的 OpenCode Go、自定义）和 v2→v3 设置迁移；保留原有 ID、地址、隐私 / Agent 授权与引用。
- **阶段 3 PASS**：模型发现、模型级 effort、Responses / Gemini 适配、临时测试票据、取消 / 超时、所选组合试调和失败回滚。未知 effort 不发送参数；地址改变不能复用旧 key；命名配置不会用环境 key 替代丢失的 key。
- **阶段 4 PASS**：配置编辑器、保存前草稿、测试后模型 / effort 联动、已保存配置引用、清除 key 和受引用检查保护的删除。中 / 英 / 德 / 法文案已同步。
- **阶段 5 PASS**：`npm run typecheck`、`npm test`（14 个文件 / 187 项）、`npm run build` 全部通过；最终构建的 Electron 冒烟两阶段通过。通过实际双击脚本启动正式 v2，并用原生界面确认“设置 → 模型连接”；当前应用停留在该页面。
- **桌面交互证据**：本地 HTTP 测试服务 + 临时用户目录，覆盖预设清单、错误 key、模型发现、effort 切换、地址变更使测试失效、验证保存、已保存配置实际解释、取消、控制台和 1024×768 布局、重启恢复。截图保存在本机临时用户目录，未随源码发布。Browser 插件未提供，使用项目既有 Electron 自动化与原生 CUA 核验。
- **OPEN / NOT RUN**：OpenCode Go 按已确认范围保留禁用预设，官方要求 coding-agent traffic，阅读器适用性未获确认；未向它发送 key。其他外部服务商未用真实 key 调用，API 账户权限、余额、服务可用性仍待用户逐项测试。原生钥匙串加密存储未做新真实密钥写入验收，Windows 未测。
- **备份 / 回退**：项目根目录 `.checkpoints/20261017-215652/`，含改前 `before-model-config.tar.gz`、阶段 3 / 4 快照、原 Linux Electron 文件和受限权限的用户配置备份；最终源码 / 构建快照 `completed.tar.gz`。本目录未初始化 Git；没有提交或推送。应用依赖未新增，package-lock 保持改前内容。
- **交付标识**：源码 SHA256 `c9fb43099f1d1b273b36af69ece87291847b0744558c8e320a44c93df0e3f57d`；`dist/main/main.js` SHA256 `b1d9a3aec2d17a78ffa1659112511b70e91552aa9ddfeb9f9f78251933dc7b84`。
- **下一步**：在“模型连接”添加或编辑命名配置，用户输入真实 key 后获取模型并验证保存。自定义接口无模型列表时手填模型 ID。
<!-- model-config-checkpoint:end -->


原始基线来自独立只读快照，未随源码发布。对照自己的基线时，可使用 `git diff` 或 `diff -rq`。

## 验证级别说明

| 级别 | 含义 |
|---|---|
| 单元（替身） | Vitest。使用假 Provider、模拟 HTTP、假 Agent CLI 和合成临时目录 |
| Electron 冒烟 | 无头 Electron 44（Linux arm64）中真实运行应用：真实 IPC、协议、`<webview>` 会话、键盘鼠标事件，启动两次。模型和 Agent 仍是替身 |
| 真实 CLI（无模型调用） | 只运行本机 `claude --version` / `--help`（2.1.296） |
| 未验证 | 真实模型调用、真实 Agent 运行、macOS / Windows、真实操作系统钥匙串 |

## 问题与修复

| 编号 | 根因（基线复现） | 关键修改文件 | 测试 | 验证级别 | 剩余风险 |
|---|---|---|---|---|---|
| P0-1 缓存串用 | 缓存键只含技能名、术语、句子、语言、显示标签和**技能正文长度**；命中时直接返回旧 Job（含旧 docId）。基线复现：另一文档命中返回 `docId=aaa…`；段落不同只调用 1 次 | `src/main/cache.ts`（新）、`src/main/job-plan.ts`（新）、`src/main/jobs.ts` | `test/jobs.regression.test.ts`（P0-1 共 13 项） | 单元；Electron 冒烟（重启后缓存命中） | 键不含 Provider 端服务的模型版本漂移（同名模型升级不会使缓存失效） |
| P0-2 输出契约 / 重启空速览 | direct 运行固定写 `result.md`，覆盖为 HTML 时也标 done；`job.json` 不存正文，重启后速览为空；输出文件缺失时仍为 done | `src/main/output-contract.ts`（新）、`output-protocol.ts`（新）、`jobs.ts`、`runners/agent.ts`、`renderer/components/JobCard.tsx`、`Settings.tsx` | `jobs.regression`（P0-2 共 7 项）；冒烟第二次启动 | 单元；Electron 冒烟（重启恢复、删除产物后显示错误卡片） | direct + HTML 选择拒绝（主进程与 UI 双侧），未实现该组合 |
| P0-3 参数与流式终止 | OpenAI 兼容请求不发长度上限；EOF 无终止标记也按成功处理；`finish_reason=length` 和 Anthropic `max_tokens` 当完整结果缓存；SDK 自动重试 2 次 | `providers/openai.ts`、`providers/sse.ts`（新）、`providers/anthropic.ts`、`providers/index.ts`、`shared/capabilities.ts`（新）、`jobs.ts` | `test/providers.regression.test.ts`（14 项）、`jobs.regression`（P0-3 共 5 项） | 单元（模拟 HTTP / SSE） | 未连真实端点；各兼容服务的长度字段需在设置中按实际服务选择 |
| P0-4 全文与预热授权 | `sendFullDocument` 默认开启；打开文档有密钥即预热（上传全文） | `shared/data-scope.ts`（新）、`settings-policy.ts`（新）、`dialogs.ts`（新）、`shared/defaults.ts`（迁移）、`job-plan.ts`、`jobs.ts`、`ipc.ts`、`PickerCard.tsx`、`Settings.tsx` | `test/data-scope.test.ts`（16 项） | 单元；Electron 冒烟（UI 收窄范围经主进程校验保存） | 扩大授权的原生确认对话框未在无头环境中点击验证 |
| P0-5 Agent 授权与执行限制 | 仅渲染进程 `window.confirm`；IPC / 重试 / 自动速览均可绕过；子进程继承完整 `process.env`；SIGKILL 定时器可能在进程退出后误杀复用的进程组 | `agent-policy.ts`、`agent-env.ts`、`isolation.ts`、`dialogs.ts`（均新）、`runners/agent.ts`、`jobs.ts`、`validate.ts` | `test/agent-policy.test.ts`（12 项）；冒烟 IPC 检查 | 单元（含真实子进程和孙进程终止）；Electron 冒烟（无 origin / auto 拒绝） | **没有操作系统级隔离**：Agent 仍可读取用户可读文件、使用网络。本机无 bubblewrap，也不允许用户命名空间 |
| P0-6 路径 / 链接 / 重命名 / IPC | `safeJoin` 不处理符号链接；`statSync` 跟随链接；导入 `cpSync` 保留链接；`previousName` 未校验（可移动任意目录）；IPC 参数无运行时校验 | `fs-safe.ts`（新）、`validate.ts`（新）、`skills.ts`、`output-protocol.ts`、`runners/agent.ts`、`ipc.ts`、`main.ts` | `test/fs-safety.test.ts`（27 项） | 单元；Electron 冒烟（非法 IPC 被拒） | 非 Linux 平台在逐级 lstat 与 open 之间仍有小竞争窗口（Linux 用 `/proc/self/fd` 复核）；没有归档导入功能（不涉及解压） |
| P0-7 网页权限与密钥 | 未设置任何 session 权限处理；系统加密不可用时密钥明文落盘 | `web-security.ts`（新）、`secrets.ts`（新）、`store.ts`、`main.ts`、`Settings.tsx` | `test/secrets-web.test.ts`（9 项）；冒烟 | 单元；Electron 冒烟（真实 webview 会话中 geolocation / 通知 / 麦克风 / 摄像头为 denied） | 未在真实 Keychain、DPAPI 或 libsecret 上验证加密持久化；本机为无钥匙串环境，验证的是降级路径 |
| P1-1 能力探测 | 无 | `harness-probe.ts`、`shared/verification.ts`（新）、`Settings.tsx` | `test/harness-probe.test.ts`（3 项，其中 1 项针对本机真实 `claude`） | 替身 + 真实 CLI（不调用模型） | Codex / OpenCode 未安装，标为未验证；Codex 的任务目录 `git init` 未实测 |
| P1-2 生命周期 / 费用 | 迟到事件可改写已结束任务；同请求可重复提交；预算说明不准确 | `jobs.ts`、`Settings.tsx` | `jobs.regression`（取消竞争、并发去重）、`agent-policy`（取消后队列释放） | 单元 | 预算只在命令含 `--max-budget-usd {budget}` 时由 CLI 强制 |
| P1-3 资源 | 主进程同步读取并哈希整个文件；PDF 渲染的画布从不释放；任务目录无清理 | `documents.ts`、`PdfReader.tsx`、`retention.ts`（新）、`main.ts`、`scripts/bench/open-hash.mjs`（新） | `test/retention.test.ts`；冒烟长 PDF；基准脚本 | 测量（见下） | 清理只在启动时运行 |
| P1-4 动态网页 | 只在加载后固定时间上报一次正文 | `shared/text-watch.ts`（新）、`preload/webview.ts` | `test/dynamic-pages.test.ts`（4 项）；冒烟 SPA 路由 | 单元；Electron 冒烟（pushState 后变为新文档并使用新上下文） | 仅对 example.com 加 pushState 场景验证 |
| P1-5 交付说明 | 文案未区分替身和真实验证 | `README.md`、本文件 | — | — | — |

## 测量（同一方法，改前 / 改后）

- **打开大文件对主进程事件循环的阻塞**：`node scripts/bench/open-hash.mjs 200`（200 MB 随机合成文件，Node 24.21）。
  - 改前（`readFileSync` + sha256）：最长阻塞 212 / 210 ms。
  - 改后（流式哈希）：最长阻塞 2 / 3 ms。
  - 总耗时相近（221 ms 对 196 ms）。
- **滚动 80 页 PDF 时存活的画布数**：冒烟测试中按 41 步滚动到底，每步间隔 120 ms。
  - 基线构建（同一测量代码套在基线快照上）：滚动中最多 14 个，结束时 16 个。
  - 改后：滚动中最多 2 个，结束时 2 个，最后一页仍能渲染。

## 命令与结果（本轮实际输出）

```
npx tsc --noEmit -p tsconfig.json      → TYPECHECK OK
npx vitest run                          → Test Files 11 passed (11); Tests 156 passed (156)
npm run build                           → Built → dist/
GLOSSA_SMOKE_WEB_URL=https://example.com/ GLOSSA_NO_SANDBOX=1 node scripts/smoke.mjs
                                        → [smoke] ALL PASSED / [smoke] ALL PASSED (phase 2) / exit 0
GLOSSA_NO_SANDBOX=1 node scripts/smoke.mjs   （本地测试网页）
                                        → exit 1：本沙箱禁止回环连接（基线相同）
```

## 迁移与行为变化

- **设置 v1 → v2**：存储的 `sendFullDocument` 无法区分是默认值还是用户选择，因此不视为授权，改为 `dataScope: 'paragraph'`，`prewarmDocuments` 设为 false。若曾在旧版风险提示中点过确认（`agentWarningAccepted`），保留为 `agentsEnabled: true`，但每次运行仍需批准。
- **缓存 v2**：旧的无版本缓存条目全部忽略，首次查询会重新生成；旧任务目录和卡片保留，旧布局（`jobs/<id>/output`）仍可打开。
- **新任务布局**：`jobs/<id>/job.json` 加 `jobs/<id>/work/`（Agent 工作目录与元数据分开）。
- **密钥**：系统无受保护存储时不再写入磁盘，改为仅本次会话有效。旧版明文密钥只在加密回读校验通过后才替换；无法加密时原样保留，并提供显式“删除未加密密钥”按钮。
- **用户操作变化**：
  - 发送全文、预热、启用 Agent 都要在主进程对话框中确认；
  - 每次 Agent 运行都需批准（可对某个技能版本加命令选择不再询问）；
  - direct 技能不能选 HTML 输出；
  - Provider 请求不再自动重试。

## 未完成 / 后续

1. **真实端到端**：没有真实模型调用，也没有真实 Agent（Anatomy / Claude Code）运行。下一步用低成本模型做一次 ELI5，并用很小的预算上限跑一次 Anatomy。
2. **系统级隔离**（P2）：没有实现 bubblewrap / sandbox-exec 包装，本机也无法验证。在此之前不能宣称 Agent 被隔离。
3. **平台**：旧稳定化检查在 Linux arm64 无头环境完成；本轮已补充 macOS 启动和模型配置桌面交互验证（见顶部 checkpoint）。macOS 钥匙串新真实密钥写入、Windows 和扩大授权的原生对话框交互仍未测。
4. **P2 建议顺序**：
   1. 目录导航和文内检索；
   2. 解释结果按 Markdown / JSON 导出（术语、原文片段、定位、技能、模型、时间）；
   3. 系统级隔离；
   4. 安装包、签名和 CI。OCR / EPUB 另行评估。
