# 部门简介动态提示词实施报告

日期：2026-10-24。任务：复用既有每轮部门名单注入入口，把部门名称、职责简介与必要标签放入原 `pao_dept_registry` section。

## 结论

- 已完成实现、返修和定向验证。主控每轮通过既有 `before_agent_start` 入口读取当前注册表及配方，不新增提示入口、配置字段、缓存或第二份部门名单。
- 职责简介直接复用 `readDeptCatalog` 已解析的配方「人设」；同一 section 每轮替换，部门修改、增加或移除均在下一轮生效。
- 静态目录只陈述名称、人设可读性和注册表标签，不自行判断任务、预算或权限是否允许派发；目录问题保留自身归属，不会扩散到其它部门。
- 格式检查和 dept 定向测试全部通过（4 个测试文件、59 项）。生产包类型检查通过；仓库根整体类型检查仍因既有测试与桌面配置报错失败。

## 变更路径与实现

| 路径 | 变更 |
| --- | --- |
| `PAO/packages/coding-agent/src/pao/dept/catalog.ts` | 把 `RECIPE_FILE_NAME` 定义移到 catalog，避免 render 复用 catalog 时形成循环依赖；文件名不变。 |
| `PAO/packages/coding-agent/src/pao/dept/render.ts` | `renderRegistryFromHome` 改用 `readDeptCatalog`，在原 section 渲染部门名、人设、注册表标签及真实读取失败状态。保留旧 `renderRegistrySnapshot` 与 `renderRegistryText` 接口。 |
| `PAO/packages/coding-agent/src/pao/dept/index.ts` | 区分缺少 PAO_HOME 与已有 PAO_HOME 但渲染异常：前者沿用跳过行为，后者明确报告读取失败。仍只使用原 `pao_dept_registry` section。 |
| `PAO/packages/coding-agent/test/pao/dept-tools.test.ts` | 通过真实 `registerDeptTools` 注册的 `before_agent_start` 验证动态读取、刷新、移除、空名单、未填写人设、缺配方、读取失败、重名问题不扩散和提示内容边界；测试隔离目录使用仓库通用的 `tmpdir()`。 |

返修后的完整任务差异：`final-increment.patch`。独立修改前文件在 `before/`，校验值在 `baseline-sha256.txt`。既有未提交的 `pao/index.ts` 文件和 `dept-recipe.test.ts` 修改均未重置，且不计入本次差异。

实现复用 `registerDeptTools` 的原 `before_agent_start` 事件与原 `pao_dept_registry` section，没有新建平行注入机制。每行只输出部门名、人设原文和注册表已有标签（有才输出）；没有输出完整配方、工具清单、技能全文、知识库或历史。

人设缺失或仍是 `<待填...>` 时标为「未填写」；配方缺失或不可读时标为「不可读取（配方缺失或不可读）」，但不会据此推断派发资格。注册表不存在是明确的空名单；注册表路径存在但无法读取时明确说「部门名单读取失败，不能视为没有已登记部门」。渲染只读取 catalog 中归属为 `（注册表）` 的注册表失败项，重名等归属于具体部门的目录问题不会扩散成全局问题。原 section 名整体赋值，所以下一轮直接替换旧内容，不会累积已移除部门。

工人边界未改动：`WORKER_SKIPPED_MODULES` 仍包含 `dept`，工人不注册此模块或名单提示。

## 验证证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 修改文件格式检查 | 通过，退出码 0 | `biome check` 覆盖 4 个修改文件 |
| dept 定向测试 | 通过，退出码 0 | 4 个测试文件、59 项测试全部通过 |
| 生产包类型检查 | 通过，退出码 0 | `tsconfig.build.json`，日志为空 |
| 仓库根整体类型检查 | 失败，退出码 1 | `types-root.log`，90 行既有报错；不含本次 dept 文件 |

命令、工作目录和结果详见 `repair-validation.log`。返修轮按项目固定版本 Biome 检查了 4 个修改文件，重跑 dept 的 4 个测试文件（59 项）和生产包类型检查，结果分别通过。测试按仓内通用做法使用 `tmpdir()` 下的独立 PAO_HOME，并由 `afterEach` 清理；不依赖一次性任务目录。这是自动化模拟验证，不是正式运行数据上的集成验证。

## 未验证与限制

- 未在正式 PAO_HOME、真实模型端点、桌面应用或 r11 运行中验证；未发送模型请求、未跑 Docker、未跑全库测试、未重新评分。
- 根类型检查的既有失败不在本任务写入范围，未修改相关文件。`types-build.log` 是本次生产包类型检查的零字节空日志，用于证明退出码 0。
- 未提交 Git，未清理其它任务或既有未提交修改。

## 写入边界核对

- 本轮业务代码只改 `PAO/packages/coding-agent/src/pao/dept/` 的三个必要文件，测试只改 `PAO/packages/coding-agent/test/pao/dept-tools.test.ts`。
- 独立 baseline 还保存了 `dept-catalog.test.ts` 与既有未提交的 `pao/index.ts` 供安全比对；两者没有在本轮写入。
- 未触碰 r11、历史冻结运行、官方题目、正式 PAO_HOME 或用户主目录配置。没有使用主目录初始化。测试隔离目录已清理，任务留档保留。

## 返修记录

主对话审核指出两项问题：初版将未匹配单部门名称的阻止项扩散到所有部门，并把静态 catalog 当成运行时派发资格；测试还依赖一次性任务目录。返修删除了 `blockingByDept`、`commonBlockers` 和派发状态推断，只渲染简介事实；测试改用 `tmpdir()`，并新增两个注册表行共用目录的重名场景，确认问题不扩散到其它部门，也不生成派发资格文案。

返修前实现保存在 `implementation.patch`，`repair-before/` 是返修过程中的中间快照。返修后的完整任务差异在 `final-increment.patch`，从 `PAO/` 仓库导出的当前仓库差异在 `final-implementation.patch`，四个最终文件校验值在 `final-sha256.txt`。早期 `before/` 与 `baseline-sha256.txt` 原样保留。

