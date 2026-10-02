# PAO

以 pi 为内核的个人编码 agent（v2 重启）：终端先行、桌面端二期做纯壳，目标完全替代 ZCode。需求与架构的权威定案在 `plans/`，本文件只放干活时必须遵守的执行规则。

<!-- 上级公约嵌入区：由 agents-md-authoring 按根公约现行版刷新，勿手改 -->

## 0. 两个世界

| 区域 | 路径 | 只放 |
|---|---|---|
| 工作区 | `D:\AI\workspace` | 干活的工作产物 |
| 知识库 Vault | `D:\notebook` | 要长期保留的记忆与知识 |

一个文件放哪，先问：它是「某次工作的产物」还是「以后还要查的知识」。
工作产物不进 Vault，记忆与知识不散落工作区。Vault 细则见 `D:\notebook\00_系统\使用规范.md`。

## 1. 文件规范

总原则：**一个事实一个家**——任何内容只在一个归属处维护，别处用链接引用；
想要第二份副本时，先怀疑是分类错了。

### 1.1 归属总表（任何文件落位前先查此表）

| 内容类型 | 唯一归属 | 说明 |
|---|---|---|
| 项目代码、数据、文档 | `<项目>/` 内 | 内部结构由项目 AGENTS.md 定义 |
| 项目决策（代码与非代码） | `<项目>/.agents/notes/{implemented,rejected}/` | 选型/架构/流程的 why 与被否方案；纯机械改动不留 |
| 项目编排状态（任务卡、计划、运行留档） | `<项目>/` 自己的编排目录（默认 `.hermes/`） | 各项目通用、各管各的；项目 AGENTS.md 可另声明路径；根 `.hermes/` 只放跨项目任务 |
| 归档与冻结快照 | `<项目>/archive/` 或 `<名>_frozen/` | 只读，不追加 |
| 一次性任务 | `临时文件夹/<任务简称>-YYYYMMDD/` | 结束删过程缓存，留脚本与成品 |
| 代码图数据 | `D:\cbm-cache\`（CBM_CACHE_DIR 指定） | codebase-memory-mcp 全局缓存（按项目分库）：建图一次，运行期自动同步；勿手改 |
| 经验教训 | Vault `01_经验教训/` | 各项目相关条目由该项目对应会话维护，全局共用一个库 |
| 对话日志 | Vault `09_日志/对话日志/YYYY-MM-DD/<项目>.md` | 按项目分文件，各自项目的事记各自文件，只追加；由每日自动任务生成；一次性任务归其来源项目，无来源项目的才归 Hermes.md |
| 跨项目决策、已否决方案 | Vault `05_决策/` | 只放影响多个项目的；单项目决策放各自项目 |
| 退役登记、未决事项 | Vault `00_系统/` | 全局共用；工具退役当天登记 |
| 凭证 | 环境变量或专用 .env | 不入库、不进日志与报告 |
| 项目上下文规则 | `<项目>/AGENTS.md` | 项目级唯一规则正本；顶部含上级公约嵌入区（由 agents-md-authoring 维护） |

### 1.2 新建文件夹

- **一级目录 = 独立项目**：新建必须同批创建项目级 AGENTS.md，**通过 agents-md-authoring skill 创建**
  （截至 2026-10-01 定义文件（v0.4.0）：`C:\Users\ASUS\AppData\Local\hermes\skills\governance\agents-md-authoring\SKILL.md`；
  非 Hermes agent 参照其流程：调查真实项目 → 最小必要内容 → 用户确认后写入）；
  完成前不开始大规模实现；同步更新第 3 节索引。
- **新项目须 git init 并纳入备份**：git 只管本地版本控制，不等于备份；备份指远端或备份脚本覆盖。细则见 agents-md-authoring skill 的「新项目入门要求」。
- **项目内部**：由项目 AGENTS.md 自行定义，遵循「一个事实一个家」。
- **临时目录**：`<任务简称>-YYYYMMDD/`，脚本顶部注明用途/输入/输出；不写入项目子目录，不放系统 Temp。
- **根目录**：只放本文件与跨项目编排状态，不放任何工作产物。

### 1.3 命名

- 目录与文件名用中文；保留原名的例外：AGENTS.md、package.json 等工程约定文件、
  凭证文件、外部导入的原始文件。
- 日期统一 `YYYY-MM-DD`（目录后缀用 `YYYYMMDD`）。

## 2. 通用原则

1. **先读再改**：动文件前先读项目 AGENTS.md 与相关源文件；不猜路径、命令、版本。
2. **最小改动**：只改任务所需范围；不覆盖他人无关修改；跨项目修改须说明并经确认。
3. **真实汇报**：区分「已修改／已检查／实际运行成功」；不编造，失败如实报。
4. **现状断言带日期**：写「在用什么、路径在哪」注明截至日期；来源退役即同批订正。
5. **全局操作须授权**：磁盘权限、系统服务、全局工具链变更必须先经用户批准。
6. **显式解释器**：不依赖 PATH 里的 python；项目用项目声明的解释器，临时脚本用绝对路径。
7. **清理边界**：只删自己本轮创建且确认无用的文件与进程。
8. **优先复用，不重复造轮子**：写代码前先查项目内既有实现，再查本机成熟依赖
   （标准库、npm/PyPI 现成包），本地都没有才上网找公开方案——找到了能直接用就别自己写。
   引入第三方代码时把许可证与维护状态记进决策笔记备查（无维护但好用的代码可以用，
   风险自己知情即可）。
9. **改代码先查代码图**：已建图项目里修改函数/重构/修 bug 前，先用 codebase-memory-mcp
   查调用链与影响面（`cli trace_path` / `search_graph`），代替逐文件翻读；
   代码项目首次开工建一次图（`cli index_repository --repo_path <项目>`）；
   图随文件改动自动同步，服务未运行期间发生大改动后用 `cli index_status` 确认未过期。
10. **先查表再落文件**：归属表查不到的类型，先补表再落文件。
11. **用中文、说人话、说简洁**：与用户交流及写文档一律中文；输出通俗易懂，术语首次
    出现时用一句大白话解释它是什么；不用行业黑话、自造简称和未解释的缩写；先给结论
    不绕弯，能一句说清的不写三句。
12. **汇报结构**：向用户汇报按「结论 → 经过 → 做了什么 → 待决策」组织——结论先行；
    经过记事情怎么发展（含岔路与意外）；做了什么只列采取的动作与改动；待决策逐条独立
    成段，每条说清背景并附建议。小任务可退化为「结论 + 做了什么」两段，不写八股。

<!-- 嵌入区结束 -->

## Structure

- `plans/` — 需求与架构定案（`v2-REQUIREMENTS.md`、`v2-ARCHITECTURE.md`），架构决策的唯一归属；内部规范见 `plans/AGENTS.md`
- `pao配置/` — pao 自身运行时配置唯一归属（档位、记忆供应商选择等，随对应功能实施落文件；见其 README）
- `PAO/` — pao 本体：pi 1.0.0 源码 fork（独立 git 仓库，主分支 `pao-main`，基线 1.0.0——2026-10-02 自 0.99.2 rebase 升级、零冲突，升级留档见提交 `10952dda6`；升级前锚点分支 `pre-1.0-upgrade`；已从本仓库 .gitignore；备份＝私有远端 `backup`→github.com/gcxfn/pao，2026-10-02 起推送，上游 remote 为 `origin`→github.com/earendil-works/pi）。2026-10-02 路线变更，原「自含扩展包」方案作废，见 `.agents/notes/`
- `摩擦日志.md` — 日常使用 PAO 的摩擦滚动记录（2026-10-02 已开张）
- `部门/` — 部门配方与部门知识库（骨架见 `plans/v2-ARCHITECTURE.md` §6.2，待建）
- `.agents/notes/{implemented,rejected}/` — 决策笔记：只记 why 与被否方案；现行规则的正文住 `plans/`，两边互引、不各存一套结论；纯机械改动不留

## Commands

- `pao` — 本项目 CLI（pi 1.0.0 fork 构建产物，含 pao 扩展）。截至 2026-10-02：全局命令经 `D:\npm-global` 三个垫片（`pao`/`pao.cmd`/`pao.ps1`）指向 `PAO/packages/coding-agent/dist/bundle/cli.js`；改代码后须在 `PAO/` 下 `npm run build`（按依赖序全仓构建，单独 `-w packages/coding-agent` 会因兄弟包 dist 过期而挂）才生效。上游 `pi` 全局命令（npm 安装的 0.99.2）不受影响、命令名未被占用。品牌：fork 经 `package.json → piConfig.name="pao"` 官方改名口子换 APP_NAME（帮助/终端标题/启动字标，configDir 仍 `.pi` 保登录态与目录）。**禁跑 `pao update`（含 `pao update self`）**——自更新不识别 fork 身份，会以上游产物覆写本 fork；升级只走 rebase 路线。TUI 说明：pi 1.0 起 fullscreen 为默认模式，空会话下与 regular 观感接近，转录变长后编辑区固定才可见；`/settings` 可核当前模式。
- pao 一条龙（M1 起真实可用）：`PAO_HOME` 指本工作区根后，headless 主控 `pao --mode json -p --no-session --model 主力|快 "…"` 驱动 pao_建部/建卡/扇出/改状态/入库/查库；worker 由扇出拉起（`PAO_ROLE=worker` 自动注入），回执证据落 `%TEMP%\pao-worker-evidence\`，卡在 `.pao/卡/`。技能目录 `pao配置/skills/`、两档 `pao配置/档位.json`、装载清单 `pao配置/装载清单.md`（R10 正本）。

## Working Rules

- 动手前先读 `plans/` 两份定案文档；已对齐决策不重新讨论，要推翻先留否决笔记（标日期与原因）再改文档。
- pi 基座：`PAO/` 为 pi 1.0.0 源码 fork（2026-10-02 起 fork 路线并同日升至 1.0.0，上游 github.com/earendil-works/pi）；升级走 `v2-REQUIREMENTS.md` §5.4 适配四步（第③步＝rebase fork 改动；2026-10-02 实操沉淀见 `plans/持续维护与升级.md` 与 fork 提交 `10952dda6`），升级后同批订正本文件的版本断言。**rebase 制的代价：每次升级 rebase 后，历史整链重写，推备份远端必须 `git push --force-with-lease backup pao-main`**（普通推会被 non-fast-forward 拒；2026-10-02 实测，推前 fetch 核对远端独有提交均已含在本地）。
- 不做常驻服务，主会话关闭全停（架构 §1）。
- 编排状态（任务卡、黑板、产物）放 `.pao/`（pao 自有编排目录，2026-10-02 定案，根公约允许项目自声明；任务工作区制见 `plans/v2-ARCHITECTURE.md` §2.1）。
- 本项目例外（2026-10-02 用户定案）：pao 自身的经验教训正本住部门知识库（架构 §6.2），不上交 Vault；跨项目通用经验仍归 Vault，两边互放指针。此为对上级公约归属表「经验教训」条的项目级例外声明（嵌入区不改，下次 agents-md-authoring 刷新时同步）。

## Verification

- pao 模块测试：`PAO/packages/coding-agent` 下 `npx vitest run test/pao/`（须全绿；用例数不在此写死——2026-10-02 K3 审查实测 218，R23）。
- coding-agent 全量：同目录 `npx vitest run`；Windows 下上游基线 68 失败/21 文件（POSIX 假设等上游债，2026-10-02 随 pi 1.0.0 升级重建——新增上游 experimental durable 测试在 Windows 缺 `process.getuid`，旧 0.99.2 基线 67 失败中 3 处已消失；留档 `.pao/并行实施-20261002/产物/基线测试-coding-agent.log`），验收口径＝失败集合较基线不扩大，不替上游修；并发计时类测试偶发轮换失败属环境抖动，隔离复跑判定。该口径已机械化（M0-09）：`PAO/` 仓库根 `node scripts/check-baseline-failures.mjs` 自己跑全量再比对，`--log <文件>` 比对现成输出、`--baseline` 换基线、`--save-log` 留档新基线。
- 全仓 `tsc --noEmit`（上游 pre-commit 链的一环）：pi 1.0.0 上游自带 1 错——`packages/ai/test/together-models.test.ts` 引用目录里不存在的 `deepseek-ai/DeepSeek-V4-Pro` 字面量（vitest 不查类型故测试不红）；我方对 `packages/ai` 零改动，不替上游修，类型门＝除该上游项外无错。

## Maintenance

- pi 锁版变化、目录结构变化、首个可运行命令出现、架构决策新增或推翻时更新本文件。
- 事实（在用工具、路径、命令、状态）变动时，同批订正引用它的文件与索引。
