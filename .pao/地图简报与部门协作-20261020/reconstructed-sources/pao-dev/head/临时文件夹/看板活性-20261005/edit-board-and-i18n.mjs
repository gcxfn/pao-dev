import { readFileSync, writeFileSync } from "node:fs";
const board = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/workboard/kanban-board.tsx";
const zh = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/contracts/i18n-zh.ts";
const css = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/styles/kanban.css";
const must = (text, needle, label) => {
  if (!text.includes(needle)) throw new Error("锚点不匹配: " + label);
};

// ---- i18n ----
let t = readFileSync(zh, "utf8");
const zhTail = '  "The card file could not be opened.": "卡文件无法打开。",\n};';
must(t, zhTail, "zh 结尾");
const zhAdd = `  "The card file could not be opened.": "卡文件无法打开。",

  // 看板 worker 活性（同进程只读；无信号必须显式）
  "Worker activity": "worker 活性",
  "No activity signal": "无活性信号",
  "Silence alert off": "静默预警已关",
  "Silent {minutes} min · threshold {threshold} min": "静默 {minutes} 分钟 · 阈值 {threshold} 分钟",
  "Silence threshold": "静默阈值",
  "Last output": "最近输出",
  Registered: "登记时间",
  Stopped: "已停止",
  Execution: "执行标识",
  "Current attempt": "当前尝试",
  "{minutes} min": "{minutes} 分钟",
};`;
t = t.replace(zhTail, zhAdd);
writeFileSync(zh, t);

// ---- css ----
let c = readFileSync(css, "utf8");
const chipBlock = `.kanban-card__chip {
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--surface-muted);
  white-space: nowrap;
}`;
must(c, chipBlock, "chip 样式");
c = c.replace(
  chipBlock,
  chipBlock +
    `

.kanban-card__chip--stale {
  background: color-mix(in srgb, var(--warning) 18%, var(--surface));
  color: var(--warning-ink);
  font-weight: 600;
}

.kanban-card__chip--muted {
  border: 1px dashed var(--line-strong);
  background: transparent;
  color: var(--muted-strong);
}`,
);
writeFileSync(css, c);

// ---- board ----
let b = readFileSync(board, "utf8");
const importAnchor = 'import { useI18n } from "../../i18n/react";';
must(b, importAnchor, "useI18n 导入");
b = b.replace(
  importAnchor,
  'import { useI18n } from "../../i18n/react";\nimport { kanbanActivitySignal, kanbanSilenceMinutes } from "./kanban-activity";',
);

const metaTail = `                  {card.dependencies.map((dependency) => (
                    <span className="kanban-card__chip" key={dependency} title={dependency}>
                      依赖 {dependency}
                    </span>
                  ))}
                </span>`;
must(b, metaTail, "卡片 meta 结尾");
b = b.replace(
  metaTail,
  `                  {card.dependencies.map((dependency) => (
                    <span className="kanban-card__chip" key={dependency} title={dependency}>
                      依赖 {dependency}
                    </span>
                  ))}
                  {card.status === "进行中" ? <ActivityChip card={card} /> : null}
                </span>`,
);

const detailStart = `function KanbanDetail({`;
must(b, detailStart, "KanbanDetail");
const chipFn = `/**
 * 进行中卡的静默预警标记：当前尝试无信号、预警已关都显式写出，
 * 不拿卡创建时间兜底成「正常」；amber 只在静默达到现读阈值时出现。
 */
function ActivityChip({ card }: { readonly card: KanbanCard }) {
  const { t } = useI18n();
  const now = Date.now();
  const signal = kanbanActivitySignal(card, now);
  if (signal === "active") return null;
  if (signal === "off")
    return (
      <span className="kanban-card__chip kanban-card__chip--muted" data-testid="kanban-activity-off">
        {t("Silence alert off")}
      </span>
    );
  if (signal === "unknown")
    return (
      <span className="kanban-card__chip kanban-card__chip--muted" data-testid="kanban-activity-unknown">
        {t("No activity signal")}
      </span>
    );
  return (
    <span className="kanban-card__chip kanban-card__chip--stale" data-testid="kanban-stale">
      {t("Silent {minutes} min · threshold {threshold} min", {
        minutes: kanbanSilenceMinutes(card, now) ?? 0,
        threshold: card.activity?.silenceMinutes ?? 0,
      })}
    </span>
  );
}

${detailStart}`;
b = b.replace(detailStart, chipFn);

const detailTail = `        </ul>
      )}
    </aside>
  );
}`;
must(b, detailTail, "详情结尾");
const activitySection = `        </ul>
      )}

      <h3 className="kanban-detail__section">{t("Worker activity")}</h3>
      {card.activity ? (
        <dl className="kanban-detail__fields" data-testid="kanban-detail-activity">
          <DetailField label={t("Owner")} value={card.activity.owner || t("None")} />
          <DetailField label={t("Execution")} value={card.activity.executionId || t("None")} />
          <DetailField label={t("Attempt")} value={String(card.activity.attempt)} />
          <DetailField
            label={t("Current attempt")}
            value={card.activity.current ? t("Current") : t("History")}
          />
          <DetailField label={t("Running")} value={card.activity.running ? t("Running") : t("Stopped")} />
          <DetailField label={t("Registered")} value={card.activity.registeredAt} />
          <DetailField label={t("Last output")} value={card.activity.lastOutputAt ?? t("None")} />
          <DetailField
            label={t("Silence threshold")}
            value={
              card.activity.silenceMinutes > 0
                ? t("{minutes} min", { minutes: card.activity.silenceMinutes })
                : t("Off")
            }
          />
        </dl>
      ) : (
        <p className="kanban-detail__note" data-testid="kanban-detail-activity-none">
          {t("No activity signal")}
        </p>
      )}
    </aside>
  );
}`;
b = b.replace(detailTail, activitySection);
writeFileSync(board, b);
console.log("ok: i18n/css/board 已改");