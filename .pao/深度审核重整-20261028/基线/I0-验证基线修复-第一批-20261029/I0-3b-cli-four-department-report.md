# I0-3b：CLI 与四部门装配复跑

日期：2026-10-30

## 范围

只复跑 A6 中 CLI/构建产物模块解析的 7 项失败，以及四部门文件的文件级装配失败：

- `cli-lifecycle-real.test.ts`：A6 记录 6 failed / 6。
- `host-lifecycle.test.ts`：A6 记录 1 failed / 29，仅“当前 dist 真实 CLI 的隔离组织受控慢扩展”失败。
- `workflow-four-department-real.test.ts`：A6 记录 0 test，收集阶段失败；声明 4 项。

保留 A6 原日志：
`../../审核/A6-内核测试原始输出/vitest-default.log`（317,964 字节，LastWriteTime 2026-10-29 08:22）。

## 原错误

- CLI 6 项：当前 `dist/pao/memory/gbrain.js` 找不到 `@earendil-works/pi-mcp`，导致扩展和 faux provider 都未加载。
- host 1 项：真实 CLI 子进程在握手前以 exitCode 1 退出，stderr 同样报上述模块缺失。
- 四部门 0 test：`desktop/packages/catalogs/src/node/json-catalog-store.ts` 找不到
  `@pi-gui/session-driver`，文件在收集阶段退出。

## 当前装配证据

- `dist/bundle/cli.js` 存在（160 字节，2026-10-30 00:41:09）。
- `dist/pao/memory/gbrain.js` 可导入，直接探测输出 `GBRAIN_IMPORT_OK`。
- `@earendil-works/pi-mcp` 解析到 `PAO/packages/mcp/dist/index.js`。
- 桌面 `packages/catalogs` 和 `apps/desktop` 各自拥有指向
  `desktop/packages/session-driver` 的本地 junction；从 catalogs 解析
  `@pi-gui/session-driver` 得到 `desktop/packages/session-driver/dist/index.js`。

因此当前旧失败属于离线构建或 workspace 装配已恢复，没有再发现源码、测试 fixture 或当前 dist 的新错误。
本轮没有执行构建。

## 实跑命令

所有命令都在 `PAO/packages/coding-agent` 下执行，设置：

```powershell
$env:PAO_HOME='D:\AI\workspace\临时文件夹\深度审核重整-20261028\i0-3b-cli-four-department\PAO_HOME'
$env:PI_OFFLINE='1'
$env:PI_NO_LOCAL_LLM='1'
```

未传入全局 `--testTimeout`：

```powershell
node ..\..\node_modules\vitest\vitest.mjs run test/pao/cli-lifecycle-real.test.ts --maxWorkers=1 --reporter=verbose
node ..\..\node_modules\vitest\vitest.mjs run test/pao/host-lifecycle.test.ts --maxWorkers=1 --reporter=verbose
node ..\..\node_modules\vitest\vitest.mjs run test/pao/workflow-four-department-real.test.ts --maxWorkers=1 --reporter=verbose
```

## 当前结果

| 文件 | 结果 | 退出码 | 耗时 | 日志 |
|---|---:|---:|---:|---|
| `cli-lifecycle-real.test.ts` | 6/6 passed | 0 | 14.37s | `I0-3b-cli-lifecycle-real-current.log` |
| `host-lifecycle.test.ts` | 29/29 passed | 0 | 139.92s | `I0-3b-host-lifecycle-current.log` |
| `workflow-four-department-real.test.ts` | 4/4 passed | 0 | 626.18s | `I0-3b-workflow-four-department-real-current.log` |
| 合计 | 39/39 passed，3 个文件 | 0 | 单独顺序执行 | 上述三份 |

四部门 4 项均真实执行并通过：

- success：151,673ms。
- illegal-acceptance：168,334ms。
- lost-minister：161,597ms。
- map-refresh：135,601ms。

该文件的 4 个用例在源码内明确声明 180 秒预算；本轮没有放宽或覆盖。产生的新通过现场位于
`.pao/具体故障修复-20261022/G-四部门离线闭环-evidence/passed-*`。

## 边界与说明

- 本轮没有修改产品源码、测试、fixture、package 或 lock。
- 当前工作树的 `host-lifecycle.test.ts` 已有未提交修改，保持原样；本轮没有写入。
- 没有安装依赖、执行构建、调用真实模型、访问 Harbor 或使用 Docker。
- 首次 CLI 试跑误把 cwd 放在 `PAO`，错误解析为 `PAO/dist`；该无效诊断日志单独保存为
  `I0-3b-cli-lifecycle-real-wrong-cwd-diagnostic.log`，不计入验收。
- 未运行其他 23 个行为失败，也未扩展 I0-3 范围。
