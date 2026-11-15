import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createWorkboardQuery,
  normalizeDeptRows,
  normalizeInstanceScan,
  normalizePendingItems,
} from "../../electron/platform/pao/workboard-query";
import type { PaoWorkboardAggregates } from "@pi-gui/pi-sdk-driver";

function stubAggregates(overrides: Partial<PaoWorkboardAggregates> = {}): PaoWorkboardAggregates {
  return {
    deptBacklog: async () => [],
    workflowInstances: async () => ({ 挂起: [], 异常: [] }),
    pending: async () => [],
    ...overrides,
  };
}

test.describe("workboard query", () => {
  test("missing PAO home is unavailable and never loads aggregates", async () => {
    let loaded = false;
    const query = createWorkboardQuery({
      paoHome: "",
      loadAggregates: async () => {
        loaded = true;
        return stubAggregates();
      },
    });
    const result = await query.collect();
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.code).toBe("pao-home-missing");
    expect(result.message.trim()).not.toBe("");
    expect(loaded).toBe(false);
  });

  test("unreachable PAO home reports the reason instead of empty data", async () => {
    const missing = join(tmpdir(), `pi-gui-workboard-missing-${Date.now()}`);
    const query = createWorkboardQuery({ paoHome: missing, loadAggregates: stubAggregates });
    const result = await query.collect();
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.code).toBe("pao-home-unreachable");
    // ENOENT detail survives into the message; the folder path is not swallowed.
    expect(result.message).toContain(missing);
  });

  test("a file at PAO_HOME is not treated as a home", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-gui-workboard-file-"));
    const file = join(dir, "not-a-folder");
    await writeFile(file, "data");
    const query = createWorkboardQuery({ paoHome: file, loadAggregates: stubAggregates });
    const result = await query.collect();
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.code).toBe("pao-home-not-directory");
  });

  test("aggregate loader failure is unavailable, not a fake empty board", async () => {
    const query = createWorkboardQuery({
      paoHome: tmpdir(),
      loadAggregates: async () => {
        throw new Error("fork build products missing");
      },
    });
    const result = await query.collect();
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.code).toBe("aggregates-unavailable");
    expect(result.message).toContain("fork build products missing");
  });

  test("happy path shapes all three sections", async () => {
    const query = createWorkboardQuery({
      paoHome: tmpdir(),
      loadAggregates: async () =>
        stubAggregates({
          deptBacklog: async () => [
            { 部门: "档案部", 待验证: 2, 警示: [{ area: "教训", count: 1 }] },
          ],
          workflowInstances: async () => ({
            挂起: [{ 工作流: "复盘", 项目: "demo", 路径: "/p/实例-1" }],
            异常: [{ 路径: "/p/实例-2", 文件: "实例-2", 原因: "清单损坏" }],
          }),
          pending: async () => [
            {
              类型: "人工门待确认",
              主体: "节点「审」",
              为什么停: "门未点头",
              要决定什么: "是否放行",
              建议: "pao_control_node action=confirm",
              证据: ["/p/实例-1"],
            },
          ],
        }),
    });
    const result = await query.collect();
    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("unreachable");
    expect(result.departments).toEqual({
      kind: "rows",
      rows: [{ dept: "档案部", pendingValidation: 2, warnings: [{ area: "教训", count: 1 }] }],
    });
    expect(result.suspendedInstances).toEqual({
      kind: "rows",
      rows: [{ workflow: "复盘", project: "demo", path: "/p/实例-1" }],
    });
    expect(result.instanceAnomalies).toEqual({
      kind: "rows",
      rows: [{ path: "/p/实例-2", file: "实例-2", reason: "清单损坏" }],
    });
    expect(result.pendingItems).toEqual({
      kind: "rows",
      rows: [
        {
          kind: "人工门待确认",
          subject: "节点「审」",
          whyStopped: "门未点头",
          decisionNeeded: "是否放行",
          suggestion: "pao_control_node action=confirm",
          evidence: ["/p/实例-1"],
        },
      ],
    });
  });

  test("pending section is queried with lifted limits and surfaces card departments", async () => {
    let capturedLimits: unknown;
    const query = createWorkboardQuery({
      paoHome: tmpdir(),
      loadAggregates: async () =>
        stubAggregates({
          pending: async (_home, limits) => {
            capturedLimits = limits;
            return [
              {
                类型: "缺输入补卡",
                主体: "#3 缺输入活（demo）",
                为什么停: "失败分型为缺输入",
                要决定什么: "由谁补上输入",
                建议: "补上输入后重试",
                证据: ["/p/卡0003-缺输入活.md"],
                部门: "审查",
              },
            ];
          },
        }),
    });
    const result = await query.collect();
    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("unreachable");
    // 全量拉取:三个 fork 限额全放到顶,待处理段不再被内部上限截断。
    expect(capturedLimits).toEqual({
      itemLimit: Number.MAX_SAFE_INTEGER,
      instanceGateLimit: Number.MAX_SAFE_INTEGER,
      cardItemLimit: Number.MAX_SAFE_INTEGER,
    });
    expect(result.pendingItems).toEqual({
      kind: "rows",
      rows: [
        {
          kind: "缺输入补卡",
          subject: "#3 缺输入活（demo）",
          whyStopped: "失败分型为缺输入",
          decisionNeeded: "由谁补上输入",
          suggestion: "补上输入后重试",
          evidence: ["/p/卡0003-缺输入活.md"],
          dept: "审查",
        },
      ],
    });
  });

  test("one aggregate throwing degrades only its section to an error row", async () => {
    const query = createWorkboardQuery({
      paoHome: tmpdir(),
      loadAggregates: async () =>
        stubAggregates({
          workflowInstances: async () => {
            throw new Error("instance scan exploded");
          },
        }),
    });
    const result = await query.collect();
    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("unreachable");
    // 部门段照常返回数据，不受实例扫描崩溃影响。
    expect(result.departments.kind).toBe("rows");
    for (const section of [result.suspendedInstances, result.instanceAnomalies]) {
      expect(section.kind).toBe("error");
      if (section.kind !== "error") throw new Error("unreachable");
      expect(section.message).toContain("instance scan exploded");
    }
    expect(result.pendingItems.kind).toBe("rows");
  });
});

test.describe("workboard shaping functions", () => {
  test("normalizeDeptRows rejects non-lists and drops malformed rows", () => {
    expect(() => normalizeDeptRows(undefined)).toThrow();
    expect(() => normalizeDeptRows({})).toThrow();
    const rows = normalizeDeptRows([
      { 部门: "档案部", 待验证: "3", 警示: [{ area: "导览", count: 2 }, "junk"] },
      { 待验证: 5 },
      null,
      "junk",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      dept: "档案部",
      pendingValidation: 3,
      warnings: [{ area: "导览", count: 2 }],
    });
  });

  test("normalizeInstanceScan keeps both sides independently", () => {
    expect(() => normalizeInstanceScan("nope")).toThrow();
    const scan = normalizeInstanceScan({
      挂起: [{ 工作流: "复盘", 项目: "", 路径: "/p/i1" }, null],
      异常: [{ 路径: "", 文件: "", 原因: "dropped" }, { 路径: "/x", 文件: "x", 原因: "坏 JSONL" }],
    });
    expect(scan.suspended).toEqual([{ workflow: "复盘", project: "", path: "/p/i1" }]);
    expect(scan.anomalies).toEqual([{ path: "/x", file: "x", reason: "坏 JSONL" }]);
  });

  test("normalizePendingItems keeps dept only when present and trims blanks", () => {
    const rows = normalizePendingItems([
      { 类型: "失败待处置", 主体: "#4 力甲（demo）", 证据: ["/p/卡0004.md"], 部门: "开发" },
      { 类型: "人工门待确认", 主体: "节点「审」", 证据: ["/p/i1"], 部门: "  " },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ dept: "开发" });
    expect(rows[1]).not.toHaveProperty("dept");
  });

  test("normalizePendingItems preserves the fixed four-line shape", () => {
    expect(() => normalizePendingItems(42)).toThrow();
    const rows = normalizePendingItems([
      {
        类型: "待裁定",
        主体: "工作流「发布」",
        为什么停: "等待裁定",
        要决定什么: "放行或打回",
        建议: "pao_control_node action=rule",
        证据: ["/p/控制.md", 7, null],
      },
      { 主体: "" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      kind: "待裁定",
      subject: "工作流「发布」",
      whyStopped: "等待裁定",
      decisionNeeded: "放行或打回",
      suggestion: "pao_control_node action=rule",
      evidence: ["/p/控制.md"],
    });
  });
});
