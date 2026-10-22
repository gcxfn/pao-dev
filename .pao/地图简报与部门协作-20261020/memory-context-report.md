# memory/context 4.1.5–7 与 V16 实施记录

截至 2026-10-20，自动召回和上下文工具规模统计已按授权修改。没有提交开发仓，没有使用正式 PAO_HOME，没有调用付费服务，没有修改上游 pi、worker、cards、workflow 或 role.ts。

## 已实现

- 自动召回按供应商＋记忆 ID 识别结构化身份；无 ID 时按供应商＋规范化正文识别。供应商相同的同正文结果不再重复，不同供应商的同 ID 不会互相误去重。
- 普通消息只按真实正文判断是否已存在。用户只写“记忆ID xyz”或只出现短 ID、其他供应商同 ID 时，不会掩盖仍需要的召回正文。
- 单条正文上限 800 码点，最终模型可见的自动召回总量上限 2000 码点，以 Unicode 码点计算。超量内容带明确截断标注。
- 总量预算基于当前上下文和纠正过滤后的模型可见副本。已纠正而不会发送的自动召回、手动工具召回都不占自动预算；多个仍可见的自动召回块会累计。
- 当前上下文不含必要事实时会重新召回，没有保存永久“已见”集合。压缩后事实消失可重新补充。
- 原始会话历史不删除。`context` hook 只修改下一次模型可见副本：过滤被纠正的自动召回，手动结果保留 `toolCallId`；归纳后为空时用明确说明替代。
- 纠正事实按供应商＋身份或正文排除。会话恢复后旧事实仍不复活；会话切换会清空本会话状态。
- 扩展已有 `observeProviderRequests({ onFinalPayload, onResponse })`，统计最终变换后 payload 的工具声明 JSON 码点、UTF8 字节、会话、请求序号、请求标识、模型、工具名和响应状态。未知 token 记为 `null`，不保存工具说明全文或重复正文。
- 响应状态只按请求身份绑定；删除了按“最新请求”猜测的响应回填。请求序号每个真实请求只递增一次。

## 验证

已实际运行并通过：

```text
npx vitest run test/pao/memory-session.test.ts test/pao/memory-resident.test.ts test/pao/context-inspection.test.ts test/pao/memory-cancellation.test.ts test/pao/memory-compaction-state.test.ts
5 files, 70 tests passed（作者轮次）

npx vitest run test/sdk-stream-options.test.ts
1 file, 11 tests passed

npx biome check <本任务 6 个文件>
Checked 6 files, no fixes applied

git diff --check <本任务 6 个文件>
通过
```

主审最终独验为 memory 相关 5 个文件共 71 例通过；上面保留作者轮次的 70 例原始记录，最终数字以主审独验为准。真实 `SessionManager.inMemory()` 测试覆盖压缩后的投影、旧事实过滤、新事实保留和原始条目保留。供应商与模型路径仍使用离线替身，不代表正式 gbrain、真实模型或桌面发行物验收。

全包类型检查未通过，阻断来自写集外的并行修改：

```text
src/pao/cards/execution-context.ts
src/pao/worker/dispatch-core.ts
src/pao/fanout/execute.ts
src/pao/worker/index.ts
src/pao/workflow/auto.ts
src/pao/index.ts
```

当前全包错误输出未列出本任务修改的三个源码文件。此后主审在 stage3 实际运行内核类型检查，退出 0、日志为空。代码图 `index_status` 为 ready；`registerResidentMemory` 的调用方仍只有 `paoExtension`，无需新增公共入口。
