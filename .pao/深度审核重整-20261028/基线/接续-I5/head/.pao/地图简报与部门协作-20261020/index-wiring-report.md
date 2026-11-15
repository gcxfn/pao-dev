# index-wiring primary 装配切片报告

## 结论

本切片完成。`test/pao/index-wiring.test.ts` 定向运行通过：1 个测试文件、2 个测试全部通过，退出码 0。最终核对时没有残留的目标测试进程。

- CLI 单卡：真实 `pao_dispatch_card.execute` 已进入 `WiringRunner.run`。
- CLI 扇出：真实 `pao_fanout.execute` 已进入 `WiringRunner.run`。
- worker 角色：侦察保存工具真实执行通过；无递归派发、建树、整合、普通改卡、交回执入口。
- 测试使用 `primary` 卡档位，生产默认 `primary` 与缺配置拒派保护未改。
- 等待使用 runner 启动 Promise 与真实派发通知竞速，无固定 sleep、轮询或公开测试专用配置。
- `before_agent_start` 按核心处理顺序执行，合并 section 修改、追加消息和 `systemPrompt` 覆盖。

## 实际改动

只修改了：

- `PAO/packages/coding-agent/test/pao/index-wiring.test.ts`

未修改 `PAO/packages/coding-agent/src/pao/index.ts` 或 `role.ts`。没有新增 `PaoExtensionOptions` 字段。

测试夹具的具体变化：

1. 临时任务根初始化真实 Git 仓库并提交基线，满足派发链读取 Git 身份的真实前置条件。
2. 卡片档位从 `fast` 改为 `primary`，与默认派发目标及测试配方一致。
3. `WiringRunner` 提供按第 N 次运行完成的启动 Promise。
4. `mockPi` 提供按通知序号完成的真实 `sendMessage` Promise。
5. 单卡在调用工具前登记启动与通知等待；工具返回后二者竞速。若通知先到，立即执行 `before_agent_start` 并把真实失败文本写入断言诊断。
6. 扇出直接等待 `WiringRunner.run` 启动 Promise。
7. 删除固定 10ms、最多 200 次的等待辅助。

## 验证

命令：

```powershell
cd D:/AI/workspace/pao-dev/PAO/packages/coding-agent
npm exec -- vitest --run --reporter=verbose test/pao/index-wiring.test.ts
```

临时目录：

```text
D:/AI/workspace/临时文件夹/地图简报验证-20261020/index-wiring-primary-slice-20261021
```

运行时设置了 `TMP`、`TEMP`、`TMPDIR` 为该目录。

真实结果：

```text
Test Files  1 passed (1)
Tests       2 passed (2)
Exit code   0
Duration    13.42s
```

证据：

- 原始日志：`index-wiring-primary-slice-r2.log`
- 机器可读计数：`index-wiring-primary-slice-r2.json`
- 首次失败日志：`index-wiring-primary-slice-r1.log`

首次失败保留了有价值的真实诊断：修正档位后，派发链没有进入 runner，实际通知为“Git 身份不可读取：not a git repository”。因此测试夹具补了真实 Git 初始化，生产派发保护没有削弱。

## 证据边界

- 真实 Git：是。临时任务根执行了 `git init`、`git add` 和 `git commit`。
- 真实工具：是。单卡、扇出和 worker 侦察保存均调用工具 `execute`。
- 真实通知缓冲：是。由实际派发链调用 `pi.sendMessage`，再消费 `before_agent_start` section。
- 真 worker 子进程：否。`WiringRunner` 覆写了 `run`，返回测试回执，不拉起子进程。
- 真实模型：否。本切片只验证装配和执行路径。
- 全量测试：未运行，按本切片边界只运行目标测试文件。

## 未完成

`onReferenceImpact` 仍未接成 active 精确停止和 checkpoint 回流，本切片没有触碰该实现。旧 attempt 冻结、复核后新 attempt 恢复、pending 持久拒旧引用等验收留待后续切片。

## Git 记录限制

`pao-dev` 根仓的 `.gitignore` 忽略 `/PAO/`，因此该测试文件不出现在 `git status` 或 `git diff`。证据目录的 `reconstructed-sources/PAO/current` 也没有这个新测试文件，无法生成可靠的历史 diff。

本切片以当前文件 SHA-256 记录内容：

```text
ACBF48F0BEBD12425B797CE084E6117E96EE17157B8E97B752C2B34935B3A877
```

没有提交、reset、stash 或覆盖其他修改。

