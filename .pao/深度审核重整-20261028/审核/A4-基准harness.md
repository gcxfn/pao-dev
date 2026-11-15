# A4 基准 harness 与运行环境审核

审核员 A4，2026-10-28，只读。状态：完成。

## 已掌握事实（草稿，待整理）

- 现役链：Windows 上 `prepare_run.py --sources` 组装运行目录（复制 source.zip、model-data.zip、node 包、git-system-dependencies.zip、task-cache、organized-post 里 7 个 benchmark-sdk-host 打包副本、map_bench_pao、scripts、控制器自身），写 run-config/approved-launch/source-manifest/run-sources/run-freeze，再调用 bench_controller.validate。
- `launch_run.py` 在 Windows 用写死的 `D:/Docker/resources/bin/docker.exe` 起控制器容器 `pao-benchmark-controller:20261021`，挂 docker.sock、整个 `D:/AI/workspace`（含正式 PAO_HOME）到 `/mnt/d/AI/workspace`，解释器写死为 `临时文件夹/地图简报基准-20261020/f-harbor-linux/.venv/bin/python`（launch_run.py:17-21,174-205）。
- `bench_controller.py run_sequence`（569-774）：预检 PreparationOnlyAgent → 正式 Job；每 5 秒执行观察 `observe_runtime`，观察任何异常都会 `stop_acceptance` 并取消正式作答（656-698）。即观察器拥有“杀掉作答”的权力，r18 docker ps 非零、cp 内存不足即属此类。
- `runner_common.validate_execution_contract` 写死题目 html-js-filter、post-pao high、工具集与凭证名（runner_common.py:187-265）。
- `build_source_archive` 用 `git ls-files --cached --others`，包含未跟踪文件，但不记录 HEAD 与脏状态（runner_common.py:427-498）。
- `watch_run.py` 另写一套 docker 查询与身份推导（DOCKER_EXE 再次写死，watch_run.py:19），与 bench_controller 的 compose_project / 评分容器名推导重复。


---
# 正文（按任务书 §6.0 结构；上面“已掌握事实”是前段落盘的草稿底稿）

记号：BM/ ＝ `.pao/地图简报与部门协作-20261020/benchmark/`；SH/ ＝ `.pao/协作机制重构-20261023/benchmark-sdk-host/`；TMP/ ＝ `D:\AI\workspace\临时文件夹\审查修复-20261026\`；TB/ ＝ `D:\AI\workspace\临时文件夹\地图简报基准-20261020\`；R37/ ＝ `BM/real-run-20261028-prepared-r37/`。“harness”＝跑基准的外壳；“Harbor”＝Terminal-Bench 官方跑题框架（0.24.0，源码副本在 TB/f-harbor-import/harbor-source，无 git）；“冻结”＝把输入拷贝进运行目录并记摘要，运行中不允许变。

## 1. 结论（按影响排序）

1. **观察器拥有“杀掉本轮”的权力，且任何异常都用它**：`run_sequence` 每 5 秒调 `observe_runtime`，抛任何 `Exception` 都 `stop_acceptance`＋`current.cancel()`（BM/bench_controller.py:656-698）。观察代码自身会主动抛错的位置至少 4 处（:423 多容器、:498 越界、:513 控制正本被搬走、:522 身份改变）。A1 的 r6、r7、r18、r21、r24、r30 六轮都是这条路径。这是 harness 的第一号结构缺陷：**观察与终止没有分离**。
2. **机制验收与官方评分被耦合，导致“没有结论”**：适配器在流程状态不是 `completed` 时直接 `raise RuntimeError`（SH/benchmark-organized-adapter.py:239-240），Harbor 把 trial 记为异常，评分器不运行。R37/task-1-summary.json 的异常正是“组织工作流未完成：status=hold”，随后 `control-status.json` 为 `execution_error`。结果是：43 个目录里 8 次出分都是半成品分（A1 结论 1），其余轮次既无分又无组织结论。
3. **“开始协作”依赖真实模型照做**：适配器的任务说明要求主控“必须调用 `pao_start_flow`…… 每 30 分钟监督…… 调用 `pao_ack_supervision`”（adapter.py:92-98）。流程能否启动、是否按期确认，取决于模型是否遵守一段提示文字；未启动则在 :143-150 以“组织流程未实际启动”失败。这是应由程序在受理后自动做的动作（与 A2/A5 对接）。
4. **每轮是 20–40 个临时脚本和人工接力**：TMP/ 顶层 323 个文件（任务书的 372 含子目录内文件），其中每轮一份的包括 launch-prepared-rNN.py 19、prepare*.py 34、rNN-network-override.yaml 19、rNN-sources.json 19、rNN-previous-stop.json 20、rNN-code-review.json 16、收取/终态脚本 19，另有 106 个测试日志与 16 个源码“修改前”备份。不存在一个“跑一轮”的命令。
5. **每轮复制并保存不变的大件**：43 个运行目录共 3569 MB；其中 Node 压缩包 31.5 MB 完全相同的副本 35 份（1052 MB）、git 系统依赖包 21.2 MB 相同副本 32 份（647 MB）、`source.zip` 42 份（422 MB），三项合计约 2.1 GB（59%）。另有 `command-evidence.jsonl` 17 份共 561 MB（r29 129 MB，r37 79 MB）。
6. **环境脆弱点没有统一的“开跑前体检”**：Docker 默认地址池耗尽需每轮建专属网络（rNN-network-override.yaml；R37/network-receipt.json 里列了 30+ 个被检查的路由/子网，最终选 10.243.37.0/24）；WSL 内存被固定为 4GB（`C:\Users\ASUS\.wslconfig`：`mirrored`、`memory=4GB`）；Windows→Linux 路径转换与 9p 挂载；本次审核时 WSL 与 Docker Desktop 都处于停止状态（见 §2.5）。这些都靠故障后才加检查。
7. **harness 绑死一道题、一台机器、一个目录**：题目 `terminal-bench/html-js-filter`、profile `post-pao high`、工具集、凭据名全写成代码（BM/runner_common.py:190,210,224,242-249）；`docker.exe`、控制器镜像、解释器路径写死（BM/launch_run.py:17-21；BM/watch_run.py:19）；Harbor 与 Linux 解释器住在“临时文件夹”（launch_run.py:21）。
8. **建议**：新 harness 只有一个命令入口（`pao-bench run`），观察器降为只读旁路，评分永远执行，机制结论单列；用本机“脚本化模型服务”做彩排；基准直接跑产品 CLI（与 A3 §4.1 对接）；大件走内容寻址缓存；清理由标签驱动、可重复执行。

## 2. 现状地图

### 2.1 一次运行的完整步骤、代码位置与历史故障

| # | 步骤 | 代码位置（输入→输出） | 历史故障（A1 轮次） |
|---|---|---|---|
| 1 | 准备 | TMP/prepare-and-launch-rNN.py（临时）→ `prepare_run.prepare()`（BM/prepare_run.py:303-682）：读 source-manifest，组装 pao 源码包（`build_source_archive` 取 `git ls-files --cached --others`，runner_common.py:427-498）、Node 包、git 依赖包、model-data、task-cache、organized-post、map_bench_pao、scripts、控制器自身，写 run-config/approved-launch/source-manifest/run-sources/run-freeze | 22 Docker 挂载反斜杠；kit 目录当文件传；漏带 runner_common.py（r19）；装配类共 9 次 |
| 2 | 冻结与校验 | `bench_controller.validate()`（:124）＋`runner_common.validate_run_config/validate_execution_contract`（:187-265） | 凭证变量名、题目契约写死 |
| 3 | 网络 | 临时脚本手工 `docker network create`＋rNN-network-override.yaml＋R37/network-receipt.json | Docker 地址池耗尽、网络冲突（r19–r26、r37 诊断脚本 diagnose-r37-network-conflict.py） |
| 4 | 启动 | `launch_run.launch()`（BM/launch_run.py:129-242）：核对授权、`docker run -d` 控制器容器（挂 docker.sock、整个 `D:/AI/workspace`、run 目录、Harbor 缓存），凭证从环境变量 `PAO_BENCH_API_KEY` 传入（凭证取值由临时脚本完成，本审核未读取） | WinError 1455 页面文件太小（r4）；WSL 4GB 与 cp 内存不足（r18） |
| 5 | 预检 | `run_sequence` 先跑 `PreparationOnlyAgent` 的 Harbor 作业（bench_controller.py:601-624），不开评分 | 子进程探针、身份夹具（r7→r8）、探针契约（r16→r17） |
| 6 | 作答 | 正式 Harbor 作业 → `OrganizedPAOAgent.install`（适配器 :22-89：上传 10 个文件、`setup.mjs`、三角色工具探针、子进程 RPC 探针）→ `.run`（:91-）→ 容器内 `benchmark-organized-entry.mjs`（SH）。R37 实测：环境 3 秒、agent 安装 56 秒、作答 51 分钟 | 回执缺字段、JSON 被说明文字包裹、人工门（r10…r37） |
| 7 | 观察 | 控制器内 `observe_runtime`（每 5 秒 `docker ps -a`＋`docker exec … tar` 抽取控制正本，:400-523）；外加独立进程 `watch_run.py`（间隔 15 秒，由派发的子代理启动，R37/observer-receipt.json） | r6 datetime、r18/r24 `docker ps` 隐式算容器大小、r30 PermissionError、r7/r21 控制正本被搬走 |
| 8 | 终局 | `harbor_execute` 收尾核查活动容器（:787-811）；适配器 `query-organized-terminal.mjs` 终态查询（:156-240）；`classify_result`（:551） | 漏认评分容器、终态事实（A1 观察与收证类） |
| 9 | 收取 | TMP/collect-rNN-terminal.py 等 19 个临时脚本；`watch_run.terminal_facts`（watch_run.py:464）→ terminal-receipt.json | — |
| 10 | 评分 | 正常路径是 Harbor 在 trial 内起评分容器；中断后的补评分是 `score_current`（:821-948，容器名 `pao-score-<run哈希>`，核对 task.toml 与 tests 的 SHA、镜像必须带 digest） | r36/r37 因 status≠completed 不出分；曾出的 8 个分都是半成品（A1） |
| 11 | 清理 | TMP/rNN-previous-stop.json（20 份）、`launch_run.verify_previous`（:75）、historical-test-container-cleanup.json；网络靠人工删除 | 前轮残留容器/网络占地址池 |

### 2.2 谁能终止本轮（终止权力表）

| 触发 | 位置 | 结果 | 是否合理 |
|---|---|---|---|
| 观察抛任何异常 | bench_controller.py:656-698 | 取消正式作答，写 `mechanism_stopped` | **不合理**：观察器 bug 即终止（r6/r18/r24/r30） |
| 控制正本被搬走/重建/多实例 | :511-513 → 同上 | 同上 | **不合理**：模型的恢复尝试被当作违规直接终止（r7/r21）；应记为“完整性告警”写进报告 |
| 冻结输入或配置哈希变化 | :580-592 | 同上 | 合理，但应只在**运行前和运行后**各验一次，运行中每 5 秒 stat 比对（:584-591）是多余的耦合 |
| 用户 `pause --immediate` | :640-654 | 取消并确认停写 | 合理（人为） |
| 预检失败 | :622-624 | 不启动模型 | 合理 |
| 单次 Harbor 异常 | :716-774 | `failed`/`stop_unconfirmed`，崩溃后不能重放 | 部分合理；`control-started.json` 以独占创建（:571-573）使任何一次崩溃都需新建整轮 |

### 2.3 Python 文件间的重复逻辑

| 重复项 | 位置 | 说明 |
|---|---|---|
| docker 查询包装 | launch_run.py:24 `docker_query`；bench_controller.py:49 `command`；watch_run.py:22 `query`；`score_current` 内 `run_command`；harbor_execute 内联 | 五套超时/编码/记录方式 |
| Compose 项目名与评分容器名推导 | bench_controller.py:526 `compose_project`；watch_run.py:101-122 `expected_projects`/`score_container_name`/`planned_identities` | 同一命名规则两处实现；A1 观察类的“漏认评分容器”与两份推导并存直接相关（推断） |
| docker.exe 路径 | launch_run.py:17、watch_run.py:19，另有 bench_controller `--docker` 默认 `docker` | 三种缺省值 |
| 原子写与临时兄弟文件 | runner_common.py:57-139 `_replace_with_bounded_wait`、`write_json`；bench_controller.py:45 `write` | r30 PermissionError 后补的一套有界重试，控制器自己的 `write` 另一套 |
| 摘要/读 JSON | runner_common.py:25-42；bench_controller.py:37-109 | 各一份 `read`/`digest`/`now` |
| 冻结文件清单 | prepare_run.py 写、runner_common.validate_run_references 读（:359-426）、bench_controller.check_frozen 再读（:580-592） | 三处各有校验口径 |
| 打包后的副本 | organized-post/ 下 7 份 SH 副本（kit 目录，adapter.py:40-43 逐个上传） | 与 SH/ 源文件重复，须靠 manifest 摘要对账 |
| 旧版并存 | TB/ 下 controller.py(7.5KB)、prepare-real-run.py、launch-controller.py 等 20+ 个早期脚本 | 与 BM/ 同职能的旧版 |

### 2.4 每轮复制/冻结的内容：哪些真有必要

| 项 | 现状 | 必要性 | 处置 |
|---|---|---|---|
| 被测 PAO 源码包 | 每轮一份 `source.zip`（约 10 MB），含**未跟踪文件**，不记 HEAD、不记工作区脏状态 | 需要“被测代码”可复现 | 保留，但改为 `git archive <提交>` 或“提交＋补丁”，并在报告写 HEAD、补丁哈希；零未提交为跑真实评测的前置条件 |
| Node 压缩包 | 35 份相同副本 | 内容固定 | 放内容寻址缓存 `cache/sha256/…`，运行目录只写哈希引用 |
| git 系统依赖包 | 32 份相同副本 | 同上 | 同上 |
| model-data.zip（75 KB）、model-metadata | 25 份 | 小，内容固定 | 并入配置，不再复制 |
| task-cache（9 个文件）、public-inputs/fixed-manifest | 每轮复制 | 题目输入需要冻结，但不需要每轮复制 | 缓存＋哈希引用 |
| organized-post 与 SH 副本、map_bench_pao、scripts、bench 代码自身 | 每轮复制进 run 目录 | **不必要**：基准代码应固定在仓内，报告记其提交即可；复制是为“防运行中被改”，应改成运行前后各验一次 | 删除复制 |
| run-config/approved-launch/run-freeze/source-manifest(467KB) | 每轮 | 配置与授权记录必要；467KB 逐文件清单可由源提交取代 | 保留前者，后者改为提交号 |
| command-evidence.jsonl | 每轮 0–129 MB | 排障有用，但体量说明记录了全部 docker 输出 | 限长、只记失败与摘要 |

### 2.5 环境脆弱点与现状（只读查询结果）

| 脆弱点 | 证据 | 稳妥做法 |
|---|---|---|
| WSL 内存固定 4GB | `C:\Users\ASUS\.wslconfig`：`[wsl2] networkingMode=mirrored memory=4GB`；A1：r4 WinError 1455、r18 cp 内存不足 | 开跑前体检读 `wsl --status`/可用内存，不足则拒跑并给出调整建议；大文件拷贝用流式而非 `docker cp` 全量 |
| Docker 地址池 | 每轮专属网络；R37/network-receipt.json（子网 10.243.37.0/24，检查了 172.17–31、192.168.x 等） | 自动选网：枚举所有现有网络与路由，在 10.243.0.0/16 里挑空闲 /24；网络与容器都打 `pao.bench.run=<id>` 标签，清理按标签 |
| 9p/跨系统路径 | `container_path/staged_path`（runner_common.py:326-358）；Harbor 异常栈里 `/run/desktop/mnt/host/d/...` 与 `/mnt/d/...` 并存 | 运行目录放 WSL ext4（或容器卷），结束后一次性复制结果回 D 盘 |
| 软件源/外网 | 24-r2：Node curl 35 SSL；已改本地包 | 全部离线缓存＋体检里校验缓存哈希 |
| Docker Desktop／WSL 未启动 | 本审核时 `wsl -l -v`：Ubuntu、docker-desktop 均 Stopped；`docker ps -a` 报无法连接 `dockerDesktopLinuxEngine` 管道 | 体检第一项：引擎可达；不可达则明确提示，不进入准备 |
| Harbor 与解释器在临时目录 | launch_run.py:21；TB/f-harbor-import/harbor-source（0.24.0，无 git）、TB/f-harbor-linux/.venv | 固定版本入仓内 `tools/` 或锁定的 uv 环境，镜像摘要写入配置 |
| 控制器容器挂整个 `D:/AI/workspace` | launch_run.py:190 | 只挂 run 目录、缓存、只读的题目输入；**不得挂正式 PAO_HOME** |
| 凭证接力 | `PAO_BENCH_API_KEY` 由临时启动脚本注入（如 TMP/launch-prepared-r31.py 末段从 `C:/Users/ASUS/.pi/agent/models.json` 读取密钥字段） | 由 `pao-bench` 从单一受控来源读取并只经进程环境传递，不落盘不入日志（本审核未读取凭证内容） |

### 2.6 临时脚本归类（TMP/，323 个文件、50 余个子目录）

| 类别 | 数量 | 为什么需要 | 新 harness 里对应的子命令 |
|---|---|---|---|
| 逐轮启动/准备（launch-prepared、prepare*、prepare-and-launch） | 19＋34 | 一轮一份：改 run 名、网络、sources.json | `prepare`/`run` |
| 逐轮网络覆盖 yaml、sources.json、previous-stop.json | 19＋19＋20 | 地址池、前轮清理证明 | 自动选网、`clean` |
| 收取/终态/监控（collect、terminal、watch、diagnose、inspect、audit） | 19＋14 | 观察器与终态判定不全 | `watch`、`collect`、`report` |
| 启动确认/授权（confirm、approve、finish start） | 9 | 人工签收流程 | 授权写进配置，一次确认 |
| 代码审查回执（rNN-code-review.json） | 16 | 逐轮 SHA 签收（A7 评议） | 由提交号取代 |
| 测试输出日志 | 106 | 补丁的验证记录 | 归标准检查产物 |
| 源码修改前备份（*.before*、.ts） | 16 | 无提交，靠备份回退 | 提交取代 |
| 其余（r2x–r3x 现场取证子目录、fixture） | 约 30 个子目录 | 取证 | 归入各运行目录 |


## 3. 问题清单

格式同 A3：严重度｜证据｜根因类别｜关联历史运行｜修复方向。

**A4-1 P0 观察器可终止整轮（观察与终止未分离）**
- 证据：BM/bench_controller.py:656-698（`supervise` 抛任何 `Exception`→`stop_acceptance`＋`current.cancel()`→`mechanism_stopped`）；:423、:498、:513、:522 为观察函数主动 `raise ValueError`；:321-328 `stop_acceptance` 写 `mechanism-acceptance-stopped.json` 且标 `writers_stopped=False`；:703-708 终局再观察一次，失败同样改写终态。
- 机理：`docker ps`/`docker exec`/tar 解析/YAML 解析/原子替换任一小故障，或模型把控制正本改名，都会让一小时的真实作答作废。观察器的错误与“被观察对象的问题”混为一谈。
- 类别：harness 自身。历史：r6（YAML 时间转 datetime）、r18、r24（`docker ps` 隐式算大小失败）、r30（Windows 原子替换 PermissionError）、r7、r21（控制正本被搬走）。每次修复只堵该异常，观察器仍有终止权。
- 修复（结构）：见 §4.2：观察器只写 `observations.jsonl` 与 `observer_error` 事件，永不取消作答；“完整性告警”（控制正本移位、多容器）进报告而非终止。保留的终止源只有：墙钟总预算、用户 `stop`、Harbor 自身结束。

**A4-2 P0 机制未完成即不评分，轮次无结论**
- 证据：SH/benchmark-organized-adapter.py:239-240（`status != 'completed'` 抛 `RuntimeError`）；R37/task-1-summary.json 的 `exception_message`＝“组织工作流未完成：status=hold”，发生在 51 分钟作答之后（agent_execution 07:15:40→08:06:05）；R37/control-status.json 终态 `execution_error`；A1 结论 1。
- 机理：组织协作的好坏被当成“trial 成功与否”，于是只要流程挂起/保留，Harbor 就不跑评分器，得到的只有“没有分数、没有结论”。同时 A1 指出出过的 8 个分是外层在流程未完成时照样评出的 0 分，也不代表协作质量。两种结局都不给出可比较的结论。
- 修复（结构）：适配器**永远正常结束**（把流程终态写进 `organization-terminal.json`），评分器永远运行；报告并列“流程终态”和“官方分”，并明确写出“流程未完成，分数仅代表半成品”。
- 关联：A2 的“无人值守终态”设计——流程要有失败/终止终态，适配器才能如实记录。

**A4-3 P1 流程启动与周期确认交给模型**
- 证据：adapter.py:92-98（“必须调用 pao_start_flow ……主控每 30 分钟监督…… pao_ack_supervision”）、:143-150（未启动即失败）。
- 机理：多一跳“模型必须照做”，且指令含固定中文流水线名与卡目录绝对路径；真实模型在此处偏差无法在离线测试里出现（离线从没有脚本化模型）。
- 修复（结构，与 A2/A5）：宿主在受理任务时按配置自动启流；监督确认改为程序心跳，不需要模型 `ack`。

**A4-4 P1 Docker 网络与地址池靠人工逐轮处理**
- 证据：TMP/rNN-network-override.yaml 19 份；R37/network-receipt.json、R37/network-override.yaml；TMP/diagnose-r37-network-conflict.py、TMP/r23-network-conflict-before.http；`launch-prepared-r31.py` 在启动前 `docker network inspect <本轮名>` 并核对标签/空容器。
- 机理：缺少统一的“选网＋建网＋打标签＋清理”，每轮由临时脚本手工完成；子网冲突故障（r19–r26 一带的网络覆盖、r37 冲突诊断）反复出现。
- 修复（局部→结构）：`pao-bench doctor/run` 自动选网（§4.4）。

**A4-5 P1 启动器写死环境，控制器容器暴露整个工作区**
- 证据：BM/launch_run.py:17-21（`D:/Docker/resources/bin/docker.exe`、镜像 `pao-benchmark-controller:20261021`、`D:/AI/workspace` 整体挂入、解释器在 TB/f-harbor-linux/.venv）、:187-199；BM/watch_run.py:19。
- 机理：控制器容器可读写 `D:/AI/workspace` 下一切（含正式 PAO_HOME `D:\AI\workspace\pao`，任务书 §2.2 明令不碰），并持有 docker.sock（等同宿主 root）；解释器/Harbor 放在“临时文件夹”，没有锁定版本与摘要来源（Harbor 目录无 git）。
- 修复（结构）：只挂 run 目录、缓存、题目输入；Harbor 与 Python 环境在仓内由锁文件构建（BM/requirements-venv.lock 已有，97 行）。

**A4-6 P1 每轮复制不变大件，运行目录体量失控**
- 证据：§1 结论 5 的统计（35×31.5 MB、32×21.2 MB、42×~10 MB；总 3569 MB；`command-evidence.jsonl` 561 MB）。
- 机理：磁盘占用大本身是 P2；但 `docker cp` 内存不足（r18）、WinError 1455（r4）与大文件拷贝同源（推断），每轮重新拷贝 ~65 MB 也拉长准备时间。
- 修复（局部）：内容寻址缓存，运行目录只存哈希引用。

**A4-7 P1 被测代码不可复现：打包包含未跟踪文件，不记 HEAD 与脏状态**
- 证据：BM/runner_common.py:427-498（`git ls-files --cached --others`）；10-26 11:26 之后内核、开发根、桌面均无提交（A1 结论 7）。
- 机理：同一个 r 号，只靠 `source-manifest.json`（467 KB 的文件哈希表）识别代码；没有提交号，也就无法回答“r37 之后改了什么”。评测结论与代码版本的对应只能靠 TMP/rNN-code-review.json 的人工 SHA 签收。
- 修复（局部）：运行前要求工作区干净或把补丁以 `git diff` 形式一并冻结；报告首行写 HEAD 与补丁哈希。

**A4-8 P1 题目、profile、工具集、凭据名以 `if` 写死**
- 证据：BM/runner_common.py:190,210,224-250（题目必须是 html-js-filter、`post-pao`、`high`、`read,bash,edit,write`、`PAO_BENCH_API_KEY`、`import_path` 固定）。
- 机理：任何离线彩排、换题、换模型都必须改代码；测试只能构造“合规 config”绕过。
- 修复（结构）：契约变成配置文件里的数据（`bench.toml`），校验器通用（只校“配置内部一致＋与冻结一致”）。

**A4-9 P1 两个观察实现同时运行，证据量失控**
- 证据：控制器内 `observe_runtime`（5 秒）＋ `watch_run.py`（R37/observer-receipt.json：间隔 15 秒，上限 21600 秒）；`compose_project`（bench_controller.py:526）与 `watch_run.expected_projects/score_container_name`（:101-122）两份推导；`command-evidence.jsonl` 561 MB。
- 机理：观察读 `docker exec` 会与被观察容器竞争（推断）；两处推导不一致就出现“漏认评分容器”类误判（A1 观察类）。
- 修复（结构）：单一观察器模块，单一命名函数；证据限长。

**A4-10 P1 独占启动标记使任何一次中断都要重做整轮**
- 证据：bench_controller.py:571-573（`open(..., "x")` 且“不删除”）、launch_run.py:141-144。
- 机理：设计目的是防“自动重放”，代价是控制器崩溃（r30）、宿主休眠、网络闪断后无法续跑；一轮 1–2 小时，A1 统计两轮之间中位约 2 小时。
- 修复（结构）：运行状态落 `events.jsonl`（追加）；同一 run id 允许 `resume`，由状态机判定可恢复点（预检通过后、作答未开始/已结束时可重入；作答进行中则要求先 `clean`）。

**A4-11 P1 适配器每个 trial 重传 10 个文件并现场安装，探针与真实路径不同**
- 证据：adapter.py:40-49（上传 10 个文件含 3039 行副本）、:50-89（setup＋三角色工具探针＋子进程 RPC 探针，安装耗时 56 秒：R37/task-1-summary.json）；探针通过 `probe-tools.mjs`/`probe-child-rpc.mjs` 自装配，而不是真实 `pao` 路径（A3-3）。
- 机理：预检过了不等于真实入口过（A1：r8、r17 探针契约）。
- 修复（结构）：预检就是“用真实入口、脚本化模型跑一遍极小任务”（§4.5 彩排），不再有专用探针脚本。

**A4-12 P2 测试体量与覆盖形态**
- 证据：BM/test_governance_runner.py 4034 行、54 个用例；test_bench_controller.py 23；test_final_assembly.py 2；test_prepare_sources.py 7；test_pao_agent.py 14；test_usage.py 15；全部用 `unittest.mock` 替换 Docker/Harbor，检索无脚本化模型（无 `http.server`/Fake 模型命中）。
- 机理：测的是控制器的分支，不是“整链能不能跑通”；A1 结论 6 的另一面。
- 修复：保留与新 harness 同职能的用例，其余冻结；新增 §5 的彩排用例。

**A4-13 P2 路径转换与双份目录**
- 证据：runner_common.py:326-358（`container_path`、`staged_path`）、launch_run.py:19-21 与 mounts；Harbor 异常栈里 `/run/desktop/mnt/host/d/...`（9p）。
- 修复：运行目录放 WSL ext4 或容器卷，减少转换点。

**A4-14 P2 旧版/重复文件并存**
- 证据：TB/ 下 controller.py、prepare-real-run.py、launch-controller.py、freeze-run-inputs.py 等 20+ 个脚本；BM/configs/ 三份 yaml（pre-pao、single、post-pao）而当前只允许 post-pao（runner_common.py:242）；BM/scripts/single-entry.mjs、probe-single.mjs 属 single profile。
- 修复：§6 清单。

**A4-15 P1 开跑前缺统一体检**
- 证据：§2.5：Docker/WSL 停止、WSL 4GB、网络冲突等均靠故障触发后补检查；`doctor` 之类入口不存在（BM/控制器使用说明.md 50 行，仅描述子命令 validate/run/status/pause/score）。
- 修复：`pao-bench doctor`，所有检查一屏输出、可脚本化。


## 4. 大刀阔斧的目标设计

### 4.1 总体：一个命令入口，一份配置，一个事件账本

`pao-bench`（Python 包，源码放开发根 `tools/pao-bench/`，**进 git**；不再放 `.pao/`，`.pao/` 只留每轮运行留档）。运行状态的唯一正本是运行目录里的 `events.jsonl`（追加写），`status`、报告、`control-status.json` 都从它派生（任务书原则 4：一个事实一个家）。

| 子命令 | 作用 | 取代 |
|---|---|---|
| `doctor` | 体检：Docker 引擎可达、WSL 状态与内存、磁盘、缓存哈希、工作区干净度、网络可选、模型端点可达（彩排则本机端口） | 故障后补的各种检查、TMP/diagnose-*.py |
| `prepare` | 读 `bench.toml`，把缓存件按哈希引用，冻结被测提交（或提交＋补丁）、题目输入、配置，写 `run.json` | prepare_run.py、prepare-and-launch-rNN.py、rNN-sources.json |
| `run` | 一条命令跑完：doctor→prepare→选网→启动→预检→作答→终局→收取→评分→报告；`--rehearsal` 用脚本化模型；`--detach` 后台跑 | launch_run.py、launch-prepared-rNN.py、collect-rNN-*.py |
| `watch` / `status` | 只读观察与一屏状态；不持有终止权 | watch_run.py、控制器 `status` |
| `stop` | 用户显式停止（唯一的人为终止入口），停写后确认 | 暂停请求文件 |
| `score` | 对已停止的现场补评分（沿用 `score_current` 的哈希核对） | score_current |
| `clean` | 按标签 `pao.bench.run=<id>` 删容器与网络，可重复执行、无副作用 | rNN-previous-stop.json、手工删网 |
| `report` | 生成 `report.md`＋`report.json`（见 §4.6） | 手写留档 |

配置 `bench.toml`（一份，可多题；契约是数据）：
```
[run]      id = "auto"; budget_minutes = 150; unattended = true
[code]     repo = "PAO"; rev = "HEAD"; require_clean = true   # 否则冻结 diff
[task]     name = "terminal-bench/html-js-filter"; tools = "read,bash,edit,write"
[model]    mode = "real" | "scripted"; provider/model/thinking; key_env = "PAO_BENCH_API_KEY"
[env]      docker = "auto"; network = "auto"; wsl_workdir = "~/pao-bench/runs"
[observe]  interval_s = 15; evidence_max_mb = 5
[organization] recipe = "benchmark-flow"  # 配方直接取自产品配方，不再有 kit.json 副本
```

### 4.2 观察器只观察（回答 A4-1/A4-2）
1. 观察器是独立线程/进程，异常捕获后只写 `{event:"observer_error", where, error}`，下一轮继续；连续 N 次失败只在报告标红，**不动作答**。
2. 终止源只有四个，且都显式记入账本：墙钟预算到、`stop` 命令、Harbor 作业自然结束、体检失败（作答前）。
3. “完整性告警”（控制正本被搬走/多实例/多容器/冻结文件被改）写 `integrity_alert`，进入报告的“结论可信度”栏；报告据此把结果标为“机制验收：不可信”，但仍收取成果并评分。
4. 冻结输入只在作答前、作答后各验一次（取代每 5 秒的 stat 比对）。
5. 终态查询与评分不依赖流程是否 `completed`：适配器永远 `exit 0`，把 `organization-terminal.json`（状态、原因、挂起点）放进 `/logs/agent/`，评分器照常运行。

### 4.3 直接走产品宿主路径（与 A3 §4.1 对接）
- 删除 `benchmark-organized-entry.mjs`、`benchmark-host-factories.mjs`、`benchmark-child-entry.mjs`、`benchmark-worktree-host.mjs`（3039 行）、`probe-child-rpc.mjs`、`probe-tools.mjs`、`activate-tools.mjs`、`query-organized-terminal.mjs` 与 organized-post 里的副本。
- 适配器（`benchmark-organized-adapter.py` 240 行 → 约 80 行）只做：安装冻结的内核包与 Node → 写 `models.json`/档位/设置 → 以产品命令 `pao --print --mode json --tools read,bash,edit,write …` 启动 → 收集 `/logs/agent`。配方由产品的“导入配方”命令（或把 `kit.json` 的 `departments`/`workflow` 作为配置文件落在 `PAO_HOME`）装入，`setup.mjs` 的职责缩成“写目录＋Git 基线”。
- 需要内核先提供（A3 的 M1–M2）：默认本地文件版工作树服务、`resolveHostEnv`、受理后自动启流（A2）；这三项完成前，基准无法直接走产品路径，所以 harness 重写与 A3 M2 可并行但 M4 必须在其后。

### 4.4 环境：自动选网、体检、清理
- **自动选网**：`doctor` 枚举 `docker network ls/inspect` 的全部子网与宿主路由（`route print`/`ip route`），在保留段 `10.243.0.0/16` 内顺序挑第一个不重叠的 /24；创建 `docker network create --subnet … --label pao.bench.run=<id>`；Harbor 通过 compose override 使用该外部网络（现有做法：R37/network-override.yaml，仅改为自动生成）。
- **体检清单**：①`docker version` 与引擎管道可达（本次审核时不可达）；②`wsl -l -v` 状态、可用内存 ≥ 阈值（现 `.wslconfig` memory=4GB，可读出并提示）；③磁盘与缓存哈希；④无同名残留容器/网络；⑤工作区干净或补丁已冻结；⑥模型端点可达（彩排检查本机端口）；⑦凭证环境变量存在但**不打印**。
- **运行目录位置**：放 WSL ext4（`~/pao-bench/runs/<id>`），结束后打包复制回 `D:\...\runs\<id>`，避开 9p 与路径转换（推断收益，需实测）。
- **控制器位置**：首选“`pao-bench` 直接在 WSL Ubuntu 里运行，调用 Docker Desktop 的 docker CLI”，去掉“控制器容器＋docker.sock＋挂整个工作区”这一层；若保留容器，只挂 run 目录、缓存和只读题目输入（A4-5）。Ubuntu 发行版在本机已存在（`wsl -l -v` 可见，已停止）；其内是否装有 Docker CLI/集成未查（见 §6）。
- **清理**：`clean --run <id>` 按标签列出并删除容器、网络；`--all-stale` 删除超过 N 小时且无活动容器的；可重复执行，输出“删了什么”。

### 4.5 彩排模式：脚本化模型服务（回答任务书 §6.4 第 5 问）
可行性已有证据：Harbor 自带的 Pi 代理已支持自定义端点——`user_supplied_base_url` 加 `model_api`（`openai-completions`/`openai-responses`/`anthropic-messages`…），并生成 `harbor-endpoint` 供应商（TB/f-harbor-import/harbor-source/src/harbor/agents/installed/pi.py `_build_custom_models_json`，输出 `baseUrl`、`api`）；`map_bench_pao/pao_agent.py:286-306` 已用它并要求“可信模型元数据”。因此**只需让端点指向本机服务，不改内核、不改 Harbor**。

最小实现（约 250–300 行，Python 标准库，也可放进 Node 测试辅助）：
1. `POST /v1/chat/completions`（流式 SSE 与非流式各一条路径），按请求里的 `messages`＋`tools` 判断“当前是谁、第几轮”：角色靠系统提示里的部门名/工具集合（工人没有 `pao_start_flow`、部长没有扇出）；每个会话按 `会话键＝首条用户消息哈希` 保持步号。
2. 脚本是 `rehearsal/scripts/<role>.yaml`：每步 `when`（角色、可用工具、上一步工具结果包含的字符串）→ `reply`（文本或 `tool_calls: [{name, arguments}]`）。含标准“快乐路径”脚本，覆盖受理→侦察→规划→实施（工人改文件、自测、回执）→交付→审核→结束。
3. 故障注入作为步骤属性：`prose_wrap_json`（回执 JSON 被说明文字/围栏包裹）、`drop_field`（回执缺字段）、`not_run`（工人自报未运行）、`bad_quote`（命令嵌套引号/转义）、`out_of_order`（乱序调用工具）、`delay_ms`（慢响应）、`abort_after_chunks`（断流）、`exit_child`（令工人子进程中途退出，通过工具触发 `process.exit`）。这些就是任务书 §5 的偏差清单与 A1 的历史故障表。
4. 输出 `usage`（固定 token 数）以便费用统计路径也被走过；记录每次请求到 `rehearsal-trace.jsonl`，作为离线回归的黄金记录。
5. 两个层级：**L1 本机层**（不需要 Docker）：`pao-bench run --rehearsal --local` 在本机临时 Git 仓与临时 `PAO_HOME` 里直接起产品 `pao`（A3 的 `assemblePao`），10 分钟内跑完；**L2 容器层**：同一脚本，经 Harbor 自定义端点（`host.docker.internal`）进 Linux 容器，用来发现 Windows/Linux 差异（树杀、路径、9p）。
局限：脚本化模型验证“协议、状态机、生命周期”，不验证真实模型的语义偏差；按任务书最终仍要一次真实模型确认（须用户授权付费）。

### 4.6 自动生成运行报告
`report.md` 固定栏目：①被测版本（HEAD、补丁哈希）与配置摘要；②环境体检结果；③时间线（准备/预检/作答/终局/评分，各自耗时，对照 R37：环境 3s、安装 56s、作答 51m）；④协作终态（流程状态、停点、挂起原因、谁能解除）；⑤官方评分（若有）与“半成品声明”；⑥结论可信度（`integrity_alert`、`observer_error` 汇总）；⑦成本与 token（含“下界”标注）；⑧产物清单与大小。目的：取代手写留档与 TMP/ 里的收取脚本，一轮一份固定格式，机器可比较。

### 4.7 迁移步骤与风险
| 步 | 内容 | 风险与对策 |
|---|---|---|
| H0 | 提交现有脚本与测试作基线；把观察器改为只观察（先在旧控制器上做一个 20 行补丁验证 A4-1） | 旧控制器仍在用，补丁须有回归用例 |
| H1 | `tools/pao-bench` 骨架：`doctor`、`clean`、自动选网、账本；用 `docker` 命令垫片（PATH 替身）写自动测试 | 垫片与真 Docker 行为差，需在 L2 层补一次真机验证 |
| H2 | 脚本化模型服务＋L1 彩排 | 依赖 A3 M2 的统一装配；此前可先对现有 CLI 跑通基本路径 |
| H3 | `prepare/run/report` 与 Harbor 适配器瘦身，删除副本 | 适配器改动影响所有 Harbor 运行：保留旧入口一个版本周期 |
| H4 | 冻结 BM/ 旧脚本（只读），TMP/ 归档 | 归档前确认没有未入账的证据 |

## 5. 离线验证方式

| 问题 | 怎么在离线抓到 | 判据 |
|---|---|---|
| A4-1 | 在 harness 单测里注入观察故障：`docker ps` 非零、返回乱码、超时；写文件抛 `PermissionError`；YAML 含时间；容器内控制正本改名（r6/r18/r24/r30/r7/r21 逐个复现） | 旧控制器上红（作答被取消）；新 harness 上作答照常结束，账本有对应 `observer_error`/`integrity_alert` |
| A4-2 | 彩排脚本让流程停在 `hold`（人工门）和 `failed` | 适配器 exit 0，评分器运行，报告“流程未完成”栏正确 |
| A4-3 | 彩排脚本里模型“忘记调用启流工具” | 自动启流使流程仍然开始（A2/A5 配合） |
| A4-4 | 垫片预建 N 个占用 10.243.x.0/24 的网络，另有与宿主路由冲突的网段 | `doctor` 选到空闲子网；`clean` 后幂等 |
| A4-5 | 配置检查：挂载列表不得含 `D:/AI/workspace` 根与正式 PAO_HOME | 违规则 `doctor` 红 |
| A4-6/7 | `prepare` 两次相同输入 | 缓存命中、运行目录无大件副本；报告含 HEAD/补丁哈希；工作区脏且未冻结补丁则拒绝 |
| A4-8 | 用 `bench.toml` 改题目/工具集 | 无需改代码，校验器通过 |
| A4-9 | 同时开 `watch` 与 run 内观察 | 只有一个观察模块；命名函数单测覆盖评分容器 |
| A4-10 | 作答中杀控制器进程，再 `resume` | 按账本判定可恢复点，或明确要求 `clean` |
| A4-11 | 彩排 L2 层使用真实入口 | 无专用探针脚本，装配错误（缺文件、变量名）在预检内暴露 |
| 总体 G1 | `run --rehearsal` 全链，单次 ≤10 分钟 | 并入标准检查 |

## 6. 冻结与删除清单（只列不执行）

**冻结为历史（保留只读，不再被引用）**：`BM/` 下 `bench_controller.py`、`prepare_run.py`、`launch_run.py`、`watch_run.py`、`runner_common.py` 与对应测试（`test_governance_runner.py` 4034 行、`test_bench_controller.py`、`test_final_assembly.py`、`test_prepare_sources.py`）；`F离线准备收尾报告.md`、`F真实对比最小准备.md`、`真实对比运行记录.md`（以报告归档）；43 个 `real-run-*` 目录（先抽出各轮 terminal-receipt/task-summary/control-status 汇总为一张总表，再把 r37 与一个更早的代表轮留作回归夹具）。

**可以删除**：各 `real-run-*` 里重复的 `node-v24.18.0-linux-x64.tar.xz`(35 份)、`git-system-dependencies.zip`(32 份)、`model-data.zip`(25 份)、`source.zip` 中非留作夹具的副本——约 2.1 GB（以缓存引用代替）；`command-evidence.jsonl` 超过阈值的部分；`BM/configs/pre-pao.yaml`、`single.yaml`、`scripts/single-entry.mjs`、`probe-single.mjs`、`organized-post/` 下 7 份 SH 副本；`SH/benchmark-worktree-host.mjs` 等（A3 §4.4）；TMP/ 全部 323 个顶层文件与 50 余个取证子目录在归档（压缩一份留证）后清空，其中 `*.before*`、`rNN-code-review.json` 因被提交取代可直接删；TB/ 下早期脚本。

**保留并迁入新 harness**：`fixed-manifest.json`、`dependency-lock.json`、`dependency-audit.json`、`requirements-venv.lock`、`public-inputs.json`、`model-metadata.json`、`real-run-authorization.json`（作为配置/授权模板）；`map_bench_pao/pao_agent.py` 的 Harbor 适配核心（需瘦身）与 `usage.py`（`test_usage.py` 15 例保留）；`score_current` 的评分哈希核对逻辑；`Controller.Dockerfile`（若保留容器方案）。

## 7. 未查清项

1. **Docker 与 WSL 当前均为停止状态**（`wsl -l -v`：Ubuntu、docker-desktop 均 Stopped；`docker ps -a`/`network ls`/`images` 报引擎管道不存在），无法列出现存容器、网络与镜像；因此地址池占用、残留网络数量、控制器镜像是否存在均**未实测**，上面的网络结论来自 R37/network-receipt.json 与 A1。按硬性约束未启动 Docker。
2. WSL Ubuntu 内是否已有 Docker CLI/集成、可用内存与磁盘，未查（需启动 WSL，超出只读约束）。
3. “运行目录放 ext4 能减少故障”“`docker exec` 观察与被观察容器竞争”均为推断，未实测。
4. 脚本化模型对 PAO 实际请求形态（工具调用格式、流式事件、`thinking` 字段、`sendSessionAffinityHeaders`）的兼容细节未验证；需读内核 provider 层（A5 范围）后在 H2 实测。
5. `prepare_run.py` 内 `build_package_assembly`（:58-160）与 `derive_kit`（:228-285）、`watch_run.py` 的 `_discover_scope`（:233-394）只读了入口与注释，未逐行核对；`test_governance_runner.py` 54 个用例只统计了数量与导入，未逐个分类。
6. TMP/ 的 323 个文件为顶层文件数；任务书的 372 含子目录文件，本审核按用途归类了顶层与目录名，未逐个读内容。
7. 凭证相关：发现 TMP 启动脚本会从用户 `.pi/agent/models.json` 读取密钥字段，本审核未读取、未复述其内容；是否需要改为受控来源由主控决定。
8. 与 A2/A3/A5 的耦合点（自动启流、无人值守终态、统一装配）依赖其定案，H3/H4 的具体接口待 P2 汇总后确认。
