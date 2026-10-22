# F 监控修复报告

主控整合补核：探针自己的Python进程曾被算作题目程序，已在`/proc`采样中排除自身PID，保留其他真实Python程序。新真实探针增加“观测者不冒充题目程序”断言，14项全部通过并清理容器；原13项通过证据保存在`F-real-probe-before-self-exclusion.json`。文末源码哈希为代理收尾时的身份；最终源码与证据身份以本批增量及统一报告为准。

## 结论

批次 F 已完成并通过离线自测和真实改名进程探针。

- 资源监控现在以 `/proc/<pid>/exe` 识别实际运行时，不再把可变的 `argv[0]` 当作 Node 身份。
- PAO 内核身份采用组合证据：实际可执行文件是 Node/Electron run-as-node；参数中有已知 PAO 入口，或在入口被 `process.title` 覆盖后标题精确匹配 `pao` / `pao-rpc` 且 `PI_CODING_AGENT=true`。
- 普通 Node 子程序只保留安全的展示字段；即使继承 `PAO_ROLE`、`PAO_DEPT`、`PI_CODING_AGENT`，只要不是已知入口且没有精确 PAO 标题，就归为 `task-node`，角色和部门不继承。
- 每进程使用“容器 + PID + 启动时刻（`start_ticks`）”作匹配键；短进程退出、读取权限不足和 PID 复用均不填 0。
- 准备、正式模型、模型空闲、题目程序和未知状态使用互不重叠的分类；缺少明确准备证据时保持 `unknown`。

本轮只修改了两个目标监控脚本，并新增一个本批临时真实探针。未修改 controller、产品源码、正式 PAO_HOME，未安装依赖，未调用模型，未启动历史测试或 Docker 服务。

## 经过

先核对基线和代码图，再比较目标脚本与 `.pao/具体故障修复-20261022/before/monitor/` 的冻结副本，确认开工时未被其他修改覆盖。

首轮真实探针暴露了夹具问题：`NODE_OPTIONS=--require` 对普通题目进程也生效，导致题目脚本同样执行了 `process.title="pao"`，无法证明真实身份规则。该失败结果已保留为 [F-real-probe-pre-fix-failed.json](D:/AI/workspace/pao-dev/.pao/具体故障修复-20261022/F-real-probe-pre-fix-failed.json)。

修正夹具后，只有已知 bundle `rpc-entry.js` 和 `cli.js` 会改名，普通任务保持 `argv[0]=node`；另设一个移除 `PI_CODING_AGENT` 但自行把标题改成 `pao` 的对照。修改身份逻辑前再次真实采样，RPC 和 CLI 都因标题覆盖而丢失脚本参数并被误归为 `task-node`。该证据保留为 [F-real-probe-pre-identity-fix-failed.json](D:/AI/workspace/pao-dev/.pao/具体故障修复-20261022/F-real-probe-pre-identity-fix-failed.json)。

随后修改 `PROBE` 的组合识别并复跑同一真实场景，全部断言通过。

主控复核又发现阶段推断过宽：`agent_settled` 只表示模型本轮结束，后台工作仍可能继续；仅出现 Node/Python 也不能证明正在准备。修复前真实探针证据保留为 [F-real-probe-pre-phase-fix.json](D:/AI/workspace/pao-dev/.pao/具体故障修复-20261022/F-real-probe-pre-phase-fix.json)。阶段修复后再次短跑真实探针，实际 `category=unknown`，证据为 [F-real-probe.json](D:/AI/workspace/pao-dev/.pao/具体故障修复-20261022/F-real-probe.json)。

## 做了什么

### [resource-monitor.py](D:/AI/workspace/临时文件夹/PAO三题复测-20261022/resource-monitor.py)

- 用 `/proc/<pid>/exe` 的 basename 判定 Node、Electron、Bun、Python；Node/Electron 的 `argv[0]` 不再承担身份判定。
- 参数仍含 `/tmp/harbor-pao-source/**/dist/cli.js` 或 `rpc-entry.js` 时，按已知入口识别。
- 入口被 `process.title` 覆盖时，仅在 Node/Electron、精确标题 `pao`/`pao-rpc`、`PI_CODING_AGENT=true` 三项同时成立时还原 CLI/RPC 身份。
- 只读取 `PAO_ROLE`、`PAO_DEPT`、`PI_CODING_AGENT`、`ELECTRON_RUN_AS_NODE` 四个白名单环境字段，不返回完整环境。
- `worker`、`部长`/`minister`、`主控`/`master`/`main` 统一规范化；非法 PAO 角色记录 `invalid_pao_role`。
- 无 PAO 身份证据的 Node 一律为 `task-node`，角色清空并记录 `inherited_role_ignored`。
- PID 资源状态以 `container:pid:start_ticks` 关联；启动时刻变化视为新进程，不沿用旧 CPU/RSS。
- 进程扫描的退出、权限及解析异常进入 `scan_errors`，再作为 `proc_scan_failed` 写入样本错误。
- CPU、RSS 未知值保持 `None`。组内只要有一个进程 RSS 未知，组总 `rss` 也保持 `None`，另提供 `rss_known_sum` 和 `rss_unknown_process_count`。
- 容器分为 `controller`、`trial-main`、`verifier`、`service`。
- 阶段分类：`agent_start` 的非题目内核归入 `formal_model`；`agent_settled` 归入独立的 `model_idle`，表示模型已结束但后台状态未知；题目 Node/Bun/Python 始终归入 `task_program`；其余保留 `unknown`。Node/Python 的存在不再推断为准备阶段。
- `preparation` 只保留给后续可提供明确准备标记的输入；当前没有独立准备标记，因此不凭进程组合猜测。
- 汇总新增观测进程、运行时类型，以及准备、正式模型、模型空闲、题目程序、未知五类互斥计数，保留原有采样与摘要输出。

### [resource-monitor-selftest.py](D:/AI/workspace/临时文件夹/PAO三题复测-20261022/resource-monitor-selftest.py)

- 保留假 Docker 自测，不启动容器、不访问真实运行目录。
- 覆盖 setup pending、Python 不可用、只探测主容器、PAO 角色、题目 Node/Bun/Python、PID 复用、重复进程键、阶段互斥和容器分类。
- 明确断言 `agent_settled` 得到 `model_idle`；只有题目 Node/Python、没有阶段标记时得到 `unknown`。
- 模拟 `process_exited`、`exe_permission_denied` 和未知 CPU/RSS，断言错误被记录且指标不填 0。
- 在进程记录中注入额外 `secret` 字段，断言输出白名单会将其过滤。

### [resource-monitor-real-probe.py](D:/AI/workspace/临时文件夹/PAO三题复测-20261022/resource-monitor-real-probe.py)

- 使用本机已有的 Linux 镜像 `sha256:9779ef143cc897dcaf255f82167d0e070c2d2fa3671a57517fc8ef779d88610a`，该镜像同时包含 Node 和 Python 3。
- 启动一个短命真实容器，产生四类 Node 进程：
  - `pao-rpc`：已知 RPC 入口改名，`PI_CODING_AGENT=true`。
  - `pao`：已知 CLI 入口改名，`PI_CODING_AGENT=true`。
  - 普通任务：保持 `argv[0]=node`，继承完整角色和 `PI_CODING_AGENT`。
  - 标题对照：无 `PI_CODING_AGENT`，仅把标题改成 `pao`。
- 探针结束后强制删除容器，再按名称查询残留并删除临时目录。

## 实际验证

| 检查 | 实际命令 | 结果 |
|---|---|---|
| Python 语法 | `C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe -m py_compile resource-monitor.py resource-monitor-selftest.py resource-monitor-real-probe.py` | 通过，退出码 0，无输出 |
| 离线自测 | `C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe resource-monitor-selftest.py` | 通过：`ok=true`，stats 4、precheck 4、probe 2；只对主容器执行 probe |
| 镜像确认 | `D:/Docker/resources/bin/docker.exe image inspect --format ... 9779ef143cc8` | 通过，amd64/Linux；容器内 `node`、`python3` 均存在 |
| 改前真实探针 | 同一 `resource-monitor-real-probe.py`，身份组合规则修改前运行 | 失败证据已保留：改名 RPC/CLI 被归为 `task-node` |
| 改后真实探针 | `C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe resource-monitor-real-probe.py` | 通过，13 项断言全为 true；阶段实际为 `unknown` |
| 清理确认 | `D:/Docker/resources/bin/docker.exe ps -a --filter name=pao-f- ...` | 无本轮残留容器；删除容器返回码 0 |

最终真实探针的关键结果：

| 场景 | 实际结果 |
|---|---|
| RPC 改名 | `runtime=node`、`kind=pao-runtime`、`identity=pao-rpc`、角色 `部长`、部门 `实施` |
| CLI 改名 | `runtime=node`、`kind=pao-runtime`、`identity=pao-cli`、角色 `worker`、部门 `内核` |
| 普通任务继承角色和 Agent 标记 | `title=node`、`kind=task-node`、`role=null`、`inherited_role_ignored=true` |
| 仅标题为 `pao`、无 Agent 标记 | `kind=task-node`、`role=null`、`agent_env=false` |
| 探测状态 | `probe_status=collected`、`phase.category=unknown`、无探针错误 |

完整差异补丁：[F-current-vs-before.patch](D:/AI/workspace/临时文件夹/PAO三题复测-20261022/F-current-vs-before.patch)，SHA-256 为 `495B6E355E05FCAD6975B27BA56023B29AEE4CBE0368AB24894955D52619E71A`。

文件 SHA-256：

- `resource-monitor.py`：`76498E3AC6493CAE5240DDE337245D064926B91E0C71EE3A574FF0F42B35E461`
- `resource-monitor-selftest.py`：`68AE9FD61746F4B46F3B03C15A55A8D623CC68BA06C3F75F58869F11FAB80C1B`
- `resource-monitor-real-probe.py`：`6794D1A0015D0BD53B1FFCCADBC8FDB11FCE5EA936CA3797442A7D4148DDDD3B`
- `F-real-probe.json`：`CF033B9EDE4FC7D3D3A21FD2FEEBDFF7DB1AB908F851ABEE2AEA57D5976E0836`
- `F-real-probe-pre-fix-failed.json`：`A5EB6653B794C454A16403D13947B3E46B88CD93952248CD585F278C423315C1`
- `F-real-probe-pre-identity-fix-failed.json`：`A8BA843D05F6ED843C6C8D3F7E6140BB6B839CEF7AD0EE9D885280D8F121C04F`
- `F-real-probe-pre-phase-fix.json`：`6A3284067CD2D72E1BBFDFB1F27474BFEA40D62A024602D3A4A3AE5466FDDF42`

## 未验与限制

- PID 复用只通过离线改变 `start_ticks` 验证，未等待真实 PID 回绕。
- 短进程退出和权限拒绝只通过离线模拟错误验证；真实容器以 root 运行，未自然制造权限拒绝。
- 真实探针覆盖了 Node 标题覆盖和普通任务隔离，未覆盖 Electron run-as-node、Bun 的 PAO 身份和容器内权限受限用户。
- 未运行真实三题复测，未验证一整个真实运行周期中的阶段日志切换和汇总稳定性。
- 真实改名探针只验证了“无阶段标记时保持 `unknown`”；`model_idle` 与 `formal_model` 的切换由离线日志回归覆盖，未在完整真实运行周期中验证。当前没有明确准备标记，准备阶段识别未验证，不能宣称三阶段已全验。

## 待决策

无。批次 F 的指定边界内工作已完成。
