# E 取消窄修报告

截至 2026-10-21，指定取消用例和完整 `delivery-commit.test.ts` 均已实际通过，退出码为 0。修改只在测试文件内，产品源码与验收保护未改。

## 结论

- 取消用例：1 个通过、19 个跳过，退出码 0，用例耗时 18.883 秒。
- 完整文件：20 个通过、0 个失败、0 个待执行，退出码 0，总耗时 69.11 秒。
- `baseline.ts` 仍为 32,988 字节，SHA-256 为 `78271F2252985600FD01BECB80E79D1B0F4427FF7347AEA64E7B3B8920120130`。
- 真实 `commit-tree` 代理及后代、取消错误类型、进程停止、无关进程存活、宿主 HEAD、受控引用未发布、产物保留等原有强断言全部保留。

## 根因与经过

原测试只描述“真实 commit-tree 代理未就绪”，无法区分等待超时和 `deliverCard` 提前结束。窄修先让测试同时观察代理标记与交卷结果，得到的真实错误是：

`ExecutionContextError: Git 顶层与绑定的 repositoryRoot 不一致`

错误详情中，期望路径是正常的 `D:\...\临时文件夹\...`，实际路径中的中文已变成替换字符。原 `blockingGitShim()` 用 .NET `StreamReader` 把真实 Git 的 UTF-8 输出解码为字符串，再用 `Console.Out.Write` 按默认 Windows 控制台编码输出。Node 随后按 UTF-8 读取，中文路径的身份因此改变。产品因此在实时核对 `repositoryRoot` 时拒绝继续，尚未执行到 `commit-tree`。

该行为不是产品路径校验缺陷。没有放宽 `sameRepositoryPath` 或相关保护。

## 修改

- `blockingGitShim()` 的 C# 代理改为直接复制真实 Git stdout/stderr 的原始字节，不再经过 `StreamReader`、`Console.Out` 或控制台编码转换。
- 取消用例同时观察代理标记与 `deliverCard` 结果。交卷提前返回或抛错时，测试会立即报告结果及错误详情，不再只显示“代理未就绪”。
- 原有真实 Git、真实父孙进程、取消和宿主不变断言没有删除或放宽。
- 没有修改任何产品源代码。

## 验证

| 验证 | 结果 | 真实退出码 | 证据 |
|---|---:|---:|---|
| 修复前诊断 | 1 失败、19 跳过；捕获提前结束原因 | 1 | `checks/E-取消窄修/diagnostic-2-cancel.{json,log,exit}` |
| 取消用例 | 1 通过、19 跳过 | 0 | `checks/E-取消窄修/isolated-fixed.{json,log,exit}` |
| 完整 `delivery-commit.test.ts` | 20 通过、0 失败 | 0 | `checks/E-取消窄修/delivery-commit-fixed.{json,log,exit}` |

完整运行使用工作区隔离目录：

`D:/AI/workspace/临时文件夹/地图简报验证-20261020/cancel-serial-recovery`

没有运行 Electron、正式 PAO_HOME、模型实验、全局安装、提交或发布。

## 冻结摘要

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `PAO/packages/coding-agent/test/pao/delivery-commit.test.ts` | 37,444 | `152912CA5712A4EE271D292C764B236BBDE532F787E052A80881A106C2F49CDE` |
| `PAO/packages/coding-agent/src/pao/cards/delivery.ts` | 29,150 | `F754FB53FFB4170CD383737F637534BC05209205A8E05D07BACE4F3F63DAEBAA` |
| `PAO/packages/coding-agent/src/pao/cards/process.ts` | 7,527 | `11EC85E4343CF76FDE3D7B6261933A71E89123AAE63D59F11CB76E3D4246F593` |
| `PAO/packages/coding-agent/src/pao/cards/baseline.ts` | 32,988 | `78271F2252985600FD01BECB80E79D1B0F4427FF7347AEA64E7B3B8920120130` |
| `PAO/packages/coding-agent/src/pao/cards/execution-context.ts` | 19,347 | `736BE4DB087A4B1DC1AC0CB4BC9733ABEC80C1F40CBAA03442B76B2BC4B057E7` |

测试文件修改前为 36,551 字节，SHA-256 为 `08D44ED1DB081D26B03BFFFA76959D6F3BBF1CB8AE5F5F52D961DC8D88AE77E5`。修改后摘要已写入 `source-frozen.json`。

## 局限

- 该用例沿用原有的 Windows 专用边界；非 Windows 环境继续跳过。
- 本轮只运行了取消单例与完整 `delivery-commit.test.ts`，没有重跑主已核通过的其他 E 测试，也没有在冻结产品源码后重新运行生产类型检查。
- 诊断文件保留的是失败现场，用于证明根因；最终结论以 `isolated-fixed` 和 `delivery-commit-fixed` 的退出码 0 为准。

## 文件

- 修改：`PAO/packages/coding-agent/test/pao/delivery-commit.test.ts`
- 报告：`.pao/地图简报与部门协作-20261020/E-取消窄修报告.md`
- 证据：`.pao/地图简报与部门协作-20261020/checks/E-取消窄修/`
- 运行脚本：`D:/AI/workspace/临时文件夹/地图简报验证-20261020/cancel-serial-recovery/run-delivery-commit.ps1`

源码文件已按上表和 `checks/E-取消窄修/source-frozen.json` 冻结。
