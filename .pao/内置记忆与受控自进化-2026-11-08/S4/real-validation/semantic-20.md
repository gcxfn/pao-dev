# 20 条同义查询语义验收

日期：2026-11-09。状态：入口与离线门控完成；尚未执行真实嵌入和检索，20 条质量未通过。

## 输入与身份

查询正本固定为
`PAO/packages/coding-agent/test/pao/fixtures/memory/acceptance/synonyms-20.json`。入口不修改
query、expected alias、`mustNotAlias`，也不按文字相似度猜 alias。

真实运行还需两份由实际运行证据建立并保留的输入：

```json
{
  "scope": {
    "projectId": "<resolveMemoryScope 实际返回的 projectId>",
    "executionRoot": "<实际执行根>",
    "sessionId": "<可选实际会话 ID>",
    "taskId": "<可选实际任务 ID>",
    "department": "<可选实际部门>"
  }
}
```

```json
{
  "aliasMap": {
    "<冻结 expectedAlias 或 mustNotAlias>": {
      "memoryId": "<实际提交返回的 memory ID>",
      "revision": 1
    }
  }
}
```

`executionRoot` 必须实际存在；入口调用产品 `resolveMemoryScope()`，要求解析后的
`projectId` 与 `executionRoot` 和输入一致。alias 映射只接受 `memoryId + revision` 身份，
不从 expected 创建产品数据，也不按 memory ID 全局折叠 revision。缺少任一被查询引用的
alias 时，该 query 保持 `incomplete`，交给主审补实际证据或裁定。

## 固定查询 mode

20 条查询都独立保留原期望，固定表只决定 `service.searchMemory()` 的查询 mode：

| query | mode |
|---|---|
| `syn-01`—`syn-07`、`syn-09`—`syn-20` | `current` |
| `syn-08` | `history` |

`syn-08` 的“最初设定每轮取出五条”仍期望 `mem-recall-top5`，仍禁止
`mem-recall-top3`；固定使用 history 才能同时表达历史 r1/top5 与当前 r2/top3。
原 fixture 和其他 query 的 expected 不改。

## 入口与真实门控

入口为
`PAO/packages/coding-agent/scripts/memory-semantic-validation.mjs`
导出的 `runSynonymAcceptance(options)`。默认离线执行：

```powershell
node PAO/packages/coding-agent/scripts/memory-semantic-validation.mjs
```

默认入口只校验 20 条冻结查询、固定 mode 和 alias 映射形状；全部 query 记
`incomplete`，不打开 memory service，不调用产品检索，不发网络请求。

真实执行必须同时给出：

```powershell
node PAO/packages/coding-agent/scripts/memory-semantic-validation.mjs `
  --home <隔离 PAO_HOME> `
  --scope <scope.json> `
  --alias-map <aliases.json> `
  --execute-real `
  --allow-real-embedding `
  --output <result.json>
```

门控还要求：

- 隔离 `PAO_HOME` 已存在，`executionRoot` 已存在且 scope 解析一致。
- `EMBED_BASE_URL`、`EMBED_API_KEY`、`EMBED_MODEL` 均有显式配置。
- 隔离 home 的外发配置明确允许该项目使用该嵌入端点。
- 每条 query 经真实 `service.searchMemory({ scope, query, mode, limit: 5 })` 执行。

上面的真实命令本轮没有执行。

## 结果语义

每条 query 记录：

- 实际 request 的 query、mode、limit 和结果状态。
- `requestId`、`latencyMs`。
- 完整 hits 的 `memoryId`、`revision`、alias、relevance 与 `matchKind`。
- `actualHit` 和 query 级 `matchKind`。
- `memory_usage` 事件、嵌入请求的 URL/status/latency/requestId/usage。
- `semanticEvidence` 及最终 `status/reason`。

通过一条 query 必须同时满足：

1. `service.searchMemory()` 成功且没有 `degraded=true`。
2. fetch observer 记录到该 query 的成功嵌入 HTTP 响应。
3. expected alias 按 `memoryId + revision` 出现在 hits。
4. 该 hit 的 `matchKind` 是 `semantic` 或 `both`。
5. `mustNotAlias` 对应的 `memoryId + revision` 均未出现在 hits。

以下情况不能记作语义通过：

- 未映射 alias：`incomplete`。
- 检索降级：`failed`。
- 目标只经 `lexical` 命中：`failed`。
- 缺少成功的嵌入请求证据：`failed`。
- expected revision 未命中或 forbidden revision 出现：`failed`。

嵌入 usage 或供应商价格缺失时保留 `unknown`。没有供应商费用依据时，模型配置中的成本
`0` 不能当作实际费用 `0`；结果中的 `providerFee` 与 `cost` 固定为 `unknown`。

只有 20 条 query 均为 `passed`，批次才为 `passed`；任何 `failed` 使批次为 `failed`，
否则存在未映射 alias 时为 `incomplete`。

## I10 降级与质量子批次

本次 20 条查询是语义质量子批次。I10 的外发拒绝/降级验收另列，不在本入口内：
拒绝场景可以验证系统明确降级并保留词法可用性，但 deny 时的词法命中不能计入本批次
`passed`，也不能替代真实 embedding 的语义证据。

开启 I10 质量时必须使用隔离的明确许可，让 `service.searchMemory()` 真调 embedding；
如果该环境仍为 deny、degraded 或 embedding 请求缺失，本批次按上述规则失败。两个子批次
分别保存结论，不互相抬升状态。

## 本地测试

运行：

```powershell
node --check PAO/packages/coding-agent/scripts/memory-semantic-validation.mjs
node --test PAO/packages/coding-agent/scripts/memory-semantic-validation.test.mjs
```

2026-11-09 实际结果：语法检查通过，4 项测试通过。覆盖：

- 默认离线 20 条全部 `incomplete`，网络调用为零，只有 `syn-08` 使用 history。
- 真实模式缺少非空隔离 `paoHome` 时在打开 store 和网络调用前失败。
- 同一 memory ID 的 r1/top5 与 r2/top3 按 revision 区分；history 不接收当前禁止 revision。
- 未映射 alias 保持 `incomplete`；词法、降级和缺失嵌入证据均不能冒充语义通过；费用保持
  `unknown`。

离线测试不产生真实 query 命中、provider usage 或质量结论。20 条真实语义质量仍未通过。
