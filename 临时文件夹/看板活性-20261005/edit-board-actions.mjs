import { readFileSync, writeFileSync } from "node:fs";
const board = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/workboard/kanban-board.tsx";
const zh = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/contracts/i18n-zh.ts";
const css = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/styles/kanban.css";
const must = (text, needle, label) => {
  if (!text.includes(needle)) throw new Error("锚点不匹配: " + label);
};

// ---- i18n：去掉重复 Stopped，补主控操作文案 ----
let t = readFileSync(zh, "utf8");
const dup = '  Registered: "登记时间",\n  Stopped: "已停止",\n  Execution: "执行标识",';
must(t, dup, "重复 Stopped");
t = t.replace(dup, '  Registered: "登记时间",\n  Execution: "执行标识",');
const zhTail = '  "{minutes} min": "{minutes} 分钟",\n};';
must(t, zhTail, "zh 结尾2");
t = t.replace(
  zhTail,
  `  "{minutes} min": "{minutes} 分钟",

  // 看板主控操作（只生成指令，不直通卡）
  "Master actions (command only)": "主控操作（只生成指令）",
  "Review in the original master session, then run it. The board never changes card status and sends nothing.":
    "回原主控会话核对后执行；看板不改卡状态，也不发送任何请求。",
  "Prepare cancel request": "准备取消请求",
  "Prepare terminate request": "准备终止请求",
};`,
);
writeFileSync(zh, t);

// ---- css ----
let c = readFileSync(css, "utf8");
const cssAnchor = `.kanban-card__chip--muted {
  border: 1px dashed var(--line-strong);
  background: transparent;
  color: var(--muted-strong);
}`;
must(c, cssAnchor, "muted chip 样式");
c = c.replace(
  cssAnchor,
  cssAnchor +
    `

.kanban-detail__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.kanban-detail__command-text {
  width: 100%;
  min-height: 140px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  color: var(--text-strong);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}

.kanban-detail__command-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}`,
);
writeFileSync(css, c);

// ---- board ----
let b = readFileSync(board, "utf8");
const importAnchor = 'import { kanbanActivitySignal, kanbanSilenceMinutes } from "./kanban-activity";';
must(b, importAnchor, "活性导入");
b = b.replace(
  importAnchor,
  importAnchor +
    '\nimport {\n  buildCancelCommand,\n  buildTerminateCommand,\n  canPrepareCancel,\n  canPrepareTerminate,\n} from "./kanban-command";',
);

const detailUsage = '                <KanbanDetail card={selected} onClose={() => setSelectedPath(null)} />';
must(b, detailUsage, "KanbanDetail 使用点");
b = b.replace(
  detailUsage,
  '                <KanbanDetail\n                  key={selected.path}\n                  card={selected}\n                  onClose={() => setSelectedPath(null)}\n                />',
);

const detailHead = `function KanbanDetail({
  card,
  onClose,
}: {
  readonly card: KanbanCard;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className="kanban-detail" data-path={card.path} data-testid="kanban-detail">`;
must(b, detailHead, "KanbanDetail 头");
b = b.replace(
  detailHead,
  `function KanbanDetail({
  card,
  onClose,
}: {
  readonly card: KanbanCard;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const prepare = (kind: "cancel" | "terminate") => {
    setCopied(false);
    setCommand(kind === "cancel" ? buildCancelCommand(card) : buildTerminateCommand(card));
  };
  const copy = async () => {
    if (command === null) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // 剪贴板不可用不报成功：指令仍留在只读文本框里，用户可手动复制。
      setCopied(false);
    }
  };
  return (
    <aside className="kanban-detail" data-path={card.path} data-testid="kanban-detail">`,
);

const detailTail = `      )}
    </aside>
  );
}`;
must(b, detailTail, "详情结尾2");
b = b.replace(
  detailTail,
  `      )}

      <h3 className="kanban-detail__section">{t("Master actions (command only)")}</h3>
      <p className="kanban-detail__note">
        {t(
          "Review in the original master session, then run it. The board never changes card status and sends nothing.",
        )}
      </p>
      <div className="kanban-detail__actions">
        {canPrepareCancel(card) ? (
          <button
            className="button button--ghost"
            data-testid="kanban-prepare-cancel"
            type="button"
            onClick={() => prepare("cancel")}
          >
            {t("Prepare cancel request")}
          </button>
        ) : null}
        {canPrepareTerminate(card) ? (
          <button
            className="button button--ghost"
            data-testid="kanban-prepare-terminate"
            type="button"
            onClick={() => prepare("terminate")}
          >
            {t("Prepare terminate request")}
          </button>
        ) : null}
      </div>
      {command === null ? null : (
        <div className="kanban-detail__command">
          <textarea
            className="kanban-detail__command-text"
            data-testid="kanban-command"
            readOnly
            rows={8}
            value={command}
          />
          <div className="kanban-detail__command-actions">
            <button className="button" data-testid="kanban-copy-command" type="button" onClick={copy}>
              {copied ? t("Copied") : t("Copy")}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}`,
);
writeFileSync(board, b);
console.log("ok: 主控操作入口已加");