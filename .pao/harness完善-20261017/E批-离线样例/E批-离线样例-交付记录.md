# E6 离线样例与端到端最小链路 —— 交付记录

> task-12 / E6。写范围：`PAO/packages/coding-agent/test/pao/e-batch-sample.test.ts`、`.pao/harness完善-20261017/E批-离线样例/`
> 任务规则：只写 test 与样例目录，**未改 src/ 下任何源码**。

## 一、结论

E 批离线样例仓与端到端最小链路已建立，**14 个用例全部通过**，`tsc -p tsconfig.build.json --noEmit` 干净。

计划 §5.3/§5.4 点名的六件事全部有可执行断言覆盖：一次受理（可查回）、部分成功、真实拒绝原因、
重复提交（回填首次真实身份且不重复派发）、停止后旧结果失效、中途改要求。

**没有发现缺陷。** lead 特别要求的「duplicate 必须回填首次真实卡号/卡路径/尝试号」这条硬要求，
经核查 E3 已真实满足：`accept.ts:248-266` 的 `duplicateOutcome()` 从账本条目回填 `cardNo`/`cardPath`/`attempt`，
并且 `duplicateOf` 上挂一份首次的 `accepted` 结果。测试按 lead 要求**严格断言**，未放宽。

## 二、新增文件清单

| 文件 | 说明 |
|---|---|
| `PAO/packages/coding-agent/test/pao/e-batch-sample.test.ts` | 端到端最小链路测试（14 用例） |
| `.pao/harness完善-20261017/E批-离线样例/E批-离线样例说明.md` | 总说明：用法、逐文件用途、能证明/不能证明、F 批扩展建议 |
| `.pao/harness完善-20261017/E批-离线样例/E批-离线样例-交付记录.md` | 本文件 |
| `.pao/harness完善-20261017/E批-离线样例/启动区-README.md` | 启动区布局与设计取舍 |
| `.pao/harness完善-20261017/E批-离线样例/启动区-PAO_HOME/部门/注册表.md` | 样例部门名单（3 部门） |
| `.pao/harness完善-20261017/E批-离线样例/启动区-PAO_HOME/部门/{写作,审查,只读审查}/配方.md` | 三份样例配方（工具/技能分两行） |
| `.pao/harness完善-20261017/E批-离线样例/启动区-PAO_HOME/部门/*/知识库/**` | 六目录 + 四子索引 + 索引门面（`createDept` 生成） |
| `.pao/harness完善-20261017/E批-离线样例/启动区-PAO_HOME/pao配置/档位.json` | 快/主力两档，假 provider |
| `.pao/harness完善-20261017/E批-离线样例/启动区-PAO_HOME/pao配置/skills/小说文风校准/SKILL.md` | 样例技能 |
| `.pao/harness完善-20261017/E批-离线样例/启动区-项目/README.md` | 样例项目根说明 |
| `.pao/harness完善-20261017/E批-离线样例/启动区-项目/.pao/.gitkeep` | 编排目录占位 |
| `.pao/harness完善-20261017/E批-离线样例/启动区-项目/正文/文风基线.md` + `.gitkeep` | 判定依据 + 产出落点 |
| `.pao/harness完善-20261017/E批-离线样例/启动区-项目/待审查稿/第一章-旧桥-v1.md` + `只读目录说明.md` | 只读审查输入 |

## 三、测试用例清单与结果

| # | 用例 | 覆盖点 | 结果 |
|---|---|---|---|
| 1 | 三个样例部门齐备，工具与技能分家，档位解析到配方，校验零问题 | 前置：部门目录干净 | pass |
| 2 | 样例技能 SKILL.md 是真实文件，文风基线与被审稿都在项目里 | 前置：夹具完整 | pass |
| 3 | 受理写作部门第一步，返回真实卡号与卡路径，卡内容与请求一致 | ① 一次受理 + 可查回 | pass |
| 4 | 部门未登记的那条被真实预检拒绝，另一条正常受理，`partial` 为真 | ② 部分成功 + 真实拒绝 | pass |
| 5 | 依赖卡未放行时如实报 `deferred`，原因点名依赖卡号 | ② 真实原因（排队语义） | pass |
| 6 | 请求形状不全时被真实拒绝，原因逐条列出缺什么，且不建卡 | ② 真实拒绝（形状） | pass |
| 7 | 第二次提交返回 `duplicate`，回填首次卡号/卡路径，卡文件数不变 | ③ 重复提交 | pass |
| 8 | 重复提交不重复派发：派发通道只被调用一次 | ③ 不重派 | pass |
| 9 | 受理后把卡置为 `canceled`，`isIntakeOutcomeStale` 由 false 变 true | ④ 停止后失效 | pass |
| 10 | 卡文件被删掉后旧结果同样判失效 | ④ 查不到不许说成功 | pass |
| 11 | 改后的卡能查回新目标与新约束，旧结果不再当当前依据 | ⑤ 中途改要求 | pass |
| 12 | 改要求后卡进了新一轮尝试时旧结果判失效 | ⑤ 尝试号比对 | pass |
| 13 | 所有夹具路径都在临时根下，未指向正式 PAO_HOME | 边界自检 | pass |
| 14 | 受理全程没有留下运行产物：卡目录在临时根内 | 边界自检 | pass |

## 四、真实运行的命令与输出

### 4.1 端到端样例测试

```powershell
cd D:\AI\workspace\pao-dev\PAO\packages\coding-agent
pnpm exec vitest --run test/pao/e-batch-sample.test.ts
```

```
 RUN  v4.1.11 D:/AI/workspace/pao-dev/PAO/packages/coding-agent

 ✓ test/pao/e-batch-sample.test.ts > E 批离线样例：部门目录在真实校验下是干净的 > 三个样例部门齐备，工具与技能分家，档位解析到配方，校验零问题 41ms
 ✓ test/pao/e-batch-sample.test.ts > E 批离线样例：部门目录在真实校验下是干净的 > 样例技能 SKILL.md 是真实文件，且文风基线与被审稿都在项目里 33ms
 ✓ test/pao/e-batch-sample.test.ts > ① 一次受理小说第一步：拿到卡号与尝试号，能按卡号查回该卡 > 受理写作部门第一步，返回真实卡号与卡路径，卡内容与请求一致 58ms
 ✓ test/pao/e-batch-sample.test.ts > ② 批量两条（写作 + 只读审查）：部分成功，拒绝原因来自真实预检 > 部门未登记的那条被真实预检拒绝，另一条正常受理，report.partial 为真 64ms
 ✓ test/pao/e-batch-sample.test.ts > ② ... > 依赖卡未放行时被如实报为 deferred（卡已建、此刻不派），原因点名依赖卡号 62ms
 ✓ test/pao/e-batch-sample.test.ts > ② ... > 请求形状不全时被真实拒绝，原因逐条列出缺什么，且不建卡 37ms
 ✓ test/pao/e-batch-sample.test.ts > ③ 同一请求判据重复提交：不新建卡，返回第一次的真实身份 > 第二次提交返回 duplicate，回填首次卡号/卡路径，卡目录文件数不变 59ms
 ✓ test/pao/e-batch-sample.test.ts > ③ ... > 重复提交不重复派发：派发通道只被调用一次 56ms
 ✓ test/pao/e-batch-sample.test.ts > ④ 停止一条后旧受理结果被判失效 > 受理后把卡置为 canceled，isIntakeOutcomeStale 由 false 变 true 64ms
 ✓ test/pao/e-batch-sample.test.ts > ④ ... > 卡文件被删掉后旧结果同样判失效（查不到就不许说成功） 60ms
 ✓ test/pao/e-batch-sample.test.ts > ⑤ 中途改要求：卡已有受理结果后改目标/追加约束 > 改后的卡能查回新目标与新约束，旧受理结果不再被当作当前要求的完成依据 57ms
 ✓ test/pao/e-batch-sample.test.ts > ⑤ ... > 改要求后卡进了新一轮尝试（尝试号变化）时旧受理结果判失效 53ms
 ✓ test/pao/e-batch-sample.test.ts > 样例边界自检：不碰正式 PAO_HOME、不 spawn > 所有夹具路径都在临时根下，且没有指向正式 PAO_HOME 40ms
 ✓ test/pao/e-batch-sample.test.ts > 样例边界自检：不碰正式 PAO_HOME、不 spawn > 受理全程没有留下运行产物在仓库里：卡目录在临时根内，开始与结束都是隔离的 70ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  11:32:37
   Duration  1.75s
```

### 4.2 类型检查

```powershell
pnpm exec tsc -p tsconfig.build.json --noEmit
```

```
[tsc exit=0]     ← 无任何错误输出
```

> 首跑时曾出现 `src/pao/dept/catalog.ts(273,15): error TS2304: Cannot find name 'isAbsolute'`。
> 核查：该文件 `LastWriteTime` 与我的 tsc 运行同分钟（11:32:47），是同僚并发写入的**瞬时中间态**；
> 同文件 17 行 import 与 273 行用法均存在，重跑后 exit=0。**不是我的代码问题**，也不是真实缺陷。

### 4.3 仓库无残留 / 编码校验

```powershell
# PAO 是独立 git 仓（根 .gitignore 第 2 行 /PAO/ 忽略整个目录），故在其仓内查状态
cd D:\AI\workspace\pao-dev\PAO
git status --short -- packages/coding-agent/test/pao/e-batch-sample.test.ts
# → ?? packages/coding-agent/test/pao/e-batch-sample.test.ts     （仅新增该文件，无运行产物）

# U+FFFD 字节级校验（我的 29 个文件）
files with U+FFFD: 0 / checked 29
```

## 五、样例能证明 / 不能证明的边界

**能证明**（详见 `E批-离线样例说明.md` 第四节，12 条）：受理身份真实回填、可查回、部分成功与真实拒绝原因、
duplicate 回填首次身份且不重派、停止与删卡后旧结果失效、中途改要求的可见性与旧结果处置、部门目录校验零问题、
隔离性（全部在临时根、无仓库产物）。

**不能证明**（详见说明第五节，7 条）：真实模型行为、真实子进程（派发为替身）、Electron 界面、
工作流实例语义（样例均为普通卡）、改要求走的是正本读写而非公开工具、审查打回→改稿的业务闭环内容流转、
只读目录写入拒绝的断言。

## 六、过程中的偏差与修正（如实记录）

首跑 13 用例中 5 个失败，**全部是我假设的内核 API 与真实实现不符**，已按真实实现改正，无一处放宽断言：

1. `changeCardStatus(card, { status })` → 真实签名 `changeCardStatus(card, { 操作者, to, 时间, 依据?, 失败类型?, 尝试上限? })`。
   同时确认状态机 `unclaimed → canceled` 是合法迁移，且 `to === "canceled" && 操作者 === "用户"` 不要求 owner 匹配
   （`statemachine.ts:99`），正好对应「用户停止」。
2. `patchDispatch(...)` **不存在**（全 src 检索无此符号）。内核当前没有「改进行中卡的目标」的公开工具；
   改为正本读写 `readCard → 改 frontmatter → serializeCard → writeFileSync`，并在测试与说明里显式注明这是模拟 owner 改卡。
3. 依赖未放行我原以为返回 `rejected`，真实是 **`deferred`**（`accept.ts:226-232` 排队语义：卡已建、此刻不派）。
   已改为按真实语义断言，并补验「原因点名前置卡号」。
4. `PreflightItem` 的字段是 `level`（值 `"阻止启动"|"可排队"|"警告"|"未验证"`），不是 `级别`。

这 4 条都是「样例写错」而非「内核有缺陷」，因此不作为缺陷上报。

## 七、给 F 批的扩展建议

见 `E批-离线样例说明.md` 第六节，要点：接回放式 provider 验内容流转；补工作流实例样例；
补只读目录写入拒绝断言；补同判据并发受理；补账本损坏场景。`启动区-*` 目录就是 F 批的起点，可直接在其上追加。

## 八、lead 裁定落实（2026-10-17，task-12 revision 5 认收后）

lead 逐条裁定三个待决点，本条记录落实结果。**纯文档改动，未改任何测试与源码，故未重跑测试。**

### 裁定 1：中途改要求 —— 本轮不立项，但把「非法」写透

lead 事实核对结论与我一致：`src/pao/` 下确实没有 `patchDispatch` 之类改进行中卡目标的公开入口；
现有通道只到 `cards/statemachine.ts:188 changeCardStatus(card, input)`（状态迁移 + 单写者校验），
**改目标正文没有状态机保护**。

已在 `E批-离线样例说明.md` 第五节第 5 条按要求写透三点：
1. 这是**绕过状态机**的测试替身，不是产品用法；
2. 真实产品里 owner 改卡必须经状态机/单写者校验，本样例**不代表那条通道已存在**；
3. 「改要求是否有正式通道」列为 **E 批已知缺口**，建议 F 批或后续单独立项；
   在那之前**不得把「改要求已实现」写进任何执行记录**。
另补充了缺口应含的内容：改目标要留痕、要参与版本/尝试号语义、要与 `isIntakeOutcomeStale()` 的失效判定对齐。

### 裁定 2：只读目录属性 —— 本轮不补，理由写清

lead 指出计划 §5.3 的字面要求是「**只读部门能对某目录产出审查意见**」，不是「文件系统写保护被拒」。
我已用两条证据验到该要求的可执行落点：① 只读审查部门配方只含 `read/grep/find/ls`，无 `write`/`edit`；
② 该部门对 `待审查稿/` 出了带行号定位的审查意见结构与判定结论。
文件系统 chmod 只读 + 写入拒绝属另一件事（边界防护），且 Windows 上 `chmod` 语义与清理代价都不小 → 本轮不做。

已在说明文件中落位：
- 第五节第 7 条改写为「**只读目录的写入拒绝断言本轮不补**（裁定：留给 F 批）」，并写明理由；
- 第六节第 3 条明确标注「**F 批待补：只读目录写入拒绝断言**（本轮不做，理由见第五节第 7 条）」。

### 裁定 3：F 批扩展建议 —— 采纳

四条（回放式 provider 验内容流转 / 工作流实例样例 / 同判据并发受理 / 账本损坏场景）**全部进 F 批**；
`启动区-*` 目录作为 F 批起点直接追加、不重构。
已在说明第六节顶部加标注「以下四条已由 lead 裁定全部采纳进 F 批（2026-10-17 裁定 3）」，
并把「只读目录写入拒绝」升为 F 批待补项。本轮**未写任何 F 批代码**。

### 附加要求：E1「技能/工具分家」样例侧证据

已写入 `E批-离线样例说明.md` 第三节（引文段落）：

> 样例使用的三个部门配方（写作／审查／只读审查）均为 `- 工具:` 与 `- 技能:` **两行分写**，
> `validateDeptCatalog()` 对其返回**零问题**。

并附了可查细节：对应用例名、具体断言（`工具` 为内置白名单且 `内置 === true`、
`技能` 解析到 `pao配置/skills/小说文风校准` 且 `可用 === true`、`混写技能名 === []`、`validateDeptCatalog() === []`）。
这条可直接进总册。

### 编码校验

改动后对 `.pao/harness完善-20261017/E批-离线样例/` 全部文件做 U+FFFD 字节级校验：**0 处**（见下）。

```
U+FFFD files: 0 / total 30
U+FFFD in test file: 0
```
