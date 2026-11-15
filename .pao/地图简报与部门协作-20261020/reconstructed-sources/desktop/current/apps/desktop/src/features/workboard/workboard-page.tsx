import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopPathKey as pathKey } from "../../../contracts/path-identity";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type {
  WorkboardDeptRow,
  WorkboardInstanceAnomalyRow,
  WorkboardPendingItemRow,
  WorkboardResult,
  WorkboardSection,
  WorkboardSuspendedInstanceRow,
} from "../../../contracts/workboard";
import { useI18n } from "../../i18n/react";
import { useViewAutoRefresh } from "../../ui/view-auto-refresh";

/**
 * 工作看板整页视图 v1（只读）：打开视图拉一次＋手动刷新＋打开期间 30s 静默轮询
 * （波3 §2a，卸载即停），不缓存。
 * 三段数据全部来自 PAO home 的既有聚合；unavailable 显示主进程给出的中文原因横幅。
 * 卡钻取：点部门积压行 → 滚动定位＋高亮待处理段里该部门的卡条目（第一级）；
 * 待处理行的主体是已读到的卡时 → 「打开卡详情」直接打开看板卡详情（含全部尝试回执）。
 */

/** 一次定位动作：dept 为目标部门,nonce 保证连点同一部门也能再次触发滚动。 */
interface LocatedDept {
  readonly dept: string;
  readonly nonce: number;
}

export function WorkboardPage({
  api,
  cardPathByKey,
  onOpenCard,
}: {
  readonly api: PiDesktopApi;
  /** 看板已读到的卡：归一键 → 卡原路径。待处理行证据路径命中才给「打开卡详情」入口，
   *  打开时映射回卡原路径（P2-1：两源路径分隔符/大小写不保证一致，精确比较会静默失效）。 */
  readonly cardPathByKey: ReadonlyMap<string, string>;
  readonly onOpenCard: (path: string) => void;
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<WorkboardResult | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [locatedDept, setLocatedDept] = useState<LocatedDept | null>(null);
  // 刷新竞速守卫（与 kanban-page 同款）：requestId 递增＋响应比对，旧响应不得覆盖新上下文。
  const requestId = useRef(0);

  // silent＝30s 轮询（波3 §2a）：不闪 Loading，结果与错误照常走竞速守卫。
  const runRefresh = useCallback(
    (silent: boolean) => {
      const currentRequest = ++requestId.current;
      if (!silent) setLoading(true);
      api
        .getWorkboard()
        .then((value) => {
          if (requestId.current !== currentRequest) return;
          setResult(value);
          setLoadError(undefined);
        })
        .catch((error: unknown) => {
          if (requestId.current !== currentRequest) return;
          setLoadError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    },
    [api],
  );
  const refresh = useCallback(() => runRefresh(false), [runRefresh]);
  const refreshSilently = useCallback(() => runRefresh(true), [runRefresh]);
  // 打开期间 30s 静默轮询（波3 §2a），卸载即清（上面的 useEffect 清理函数兼作旧响应作废）。
  useViewAutoRefresh(refreshSilently);

  useEffect(() => {
    refresh();
    return () => {
      requestId.current++;
    };
  }, [refresh]);

  const locateDept = useCallback((dept: string) => {
    setLocatedDept((current) => ({ dept, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const locatedMatches = useMemo(() => {
    if (!locatedDept || result?.state !== "available") return 0;
    const section = result.pendingItems;
    return section.kind === "rows"
      ? section.rows.filter((row) => row.dept === locatedDept.dept).length
      : 0;
  }, [locatedDept, result]);

  return (
    <section className="canvas workboard-view" data-testid="workboard-view">
      <header className="view-header">
        <div>
          <h1 className="view-header__title">{t("Work board")}</h1>
          <p className="view-header__body">
            {t(
              "A read-only view of departments, suspended workflow instances, and pending items from your PAO home.",
            )}
          </p>
        </div>
        <div className="view-header__actions">
          <button
            className="button"
            data-testid="workboard-refresh"
            type="button"
            disabled={loading}
            onClick={refresh}
          >
            {t("Refresh")}
          </button>
        </div>
      </header>

      {loading ? (
        <p className="workboard-status" role="status">
          {t("Loading…")}
        </p>
      ) : null}

      {loadError ? (
        <p className="error-banner" role="alert" data-testid="workboard-load-error">
          {t("The work board could not be loaded.")} {loadError}
        </p>
      ) : null}

      {!loading && result?.state === "unavailable" ? (
        <p className="error-banner" role="alert" data-testid="workboard-unavailable">
          {result.message}
        </p>
      ) : null}

      {!loading && result?.state === "available" ? (
        <>
          <WorkboardDeptSection section={result.departments} onLocate={locateDept} />
          {locatedDept ? (
            <p
              className="workboard-locate-status"
              role="status"
              data-testid="workboard-locate-status"
            >
              {locatedMatches > 0
                ? t("{count} matching pending items highlighted below.", { count: locatedMatches })
                : t("No pending items for this department in the list below.")}
            </p>
          ) : null}
          <WorkboardInstancesSection
            suspended={result.suspendedInstances}
            anomalies={result.instanceAnomalies}
          />
          <WorkboardPendingSection
            section={result.pendingItems}
            locatedDept={locatedDept}
            cardPathByKey={cardPathByKey}
            onOpenCard={onOpenCard}
          />
        </>
      ) : null}
    </section>
  );
}

function SectionError({ message }: { readonly message: string }) {
  const { t } = useI18n();
  return (
    <p className="error-banner" role="alert" data-testid="workboard-section-error">
      {t("This section could not be read.")} {message}
    </p>
  );
}

function EmptyRows() {
  const { t } = useI18n();
  return <p className="workboard-empty">{t("None")}</p>;
}

function WorkboardDeptSection({
  section,
  onLocate,
}: {
  readonly section: WorkboardSection<WorkboardDeptRow>;
  readonly onLocate: (dept: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="workboard-section" data-testid="workboard-departments">
      <h2 className="workboard-section__title">{t("Departments & backlog")}</h2>
      {section.kind === "error" ? (
        <SectionError message={section.message} />
      ) : section.rows.length === 0 ? (
        <EmptyRows />
      ) : (
        <ul className="workboard-list">
          {section.rows.map((row) => (
            <li className="workboard-row" data-testid="workboard-dept-row" key={row.dept}>
              <button
                className="workboard-dept-locate"
                type="button"
                title={t("Locate matching pending items")}
                aria-label={t("Locate matching pending items")}
                onClick={() => onLocate(row.dept)}
              >
                <strong>{row.dept}</strong>
                <span className="workboard-row__meta">
                  {t("{count} entries pending validation (dept knowledge)", {
                    count: row.pendingValidation,
                  })}
                </span>
                {row.warnings.length > 0 ? (
                  <span className="workboard-row__meta workboard-row__warnings">
                    {row.warnings.map((warning) => (
                      <span className="workboard-warning" key={warning.area}>
                        {t("{area}: {count} flags", { area: warning.area, count: warning.count })}
                      </span>
                    ))}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkboardInstancesSection({
  suspended,
  anomalies,
}: {
  readonly suspended: WorkboardSection<WorkboardSuspendedInstanceRow>;
  readonly anomalies: WorkboardSection<WorkboardInstanceAnomalyRow>;
}) {
  const { t } = useI18n();
  return (
    <div className="workboard-section" data-testid="workboard-instances">
      <h2 className="workboard-section__title">{t("Suspended / failed workflow instances")}</h2>
      <h3 className="workboard-subsection__title">{t("Suspended instances")}</h3>
      {suspended.kind === "error" ? (
        <SectionError message={suspended.message} />
      ) : suspended.rows.length === 0 ? (
        <EmptyRows />
      ) : (
        <ul className="workboard-list">
          {suspended.rows.map((row) => (
            <li className="workboard-row" data-testid="workboard-suspended-row" key={row.path}>
              <strong>{row.workflow}</strong>
              <span className="workboard-row__meta">
                {row.project ? `${row.project} · ` : ""}
                {row.path}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="workboard-subsection__title">{t("Instance anomalies")}</h3>
      {anomalies.kind === "error" ? (
        <SectionError message={anomalies.message} />
      ) : anomalies.rows.length === 0 ? (
        <EmptyRows />
      ) : (
        <ul className="workboard-list">
          {anomalies.rows.map((row) => (
            <li
              className="workboard-row"
              data-testid="workboard-anomaly-row"
              key={`${row.path}:${row.file}`}
            >
              <strong>{row.file}</strong>
              <span className="workboard-row__meta">{row.reason}</span>
              <span className="workboard-row__meta">{row.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkboardPendingSection({
  section,
  locatedDept,
  cardPathByKey,
  onOpenCard,
}: {
  readonly section: WorkboardSection<WorkboardPendingItemRow>;
  readonly locatedDept: LocatedDept | null;
  readonly cardPathByKey: ReadonlyMap<string, string>;
  readonly onOpenCard: (path: string) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    if (!locatedDept) return;
    const first = listRef.current?.querySelector(
      `[data-pending-dept="${CSS.escape(locatedDept.dept)}"]`,
    );
    first?.scrollIntoView({ block: "center" });
  }, [locatedDept]);
  return (
    <div className="workboard-section" data-testid="workboard-pending">
      <h2 className="workboard-section__title">{t("Pending items")}</h2>
      {section.kind === "error" ? (
        <SectionError message={section.message} />
      ) : section.rows.length === 0 ? (
        <EmptyRows />
      ) : (
        <ul className="workboard-list" ref={listRef}>
          {section.rows.map((row, index) => {
            const isLocated = row.dept !== undefined && row.dept === locatedDept?.dept;
            // 待处理项主体是卡（证据里有卡路径且看板已读到）→ 直接打开真实卡详情；
            // 打开传归一反查后的卡原路径，不传证据原始文本（P2-1）。
            const evidencePath = row.evidence.find((item) => cardPathByKey.has(pathKey(item)));
            const cardPath = evidencePath
              ? (cardPathByKey.get(pathKey(evidencePath)) ?? evidencePath)
              : undefined;
            return (
              <li
                className={`workboard-row workboard-row--pending${isLocated ? " workboard-row--located" : ""}`}
                data-testid="workboard-pending-row"
                data-pending-dept={row.dept}
                key={`${row.kind}:${row.subject}:${index}`}
              >
                <strong>
                  {row.kind ? `${row.kind} · ` : ""}
                  {row.subject}
                </strong>
                {cardPath ? (
                  <button
                    className="workboard-open-card"
                    data-testid="workboard-open-card"
                    type="button"
                    onClick={() => onOpenCard(cardPath)}
                  >
                    {t("Open card details")}
                  </button>
                ) : null}
                <dl className="workboard-pending__lines">
                  <div>
                    <dt>{t("Why stopped")}</dt>
                    <dd>{row.whyStopped}</dd>
                  </div>
                  <div>
                    <dt>{t("What to decide")}</dt>
                    <dd>{row.decisionNeeded}</dd>
                  </div>
                  <div>
                    <dt>{t("Suggestion")}</dt>
                    <dd>{row.suggestion}</dd>
                  </div>
                  <div>
                    <dt>{t("Evidence")}</dt>
                    <dd>{row.evidence.length > 0 ? row.evidence.join("; ") : "—"}</dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
