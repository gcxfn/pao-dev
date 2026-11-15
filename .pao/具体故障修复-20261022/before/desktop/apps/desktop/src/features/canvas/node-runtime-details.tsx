import type { CanvasNodeDetailData } from "../../../contracts/canvas";

/** 只展示卡、回执和会话的实际记录；缺失值与不完整用量直接说明。 */
export function NodeRuntimeDetails({ detail }: { readonly detail: CanvasNodeDetailData }) {
  const artifacts = detail.card?.receipts.flatMap((round) => round.artifacts ?? []) ?? [];
  const errors =
    detail.card?.receipts
      .filter((round) => round.failureType)
      .map(
        (round) =>
          `第 ${round.attempt} 次：${round.failureType} · ${round.summary ?? "未记录摘要"}`,
      ) ?? [];
  return (
    <section data-testid="canvas-runtime-details">
      <h3 className="canvas-detail__section">输入与输出</h3>
      <dl className="canvas-detail__fields">
        <dt>任务目标</dt>
        <dd>{detail.card?.target ?? "未记录"}</dd>
        <dt>输入</dt>
        <dd>{detail.card?.inputs?.join("\n") || "未记录"}</dd>
        <dt>验收要求</dt>
        <dd>{detail.card?.acceptance ?? "未记录"}</dd>
        <dt>约束</dt>
        <dd>{detail.card?.constraints ?? "未记录"}</dd>
        <dt>输出产物</dt>
        <dd>{[...new Set(artifacts)].join("\n") || "未记录"}</dd>
        <dt>创建到完成</dt>
        <dd>
          {detail.card?.durationSeconds === undefined
            ? "未记录完成时间"
            : `${detail.card.durationSeconds} 秒`}
        </dd>
      </dl>
      <h3 className="canvas-detail__section">用量与错误</h3>
      {detail.usage ? (
        <>
          <p>
            {detail.usage.partial ? "以下数字仅包含已记录用量。" : "已记录的回执用量合计。"}
            {detail.usage.note}
          </p>
          <dl className="canvas-detail__fields">
            <dt>输入 Token</dt>
            <dd>{detail.usage.input ?? "未记录"}</dd>
            <dt>输出 Token</dt>
            <dd>{detail.usage.output ?? "未记录"}</dd>
            <dt>缓存读取 / 写入</dt>
            <dd>
              {detail.usage.cacheRead ?? "未记录"} / {detail.usage.cacheWrite ?? "未记录"}
            </dd>
            <dt>费用记录</dt>
            <dd>{detail.usage.cost ?? "未记录"}</dd>
            <dt>工具调用</dt>
            <dd>{detail.usage.toolCalls ?? "未记录"}</dd>
          </dl>
        </>
      ) : (
        <p>尚无回执用量记录。</p>
      )}
      {detail.runtimeError ? (
        <p className="canvas-detail__error" role="alert">
          {detail.runtimeError}
        </p>
      ) : null}
      <p className="canvas-detail__note">{errors.join("\n") || "未记录失败原因"}</p>
      <h3 className="canvas-detail__section">执行日志记录</h3>
      {detail.executions.length ? (
        detail.executions.map((entry) => (
          <div key={entry.execId}>
            <p className="canvas-detail__note">
              {entry.execId} · {entry.sessionPath ?? "尚无会话日志路径"}
            </p>
            {entry.statsError ? (
              <p className="canvas-detail__error">{entry.statsError}</p>
            ) : entry.sessionStats ? (
              <p className="canvas-detail__note">
                已读 {entry.sessionStats.responses} 条回复、{entry.sessionStats.toolCalls}{" "}
                次工具调用、{entry.sessionStats.tokens} 个已知 Token
                {entry.sessionStats.unknownUsage
                  ? `；${entry.sessionStats.unknownUsage} 条用量未知`
                  : ""}
                {entry.sessionStats.complete ? "" : "；日志未完整读取"}。
              </p>
            ) : (
              <p>日志统计未记录。</p>
            )}
          </div>
        ))
      ) : (
        <p>尚无执行日志。</p>
      )}
    </section>
  );
}
