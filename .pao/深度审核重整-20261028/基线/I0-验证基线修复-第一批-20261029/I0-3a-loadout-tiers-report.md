# I0-3a：5 项档位隔离 fixture 失败

日期：2026-10-30

## 原失败

- 范围：`PAO/packages/coding-agent/test/pao/loadout-tiers-config.test.ts`
- 数量：`5 failed | 2 passed (7)`；退出码 `1`；日志：`I0-3a-loadout-tiers-before-default.log`
- 首个错误：配置文件存在断言得到 `false`。
- 其余四项错误：读取隔离的 `$PAO_HOME/pao配置/档位.json` 时得到 `ENOENT`。
- 原命令（默认预算，未传 `--testTimeout`）：

```powershell
$env:PAO_HOME='D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-3a-loadout-tiers-config\PAO_HOME'
$env:PI_OFFLINE='1'
$env:PI_NO_LOCAL_LLM='1'
node .\node_modules\vitest\vitest.mjs run packages/coding-agent/test/pao/loadout-tiers-config.test.ts --maxWorkers=1 --reporter=verbose
```

## 根因与修改

Vitest 将 Pi 包 alias 到工作区源码，且 `vitest.config.ts` 没有 setup 文件。产品链路
`registerTiers → resolvePaoHome → resolveTierConfigPath → loadTierConfig` 工作正常；
失败原因是测试只设置了空 `PAO_HOME`，没有声明所需的 tier 配置。这不是构建失败或包解析失败。

本轮修改：

- `PAO/packages/coding-agent/test/pao/loadout-tiers-config.test.ts`
  - 要求外部显式提供隔离 `PAO_HOME` 作为父目录，在其中创建唯一临时 home。
  - 把专用 fixture 复制到 `pao配置/档位.json`，临时设为测试进程的 `PAO_HOME`。
  - 测试结束后恢复原环境变量并删除临时 home。
  - 保留原 7 项断言，包括两档模型、思考档、注册守卫、路由不回退、错误信息和重复档名检查。
- `PAO/packages/coding-agent/test/pao/fixtures/loadout-tiers-config.fixture.json`
  - 仅提供本测试所需的显式输入，不声称或模拟产品默认配置。

## 改后验证

- 命令与原失败相同，仅把日志改为 `I0-3a-loadout-tiers-after-default.log`；未传 `--testTimeout`。
- 结果：`1 passed (1)`，`7 passed (7)`；退出码 `0`；耗时约 `365 ms`。
- `git diff --check`：退出码 `0`。
- fixture JSON 解析：`JSON_OK`，退出码 `0`。
- 临时 `loadout-tiers-*` home 清理检查：`TEMP_HOME_CLEAN`。

本轮未修改产品源码、package 或 lock 文件，未读取或写入正式 `PAO_HOME=D:\AI\workspace\pao`，
未安装依赖、运行模型或 Docker，也未扩展到其他 I0-3 测试。

按用户 2026-10-30 的最新决定，后续不安排 P5 真实模型、Harbor 或 Docker 测试，也不再申请
这类测试授权；验收继续限于当前已分配的隔离离线验证、脚本模型和临时 Git/Node 夹具。
