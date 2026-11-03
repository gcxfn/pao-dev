# pi-maestro-flow 抄改代码摘录（16 项注记配套正本）

> **用途**：2026-10-07 落进 `plans/v2-ARCHITECTURE.md`、`plans/v2-REQUIREMENTS.md`、`plans/已完成/存档-收编-2026-10-07/2026-10-05-工作流与看板形态重构需求.md` 的 16 条参照注记（A 组 10＋B 组 6），其源码摘录统一收在本文——实施批次按注记反查本文即可，**不必再扒源码**。
> **来源**：pi-maestro-flow npm v0.31.3（MIT，源仓 github.com/catlog22/pi-maestro-flow）。本地解包副本 `D:\AI\workspace\临时文件夹\pi-maestro-flow-20261006\package\`（临时目录，删除后以本文为准；行号相对该副本，版本升级后行号可能漂移，以函数名为准）。
> **抄改纪律**：直接照抄/抄改代码的文件按项目惯例保留 MIT 许可证声明，真引入时把许可证与维护状态记 `.agents/notes/implemented/`；只借思想的条目无需。
> 摘录只收「要抄的部分」，`…` 表示省略；代码内英文注释为原文，未译。

## 反查表

| 条目 | 落点（plans 注记） | 源文件（相对 package/） |
|---|---|---|
| A-1 状态通道 | 架构 §27.3 | `src/ui-projection.ts` |
| A-2 看板游标增量 | 工作流需求 §五 | `src/gateway/board-store.ts` |
| A-3 连线校验 | 工作流需求 §七第 7 条 | `src/gateway/board-contracts.ts`、`board-store.ts` |
| A-4 派单租约 | 工作流需求 §五 | `src/gateway/board-store.ts` |
| A-5 接管协议 | 架构 §27.3 | `src/ask-transport.ts`、`src/plan-transport.ts` |
| A-6 提交防连点 | 记忆备查（不入正本） | `src/submit-gate/extension.ts` |
| A-7 worker 回执 | 架构 §12/§14 | `.pi/agents/general-executor.md`＋`-report.schema.json` |
| A-8 配方写法 | 架构 §4 | `.pi/skills/team-lifecycle-v4/SKILL.md`＋`roles/coordinator/role.md` |
| A-9 入库注入防线 | 架构 §12.2 | `src/knowledge/extractor.ts` |
| A-10 护栏判定 | 需求 §6 预案① | `src/permissions/policy.ts` |
| B-1 goal 对照件 | 需求 §4.1 goal 行 | `src/tools/goal.ts`＋`goal-verification.ts` |
| B-2 压缩检查点 | 架构 §4.1 | `src/compaction/maestro-compaction.ts`＋`compaction-threshold.ts` |
| B-3 重试幂等 | 架构 §2.1 | `src/gateway/operation-contracts.ts` |
| B-4 只拦不放行 | 架构 §12.2 | `src/hooks/pi-adapter.ts`＋`trust.ts` |
| B-5 影子双跑 | 需求 §6 预案③ | `src/classifier/domains.ts`＋`extension.ts` |
| B-6 不自我提权 | 架构 §4 | `src/permissions/settings.ts` |

---

## A-1 状态通道（ui-projection）

抄：**四字段信封＋指纹去重＋generation 轮换＋查询回放**四机制；投影函数（`projectMaestroUiState`）是纯函数、字段自定。

```ts
// src/ui-projection.ts:65-149
export class MaestroUiPublisher {
  private sessionGeneration: string;
  private revision = -1;
  private lastFingerprint: string | undefined;

  beginSession(): void { this.rotateGeneration(); }

  publish(force = false): MaestroUiStateSnapshotV1 | undefined {
    const projection = projectMaestroUiState(this.read());
    const fingerprint = JSON.stringify(projection);
    if (!force && fingerprint === this.lastFingerprint) return undefined;   // 指纹未变不重发
    const snapshot = { ...this.nextEnvelope(), ...projection };
    this.emitSnapshot(MAESTRO_UI_SNAPSHOT_EVENT, snapshot);
    this.lastFingerprint = fingerprint;
    return snapshot;
  }

  publishFull() { return this.publish(true)!; }                            // 查询回放用

  private nextEnvelope() {
    if (this.revision >= Number.MAX_SAFE_INTEGER) this.rotateGeneration();
    this.revision += 1;
    return {
      version: MAESTRO_UI_SNAPSHOT_VERSION,
      sessionGeneration: this.sessionGeneration,   // 换代会话→UI 整体重置
      revision: this.revision,                     // 不连续→UI 知道丢了包
      publishedAt: this.now(),
    };
  }

  private rotateGeneration(): void {
    this.sessionGeneration = this.createGeneration();
    this.revision = -1;
    this.lastFingerprint = undefined;
  }
}

// 新订阅者喊一声即重放全量（「打开拉取」的实现）
export function registerMaestroUiQuery(events, publisher, isActive = () => true): void {
  events.on(COCKPIT_MAESTRO_QUERY_EVENT, (query: unknown) => {
    const payload = query as { version?: unknown } | null;
    if (payload?.version !== MAESTRO_UI_SNAPSHOT_VERSION || !isActive()) return;
    publisher.publishFull();
  });
}
```

另抄细节：`clear()` 发显式 `{cleared: true}` 事件而非空快照（空快照≠没数据）。

## A-2 看板游标增量（observe）

抄：**cursor 单调递增＋gap 诚实标记＋超前报错＋分页**；事件在每次变更时由存储层追加（带 cursor 字段）。

```ts
// src/gateway/board-store.ts:536-551
async observe(afterCursor = 0, limit = 128): Promise<BoardEventPage> {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new BoardStoreError("cursor must be a non-negative safe integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new BoardStoreError("limit must be in [1, 512]");
  const state = await this.load();
  if (afterCursor > state.cursor) throw new BoardStoreError("cursor is ahead of the Board event stream");  // 超前＝串源，报错不猜
  const oldestCursor = state.events[0]?.cursor ?? state.cursor + 1;
  const gap = afterCursor < oldestCursor - 1;   // 落后太多＝增量补不齐，UI 须全量重读
  const eligible = state.events.filter((event) => event.cursor > afterCursor);
  const events = eligible.slice(0, limit).map(clone);
  return { events, oldestCursor, nextCursor: events.at(-1)?.cursor ?? afterCursor, hasMore: eligible.length > events.length, gap };
}
```

## A-3 连线校验（环检测＋转移表＋依赖完成＋保护回收）

抄：三色 DFS 放在**解析/落盘边界**（读写都跑）；转移白名单；激活前依赖全完成；回收不碰被引用卡。

```ts
// src/gateway/board-contracts.ts:236-251（parseBoardEnvelope 内，加载/落盘前校验）
const visiting = new Set<string>();
const visited = new Set<string>();
const visit = (taskId: string): void => {
  if (visiting.has(taskId)) throw new BoardContractError("Board task dependency cycle detected");
  if (visited.has(taskId)) return;
  visiting.add(taskId);
  for (const dependencyId of tasks.get(taskId)?.dependencyIds ?? []) {
    if (!tasks.has(dependencyId)) throw new BoardContractError(`Unknown board task dependency ${dependencyId}`);  // 悬空依赖
    visit(dependencyId);
  }
  visiting.delete(taskId);
  visited.add(taskId);
};
for (const taskId of tasks.keys()) visit(taskId);
```

```ts
// src/gateway/board-store.ts:701-712
private assertTransition(current, status, phase): void {
  const allowed = current.status === status
    || (current.status === "open" && ["active", "blocked", "cancelled"].includes(status))
    || (current.status === "active" && ["blocked", "completed", "cancelled"].includes(status))
    || (current.status === "blocked" && ["open", "active", "cancelled"].includes(status));
  if (!allowed) throw new BoardConflictError(`Invalid board transition ${current.status} -> ${status}`);
  if (phase === "intake" && status === "active") throw new BoardConflictError("Active board task cannot remain in intake");
}

private assertDependenciesCompleted(state, task): void {
  const byId = new Map(state.tasks.map((entry) => [entry.id, entry]));
  for (const dependencyId of task.dependencyIds) {
    if (byId.get(dependencyId)?.status !== "completed") throw new BoardConflictError(`Board dependency is not completed: ${dependencyId}`);
  }
}
```

```ts
// src/gateway/board-store.ts:719-727（prune 内：被依赖的终态卡不回收）
const referenced = new Set(state.tasks.flatMap((task) => task.dependencyIds));
const removed = new Set(state.tasks
  .filter((task) => terminal(task) && !referenced.has(task.id))
  .filter((task) => (task.result?.completedAt ?? task.cancelledAt ?? task.updatedAt) <= now - this.taskRetentionMs!)
  .map((task) => task.id));
// 删卡后级联删其 operations/events
```

## A-4 派单租约（claim/renew/takeover）

抄：**认领记 leaseExpiresAt＋generation 单调＋1**；到期不自动释放；孤儿须显式接管；接管后代数+1，旧持有者一切操作被拒。

```ts
// src/gateway/board-store.ts:306-341（节选）
async claim(taskId, input, options) {
  return this.mutate("board.claim", taskId, input, options, async (context) => {
    const existing = current.claim;
    if (existing && existing.leaseExpiresAt > context.now) throw new BoardClaimError("Board task is already claimed");
    if (existing && (current.sessionBinding || current.status === "active")) throw new BoardClaimError("Expired active claim is orphaned and requires takeover");
    if (current.status !== "open") throw new BoardClaimError("Only open board tasks may be claimed");
    const generation = Math.max(current.claimGeneration ?? 0, existing?.generation ?? 0) + 1;   // 单调所有权栅栏
    const claim = { claimantId: context.actor.actorId, /* … */ claimedAt: context.now,
      leaseExpiresAt: this.leaseExpiry(input.leaseTtlMs, context.now), generation };
    const next = parseBoardTask({ ...current, claimGeneration: generation, claim, /* … */ revision: current.revision + 1, updatedAt: context.now });
    context.emit("task.claimed", next, { claimGeneration: generation, /* … */ });
    return next;
  });
}
// renew/release：requireLiveOwnedClaim(current, principalId, input.claimGeneration, now)——代数对不上即拒
// takeover（:362-364）：仅过期 claim 可接管，const generation = current.claim.generation + 1;

// :560-562 孤儿判定：租约过期＋(绑着会话或 active)＝须显式接管，不当无人认领
isOrphaned(task, now = this.now()): boolean {
  return Boolean(task.claim && task.claim.leaseExpiresAt <= now && (task.sessionBinding || task.status === "active"));
}
```

PAO 对位：generation≈回执「尝试号」（既有红线：旧尝试回执只留档不推进）；leaseExpiresAt 记在运行器登记（运行期事实），不进卡协议字段。

## A-5 双宿主接管协议（ask/plan transport）

抄：**`open(): Handle|undefined` 回落协议＋`Symbol.for` 全局注册表**；plan 侧多一档「改后回传带期望版本号」。

```ts
// src/ask-transport.ts:24-55
/**
 * Optional transport registered by a host that wants to race an external Ask
 * surface against the local Pi TUI surface. Returning undefined declines the
 * request and leaves the native Ask path in control.
 */
export interface AskTransport {
  open(request: AskTransportRequest): AskTransportHandle | undefined;
}

const registryKey = Symbol.for("pi-maestro-flow.ask-transports");   // 同进程多包共享一个注册表，不依赖 import 关系

function registry(): AskTransportRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[registryKey] as AskTransportRegistry | undefined;
  if (existing) return existing;
  const created: AskTransportRegistry = { transports: [] };
  globals[registryKey] = created;
  return created;
}

export function registerAskTransport(transport: AskTransport): () => void {
  const state = registry();
  if (!state.transports.includes(transport)) state.transports.push(transport);
  return () => { /* disposer */ };
}
// AskTransportHandle: { promise: Promise<AskTransportResult>; cancel(reason): void }——竞速输家收到 cancel 清理
```

```ts
// src/plan-transport.ts:11-59（节选）
export type PlanTransportResult =
  | { status: "decision"; decision: PlanConfirmationDecision }
  | { status: "edited"; markdown: string; expectedRevision: number }   // 远程改后回传＋防编辑冲突
  | { status: "cancelled" };

export interface PlanTransport {
  open(request: PlanTransportRequest): PlanTransportHandle | undefined;   // undefined＝回落本地 TUI
}
```

## A-6 提交防连点（submit-gate，备查）

抄：文件头根因分析＋input 闸＋排队重放＋60s 兜底。**先核 pi 1.0.0 是否仍有该竞态，上游已修则不抄**；事件名按 1.0.0 核对。

```ts
// src/submit-gate/extension.ts:1-29（根因文档，原样保留价值最大）
/**
 * submit-gate extension entry — serializes idle submissions across the
 * pre-prompt window to prevent the "Agent is already processing a prompt"
 * single-flight assertion error in pi-agent-core.
 *
 * Root cause (pi-agent-core activeRun single-flight):
 *   AgentSession.prompt()'s busy check (`_isAgentRunActive`) only latches
 *   *after* the submission's async prelude (model auth / pre-submit auto
 *   compaction / extension events) finishes. Auto-compaction stretches this
 *   unlocked window to tens of seconds; a second idle submission during it
 *   slips past the isStreaming/isCompacting guards and reaches
 *   agent.prompt() concurrently, where the later one hits the activeRun
 *   assertion and throws.
 *
 * This extension gates at the `input` event (every session.prompt() passes
 * through it): after releasing one idle submission it sets `pending`, held
 * until `agent_settled` releases it; idle submissions during `pending` are
 * intercepted and queued, then replayed serially after `settled`; a 60s
 * timeout backstops submissions that fail inside the prelude so the gate
 * never deadlocks. Streaming submissions (steer/followUp) pass straight
 * through.
 */
```

```ts
// src/submit-gate/extension.ts:110-138（闸本体，节选）
pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
  if (event.streamingBehavior !== undefined) return { action: "continue" };  // 流式走内核队列，无此竞态
  if (event.source === "extension") return { action: "continue" };          // 自己重放的消息放行
  if (submissionPending) {
    queued.push({ text: event.text, images: event.images });                // 排队不丢弃
    ctx.ui.notify("上一条消息仍在压缩/收尾,本条已排队,完成后自动发送。", "info");
    return { action: "handled" };
  }
  armPending();   // 60s 超时兜底：前置阶段炸了也不死锁
  return { action: "continue" };
});
pi.on("agent_settled", () => releaseGate());   // 重放前先 re-arm，保持单飞
pi.on("session_shutdown", () => { clearTimeout(flushTimer); clearTimeout(timeoutTimer); queued.length = 0; });
```

## A-7 worker 回执（report schema 伴生）

抄：schema 与 agent 定义同目录伴生；正文内嵌同表兜底；「有 structured_output 工具恰好调一次，之后不再输出」；四态 status。

```markdown
<!-- .pi/agents/general-executor.md 关键段（Role/Input Contract 略） -->
## Process
…
6. **Report** — Produce the structured execution report:
   - Read `.pi/agents/general-executor-report.schema.json` … The inline schema
     reference below is authoritative if the file is unavailable.   ← 文件读不到时正文兜底
   - If the `structured_output` tool is available (the caller passed
     `outputSchema`), finish by calling it exactly once with the report JSON
     and emit nothing after it. Otherwise return the report JSON as your
     final answer.                                              ← 恰好一次＋之后静默

Rules:
- Field names must match EXACTLY (case-sensitive); no extra fields.
- `status` must reflect reality: `completed` only when every criterion passed;
  `completed_with_deviations` when something is unmet but the work is
  deliverable; `blocked` when you cannot proceed without user input;
  `checkpoint` when you reached a decision point needing guidance.

## Error Behavior
- **Verification failure**: attempt fix within scope (max 3 attempts); then report `completed_with_deviations` with details
- **Blocked** (missing context / ambiguous brief): report `blocked` and list exactly what you need
- **Checkpoint** (requires a decision): report `checkpoint` with the specific question
- **File conflict** (unexpected dirty changes): stop and report `blocked` — never overwrite unrelated work

## Constraints
- Never claim a test passed unless you ran it and saw it pass          ← 反谎报
```

```json
// .pi/agents/general-executor-report.schema.json（全文，draft-07）
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "General Executor Report",
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "summary"],
  "properties": {
    "task_id": { "type": "string", "minLength": 1, "description": "Caller-provided task identifier, echoed back." },
    "status": { "type": "string", "enum": ["completed", "completed_with_deviations", "blocked", "checkpoint"],
      "description": "completed: every criterion passed; completed_with_deviations: something unmet but deliverable; blocked: cannot proceed without user input; checkpoint: decision point reached." },
    "summary": { "type": "string", "minLength": 1, "description": "One-paragraph outcome of the execution." },
    "changes": { "type": "array", "items": {
      "type": "object", "additionalProperties": false, "required": ["path", "change_type", "summary"],
      "properties": {
        "path": { "type": "string", "minLength": 1 },
        "change_type": { "type": "string", "enum": ["created", "modified", "deleted", "moved", "untouched"] },
        "summary": { "type": "string", "minLength": 1 } } } },
    "verification": { "type": "array", "items": {
      "type": "object", "additionalProperties": false, "required": ["criterion", "result", "evidence"],
      "properties": {
        "criterion": { "type": "string", "minLength": 1 },
        "result": { "type": "string", "enum": ["pass", "fail", "not_run"] },
        "evidence": { "type": "string" } } } },
    "tests": { "type": "array", "items": {
      "type": "object", "additionalProperties": false, "required": ["command", "result", "output_summary"],
      "properties": {
        "command": { "type": "string", "minLength": 1 },
        "result": { "type": "string", "enum": ["pass", "fail", "skipped"] },
        "output_summary": { "type": "string" } } } },
    "deviations": { "type": "array", "items": { "type": "string" } },
    "notes": { "type": "array", "items": { "type": "string" } }
  }
}
```

## A-8 配方写法（team-lifecycle-v4）

抄：SKILL.md 薄路由（frontmatter＋固定 XML 区块＋外置 required_reading）；Role Registry 消息前缀；coordinator 的 MUST/MUST-NOT＋Entry Router＋Spawn-and-Stop；常驻 supervisor「孵化→消息唤醒→shutdown」三段。

```markdown
<!-- .pi/skills/team-lifecycle-v4/SKILL.md（节选） -->
---
name: team-lifecycle-v4
description: "… Triggers on \"team lifecycle v4\"."
allowed-tools: teammate Read Write Edit Bash Glob Grep observe maestro
disable-model-invocation: true
session-mode: none
---
<teammate_contract>
- background: false is the default. …
- Otherwise end the turn and wait for the automatic `teammate-complete`
  notification. …        ← 派完即停，靠回调唤醒
- Never silently ignore an unfinished dispatch.
</teammate_contract>
<required_reading>
~/.maestro/workflows/run-mode-lite.md      ← 执行手册外置，按需读
</required_reading>

## Role Registry
| Role    | Path                        | Prefix                          | Inner Loop |
|---------|-----------------------------|---------------------------------|------------|
| analyst | roles/analyst/role.md       | RESEARCH-*                      | false      |
| planner | roles/planner/role.md       | PLAN-*                          | true       |
| executor| roles/executor/role.md      | IMPL-*                          | true       |
| reviewer| roles/reviewer/role.md      | REVIEW-*, QUALITY-*, IMPROVE-*  | false      |
| supervisor | roles/supervisor/role.md | CHECKPOINT-*                    | false      |
```

```markdown
<!-- roles/coordinator/role.md（节选） -->
## Boundaries
### MUST
- Maintain session state (team-session.json) — sole writer; workers and supervisor read it only
- …
### MUST NOT
- Read source code or explore codebase (delegate to workers)
- Execute task work directly
- …
- Generate more than 5 worker roles

## Entry Router
| Detection | Condition | Handler |
|-----------|-----------|---------|
| teammate-complete notification | Message contains [role-name] | -> handleCallback (monitor.md) |
| Status check | Args contain "check"/"status" | -> handleCheck (monitor.md) |
| Manual resume | Args contain "resume"/"continue" | -> handleResume (monitor.md) |
| Pipeline complete | All tasks completed | -> handleComplete (monitor.md) |
| Interrupted session | Active session in {run_dir}/work/team/ | -> Phase 0 |
| New session | None of above | -> Phase 1 |

For callback/check/resume/adapt/complete: load @commands/monitor.md, execute handler, STOP.

## Phase 4: Spawn-and-Stop
1. Find ready tasks (pending + blockedBy resolved)
2. Spawn team-worker agents … 3. Output status summary 4. STOP
```

常驻 supervisor 三段（SKILL.md）：Phase 2 孵化一次（`Init: load baseline context, report ready, go idle`）→ 每个 CHECKPOINT 任务 `SendMessage({type:"message", recipient:"supervisor", …})` 唤醒核查 → 完工 `SendMessage({type:"shutdown_request"})`。崩溃恢复＝`recovery: true` 重孵化，从既有报告自动重建上下文。

## A-9 入库注入防线（K14）

抄：**正文与证据分字段的纯函数＋K14 铁律注释**；配一条「分离不可再接通」的测试。

```ts
// src/knowledge/extractor.ts:1-53
/**
 * K14: 窗口会话原始记录提取器（Pi 插件侧）。
 * …
 * 铁律 10：提取的 quote 按 untrusted 处理——只作为证据快照原料，
 * 绝不进注入/索引/LLM 上下文。
 */
export interface TranscriptBoundCandidate {
  /** Human-authored/distilled knowledge正文，绝不由 quote 自动填充。 */
  content: string;
  /** Window transcript descriptor，仅作为 --transcript-quote evidence 输入。 */
  transcriptQuote: string;
}

/**
 * Keep candidate正文 and raw window quote on separate fields. This pure helper
 * is used by the production handler and tested directly so future refactors
 * cannot accidentally route the quote into review/corpus content again.
 */
export function bindTranscriptEvidence(candidateContent: string, transcriptQuote: string): TranscriptBoundCandidate {
  if (!candidateContent.trim()) throw new Error("candidate content is required");
  const descriptor = JSON.parse(transcriptQuote) as Partial<TranscriptQuoteInput>;
  if (typeof descriptor.quote !== "string" || descriptor.quote.length === 0) throw new Error("transcript quote descriptor is invalid");
  return { content: candidateContent, transcriptQuote };
}
```

细节一并抄：证据提取原文优先、compaction 摘要仅回退、插件自定义数据永不当对话原文（`originalEntryText`/`derivedEntryText`）；sha256 指纹集去重（默认 8 条）；`truncateUtf8` 按码点截断不切多字节字符。

## A-10 护栏判定（permissions/policy.ts）

抄：四个独立纯函数＋逐段判定入口。**PAO 场景是 worker 护栏黑/白名单，不引入其权限引擎，只抄判定核**。

```ts
// :226-231 逐段判定：每段都命中 allow 才 allow；危险语法则通配全部失效
const exactWholeRule = …; // 逐字精确整命令规则永远有效（逃生门）
if (hasUnsafeShellExpansion(command, backslashEscapes)) return undefined;  // 含 $()`<> 的命令不吃通配
const allAllowed = segments.length > 0 && segments.every((segment) =>
  settings.allow.some((rule) => matchesRuleAgainstValue(rule, call, segment, cwd)));
```

```ts
// :397-434 命令拆段（引号内分隔符不误拆）
function shellSegments(command: string, backslashEscapes: boolean): string[] {
  const segments: string[] = []; let quote: "'" | '"' | undefined; let escaped = false; let current = "";
  const flush = () => { const value = current.trim(); if (value) segments.push(value); current = ""; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) { current += char; escaped = false; continue; }
    if (backslashEscapes && char === "\\" && quote !== "'") { current += char; escaped = true; continue; }
    if (quote) { current += char; if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      flush(); if ((char === "|" || char === "&") && command[index + 1] === char) index++; continue;
    }
    current += char;
  }
  flush(); return segments;
}

// :436-465 危险语法探测：反引号/重定向/$( / 未闭合引号 → 通配规则失效
function hasUnsafeShellExpansion(command: string, backslashEscapes: boolean): boolean {
  let quote: "'" | '"' | undefined; let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) { escaped = false; continue; }
    if (backslashEscapes && char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote === "'") { if (char === "'") quote = undefined; continue; }
    if (char === "'") { quote = "'"; continue; }
    if (char === '"') { quote = quote === '"' ? undefined : '"'; continue; }
    if (char === "`" || char === ">" || char === "<") return true;
    if (char === "$" && command[index + 1] === "(") return true;
  }
  return quote !== undefined || escaped;
}
```

```ts
// :264-297 文件路径多候选：相对＋绝对＋realpath（防 junction/symlink 指圈外）；win32 大小写不敏感（:186）
function fileSpecifierCandidates(value: string, cwd?: string, actual = false): string[] {
  const pathApi = pathFlavor(value, cwd);
  const input = pathForFlavor(value.trim(), pathApi);
  if (!cwd) return [portablePath(pathApi.normalize(input), pathApi)];
  const workspace = pathApi.resolve(pathForFlavor(cwd, pathApi));
  const absolute = pathApi.isAbsolute(input) ? pathApi.normalize(input) : pathApi.resolve(workspace, input);
  const candidates = new Set<string>();
  addPathPair(candidates, pathApi, workspace, absolute);
  if (pathApi === nativePathFlavor()) {
    const real = resolveRealPathCandidate(absolute, pathApi);
    if (real) {
      if (actual && !isWithinWorkspace(pathApi, workspace, real)) candidates.clear();  // 真实路径出圈＝全部拒绝
      addPathPair(candidates, pathApi, workspace, real);
    }
  }
  return [...candidates];
}
// resolveRealPathCandidate：从最深存在的目录逐层向上 realpathSync.native（通配符先切到边界再探），
// 保证「路径不存在」时也能解析出已存在前缀的真实路径。

// :377-380 glob→regex（仅 *，其余按字面）：
const source = pattern.split("*").map(escapeRegex).join(".*");
return new RegExp(`^${source}$`, ignoreCase ? "i" : undefined).test(value);   // ignoreCase＝win32
```

## B-1 goal 对照件

抄（对照 pi-goal-x 评估时用）：**预算仅显式**（`tokenBudget?: string` 可选、`parseTokenBudget` 不合规则拒）；**判定三态** pass/fail/inconclusive；**分账计数**——`verificationFailures`（存疑）与 `failStreak`（不过，界更宽）与 `infraErrorStreak`（审计员自身故障，绝不耗目标的失败预算）三个独立计数；验证结论只认 structured_output（无结构化输出＝inconclusive，永不判完成）。

```ts
// src/tools/goal.ts:56-110（节选）
type GoalStatus = "active" | "paused" | "done";

export interface ActiveGoal {
  id: string; text: string; status: GoalStatus;
  pauseReason?: PauseReason;       // waiting/verifying/verified/stopped/budget-limited/gate-blocked/error
  iteration: number;
  tokenBudget?: number;            // 仅显式提供时存在，无默认值
  tokensUsed: number; timeUsedSeconds: number; baselineTokens: number;
  verificationFailures?: number;   // 存疑（inconclusive）计数
  infraErrorStreak?: number;       // 审计员基础设施错误——单独立账，不耗目标失败预算，有界
  failStreak?: number;             // fail 判定计数——带可行动反馈，界更宽但有界
  lastVerificationFailure?: string;
}
// :723 预算触顶：tokensUsed >= tokenBudget → 停（budget-limited），等 /goal resume [--tokens N]
```

```ts
// src/tools/goal-verification.ts:289-315（节选）
let verdict: VerifierVerdict;
…
// The deprecated text fallback produced a verdict, but structured output is
// the Goal's only accepted verdict channel …（inconclusive, never a completion verdict）
verdict = { status: "inconclusive", reasoning: "Verifier returned no structured_output verdict." };
…
publishSupervisionVerdict(bridge, goal, verdict);   // 三态进统一监督事件总线
// pass: "Goal completion verified by the independent verifier."
// fail: `Goal verification failed: …`   inconclusive: `Goal verification inconclusive: …`
```

触发时机源码对位（防实施时再翻找）：`goal.ts:628` `onAgentEnd` 只记录尝试与恢复分型，**不验证**；验证与续跑循环在 `onAgentSettled`（`goal.ts:662` 起，整轮落定才进）；注册点 `extension/index.ts:4189-4210`——agent_end 收尾处理器按「Plan → Workflow 刷新 → Goal attempt → Todo」**逐子系统隔离**（每步独立 try/catch，失败按名字告警，一个子系统炸不拖垮其他收尾，这个 step 包装模式本身也值得抄）。工具侧 `goal({action:"complete"})`（`goal.ts:286`）内联触发同一验证。

## B-2 压缩检查点

抄：**检查点明细结构＋血缘链**；**丢结果留指针**（evidenceIndex＝被丢弃 toolResult 的 session:// 回执）；检查点只作恢复工件不进知识库（K10）；**双模型联动阈值**（session 与 summary 模型各推导、取更小、标 limiter；summary 模型窗口更小时按比例提前触发防「自托不下」）。

```ts
// src/compaction/maestro-compaction.ts:838-856（节选）
const evidenceIndex = mergeEvidenceReceipts(
  previousDetails?.evidenceIndex ?? [],
  collectEvidenceReceipts({
    sessionId: ctx.sessionManager.getSessionId(),
    branchEntries: event.branchEntries,
    firstKeptEntryId: dependencies.firstKeptEntryIdOverride ?? event.preparation.firstKeptEntryId,
  }),
);
return {
  kind: DETAILS_KIND, schemaVersion: DETAILS_VERSION,
  checkpointId,
  ...(previousDetails ? { previousCheckpointId: previousDetails.checkpointId } : {}),   // 血缘链
  sessionId: ctx.sessionManager.getSessionId(), projectRoot: ctx.cwd, createdAt: now.toISOString(),
  // …todo/goal/plan 快照、activeSkills、references、trigger 元数据
};
// 落盘 .workflow/recovery/compaction-checkpoints/KNW-<时间戳>-….md；K10：仅恢复工件，不入知识库
```

```ts
// src/compaction/compaction-threshold.ts:282-348（节选）
export function deriveLinkedCompactionThreshold(input): LinkedCompactionThresholdModel {
  const session = deriveCompactionThreshold({ …input.sessionContextWindow… });
  if (…summary 模型窗口缺失或过小…) return { ...session, limiter: "session" };
  const compaction = deriveCompactionThreshold({ …input.compactionContextWindow… });
  if (compaction.thresholdTokens < session.thresholdTokens) {
    // B2: summary 模型窗口 < session 窗口时，95% 阈值必然回退——
    // 按（summary 窗口×比例 − 输出预留 − 余量）提前触发，保证摘要请求自托得下
    const selfHostedTokens = Math.max(0, Math.floor(input.compactionContextWindow * SELF_HOSTED_CAPACITY_RATIO)
      - compaction.summaryReserveTokens - SUMMARY_CAPACITY_MARGIN_TOKENS);
    …return { …compaction, thresholdTokens: selfHostedTokens, reason: "self-hosted", limiter: "compaction" };
  }
  return { ...session, limiter: "session" };
}
```

## B-3 重试幂等（canonical payload＋receipt id）

抄：**canonical JSON（键排序＋剔除 requestId）→ sha256** 做 payloadHash 与回执 id；同 operationId 重放比对 payloadHash，不符报错；「结果未知」`outcomeUnknownAt` 一等状态；重启后 dispatching 态不可重放。

```ts
// src/gateway/operation-contracts.ts:81-124（节选）
/** Stable JSON with object keys sorted and transport request ids removed at every depth. */
export function canonicalGatewayOperationPayload(value: unknown): string {
  const visit = (candidate: unknown): string => {
    …
    if (candidate && typeof candidate === "object") {
      const entries = Object.entries(candidate as Record<string, unknown>)
        .filter(([key, child]) => key !== "requestId" && child !== undefined)     // 传输层 id 不进哈希
        .sort(([left], [right]) => left.localeCompare(right));                    // 键排序保证稳定
      return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${visit(child)}`).join(",")}}`;
    }
    …
  };
  return visit(value);
}
export function hashGatewayOperationPayload(value: unknown): string {
  return createHash("sha256").update(canonicalGatewayOperationPayload(value), "utf8").digest("hex");
}
export function buildGatewayOperationReceiptId(key: GatewayOperationReceiptKey): string {
  …  // canonical key 的 sha256＝回执 id
}
// 回执状态：prepared→dispatching→accepted→terminal | outcome-unknown（outcomeUnknownAt 可选字段）
// operation-receipt-store.ts:176-184：markOutcomeUnknown 幂等保留；启动栅栏——重启后 dispatching 态不可安全重放
```

## B-4 只拦不放行（hooks）

抄：**PermissionRequest runner 恒返回 undefined**（hook 输出永不构成授权）；hook 想放行只能给 `updatedInput` 或建议加规则，经权限引擎重评；**config hash 信任账本**（path→hash，内容一变即失信）。

```ts
// src/hooks/pi-adapter.ts:280-300
const requestPermission = async (call, ctx, suggestion, _forced): Promise<undefined> => {
  const names = toolMatchValues(call.toolName);
  await execute("PermissionRequest", names, {
    …tool_input: call.input,
    permission_suggestions: [{ type: "addRules", rules: […suggestion…],
      behavior: "allow", destination: "localSettings" }],   // hook 只能「建议」加规则（写本地），不能直接放行
  }, ctx);
  return undefined;                                          // 恒 undefined＝永不授权
};
```

```ts
// src/hooks/trust.ts:15-34
export async function isHookConfigTrusted(trustFilePath, configPath, hash): Promise<boolean> {
  const trust = await readTrustFile(trustFilePath);
  return trust.trusted[trustKey(configPath)] === hash;       // 内容哈希对不上＝不信任
}
export async function trustHookConfig(trustFilePath, configPath, hash): Promise<void> {
  await serializeMutation(trustFilePath, async () => {
    const trust = await readTrustFile(trustFilePath);
    trust.trusted[trustKey(configPath)] = hash;              // 人工审过记 hash；文件一变自然失效
    await writeTrustFile(trustFilePath, trust);
  });
}
```

## B-5 影子双跑（classifier）

抄：**三模式 off/shadow/jev**（规则→影子→转正的生命周期）；**规则 terminal 语义**（命中即终判，unknown 才升级）；影子对写 jsonl 供离线对比。

```ts
// src/classifier/extension.ts:8-24（头注释）
 *   2. when enabled, each registered domain obeys its mode:
 *      - `off`    — L0 rules only (identical to today);
 *      - `shadow` — rules decide; JEV judges the same input in the background
 *                   and the pair is appended to
 *                   `~/.maestro/classifier/shadow/<date>.jsonl` for offline eval;
 *      - `jev`    — async callers escalate non-terminal rule results to JEV.
```

```ts
// src/classifier/domains.ts:22-40
export const signalTypeDomain: ClassifyDomain<CandidateType, SignalTypeInput> = {
  name: "signal-type",
  modes: ["off", "shadow", "jev"],
  rules(input) {
    const label = classifyCandidateType(input.text);       // L0 关键词规则
    return { label, terminal: label !== "unknown" };       // 命中即终判；unknown 才升级
  },
  …
};
```

## B-6 不自我提权（restrictUntrustedProjectPermissions）

抄：**仓库内声明只保留收紧面**——allow 整体忽略并告警、defaultMode 只接受 default/plan/dontAsk（弱化方向）、deny/ask/disableBypass 放行；「总是允许」只写本地（`controller.ts:177-185`）。

```ts
// src/permissions/settings.ts:169-191
function restrictUntrustedProjectPermissions(source, filePath, warnings) {
  if (!source) return source;
  const restricted = {
    ask: source.ask ?? [],
    deny: source.deny ?? [],
    ...(source.disableBypassPermissionsMode ? { disableBypassPermissionsMode: source.disableBypassPermissionsMode } : {}),
  };
  if (source.allow?.length) {
    warnings.push(`${filePath}: project allow rules were ignored; approve them into local settings first`);
  }
  if (source.defaultMode === "default" || source.defaultMode === "plan" || source.defaultMode === "dontAsk") {
    restricted.defaultMode = source.defaultMode;
  } else if (source.defaultMode) {
    warnings.push(`${filePath}: project defaultMode ${source.defaultMode} was ignored because it weakens permissions`);
  }
  return restricted;
}
```

---

*汇编：2026-10-07，来源包 pi-maestro-flow@0.31.3（MIT）。临时副本删除后本文为唯一代码依据；实施时若上游发新版，以函数名对位，不迷信行号。*
