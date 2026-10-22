# D 盘点修复报告

主控整合补核：发现最终缺省根仍回落`../..`，会误判平铺`.pao/卡`及深层临时计划现场。已按真实卡路径相对归属项目的`.pao`层级使用共享解析结果；非标准布局仍保留显式根及旧缺省用法。新增两项真实Git项目根检查，`D-layout-main-rerun.json`16项通过。首次因新增测试漏导入`realpathSync`失败，修正导入后重跑，原失败结果保留。下文代理的27项结果是补核前的定向证据；最终类型/构建与整合结果见统一报告。

完成日期：2026-10-22

## 结论

批次 D 的代码与定向回归已完成。盘点现在要求 `workspace` 直接包含可读的 `卡/` 目录；项目根、没有卡的 `.pao` 根、不存在目录、错误显式项目根都会返回结构化错误，不再生成“未完卡：无”和“Git 不可用”的假现场。标准 `.pao` 平铺布局、标准任务目录和带显式 `project_root` 的自定义任务目录均保留。存在多个合法任务目录时会全部列出并要求调用方明确选择，不会自动取第一个。合法空任务目录仍表示空队列；卡目录或卡文件读取失败会在报告中标为盘点不完整。

最终联合回归实际运行 3 个文件、27 项测试，全部通过；5 个 D 相关文件的 Biome 与 `git diff --check` 也通过。最终全包 TypeScript 检查失败，错误位于并发批次的 `src/pao/workflow/tools.ts:449`（`AutoChainReport` 没有 `waitingForEvent`），不属于本批五个文件；本批修改前的全包类型检查曾通过，但当前共享工作区最终状态没有类型检查通过。未运行模型、未使用正式 PAO_HOME、未安装依赖。未做真实容器三题重测，因此本报告不声称业务闭环或官方成绩通过。

## 经过

诊断证据显示，`workspace=/app` 时旧逻辑把项目根推成 `/`、扫描 `/卡`，目录不存在又被当成空列表，最终误报“无任务、无 Git”。修复复用现有 `projectRootForCards()` 判断标准 `.pao` 归属，复用 `shared/path-key.ts` 的 `pathKey()` 比较大小写；没有新增路径正本或自动选择框架。

代码图查询确认，修改前 `inventory()` 的直接调用者只有 `worker/index.ts` 的盘点工具执行段。调用图见 `.pao/后续执行-20261004/代码图恢复记录.md` 中记录的当前 CLI 参数格式；查询项目为 `D-AI-workspace-pao-dev-PAO`。修改后新私有函数的增量索引在检查时尚未刷新，所以其查询返回 0；源码、直接调用者和定向测试均已核实。

主控审核发现第一版修复有两处兼容性收紧：无条件拒绝名为 `.pao` 的 `workspace`，会误伤 `<项目>/.pao/卡` 平铺布局；显式 `project_root` 又被无条件强制与 `.pao` 推导根一致，会误伤原有自定义任务目录。已改为只拒绝没有卡目录的输入；标准 `.pao` 归属可识别时，显式根解析真实路径后再核对，自定义布局沿用显式根。

补回归时，符号链接测试第一次失败只是断言了链接形式，而报告按设计返回真实项目根；改为断言真实根后通过。收缩错误提示职责时又有三项失败，原因是项目根误传时没有检查输入目录自身的 `.pao`；已把候选探测留在“缺卡目录”失败分支，并同时检查输入目录、显式根和默认根。最终联合回归通过。

## 做了什么

### 路径与输入校验

- `PAO/packages/coding-agent/src/pao/worker/inventory.ts`
  - `workspace` 必须存在、是目录，且直接包含 `卡/`；只对缺卡目录报错，不再按目录名 `.pao` 无条件拒绝。
  - 项目根默认沿用原上两级约定；标准 `.pao` 布局复用 `projectRootForCards()` 识别归属。
  - 显式 `project_root` 先校验目录并解析 `realpath`；能识别标准 `.pao` 归属时，用共享 `pathKey()` 与真实推导根比较；非 `.pao` 自定义任务目录保留显式根。
  - 项目根、无卡 `.pao` 根、缺失目录、错误显式根抛出 `InventoryPathError`，带 `INVENTORY_PATH_INVALID`、检查路径、候选任务目录和建议。
  - 候选任务目录来自 `<项目根>/.pao/*/卡`，也支持平铺的 `<项目根>/.pao/卡`；只在缺卡错误提示中使用，多候选全部列出，不自动选择。
  - 合法空 `卡/` 保持空队列语义；卡目录、子目录或卡文件读取失败写入报告 `问题`，不伪装成干净盘点。
- `PAO/packages/coding-agent/src/pao/worker/index.ts`
  - 更新 `pao_inventory` 的 `workspace` 与 `project_root` 参数说明，写清标准平铺、标准任务目录和自定义显式根三种用法。
  - 路径错误返回 `isError: true` 和结构化 details。
  - 存在读取问题时输出“盘点不完整”，逐项给出路径和原因。
  - 未改派发、锁、工作流、进程登记或正式 PAO_HOME。

### 测试

- `PAO/packages/coding-agent/test/pao/worker-inventory.test.ts`
  - 项目根误传为 `workspace`：明确拒绝并列出真实任务目录。
  - 正确任务工作区：正常列出卡。
  - 显式 `project_root`：一致时正常，不一致时拒绝。
  - 平铺 `<项目>/.pao/卡`：不传 `project_root` 可直接盘点；显式根经符号链接传入时，按真实路径识别为同一项目。
  - 非 `.pao` 自定义任务目录：显式 `project_root` 正常盘点。
  - 非 Git 项目：如实报告 Git 不可用。
  - 多合法任务目录：全部列出，拒绝自动选择。
  - 空任务与坏卡：空目录保持空队列，坏卡进入问题清单。
- `PAO/packages/coding-agent/test/pao/worker-tools.test.ts`
  - 工具层验证项目根误传时返回 `isError`，不显示“未完卡：无”。
- `PAO/packages/coding-agent/test/pao/host-inventory-dispatch.test.ts`
  - 盘点宿主展示测试改用真实任务工作区，部长会话行断言保持不变。

## 实际验证

工作目录：`D:/AI/workspace/pao-dev/PAO/packages/coding-agent`

| 检查 | 实际命令 | 结果 |
|---|---|---|
| 最终联合回归 | `C:/Program Files/nodejs/node.exe ../../node_modules/vitest/vitest.mjs run test/pao/worker-inventory.test.ts test/pao/worker-tools.test.ts test/pao/host-inventory-dispatch.test.ts` | 通过：3 个文件、27 项测试 |
| 最终格式检查 | `C:/Program Files/nodejs/node.exe ../../node_modules/@biomejs/biome/bin/biome check <D 的 5 个文件>` | 通过：5 个文件，无修复 |
| 最终差异检查 | `git diff --check -- <D 的 5 个文件>` | 通过：退出码 0，无输出 |
| 最终类型检查 | `C:/Program Files/nodejs/node.exe ../../node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit` | 失败：`src/pao/workflow/tools.ts:449` 使用不存在的 `AutoChainReport.waitingForEvent` |
| D 修改后、并发改动前类型检查 | 同一 TypeScript 命令 | 曾通过：退出码 0、无诊断；不能代替最终共享状态 |

证据文件：

- `D-联合回归-最终.log`
- `D-格式检查-最终.log`
- `D-差异检查-最终.log`
- `D-类型检查-最终.log`

## 边界与未验证

- 已修改：路径解析、盘点问题报告、工具参数说明与错误回执、相关测试。
- 已检查：代码图影响面、当前源码、改动差异、共享路径函数。
- 已实际运行成功：最终联合回归、Biome 和差异检查。
- 未通过最终检查：全包 TypeScript 被其他批次的 `workflow/tools.ts` 与 `workflow/auto.ts` 并发改动阻断；本批未修改这两个文件。
- 未验证：真实宿主、容器、RPC 全流程，以及隔离 Git 夹具通过 `pao_inventory` 工具入口的现场重放。现有测试使用真实文件系统和 Git 命令，但不调用模型。
- 增量代码图在检查时尚未刷新；不影响本次调用者判断和测试结果。
- 当前共享工作区存在大量其他代理与历史修改，本报告只列出批次 D 涉及的文件。未提交、未清理其他修改、未运行付费模型、未访问或写入正式 PAO_HOME。
