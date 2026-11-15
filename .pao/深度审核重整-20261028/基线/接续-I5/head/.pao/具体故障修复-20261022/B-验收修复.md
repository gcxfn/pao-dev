# B 验收修复报告

完成日期：2026-10-22

## 结论

批次 B 已完成。建卡前的共享验收预检已导出为：

```ts
validateAcceptance(acceptance: string, projectRoot: string): void
```

它只复用现有的 `parseAcceptance`、`checkCommandSafety` 和 `checkReadPath`，不执行命令，也不要求未来产物已经存在。正常人工句保留；机械前缀后的残句、危险命令形状和越界读路径会在发号前抛出带行号及改法的 `INVALID_CARD`。

审核指出的新增过度限制已删除：不再对整行 `inlineCode` 另加检查。`包含: index.html :: <p>`、包含反引号或 `${...}` 的文本字面值均放行；安全形状 `跑: node -e "..."` 保持允许。历史坏 HTML 命令导致的 `<` 限制不会转嫁给正常文本包含验收。

自动链现会区分机械失败与正常等待：机械验收未过、安检拦截或真实失败才把本次仍在进行的卡落为 `failed`，并保留验收证据和原回执；已有交付、取消、失败、回执或尝试变化不会被覆盖。`全过停人工审` 和 `无法机械判` 不强制失败。纯人工未审核卡不因验收预检被改成失败。

`AutoChainReport` 已增加可选 `waitingForEvent?: boolean`。v2 自动链末尾仅在 `report.status === "running"` 且没有人工确认门挂起时设为 `true`，表示只等待部长拆卡、结束信号或判定等正常下级事件；`completed`、`hold`、真实失败和人工门均不设置。主控已按该字段在 `tools.ts` 的 `settleChain` 分类为 `progress`，本批没有修改 `tools.ts`。

## 做了什么

### 共享验收预检

- `PAO/packages/coding-agent/src/pao/cards/verifier.ts`
  - 新增并导出 `validateAcceptance`，错误类型为 `PaoCardError("INVALID_CARD", ...)`。
  - 机械残句逐行给出行号、原句与可直接替换的写法。
  - `跑:` 复用 `checkCommandSafety`；`存在:` 与 `包含:` 的读路径复用 `checkReadPath`。
  - 不新增整行代码格式门，不把 `包含` 的文本字面值当作 shell 命令或 inline code 审查。
  - 纯人工句不生成机械条目，正常保留。
- `PAO/packages/coding-agent/src/pao/workflow/control.ts`
  - 由主控负责接线；当前源码已在 `addNodeCards` 整批发号前逐条调用：
    `validateAcceptance(substituteParams(input.acceptance, flow.参数), projectRootForCards(...))`。
  - 本代理未修改 `control.ts`、`cardfile.ts` 或 `cards/tools.ts`，避免覆盖主控改动。

### 自动链失败落态与等待分类

- `PAO/packages/coding-agent/src/pao/workflow/auto.ts`
  - 机械验收为 `未过` 时，只有卡仍是同一次尝试的 `in_progress` 才落 `failed`；使用已有 `unknown_outcome`，不新增失败枚举。
  - 落失败前已有终态或尝试变化时只停审，保留现有状态、回执和证据。
  - 越界核查为 `无法核对` 时保留进行中，交 owner 裁决。
  - `AutoChainReport` 增加 `waitingForEvent?: boolean`。
  - v2 正常等待分支仅按 `DriveReport.status` 与结构化人工门字段判断，不解析 `stopReason` 文本。

### 回归

- `PAO/packages/coding-agent/test/pao/verifier-parse.test.ts`
  - 合法机械项不要求未来文件存在，人工句保留。
  - HTML、反引号、模板插值作为 `包含:` 字面值放行。
  - 安全 `node -e` 形状放行。
  - 机械残句、绝对读路径、命令串联和重定向给出 `INVALID_CARD`。
- `PAO/packages/coding-agent/test/pao/workflow-auto-chain.test.ts`
  - 第二张验收非法时整批不发号、不留下半批卡，控制映射也保持空。
  - 机械失败和安检拦截显式落失败，越界无法核对保持进行中。
  - 已并发交付的卡保持交付和原回执，不被失败落态覆盖。
  - v2 正常等待部长拆卡时设置 `waitingForEvent: true`；人工门、失败和完成态不设置。
  - 并发交付夹具使用当前卡 owner 写状态，继续遵守单写者保护。

## 实际验证

工作目录：

```text
D:/AI/workspace/pao-dev/PAO/packages/coding-agent
```

Node：

```text
C:/Program Files/nodejs/node.exe
```

| 检查 | 实际命令 | 结果 |
|---|---|---|
| 验收纯函数回归 | `C:/Program Files/nodejs/node.exe ../../node_modules/vitest/vitest.mjs run test/pao/verifier-parse.test.ts` | 通过：1 文件、19 项 |
| 整批预检定向 | `C:/Program Files/nodejs/node.exe ../../node_modules/vitest/vitest.mjs run test/pao/workflow-auto-chain.test.ts -t "整批验收预检"` | 通过：1 项 |
| 自动链差异定向 | `C:/Program Files/nodejs/node.exe ../../node_modules/vitest/vitest.mjs run test/pao/workflow-auto-chain.test.ts -t "机械验收\|安检拦截\|无法核对\|状态已变化\|整批验收预检"` | 通过：5 项 |
| v2 正常等待 | `C:/Program Files/nodejs/node.exe ../../node_modules/vitest/vitest.mjs run test/pao/workflow-auto-chain.test.ts -t "v2 正常等待部长拆卡"` | 通过：1 项 |
| v2 失败、人工门、正常等待 | `C:/Program Files/nodejs/node.exe ../../node_modules/vitest/vitest.mjs run test/pao/workflow-auto-chain.test.ts -t "v2 worker失败\|v2 人工门\|v2 正常等待部长拆卡"` | 通过：3 项 |
| 并发终态保护 | `C:/Program Files/nodejs/node.exe ../../node_modules/vitest/vitest.mjs run test/pao/workflow-auto-chain.test.ts -t "验收未过时卡已被并发改为交付"` | 通过：1 项 |
| 类型检查 | `npx --no-install tsc --noEmit -p tsconfig.build.json` | 通过：退出码 0，无输出 |
| 差异格式 | `git diff --check -- <B 的四个文件>` | 通过：退出码 0，无输出 |

主控随后确认类型、build 和七架构门已通过，统一回归仍在运行。B 未再启动全量测试或重复运行完整命令。

早先一次完整两文件回归在并发交付夹具修正前运行完毕，共 83 项，其中 82 项通过；唯一失败是测试夹具用非 owner 身份写已认领卡，被单写者保护正确拒绝。将夹具身份改为当前 owner 后，该用例定向通过。最终完整两文件结果以主控正在运行并即将汇总的统一回归为准，本报告不把先前那一次结果冒充最终全绿。

## 边界与未验证

- 已修改：`verifier.ts`、`auto.ts` 及本批允许的两个测试文件；另保存本报告。
- 已检查：根与 PAO 的 `AGENTS.md`、代码规范、相关源码、代码图调用链和最终差异。
- 已实际运行成功：上表全部定向测试、TypeScript 检查和差异格式检查。
- 未验证：本代理未完成最终两文件全量、整个仓库全量测试、真实模型调用、正式 PAO_HOME 或真实四部门闭环。
- 未安装依赖，未运行付费模型，未访问或写入正式 PAO_HOME，未覆盖其他代理的无关修改。
- `control.ts` 的最终接入由主控负责并已在当前源码确认存在；B 保证导出签名与其调用匹配。
