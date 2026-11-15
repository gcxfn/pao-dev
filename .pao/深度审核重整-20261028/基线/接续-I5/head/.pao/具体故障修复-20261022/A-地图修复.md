# A 地图修复报告

主控整合补核：项目可以位于Git仓库子目录，单排除仓库根`.pao`会遗漏`<子项目>/.pao`。已在共享采集入口按真实项目路径补入该编排区，跨工作树时不把仓库外路径误当排除项；新增真实Git子项目测试验证控制写入不失效、业务改动仍失效。最终证据见`A-nested-project.json`及整合报告。

## 结论

批次 A 已完成。地图采集在共享入口统一排除 `.git` 和 `.pao`，控制文件、任务卡、回执及流程实例反复变化不会使业务地图失效；覆盖范围内的真实业务内容变化仍返回 `stale_map`。文件摘要、Git 身份、覆盖范围确认、`mapDigest` 与冻结/验签保护均保留。

活动基准模板也已修正：四节点不再把流程实例或卡目录当业务输入、成果或机械验收；侦察与规划通过结构化节点地图交接；部长和主控的激活说明改为提交后结束本轮，由后台结果或监督唤醒。未启动真实模型、真实四部门闭环或正式 PAO_HOME。

## 经过

先通过代码图核实 `captureDispatchMap` 的直接调用方和调用链，再核对源码。地图新建、工具入口、预检、冻结、验签和工作流部长入口都汇入 `captureDispatchMap()`，因此在 `dispatch-brief/workspace.ts` 收口即可覆盖共享路径，未修改 `workflow/minister.ts`。

实现后新增定向测试，并补强显式控制路径覆盖。测试首次使用成员包内不存在的 `node_modules/vitest` 路径，命令在加载阶段失败；随后改用仓库已有的 `PAO/node_modules/vitest/vitest.mjs`，测试实际通过。此失败命令没有产生测试结果。

活动模板的只读复核发现旧故障确实来自 `.pao/benchmark/工作流实例-基准开发流水线.md`、卡目录和控制正本。用户随后授权修改两份活动正本，修改前已完整复制到本批 `before/benchmark/`，历史运行、源码冻结和构建数据未改。

离线模板验证脚本首次使用了 PowerShell 只读变量 `$home`，在脚本赋值处失败，未执行建部或 SDK 装载。将变量改为任务专用 `$isolatedPaoHome` 后，建部和三角色工具装载均实际通过。

新增的激活钩子直执行检查第一次失败，原因是临时模拟器没有提供 SDK 会话启动前已经存在的默认工具，暴露出的实际结果缺少 `pao_minister_save_node_map`。核对内核注册与白名单后，活动扩展的部长必需工具补入保存节点地图、审核工人和监督确认，主控也显式保留监督确认，不再依赖默认工具列表偶然存在。随后在全新隔离目录完成端到端离线验证。

## 做了什么

### 地图源码

- [workspace.ts](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/dispatch-brief/workspace.ts)：新增 `IMPLICIT_PROJECT_EXCLUDES = [".git", ".pao"]`，由 `normalizeExcludes()` 合并调用方排除项和隐式项。`captureDispatchMap()` 统一使用，并在 `coverage.excludes` 明示默认边界。
- 保留调用方额外 `excludes`、业务文件快照、`scopeConfirmed`、`scopeBasis`、`mapDigest`、Git 身份和覆盖范围重核。
- 旧地图若原 `coverage.excludes` 没有 `.git`、`.pao`，会因覆盖范围变化判定 stale，需重建一次。这是保护逻辑的预期迁移行为。

### 地图测试

- [dispatch-brief-artifacts.test.ts](D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/dispatch-brief-artifacts.test.ts)：新增项目根边界回归。
- 验证 `coverage: ["."]` 时只收录业务文件，排除 `.git/` 和 `.pao/`。
- 显式覆盖 `["src/caller.ts", ".git/HEAD", ".pao"]` 时也只保留 `src/caller.ts`，直接复刻旧故障形态。
- 连续改写流程实例、创建并暂存 `.pao` 任务卡后，预检仍有效；改写 `src/caller.ts` 后返回 `stale_map`。

### 活动基准模板

- [kit.json](D:/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020/benchmark/organized-post/kit.json)：四节点 `输入` 改为空数组，移除对流程实例的依赖。侦察和规划通过 `pao_minister_save_node_map` 保存结构化业务地图，`zero_cards_reason` 只解释零卡。实施卡不把流程实例、卡目录或编排控制文件作为业务输入、成果或机械验收；审核只核对业务改动与证据。
- [activate-tools.mjs](D:/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020/benchmark/organized-post/activate-tools.mjs)：保留角色工具白名单，并显式激活部长保存节点地图、审核工人、监督确认，以及主控监督确认。部长提交工作卡或结束拆解后立即结束本轮，主控启动后立即结束本轮。说明明确禁止 `sleep`、轮询或持续等待，收到后台结果或监督后实际检查证据再处理。
- 修改前副本：[kit.json](D:/AI/workspace/pao-dev/.pao/具体故障修复-20261022/before/benchmark/kit.json)、[activate-tools.mjs](D:/AI/workspace/pao-dev/.pao/具体故障修复-20261022/before/benchmark/activate-tools.mjs)。复制时源文件与副本 SHA-256 分别一致：`5C0D9006D3A8F6990…`、`DD33AE2C18B8CF279…`。

### 基准配方问题与历史边界

实际故障样本曾收录 `.git/HEAD`、`.git/config`、`.git/index` 和 `.pao/benchmark/工作流实例-基准开发流水线.md`。当前活动生成源已修上述两文件；历史冻结样本仍保留旧内容，仅作证据：

- `.pao/地图简报与部门协作-20261020/benchmark/real-run-20261022-r3/stop-evidence/.../recipes/*`
- `D:/AI/workspace/临时文件夹/PAO三题复测-20261022/offline-20261022-113023/home/工作流/基准开发流水线.md`

未修改 `real-run-*`、`source-freeze-*`、`build-data-*` 或冻结样本。后续运行应由活动模板重新生成新现场，不能回写历史成绩。

## 实际验证

以下命令均在 `D:/AI/workspace/pao-dev/PAO/packages/coding-agent` 执行，Node 为 `C:/Program Files/nodejs/node.exe`。

| 检查 | 命令 | 结果 |
|---|---|---|
| 地图与持久化回归 | `node ../../node_modules/vitest/vitest.mjs run test/pao/dispatch-brief-artifacts.test.ts` | 通过，25/25 |
| 简报准备回归 | `node ../../node_modules/vitest/vitest.mjs run test/pao/dispatch-brief-prepare.test.ts` | 通过，11/11 |
| 类型检查 | `node ../../node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit` | 通过，无输出 |
| 差异格式 | `git diff --check -- packages/coding-agent/src/pao/dispatch-brief/workspace.ts packages/coding-agent/test/pao/dispatch-brief-artifacts.test.ts`（在 `PAO/` 执行） | 通过 |
| 活动脚本语法 | `node --check .pao/地图简报与部门协作-20261020/benchmark/organized-post/activate-tools.mjs`（在项目根执行） | 通过 |
| 配方真实解析 | 使用现有 `dist/pao/workflow/recipe.js` 的 `parseRecipe` 解析由 `kit.json` 生成的配方文本 | 通过：版本 2、四节点拓扑序、四节点输入均为空、自动执行 true、审核 true |
| 激活钩子执行 | 在临时目录执行 `verify-activation-hook.mjs`，直接触发活动扩展的 `session_start` 与 `before_agent_start` | 通过：部长与主控注入文本均含“立即结束本轮”和“后台结果与监督会唤醒你”，旧持续等待语句不存在；部长实际 active 列表含保存地图、审核工人和监督确认，主控含监督确认 |
| 隔离组织与工具装载 | 在全新临时目录执行 `A-template-offline-20261022-1605/run.ps1`：真实建部与配方 API，分别以 `owner`、`minister`、`worker` 身份装载 SDK 工具，再执行激活钩子 | 通过：四部门、版本 2、预检 `canStart: true`；三角色工具装载和激活钩子均成功；脚本设置 `PI_OFFLINE=1`、禁止网络，未启动模型或 RPC |

另检查 `kit.json` 的活动结构：四部门、四节点，四个 `输入` 都为空，且不包含旧流程实例路径或旧卡目录机械命令。

未安装依赖，未运行付费模型，未使用正式 PAO_HOME，未执行真实四部门闭环。注入文本和离线工具激活已实际验证；真实后台结果投递、监督时钟唤醒和四部门闭环仍未运行，由后续 G 批次覆盖。离线 SDK 装载与钩子执行通过不代表这些动态集成已运行成功。临时目录中的脚本、隔离现场和证据保留作复核，不放入源码或正式运行数据。

## 待决策

无。旧地图需在对应现场重建一次，才能带上新的默认排除边界。
