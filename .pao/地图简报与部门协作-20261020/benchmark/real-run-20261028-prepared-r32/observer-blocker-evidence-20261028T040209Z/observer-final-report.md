# r32 故障观察终局报告

## 结论

r32 的真实模型执行已经发生，但没有走到审核、交卷或有效官方评分。最终停因是实施卡 0001 的两次 worker 尝试均在合法 JSON 回执前附加了一句说明，严格回执解析器要求整条最终消息就是 JSON，因此两次均记为“无有效回执”。实施部长随后建立人工裁定门，请求主控选择 A、B、C。观察代理按本轮授权调用既有 `bench_controller.py pause`，控制器与所有本轮容器已真实停止。

这不是业务正常完成，也不是真实官方 0 分。正式结果中的 `mean: 0.0` 对应 `n_trials=0`、`n_errors=1`，只能记为无有效奖励。

本报告未确认存在独立于人工门的 PAO harness 故障。地图过期曾在同一轮前段触发停链，但地图复核后自动链已经恢复，不能把它写成最终停因。

## 身份与范围

| 项目 | 实际值 |
|---|---|
| 运行目录 | `D:\AI\workspace\pao-dev\.pao\地图简报与部门协作-20261020\benchmark\real-run-20261028-prepared-r32` |
| 控制器 | `pao-audit-first-20261028-r32` |
| 控制器 ID | `2733fbca66989a7e8fb6fa01216c722c34e23914eb9162a9357d5a30ce30aa85` |
| 冻结源码 SHA-256 | `b771491918cfa46b5d2d6edc2477ba87c207a69167c9ecadf7147a121558ba32` |
| 模型与档位 | `MiniMax-M3.1-Flash` / `high` |
| 正式实例 | `0fb6d724-268d-480e-9852-b4e5bae8e324` |
| owner | `01a17ee8-adc6-77bb-b948-212697a827cf` |
| 观察代理 | `01a17c50-e551-7b70-bfe8-ab77da9a2d07` |
| 唯一收取器 | `watch_run.py`，PID 23056，父 PID 24764 |

本轮只运行 `html-js-filter`。未运行后两道题，未读取隐藏测试帮助模型，未操作正式 PAO_HOME、历史冻结或历史容器，未启动 r33。

## 时间线

| UTC 时间 | 事件 |
|---|---|
| 2026-10-27 19:45:16 | 控制器进入 running。 |
| 2026-10-27 19:49:07 | 机制摘要绑定正式实例 `0fb6d724-268d-480e-9852-b4e5bae8e324`。 |
| 2026-10-27 19:54:43 至 19:57:13 | worker 尝试 1 执行并留下实时会话证据。 |
| 2026-10-27 19:57:30 | 自动链因派发交接的地图覆盖内容变化而停。随后原规划部长复核并保存新地图，链条恢复。 |
| 2026-10-27 19:58:30 至 19:59:57 | worker 尝试 2 执行并留下实时会话证据。 |
| 2026-10-27 20:01:06 | 规划部长完成地图交接。 |
| 2026-10-27 20:01:11 | 实施部长发布 blocker，`needs_manual_check=true`，请求主控选择 A、B、C。 |
| 2026-10-27 20:02:10 | 观察代理写入 `control-request.json`，要求立即暂停。 |
| 2026-10-27 20:02:15 | 官方 trial 记录 `CancelledError`。 |
| 2026-10-27 20:02:28 | `control-status.json` 记录 `state=paused`、`writers_stopped=true`。 |
| 2026-10-27 20:02:30 | 控制器容器停止，退出码 0。 |
| 2026-10-27 20:02:37 | 唯一收取器写完 `terminal-receipt.json` 并结束。 |

## 最终 blocker

两次 worker 尝试都留下了产物与自检证据，但最终消息不是单一纯 JSON：

- 产物包括 `/app/filter.py` 和 `/app/filter_check.py`。
- `/app/filter_selftest.py` 到暂停时仍不存在。
- worker 在 JSON 前多写了一行“修复完成，验收命令均退出码 0，61 项断言全 OK。”
- JSON 本身字段齐全，但解析器对整条最终消息做严格 JSON 解析，因此把回执判为无效。

该事实来自第 1、2 次 worker 的 `.live.jsonl.gz` 原始会话、`mechanism-progress.json`、`notifications.jsonl` 和实施部长留证。完整容器 `.pao/benchmark` 已只读复制到 `container-pao-benchmark/`；不存在的 `filter_selftest.py` 没有被伪造或补写。

地图覆盖过期是前段可恢复停链，不是最后的人工门原因。观察时不把容器存活当作模型正在正常推进，也没有因摘要陈旧而杀掉仍在工作的模型。

## 停止与终局

暂停请求使用冻结的 `bench_controller.py pause --mode immediate`，参数、stdout 和退出码保存在：

- `pause-command.txt`
- `pause-command.log`，退出码 0

| 容器 | 名称 | 终局状态 |
|---|---|---|
| `2733fbca6698` | `pao-audit-first-20261028-r32` | exited，退出码 0，PID 0，OOMKilled=false |
| `683220104a09` | `html-js-filter__jh2tdno__env-main-1` | exited，退出码 137，PID 0，OOMKilled=false |
| `ae8bbcaab7eb` | `html-js-filter__rhgvowl__env-main-1` | exited，退出码 137，PID 0，OOMKilled=false |

`terminal-receipt.json` 记录 `scope_complete=true`、`writers_stopped=true`、`controller_stopped=true`、`containers_stopped=true`、`actual_stop_observed=true`。收取器 PID、控制器 PID 和正式环境原 PID 均已不存在。

## 奖励、异常与用量

- 官方奖励：缺失。`official_reward_status=formal_result_without_valid_reward`，`valid_reward_count=0`，`missing_reward_count=1`，`reward=null`。
- 结果：`n_trials=0`、`n_errors=1`；显示 `mean=0.0` 不是有效业务分数。
- 异常：`CancelledError`，发生于 `2026-10-27T20:02:15.092946Z`，由本轮人工 blocker 后的授权暂停触发。
- 官方 trial 模型用量：input `1,102,739`，cache `637,404`，output `16,696`。
- 费用：`null` / 未知。原生 `cost=0` 不能当作免费。
- PAO 已观察下界：input `6,692,508`，output `195,164`，cache read `5,874,239`，cache write `0`。
- 嵌套用量覆盖不完整，`pao_model_request_count=null`；不能把 131 个用量事件当作 131 次模型请求。

## 未验事项

- 未运行 verifier，未取得有效官方评分，未评价题目答案质量。
- 未判断两次产物是否已满足最终业务契约。
- 未确认回执解析器是否应放宽纯 JSON 回执协议，也未修改 prompt、产品代码或冻结输入。
- r31 的精确慢启动阻塞点仍未知；r31 的公共 30 秒握手预算修复不因本轮结束而升级为整链通过。
- 实际 OS 隔离、机器重启和 P5 整体费用/token 下降仍未验证。
