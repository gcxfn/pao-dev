import { readFileSync, writeFileSync } from "node:fs";
const src = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/desktop-read-model.test.ts";
let text = readFileSync(src, "utf8");
const importOld = `import {
	readDesktopMinister,
	registerDesktopOwner,
	runDesktopFlowCommand,
	runDesktopMemoryCommand,
} from "../../src/pao/desktop/index.ts";`;
if (!text.includes(importOld)) throw new Error("desktop/index 导入不匹配");
text = text.replace(
  importOld,
  `import {
	readDesktopMinister,
	readDesktopWorkerActivity,
	registerDesktopOwner,
	runDesktopFlowCommand,
	runDesktopMemoryCommand,
} from "../../src/pao/desktop/index.ts";`,
);
const extra = `
it("桌面活性只读投影：当前尝试判定、阈值现读、无注入即无信号", () => {
	const f = fixture();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: f.root,
		sessionManager: { getSessionId: () => "desktop-activity-owner" },
	} as unknown as ExtensionContext;
	registerDesktopOwner(pi, {
		getWorkerActivity: () => [
			{
				pid: 11,
				卡号: "0001",
				命令: "worker",
				登记时间: "2026-10-05T10:00:00.000Z",
				运行中: true,
				部门: "工程",
				派单理由: null,
				卡路径: f.card,
				尝试: 1,
				执行标识: "execution",
				最近输出时间: "2026-10-05T10:05:00.000Z",
			},
			{
				pid: 12,
				卡号: "0001",
				命令: "worker",
				登记时间: "2026-10-05T09:00:00.000Z",
				运行中: false,
				部门: "工程",
				派单理由: null,
				卡路径: f.card,
				尝试: 0,
				执行标识: "old",
			},
		],
		getSilenceMinutes: () => 30,
	});
	handlers.get("session_start")!({}, ctx);
	const rows = readDesktopWorkerActivity(f.root);
	expect(rows).toHaveLength(2);
	expect(rows[0].会话).toBe("desktop-activity-owner");
	expect(rows[0].静默分钟).toBe(30);
	const snapshot = readDesktopProject(f.root, "session-a");
	expect(snapshot.活性).toHaveLength(2);
	expect(snapshot.活性[0].卡路径).toBe(snapshot.卡[0].路径);
	expect(snapshot.活性[0].当前尝试).toBe(true);
	expect(snapshot.活性[1].当前尝试).toBe(false);
	expect(snapshot.活性[1].运行中).toBe(false);
	// 未注入活性的 owner 不产生信号：缺省＝无信号，不拿卡时间兜底。
	const other = fixture();
	expect(readDesktopWorkerActivity(other.root)).toEqual([]);
	handlers.get("session_shutdown")!({}, ctx);
	expect(readDesktopWorkerActivity(f.root)).toEqual([]);
});
`;
writeFileSync(src, text + extra);
console.log("ok: 内核活性测试已加");