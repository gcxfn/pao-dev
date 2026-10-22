# B 执行测试修复

本文件保留子代理第一阶段的历史记录，不作为最终状态。主控随后接手、复验77项通过并完成剩余修复，最终范围、简洁性审核和结果只看[实施与简洁性审核](实施与简洁性审核.md)。

## 结论

第一阶段已落盘：按现有真实接口修正 8 个测试文件，定向 Biome 检查通过。首轮 77 项 Vitest 有 75 项通过；两处旧行为预期与当前契约不一致，已按源码核实后修正，正在复跑。

## 实际改动

| 测试文件 | 修正 |
|---|---|
| `evidence-read-tool.test.ts` | 证据读取工具的 `execute` 补齐五参数，并传入真实测试上下文。 |
| `windows-script-encoding.test.ts` | `write`、`edit` 工具调用补齐五参数。 |
| `intake-accept.test.ts` | `changeCardStatus` 补齐必填 `时间`。 |
| `intake-tool.test.ts` | 自动受理判据字段改为真实的 `dependsOn`；失败类型改用合法值 `transient`。 |
| `host-rpc-background-real.test.ts` | 通知面 mock 补齐 `inject`、`markHandled`、`subscribe`、`retainedCount`。 |
| `s5p2-permissions.test.ts` | 字段名由不存在的 `培养档` 改为真实的 `思考档`，并按档位配置断言 `high`。 |
| `evidence-archive.test.ts` | UUID mock 改为模板类型兼容的合法 UUID。 |
| `loadout-role.test.ts` | 临时 PAO_HOME 改为固定字符串闭包，消除可选环境变量的类型问题；生命周期钩子预期按当前真实注册数更新为 7。 |

## 验证

- 第一阶段 8 个文件定向 Biome：通过。
- 第一阶段 8 个文件定向 Vitest：77 项中 75 项通过、2 项失败。
- 两项失败分别由默认思考档 `high` 和当前 7 个生命周期关闭钩子导致，均已按源码契约修正，尚待复跑。

## 余项

- 复跑第一阶段并记录结果。
- 继续处理第一阶段的 `noUnsafeFinally`、字面量模板和其余类型/未用符号问题。
- 定向 TypeScript 和最终受影响 Vitest 由本任务完成；全量 `npm run check` 留给主控。
- 排除文件及 `workflow-*` 测试错误不由本任务处理。

