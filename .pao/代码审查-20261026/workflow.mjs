// 代码审查 fan-out 编排脚本
// 目的：对 pao-dev 自有代码做全面审查（只审查不修改），产出带行号证据的建议清单。
const ROOT = 'D:/AI/workspace/pao-dev';
const REPORT_DIR = ROOT + '/.pao/代码审查-20261026';

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    scope_summary: { type: 'string' },
    files_read: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string' },
          location: { type: 'string' },
          evidence: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
          behavior_boundary: { type: 'string' },
          verification: { type: 'string' },
          confidence: { type: 'string', enum: ['confirmed', 'inferred', 'unverified'] }
        },
        required: ['severity', 'category', 'location', 'evidence', 'problem', 'suggestion', 'behavior_boundary', 'verification', 'confidence']
      }
    }
  },
  required: ['scope_summary', 'files_read', 'findings']
};

const COMMON = `你是资深代码审查员，只审查、绝不修改任何文件。工作区根目录 ${ROOT}（Windows 路径，read 工具用绝对或相对路径读取）。
项目 PAO：以 pi（开源 coding agent）为基座的个人编码 agent；CLI 与 Electron 桌面端共用同一内核；PAO_HOME 为独立运行数据目录。
本次审查必须核对的架构约束（违反即算问题）：
1. 内核公开接口与 CLI 启动入口分离；导入内核不得解析命令行、启动终端、修改全局工作目录、注册进程退出钩子。
2. PAO 业务代码集中在 packages/coding-agent/src/pao/；上游 pi 代码保持原样（不因个人偏好改上游）。
3. 模块用小而明确的公开接口协作；入口文件负责装配；业务规则、文件读写、进程管理、界面表达各归其位。
4. 工作流只决定流程，执行层只负责执行，卡片模块只管状态与回执；底层不依赖桌面或终端。
5. 不新增插件市场、动态加载、注册中心、通用依赖注入框架；可插拔仅指接口与装配点。
6. 终端、桌面、不同执行入口复用同一业务规则与数据契约，不各自维护状态真相。
7. 桌面端是内嵌内核的独立应用：界面只展示与交互，宿主经窄接口调用内核；不复制任务状态、派发、预算、停止规则。
8. renderer/main/preload/driver 经窄接口通信，不把 Node 能力或内部状态直接暴露给页面。
9. driver 保持对共享内核 SDK 的薄封装；发行物不依赖源码仓绝对路径。
10. 同一规则只实现一次；同一状态只存一份；最小改动、保留有效保护（权限/身份/并发/幂等/取消/恢复）。

审查维度：
A 复用——是否重复实现了仓内已有能力；同一规则/校验/解析/状态迁移是否在多处各维护一套；是否有只转调一次的包装层。
B 结构质量——调用链与依赖方向；反向依赖；跨模块读内部状态；状态真相多份；错误被吞（空 catch、fallback 默认成功）；职责混合；过度抽象、无真实需求的前置框架。
C 运行效率——真实路径上的重复读盘、重复解析、重复遍历、无用全量加载、串行独立 I/O、频繁建资源、无界集合增长。
D 正确性与安全（必须报，不能因"不属于过度设计"而漏）——并发竞态、幂等、取消、超时、崩溃恢复、路径处理、命令/参数注入、权限校验、错误传播、数据一致性、部分写入、事务与回滚。

硬性要求：
- 必须真实读代码，禁止臆测；每条结论给出「相对路径:行号」并贴出关键代码行作为证据。
- 只报读过代码后确认或高置信推断的问题；不为凑数报风格、命名、格式问题。
- 不修改文件；不要运行构建/测试/安装。
- 建议必须具体可执行：写清「删什么/改什么/复用什么」，并说明行为边界（默认值、异常语义、公开契约、并发语义是否变化）与验证方法。
- severity：high=正确性/安全/数据损坏/架构边界被破坏；medium=重复实现、状态多份、效率热点、可维护性风险；low=局部简化机会。
- confidence：confirmed=代码可直接证实；inferred=基于调用链的高置信推断；unverified=需要运行或进一步查证。
- findings 最多 10 条，优先高价值；每条字段控制在 400 字以内。`;

const GROUPS = [
  { id: 'K1-workflow-plan', label: '内核 工作流-计划', scope: ['PAO/packages/coding-agent/src/pao/workflow/plan.ts', 'PAO/packages/coding-agent/src/pao/workflow/plan-tools.ts', 'PAO/packages/coding-agent/src/pao/workflow/plan-feedback.ts'], focus: '计划生成/拆解/计划工具与反馈回路：规则是否只在计划层一处定义，计划数据结构是否单一真相，工具暴露面是否过宽，是否有可绕过的旁路。' },
  { id: 'K2-workflow-control', label: '内核 工作流-控制', scope: ['PAO/packages/coding-agent/src/pao/workflow/control.ts', 'PAO/packages/coding-agent/src/pao/workflow/driver.ts', 'PAO/packages/coding-agent/src/pao/workflow/host-bridge.ts'], focus: '工作流控制面：状态机、取消/预算/停止语义、host 桥接是否越过边界（控制层读 UI 状态或直接做 IO），错误是否被吞。' },
  { id: 'K3-workflow-rest', label: '内核 工作流-其余', scope: ['PAO/packages/coding-agent/src/pao/workflow/tools.ts', 'PAO/packages/coding-agent/src/pao/workflow/minister.ts', 'PAO/packages/coding-agent/src/pao/workflow/recipe.ts', 'PAO/packages/coding-agent/src/pao/workflow/auto.ts', 'PAO/packages/coding-agent/src/pao/workflow/review.ts', 'PAO/packages/coding-agent/src/pao/workflow/distill.ts'], focus: '工作流工具集、部长/配方/自动/评审/蒸馏：规则是否重复实现，配方与运行时是否多份真相。' },
  { id: 'K4-worker-dispatch', label: '内核 调度派发', scope: ['PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts', 'PAO/packages/coding-agent/src/pao/worker/index.ts', 'PAO/packages/coding-agent/src/pao/worker/runner.ts'], focus: '派发与执行：并发控制、幂等、重试、超时、取消、进程管理、锁；同一派发规则是否在 CLI/桌面各实现一套。' },
  { id: 'K5-worker-rest', label: '内核 worker 其余', scope: ['PAO/packages/coding-agent/src/pao/worker/cleanup.ts', 'PAO/packages/coding-agent/src/pao/worker/lock.ts', 'PAO/packages/coding-agent/src/pao/worker/inventory.ts', 'PAO/packages/coding-agent/src/pao/worker/receipt.ts', 'PAO/packages/coding-agent/src/pao/worker/post-dispatch.ts', 'PAO/packages/coding-agent/src/pao/worker/supervision.ts'], focus: '清理、锁、清单、回执、派发后处理：锁的原子性与陈旧回收、清理路径是否可靠、回执写入是否可重复/可损坏。' },
  { id: 'K6-cards-verify-delivery', label: '内核 卡片-校验交付', scope: ['PAO/packages/coding-agent/src/pao/cards/verifier.ts', 'PAO/packages/coding-agent/src/pao/cards/delivery.ts'], focus: '卡片校验与交付：校验规则是否唯一、失败处理是否一致、卡片写盘是否原子、是否吞错。' },
  { id: 'K7-cards-rest', label: '内核 卡片-其余', scope: ['PAO/packages/coding-agent/src/pao/cards/integration.ts', 'PAO/packages/coding-agent/src/pao/cards/baseline.ts', 'PAO/packages/coding-agent/src/pao/cards/tools.ts', 'PAO/packages/coding-agent/src/pao/cards/cardfile.ts', 'PAO/packages/coding-agent/src/pao/cards/execution-context.ts'], focus: '卡片集成、基线、工具、卡片文件与执行上下文：卡片协议（中文 frontmatter 键为外部契约）解析是否单点，目录枚举是否完整。' },
  { id: 'K8-brief-fanout', label: '内核 派发简报与扇出', scope: ['PAO/packages/coding-agent/src/pao/dispatch-brief/', 'PAO/packages/coding-agent/src/pao/fanout/'], focus: '简报生成/快照/工件/工作区准备与扇出执行：快照与大文件处理、重复读盘、扇出并发与失败隔离。' },
  { id: 'K9-kernel-desktop-adapter', label: '内核 桌面适配/面板/状态/部门', scope: ['PAO/packages/coding-agent/src/pao/desktop/', 'PAO/packages/coding-agent/src/pao/panel/', 'PAO/packages/coding-agent/src/pao/status/', 'PAO/packages/coding-agent/src/pao/dept/'], focus: '内核侧的桌面只读模型、面板、状态与部门：是否违反"底层不依赖桌面"；同一状态是否在桌面 read-model 与内核各存一份。' },
  { id: 'K10-memory-knowledge', label: '内核 记忆与知识', scope: ['PAO/packages/coding-agent/src/pao/memory/', 'PAO/packages/coding-agent/src/pao/knowledge/', 'PAO/packages/coding-agent/src/pao/context/', 'PAO/packages/coding-agent/src/pao/todo/'], focus: '记忆/知识/上下文/todo：供应商接口是否过度抽象、检索是否全量扫描、会话记忆是否重复持久化。' },
  { id: 'K11-host-entry', label: '内核 host 与公开入口', scope: ['PAO/packages/coding-agent/src/pao/host/', 'PAO/packages/coding-agent/src/pao/index.ts', 'PAO/packages/coding-agent/src/pao/command-router.ts', 'PAO/packages/coding-agent/src/pao/role.ts', 'PAO/packages/coding-agent/src/pao/runtime-impact.ts'], focus: '公开入口与装配：入口是否过胖、导出面是否过宽、是否在导入期做副作用、role/命令路由是否规则多份。' },
  { id: 'K12-kernel-misc', label: '内核 其余模块', scope: ['PAO/packages/coding-agent/src/pao/runtime/', 'PAO/packages/coding-agent/src/pao/routing/', 'PAO/packages/coding-agent/src/pao/intake/', 'PAO/packages/coding-agent/src/pao/usage/', 'PAO/packages/coding-agent/src/pao/healthcheck/', 'PAO/packages/coding-agent/src/pao/patrol/', 'PAO/packages/coding-agent/src/pao/preflight/', 'PAO/packages/coding-agent/src/pao/collab/', 'PAO/packages/coding-agent/src/pao/migration/', 'PAO/packages/coding-agent/src/pao/shared/', 'PAO/packages/coding-agent/src/pao/worktrees/', 'PAO/packages/coding-agent/src/pao/supervision/', 'PAO/packages/coding-agent/src/pao/panorama/', 'PAO/packages/coding-agent/src/pao/ui/', 'PAO/packages/coding-agent/src/pao/friction/', 'PAO/packages/coding-agent/src/pao/notify/'], focus: '零散模块：路由/预算/健康检查/巡检/迁移/共享工具；重点找重复实现、只在单处使用的抽象、命名与职责漂移。' },
  { id: 'D1-electron-appstate', label: '桌面 应用状态与编排', scope: ['desktop/apps/desktop/electron/application/', 'desktop/apps/desktop/electron/orchestration/'], focus: '主进程 app-store 与编排：状态是否单一真相、持久化时序、跨模块写入竞态。' },
  { id: 'D2-electron-platform', label: '桌面 平台层', scope: ['desktop/apps/desktop/electron/platform/'], focus: '平台适配（worktree/git/文件/终端/通知/PAO 查询）：是否复制了内核规则、路径与进程处理是否安全、查询是否全量加载。' },
  { id: 'D3-electron-ipc', label: '桌面 IPC 与入口', scope: ['desktop/apps/desktop/electron/ipc/', 'desktop/apps/desktop/electron/preload.ts', 'desktop/apps/desktop/electron/main.ts', 'desktop/apps/desktop/electron/lifecycle/', 'desktop/apps/desktop/electron/windows/'], focus: 'IPC 边界：请求校验、通道白名单、是否把 Node 能力或内部状态泄露给页面、生命周期与退出清理。' },
  { id: 'D4-electron-rest', label: '桌面 主进程其余', scope: ['desktop/apps/desktop/electron/conversation/', 'desktop/apps/desktop/electron/workbench/', 'desktop/apps/desktop/electron/scheduled-tasks/', 'desktop/apps/desktop/electron/extensions/', 'desktop/apps/desktop/electron/persistence/'], focus: '会话/工作台/定时任务/扩展/持久化：原子写、崩溃恢复、定时任务并发、扩展视图隔离。' },
  { id: 'D5-renderer-canvas', label: '渲染层 canvas', scope: ['desktop/apps/desktop/src/features/canvas/'], focus: '画布与工作流编辑器：状态是否在组件内复制、事件处理是否重复、渲染性能。' },
  { id: 'D6-renderer-cards', label: '渲染层 工作流卡片与计划', scope: ['desktop/apps/desktop/src/features/workflow-cards/', 'desktop/apps/desktop/src/features/plans/'], focus: '卡片视图与模型层：模型是否第二份真相、轮询/刷新策略、diff 计算代价。' },
  { id: 'D7-renderer-conversation', label: '渲染层 会话', scope: ['desktop/apps/desktop/src/features/conversation/'], focus: '会话时间线/输入框/注释：流式更新与重复渲染、内存增长、事件订阅清理。' },
  { id: 'D8-renderer-threads', label: '渲染层 会话列表与状态栏', scope: ['desktop/apps/desktop/src/features/threads/', 'desktop/apps/desktop/src/features/side-chat/', 'desktop/apps/desktop/src/features/task-status/'], focus: '会话列表/侧聊/任务状态：状态副本、轮询与订阅泄漏。' },
  { id: 'D9-renderer-board', label: '渲染层 看板与工作台', scope: ['desktop/apps/desktop/src/features/workboard/', 'desktop/apps/desktop/src/features/workbench/'], focus: '看板/部门执行/工作台/diff 面板：轮询、派生状态、终端与 diff 的性能。' },
  { id: 'D10-renderer-settings', label: '渲染层 设置/扩展/命令面板', scope: ['desktop/apps/desktop/src/features/settings/', 'desktop/apps/desktop/src/features/extensions/', 'desktop/apps/desktop/src/features/command-palette/', 'desktop/apps/desktop/src/features/scheduled-tasks/'], focus: '设置/扩展/命令面板：表单状态与后端配置双份真相、密钥处理、扩展视图边界。' },
  { id: 'D11-renderer-app', label: '渲染层 应用壳', scope: ['desktop/apps/desktop/src/app/', 'desktop/apps/desktop/src/ui/', 'desktop/apps/desktop/src/lib/', 'desktop/apps/desktop/src/i18n/', 'desktop/apps/desktop/src/styles/'], focus: '应用壳与全局状态：store 与 props 双份状态、上下文重渲染、路由与窗口生命周期。' },
  { id: 'D12-driver', label: '桌面 pi-sdk-driver', scope: ['desktop/packages/pi-sdk-driver/src/', 'desktop/packages/pi-sdk-driver/extensions/'], focus: 'SDK driver：是否薄封装、超大文件职责、会话监管与运行时监管的资源释放、是否复制内核规则、发行物路径依赖。' },
  { id: 'D13-desktop-other', label: '桌面 其余包与测试工具', scope: ['desktop/packages/session-driver/', 'desktop/packages/extension-ui/', 'desktop/packages/catalogs/', 'desktop/apps/desktop/scripts/', 'desktop/apps/desktop/contracts/'], focus: '小包与契约：职责边界、是否存在只为一处服务的抽象、契约与实现漂移。' }
];

function groupPrompt(g) {
  const list = g.scope.map((s) => '- ' + s).join('\n');
  return `${COMMON}

【你的审查范围（相对仓库根 ${ROOT}）】
${list}

【本组重点】${g.focus}

【工作步骤】
1. 先读该范围内全部文件（可先看目录清单再逐个读），不要只抽样。
2. 需要时用 grep 工具查调用者与被调用者，确认问题是否真实（避免把公开契约或唯一实现误判为可删）。
3. 按 A/B/C/D 四个维度各扫一遍，只保留有证据的条目。
4. 输出：scope_summary（这组代码的职责与调用关系，≤300 字）、files_read（相对路径列表）、findings（最多 10 条）。
注意：不要写文件，只把结果作为返回值。`;
}

function findingsText(res) {
  if (!res) return '(无结果)';
  const lines = [];
  lines.push('范围: ' + (res.scope_summary || ''));
  for (const f of (res.findings || [])) {
    lines.push(`- [${f.severity}/${f.confidence}] (${f.category}) ${f.location} :: ${f.problem} | 证据: ${f.evidence} | 建议: ${f.suggestion} | 行为边界: ${f.behavior_boundary} | 验证: ${f.verification}`);
  }
  return lines.join('\n');
}

const results = [];
const failures = [];

const wave = async (items) => {
  const CHUNK = 6;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    let out = [];
    try {
      out = await parallel(chunk.map((g) => () => agent(groupPrompt(g), { label: g.id, phase: '模块深审', schema: FINDING_SCHEMA })));
    } catch (e) {
      log('批次失败（继续）：' + String(e).slice(0, 200));
      out = new Array(chunk.length).fill(null);
    }
    chunk.forEach((g, j) => {
      if (out[j]) results.push({ id: g.id, label: g.label, data: out[j] });
      else failures.push(g.id);
    });
    log('批次完成 ' + (i + chunk.length) + '/' + items.length);
  }
};

await wave(GROUPS.slice(0, 12));
await wave(GROUPS.slice(12));

const stage1 = results.map((r) => `### ${r.id} ${r.label}\n` + findingsText(r.data)).join('\n\n');
const total1 = results.reduce((n, r) => n + ((r.data && r.data.findings) || []).length, 0);
log(`阶段一完成：${results.length} 组，条目 ${total1}，失败组 ${failures.join(',') || '无'}`);

const LENSES = [
  { id: 'X1-dup-state', focus: '状态真相与重复实现：同一规则/校验/解析/状态迁移在多处各实现一套、同一状态多份副本、桌面复制内核规则、终端与桌面行为漂移。', files: ['PAO/packages/coding-agent/src/pao/', 'desktop/apps/desktop/electron/', 'desktop/apps/desktop/src/', 'desktop/packages/'] },
  { id: 'X2-boundary', focus: '依赖方向与架构边界：反向依赖、跨层读内部状态、绕过装配入口、底层依赖上层、导入期副作用、过度抽象与只为转发存在的层。', files: ['PAO/packages/coding-agent/src/pao/', 'desktop/packages/pi-sdk-driver/src/'] },
  { id: 'X3-correctness', focus: '并发/幂等/取消/超时/恢复/错误传播/安全校验：竞态、非原子写、部分失败、锁失效、吞错与默认成功、路径与命令注入、权限校验缺失。', files: ['PAO/packages/coding-agent/src/pao/worker/', 'PAO/packages/coding-agent/src/pao/cards/', 'desktop/apps/desktop/electron/', 'desktop/packages/pi-sdk-driver/src/'] },
  { id: 'X4-perf', focus: '运行效率与资源：重复读盘/解析、每帧或每轮全量加载、无界集合与内存增长、串行独立 I/O、频繁创建进程/句柄、重复序列化。', files: ['PAO/packages/coding-agent/src/pao/', 'desktop/apps/desktop/src/', 'desktop/packages/pi-sdk-driver/src/'] }
];

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    lens_summary: { type: 'string' },
    confirmed: { type: 'array', items: { type: 'string' } },
    refuted: { type: 'array', items: { type: 'string' } },
    new_findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string' },
          location: { type: 'string' },
          evidence: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
          behavior_boundary: { type: 'string' },
          verification: { type: 'string' },
          confidence: { type: 'string', enum: ['confirmed', 'inferred', 'unverified'] }
        },
        required: ['severity', 'category', 'location', 'evidence', 'problem', 'suggestion', 'behavior_boundary', 'verification', 'confidence']
      }
    }
  },
  required: ['lens_summary', 'confirmed', 'refuted', 'new_findings']
};

const lensPrompts = LENSES.map((l) => `${COMMON}

【阶段二：跨模块专项复核】你负责的视角：${l.focus}
【建议重点扫描范围】${l.files.map((f) => '- ' + f).join('\n')}

下面是阶段一各模块审查员已报出的条目（可能不准确，也可能重复）。你的任务：
1. 打开文件核对与你的视角相关的条目，判断哪些成立、哪些是误报或已在别处修复；分别列在 confirmed / refuted（refuted 需写清为什么不成立）。
2. 找出阶段一漏掉的、属于你这个视角的问题（≤8 条），每条给 文件:行号 与证据。
3. 同一问题在多处出现时，只报一处最权威的位置，并在 evidence 中列出其他位置。
4. 不要修改文件。`);

const stage2 = await parallel(lensesPrompts.map((p, i) => () => agent(p, { label: LENSES[i].id, phase: '跨模块复核', schema: REVIEW_SCHEMA })));

const stage2Text = stage2.map((r, i) => {
  if (!r) return `### ${LENSES[i].id}\n(失败)`;
  const lines = ['### ' + LENSES[i].id + ' 视角: ' + LENSES[i].focus.slice(0, 40)];
  lines.push('summary: ' + (r.lens_summary || ''));
  lines.push('confirmed: ' + (r.confirmed || []).join(' | '));
  lines.push('refuted: ' + (r.refuted || []).join(' | '));
  for (const f of (r.new_findings || [])) {
    lines.push(`- [${f.severity}/${f.confidence}] (${f.category}) ${f.location} :: ${f.problem} | 证据: ${f.evidence} | 建议: ${f.suggestion} | 行为边界: ${f.behavior_boundary} | 验证: ${f.verification}`);
  }
  return lines.join('\n');
}).join('\n\n');

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    report_path: { type: 'string' },
    counts: { type: 'string' },
    top_issues: { type: 'array', items: { type: 'string' } },
    coverage: { type: 'string' },
    unverified: { type: 'array', items: { type: 'string' } }
  },
  required: ['report_path', 'counts', 'top_issues', 'coverage']
};

const reporterPrompt = `${COMMON}

【阶段三：报告整合】下面是阶段一（26 组模块审查）与阶段二（4 个跨模块专项复核）的全部条目，格式为：
- [severity/confidence] (category) location :: problem | 证据: evidence | 建议: suggestion | 行为边界: behavior_boundary | 验证: verification
并有 confirmed / refuted 列表表示哪些条目被复核认可或推翻。

=== 阶段一条目 ===
${stage1}

=== 阶段二专项复核 ===
${stage2Text}

任务：
1. 去重合并同类项（同一根因的多处出现合并为一条，主位置 + 其他位置列表）。
2. 按「高 → 中 → 低」排序，剔除被 refuted 的条目；对仅 inferred/unverified 的条目明确标注并放入"待核实项"。
3. 把完整报告写成 Markdown 文件：${REPORT_DIR}/审查报告.md（目录不存在就创建）。报告结构：
   - 一、结论概览（10 行以内：整体架构健康度、最该先修的 3-5 件事）
   - 二、高优先级问题（每条：位置 / 证据(贴关键行) / 问题 / 建议方案 / 行为边界 / 验证方法）
   - 三、中优先级问题
   - 四、低优先级与局部简化机会
   - 五、待核实项（需运行或进一步查证的条目，注明怎么验）
   - 六、模块覆盖与审读深度（每个目录：审读深度=完整通读/重点抽查/未覆盖，说明发现了什么）
   - 七、确认无需改动的部分（保留理由）
4. 同时把可执行清单写入 ${REPORT_DIR}/建议清单.md：编号、优先级、位置、一句话动作、预估影响面、验证方法。
5. 只写这两个报告文件，不要改任何源码，不要写别的文件。
6. 返回：report_path、counts（high/medium/low/待核实 各多少条）、top_issues（5-8 条一句话，每条带位置）、coverage（覆盖目录概述）。`;

const report = await agent(reporterPrompt, { label: '报告整合', phase: '报告整合', schema: REPORT_SCHEMA });

return {
  failed_groups: failures,
  stage1_groups: results.length,
  stage1_findings: total1,
  stage2: stage2.filter(Boolean).length,
  report
};
