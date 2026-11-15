# G5-O16：旧停 owner 与新结构化待决对照

## 结论

已用同一份冻结 fixture、同一业务输入、同一 FakeRunner 配方和真实 Git，分别加载已构建的 r37 旧产品与当前产品。

最终结果为：

| 分支 | Vitest exit | 测试耗时 | 结论 |
|---|---:|---:|---|
| r37 旧产品 | 0 | 12.671 秒 | 回执成功但两项自报 fail/not_run 后真实停在 owner，控制清单无结构化待决，未新增提交 |
| 当前产品 | 0 | 24.809 秒 | 登记普通偏差待决，真实办理一次后 delivered；同输入重放不新增提交或唤醒 |

最终 runner exit 为 0，并输出 `G5-O16 PASS`。没有修改任何产品源码、旧 dist、依赖或当前项目测试原件。

## 冻结文件和身份

最终 fixture SHA256：

`41E5995F9AF67C88AA71F206E26CD99ED734E358E3D0C13B1194D027B7230DBD`

| 对象 | 路径或身份 |
|---|---|
| fixture | `D:\AI\workspace\临时文件夹\接续核验-20261030\G5-O16\G5-O16.test.mjs` |
| Vitest 配置 | `D:\AI\workspace\临时文件夹\接续核验-20261030\G5-O16\vitest.config.mjs` |
| 运行入口 | `D:\AI\workspace\临时文件夹\接续核验-20261030\G5-O16\run-g5-o16.ps1` |
| 当前项目原测试（未修改） | SHA256 `DEA2933EA89CB294615B3F295276FCAB660BEBE35C5AD5AF5F07D95E089DC31F` |
| 旧产品根 | `D:\AI\workspace\临时文件夹\r37旧产品回放-20261030\I5-3b-1-旧产品准备-20261030-1\old-pao` |
| 当前产品根 | `D:\AI\workspace\pao-dev\PAO` |
| r37 原始 zip | SHA256 `9A373AE0323726E0BB7BCBEB36FF8B18D72B86D803999B734C367CF12316CDBF` |
| 旧 control.ts | SHA256 `0EBBEDD8E696D42DE22E3BC98FAB561212182216790E5155C59D349F04BB039C` |
| 旧 post-dispatch.ts | SHA256 `11D27E807515A20C8E3BEDC154F8F7469FC470E767CD8A1981F454CD2FB67B86` |
| 当前 control.ts（本次运行快照） | SHA256 `7B5CF5F3486B5170EFE384D6477F1DF7599341D2B714F3FE0E9367E332BA2F51` |
| 当前 post-dispatch.ts | SHA256 `DA5B8FD28F125C78CE1C732F9D7C19BC889315A6A9D4FDC4863B1A27F2A43A73` |

两边 `package.json` 和 `package-lock.json` 均分别为：

- `F1FE5EADA88FE344FAB13AC40C261B66054F686F112D44834AE82F35782F783F`
- `28092EA87844FEF0F4F5E09F8C3616F3231AAD46F1F68873D7DA031BF73E6DF4`

两边已有 bundle 入口 `dist/bundle/cli.js` 的 SHA256 均为 `E79626F2DD6F94AA45D30F3FA63CD84319A6EEFCD150B353CFAF274366926774`。本次没有构建或写入两边 dist。

## 运行方法

真实命令：

```powershell
& 'D:\AI\workspace\临时文件夹\接续核验-20261030\G5-O16\run-g5-o16.ps1'
```

每次产品分支执行的 Node 命令为：

```text
C:\Program Files\nodejs\node.exe
D:\AI\workspace\pao-dev\PAO\node_modules\vitest\vitest.mjs
run
D:\AI\workspace\临时文件夹\接续核验-20261030\G5-O16\G5-O16.test.mjs
--config D:\AI\workspace\临时文件夹\接续核验-20261030\G5-O16\vitest.config.mjs
--maxWorkers=1
--reporter=verbose
```

工作目录是 `D:\AI\workspace\pao-dev\PAO\packages\coding-agent`。没有设置全局 `testTimeout`；fixture 内为这一个用例保留 120 秒上限，实际两边分别约 12.7 秒和 24.8 秒完成。

`PAO_HOME`、`TEMP`、`TMP`、`TMPDIR` 均位于本任务 scratch。fixture 的最终证据分别记录了：

- 旧：`runtime\old-pao-home`
- 新：`runtime\current-pao-home`
- 临时目录：`temp\old` 和 `temp\current`

同时固定 `PI_OFFLINE=1`、`PI_NO_LOCAL_LLM=1`。

产品模块通过 `G5_PRODUCT_ROOT` 参数化加载。旧分支只导入旧产品根下的模块，没有注入当前内核；当前 Vitest 只作为测试驱动。旧 `control` 没有 `recordPending` 导出，fixture 记录其值为 `undefined`，不会调用它。

## 旧产品实测

r37 的旧业务停点在 `post-dispatch.ts` 第 242 行：检测到 `unmetReports` 后直接返回“存在自报未达项，未创建部长审核请求，链停留 owner 逐项裁决”。

最终现场：

| 检查 | 实际值 |
|---|---|
| worker 回执 | `success` |
| 自报未达 | `条件甲=fail`、`条件乙=not_run` |
| 工作流状态 | `hold` |
| 结构化待决 | 不存在 |
| `暂停` 字段 | 不存在 |
| 卡状态与 attempt | `in_progress`、attempt 1 |
| worker 次数 | 1 |
| Git 提交数办理前后 | 1、1 |
| 产物 | `产物.txt` 为未跟踪文件 |
| 查询文案 | 含“2 条自报未达项”“待 owner 裁决” |
| 通知文案 | 含“停审”“链停留 owner” |

旧工作树的 baseline HEAD 为 `10db8e06ef0879adffc7d3e284238bff9b569fe4`。`master` 在办理前后均停在该提交，证明旧路径没有自动交付或新增提交。

完整现场在：

`D:\AI\workspace\临时文件夹\接续核验-20261030\G5-O16\evidence\old-observed-before.json`

## 当前产品实测

当前路径在 `post-dispatch.ts` 产生结构化 `PostDispatchUnmetEvent`，宿主返回真实 `pending_key` 和与两项未达一一对应的 `item_refs`。控制清单中实际得到：

- `kind=普通偏差`
- `channel=主控`
- `条件甲=fail`，证据为“甲命令失败证据”
- `条件乙=not_run`，证据为“乙未运行证据”
- 两项 `item_ref` 与查询文案完全一致
- 截止时间比创建时间正好晚 30 分钟

重复登记同一待决事件只保留一条“登记普通偏差待决”记录；篡改当前 attempt 的证据会被拒绝。再次推送工作流没有重跑 worker，也没有新增唤醒。

调用一次 `pao_control_node action=resolve_pending` 后：

- 待决被清除；
- 卡变为 `delivered`；
- 本次办理增加了 Git 提交；
- 使用完全相同参数重放时返回“相同输入重放”；
- 重放前后提交数和通知数均不变。

当前工作树 baseline HEAD 为 `56f4ad0fc3c2917c4f99e5a6897a7db2aa369453`。办理前提交数为 1；首次办理后为 3；相同输入重放后仍为 3。`git log --all` 中新增：

```text
bedec9a 卡0001 产出 · delivered · 机械部分通过·人工审定
a54d987 PAO 卡0001 attempt 1 input boundary
56f4ad0 baseline
```

完整现场在：

`D:\AI\workspace\临时文件夹\接续核验-20261030\G5-O16\evidence\current-result.json`

## 真实 exit 和日志

最终日志：

- `logs\old.exit.json`：exit 0
- `logs\current.exit.json`：exit 0
- `logs\old.stdout.log`
- `logs\current.stdout.log`
- `logs\old.stderr.log`
- `logs\current.stderr.log`
- `run-summary.json`
- `identity.json`
- `logs\final-artifact-hashes.json`

最终源码哈希复查写入：

`evidence\source-hashes-after.json`

早先三次诊断现场的日志和证据均以 `attempt1-*`、`attempt2-*`、`attempt3-*` 保留。三次旧分支未通过都属于 fixture 断言不准确：

1. 初始 helper 返回对象漏了 `cardsDir`，属于夹具基础设施错误。
2. 查询实际写“待 owner 裁决”，fixture 最初误要求“留 owner”；后者实际出现在终端通知中。
3. `产物.txt` 在旧路径中保持未跟踪，fixture 最初错查 `git diff --stat`，后来改为检查 `git status --porcelain`。

修正后没有删除并发、自报未达、owner 停点、真实 Git 或重放断言。

## 限制

2026-10-30 主控补充统一验收对照：保留上述原夹具，在独立 `G5-O16-common` 副本中，对两个产品都增加相同要求“本次普通偏差必须产生结构化待决出口”。旧源码实际退出1，失败点为 `flow.待决?.kind` 是 undefined；新源码实际退出0，完成原有一次办理、真实提交及幂等重放断言，耗时24.490秒。此为真实Git与模拟worker的离线旧红新绿，不是实际模型或题目评分。新夹具SHA256：`DC096FBD540930F8A8F8ADD521B5D41E8D71122C87373A04D463BCF98DE43681`。脚本、日志和现场位于 `D:/AI/workspace/临时文件夹/接续核验-20261030/G5-O16-common/`，入口 `run-common.ps1`；最终日志为 `old-final.log`、`current-final.log`，退出码文件对应为1和0。首次复制时漏建runtime父目录的两份基础设施失败日志保留，不计作旧产品失败。

- 本次只使用确定性的 FakeRunner 和真实本地 Git，没有调用模型，没有运行被审计的真实题目。
- 没有 build、Harbor、Docker，也没有写入正式 `PAO_HOME`。
- r37 使用预先准备且已通过启动检查的旧产品现场；本次没有修改、重装或重建旧源码、dist 和依赖。
- fixture 按产品版本走对应契约分支：旧分支证明“无结构化待决，停 owner”，当前分支证明“结构化待决，一次办理，重放幂等”。没有把旧产品不存在的新接口当成模块加载成功条件。
- 最终测试结束后 30 秒，共享工作树中的当前 `control.ts` 被其他进程从本次运行快照 `7B5CF5F3…` 改成了 `5D9E68CB…`。本报告的成功结论严格绑定 `7B5CF5F3…` 运行快照；本任务没有改这个产品文件，也没有把改动归因于本次测试。其余相关当前源码和旧源码哈希在运行后复查均未变化。
