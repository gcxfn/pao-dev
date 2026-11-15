import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	BUDGET_KEY_MAP,
	FRONTMATTER_KEY_MAP,
	planCardMigration,
	RECEIPT_BULLET_KEY_MAP,
	runCardMigration,
	VALUE_MAPS,
} from "../../src/pao/migration/migrate.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(testDir, "..", "..");
const cliPath = join(packageDir, "src", "pao", "migration", "cli.ts");

function makeCorpus(subdir: string): string {
	const root = mkdtempSync(join(tmpdir(), "pao-migration-"));
	const dir = join(root, subdir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 覆盖定名表全谱的合成卡（frontmatter 12 键全出现＋预算含协作配额＋值域正例）。 */
const SPECTRUM_CARD = `---
目标: 全谱正例卡
部门: 核心机制
输入: ["a.md", "b.md"]
约束: 只读
验收: 键值全对账
depends_on: []
parent: 卡0001-旧
档位: 主力
预算: {"turns":9,"toolCalls":80,"cost":1.5,"协作配额":3}
优先级: 高
owner: 主控
尝试: 2
创建: "2026-10-02 19:31"
完成: "2026-10-02 19:35"
状态: 已交付
---

## owner记录 2026-10-02 19:31
- 事件: 状态改为 进行中
- 依据: 旧尝试留档前的依据原文

## 回执 尝试1 2026-10-02 19:33
- 留档: 旧尝试留档
- 结果: 成功
- 摘要: 摘要原文
- 产物路径: ["out/a.md"]
- 证据: ["evidence.jsonl"]
- 用量: {"input":1,"output":2,"cacheRead":3,"cacheWrite":0,"cost":0.1,"turns":4}
- 值得沉淀: 是
- 失败类型: 瞬时故障
- 任务态: completed
- verification: [{"条件": "文件存在", "结论": "pass", "证据": "x"}]
- changes: [{"路径": "src/a.ts", "类型": "modified", "说明": "改"}]

## 回执 尝试2 2026-10-02 19:34
- 失败类型: 缺输入
- 留档: 迟到回执
`;

function statusCard(status: string): string {
	return `---
目标: ${status}样本
部门: 核心
验收: 样本
尝试: 0
创建: "2026-10-02 19:31"
状态: ${status}
---
`;
}

function receiptFailureTypeCard(failureType: string): string {
	return `---
目标: 失败类型样本
部门: 核心
验收: 样本
尝试: 1
创建: "2026-10-02 19:31"
状态: 失败
---

## 回执 尝试1 2026-10-02 19:33
- 结果: 失败
- 失败类型: ${failureType}
`;
}

describe("migration 映射面（定名表 D3/D4）", () => {
	test("frontmatter 12 键＋预算协作配额全谱迁移", () => {
		const dir = makeCorpus("卡");
		writeFileSync(join(dir, "卡0001-全谱.md"), SPECTRUM_CARD, "utf8");
		const { results, exitCode } = runCardMigration(dir);
		expect(exitCode).toBe(0);
		const migrated = readFileSync(join(dir, "卡0001-全谱.md"), "utf8");
		for (const [, en] of Object.entries(FRONTMATTER_KEY_MAP)) {
			expect(migrated).toContain(`${en}:`);
		}
		// 英文保留键不动
		expect(migrated).toContain("depends_on: []");
		expect(migrated).toContain("parent: 卡0001-旧");
		expect(migrated).toContain("owner: 主控");
		// 预算嵌套键
		expect(migrated).toContain('"collab_quota":3');
		expect(migrated).not.toContain("协作配额");
		// 值域
		expect(migrated).toContain("status: delivered");
		expect(migrated).toContain("priority: high");
		expect(migrated).toContain("tier: primary");
		expect(results[0]?.status).toBe("migrated");
	});

	test("状态五值全谱", () => {
		const dir = makeCorpus("卡");
		const statuses = ["待认领", "进行中", "已交付", "失败", "取消"];
		for (const [i, s] of statuses.entries()) {
			writeFileSync(join(dir, `卡000${i + 1}-${s}.md`), statusCard(s), "utf8");
		}
		const { exitCode } = runCardMigration(dir);
		expect(exitCode).toBe(0);
		const expected = ["unclaimed", "in_progress", "delivered", "failed", "canceled"];
		for (const [i, en] of expected.entries()) {
			const content = readFileSync(join(dir, `卡000${i + 1}-${statuses[i]}.md`), "utf8");
			expect(content).toContain(`status: ${en}`);
		}
	});

	test("优先级/档位全谱与失败类型四值、留档两值", () => {
		const dir = makeCorpus("卡");
		writeFileSync(
			join(dir, "卡0001-优低.md"),
			statusCard("待认领").replace("尝试: 0", "优先级: 低\n档位: 快\n尝试: 0"),
			"utf8",
		);
		writeFileSync(
			join(dir, "卡0002-优中.md"),
			statusCard("进行中").replace("尝试: 0", "优先级: 中\n尝试: 0"),
			"utf8",
		);
		const failureTypes = ["瞬时故障", "缺输入", "能力不足", "结果未知"];
		for (const [i, f] of failureTypes.entries()) {
			writeFileSync(join(dir, `卡001${i}-失.md`), receiptFailureTypeCard(f), "utf8");
		}
		const { exitCode } = runCardMigration(dir);
		expect(exitCode).toBe(0);
		expect(readFileSync(join(dir, "卡0001-优低.md"), "utf8")).toContain("priority: low");
		expect(readFileSync(join(dir, "卡0001-优低.md"), "utf8")).toContain("tier: fast");
		expect(readFileSync(join(dir, "卡0002-优中.md"), "utf8")).toContain("priority: medium");
		const expectedFt = ["transient", "missing_input", "insufficient_capability", "unknown_outcome"];
		for (const [i, en] of expectedFt.entries()) {
			expect(readFileSync(join(dir, `卡001${i}-失.md`), "utf8")).toContain(`- failure_type: ${en}`);
		}
		// 留档两值在 SPECTRUM_CARD 已覆盖，这里断言值映射表本体
		expect(VALUE_MAPS.留档.旧尝试留档).toBe("old_attempt");
		expect(VALUE_MAPS.留档.迟到回执).toBe("late_receipt");
	});

	test("回执 8 键改名，任务态/verification/changes 与 owner记录区逐字保留", () => {
		const dir = makeCorpus("卡");
		writeFileSync(join(dir, "卡0001-回执.md"), SPECTRUM_CARD, "utf8");
		runCardMigration(dir);
		const migrated = readFileSync(join(dir, "卡0001-回执.md"), "utf8");
		for (const [, en] of Object.entries(RECEIPT_BULLET_KEY_MAP)) {
			expect(migrated).toContain(`- ${en}:`);
		}
		// 回执段标题冻结不动（定名表未定义新标题格式）
		expect(migrated).toContain("## 回执 尝试1 2026-10-02 19:33");
		// 已英文化载荷键与自由值逐字保留
		expect(migrated).toContain("- 任务态: completed");
		expect(migrated).toContain('- verification: [{"条件": "文件存在", "结论": "pass", "证据": "x"}]');
		expect(migrated).toContain('- changes: [{"路径": "src/a.ts", "类型": "modified", "说明": "改"}]');
		// owner记录区（只追加审计）不动：键与旧状态值原文保留
		expect(migrated).toContain("- 事件: 状态改为 进行中");
		expect(migrated).toContain("- 依据: 旧尝试留档前的依据原文");
		// 回执结果自由串（D4 保留面）不动
		expect(migrated).toContain("- result: 成功");
	});

	test("真实形态样本（.pao/卡 卡0001 实形）迁移后回执数与值不丢", () => {
		const dir = makeCorpus("卡");
		const real = readFileSync(
			join(packageDir, "..", "..", "..", ".pao", "卡", "卡0001-把.pao体检现有体检评测条目逐份整理成.md"),
			"utf8",
		);
		writeFileSync(join(dir, "卡0001-把.md"), real, "utf8");
		const { exitCode, results } = runCardMigration(dir);
		expect(exitCode).toBe(0);
		expect(results[0]?.status).toBe("migrated");
		const migrated = readFileSync(join(dir, "卡0001-把.md"), "utf8");
		expect(migrated).toContain("status: delivered");
		expect(migrated).toContain("- result: 成功");
		expect(migrated).toContain("- usage: ");
		expect((migrated.match(/^## 回执 尝试/gm) ?? []).length).toBe(1);
		// 正文其余内容不丢：owner记录与依据原文仍在
		expect(migrated).toContain("- 依据: 改前核对通过");
	});
});

describe("migration 冲突拒绝（未知键/无法唯一映射即拒，不猜）", () => {
	test("frontmatter 未知键 → 该文件不动并判冲突、非零退出", () => {
		const dir = makeCorpus("卡");
		const bad = statusCard("待认领").replace("尝试: 0", "技能: 挖掘\n尝试: 0");
		writeFileSync(join(dir, "卡0001-坏.md"), bad, "utf8");
		const { results, exitCode } = runCardMigration(dir);
		expect(exitCode).toBe(1);
		expect(results[0]?.status).toBe("conflict");
		expect(results[0]?.detail).toContain("技能");
		expect(readFileSync(join(dir, "卡0001-坏.md"), "utf8")).toBe(bad);
	});

	test("回执区未知 bullet 键 → 冲突", () => {
		const plan = planCardMigration(`---
目标: x
部门: 核心
验收: x
尝试: 1
创建: "2026-10-02 19:31"
状态: 进行中
---

## 回执 尝试1 2026-10-02 19:33
- 随便键: 值
`);
		// MigrationPlan 是判别联合（conflict 才有 reason），整对象断言同时钉住 status 与取值路径。
		expect(plan).toEqual({ status: "conflict", reason: expect.stringContaining("随便键") });
	});

	test("状态/档位坏值与留档未映射值（重复终结留档）→ 冲突", () => {
		const badStatus = planCardMigration(statusCard("废弃值"));
		expect(badStatus.status).toBe("conflict");
		const badTier = planCardMigration(statusCard("待认领").replace("尝试: 0", "档位: 超级\n尝试: 0"));
		expect(badTier.status).toBe("conflict");
		const badArchive = planCardMigration(SPECTRUM_CARD.replace("- 留档: 旧尝试留档", "- 留档: 重复终结留档"));
		expect(badArchive).toEqual({ status: "conflict", reason: expect.stringContaining("重复终结留档") });
		const badFailure = planCardMigration(receiptFailureTypeCard("玄学失败"));
		expect(badFailure.status).toBe("conflict");
	});

	test("新旧键并存（目标+goal）→ 冲突；无 frontmatter 的卡名文件 → 冲突", () => {
		const both = statusCard("待认领").replace("尝试: 0", `goal: 已迁\n尝试: 0`);
		expect(planCardMigration(both).status).toBe("conflict");
		expect(planCardMigration("只是正文，没有信封\n").status).toBe("conflict");
	});

	test("预算内未知键 → 冲突", () => {
		const badBudget = statusCard("待认领").replace("尝试: 0", '预算: {"turns":1,"吨位":2}\n尝试: 0');
		const plan = planCardMigration(badBudget);
		expect(plan).toEqual({ status: "conflict", reason: expect.stringContaining("吨位") });
	});

	test("实际运行遇冲突即停（不全量提交），dry-run 全量预览不写盘", () => {
		const dir = makeCorpus("卡");
		writeFileSync(join(dir, "卡0001-好.md"), statusCard("待认领"), "utf8");
		const bad = statusCard("已交付").replace("尝试: 0", "技能: x\n尝试: 0");
		// 排序上 卡0002 在 卡0001 后：先迁好卡再撞坏卡 → 停
		writeFileSync(join(dir, "卡0002-坏.md"), bad, "utf8");
		writeFileSync(join(dir, "卡0003-未及.md"), statusCard("进行中"), "utf8");
		const { results, exitCode } = runCardMigration(dir);
		expect(exitCode).toBe(1);
		expect(results.map((r) => r.status)).toEqual(["migrated", "conflict"]);
		expect(readFileSync(join(dir, "卡0003-未及.md"), "utf8")).toBe(statusCard("进行中"));

		const dir2 = makeCorpus("卡");
		writeFileSync(join(dir2, "卡0001-坏.md"), bad, "utf8");
		const dry = runCardMigration(dir2, { dryRun: true });
		expect(dry.exitCode).toBe(1);
		expect(dry.results[0]?.status).toBe("conflict");
		expect(readFileSync(join(dir2, "卡0001-坏.md"), "utf8")).toBe(bad);
	});
});

describe("migration 备份/幂等/原子性", () => {
	test("转换前备份原件，重复执行不覆盖首份备份", () => {
		const dir = makeCorpus("卡");
		writeFileSync(join(dir, "卡0001-备.md"), SPECTRUM_CARD, "utf8");
		const backupDir = join(dir, "..", "backup");
		runCardMigration(dir, { backupDir });
		const backupPath = join(backupDir, "卡0001-备.md");
		expect(existsSync(backupPath)).toBe(true);
		expect(readFileSync(backupPath, "utf8")).toBe(SPECTRUM_CARD);
		// 手动把原件再改回旧形态，重跑：已迁卡不改写、备份仍保留首版
		writeFileSync(join(dir, "卡0002-再.md"), statusCard("失败"), "utf8");
		runCardMigration(dir, { backupDir });
		expect(readFileSync(backupPath, "utf8")).toBe(SPECTRUM_CARD);
	});

	test("幂等：二次运行全部 unchanged 且字节不变", () => {
		const dir = makeCorpus("卡");
		writeFileSync(join(dir, "卡0001-幂.md"), SPECTRUM_CARD, "utf8");
		writeFileSync(join(dir, "卡0002-幂.md"), statusCard("取消"), "utf8");
		runCardMigration(dir);
		const snap = readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), "utf8")] as const);
		const second = runCardMigration(dir);
		expect(second.exitCode).toBe(0);
		expect(second.results.every((r) => r.status === "unchanged")).toBe(true);
		for (const [name, content] of snap) {
			expect(readFileSync(join(dir, name), "utf8")).toBe(content);
		}
	});

	test("合成语料对定名表每一映射至少一个正例（覆盖率自检）", () => {
		const corpus =
			SPECTRUM_CARD +
			statusCard("待认领") +
			statusCard("进行中") +
			statusCard("失败") +
			statusCard("取消") +
			statusCard("待认领").replace("尝试: 0", "优先级: 低\n尝试: 0") +
			statusCard("进行中").replace("尝试: 0", "优先级: 中\n尝试: 0") +
			statusCard("失败").replace("尝试: 0", "档位: 快\n尝试: 0") +
			receiptFailureTypeCard("能力不足") +
			receiptFailureTypeCard("结果未知");
		for (const [zh] of Object.entries(FRONTMATTER_KEY_MAP)) expect(corpus).toContain(`${zh}:`);
		for (const [zh] of Object.entries(BUDGET_KEY_MAP)) expect(corpus).toContain(`${zh}`);
		for (const [zh] of Object.entries(RECEIPT_BULLET_KEY_MAP)) expect(corpus).toContain(`- ${zh}:`);
		for (const [domain, map] of Object.entries(VALUE_MAPS)) {
			for (const [zh] of Object.entries(map)) expect(corpus, `${domain}/${zh}`).toContain(zh);
		}
	});
});

describe("migration CLI 子进程：原子写与中断恢复", () => {
	function buildBigCorpus(dir: string, count: number): void {
		mkdirSync(dir, { recursive: true });
		for (let i = 1; i <= count; i++) {
			const no = String(i).padStart(4, "0");
			writeFileSync(
				join(dir, `卡${no}-批量${no}.md`),
				statusCard(i % 2 ? "进行中" : "已交付").replace("样本", `批量${no}`),
				"utf8",
			);
		}
	}

	function spawnCli(args: string[]) {
		return spawn(process.execPath, [cliPath, ...args], { cwd: packageDir, stdio: ["ignore", "pipe", "pipe"] });
	}

	function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
		return new Promise((resolveRun, rejectRun) => {
			const proc = spawnCli(args);
			let stdout = "";
			let stderr = "";
			proc.stdout.on("data", (d: Buffer) => {
				stdout += d;
			});
			proc.stderr.on("data", (d: Buffer) => {
				stderr += d;
			});
			proc.on("error", rejectRun);
			proc.on("close", (code) => resolveRun({ code, stdout, stderr }));
		});
	}

	test("杀进程中途不留半成品，重跑续上并等于干净参考运行", { timeout: 60000 }, async () => {
		const base = mkdtempSync(join(tmpdir(), "pao-migration-kill-"));
		const drillDir = join(base, "drill", "卡");
		const refDir = join(base, "ref", "卡");
		buildBigCorpus(drillDir, 60);
		buildBigCorpus(refDir, 60);

		// 被杀运行：等前几个逐文件结果出来后 SIGKILL
		await new Promise<void>((resolveKill) => {
			const proc = spawnCli(["migrate", "--root", drillDir, "--sleep-ms", "15"]);
			let lines = 0;
			proc.stdout.on("data", () => {
				lines++;
				if (lines >= 3) {
					proc.kill("SIGKILL");
					resolveKill();
				}
			});
			proc.on("close", () => resolveKill());
			proc.on("error", () => resolveKill());
		});

		// 原子性：无 .tmp 残留；每个卡文件要么整旧、要么整新（可规划/已规范两态，无混合半成品）
		const files = readdirSync(drillDir);
		expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
		for (const name of files) {
			const content = readFileSync(join(drillDir, name), "utf8");
			const whollyOld = planCardMigration(content).status === "ok" && content.includes("\n状态: ");
			const whollyNew = planCardMigration(content).status === "ok" && content.includes("\nstatus: ");
			expect(whollyOld || whollyNew, `${name} 处于半迁移状态`).toBe(true);
		}

		// 中断恢复：重跑到完成，与参考运行逐字节一致
		const resumed = await runCli(["migrate", "--root", drillDir]);
		expect(resumed.code).toBe(0);
		const reference = await runCli(["migrate", "--root", refDir]);
		expect(reference.code).toBe(0);
		for (const name of readdirSync(refDir)) {
			expect(readFileSync(join(drillDir, name), "utf8")).toBe(readFileSync(join(refDir, name), "utf8"));
		}
		rmSync(base, { recursive: true, force: true });
	});

	test("缺 --root 拒跑（不猜默认）、list-sessions 缺根同样拒跑", { timeout: 30000 }, async () => {
		const missing = await runCli(["migrate"]);
		expect(missing.code).not.toBe(0);
		expect(missing.stderr).toContain("--root");
		const sessionsMissing = await runCli(["list-sessions"]);
		expect(sessionsMissing.code).not.toBe(0);
	});

	test("真实形态取样进子进程运行（copyFileSync 真实用法）", { timeout: 30000 }, async () => {
		const base = mkdtempSync(join(tmpdir(), "pao-migration-real-"));
		const cardsDir = join(base, "卡");
		mkdirSync(cardsDir, { recursive: true });
		const realPath = join(
			packageDir,
			"..",
			"..",
			"..",
			".pao",
			"卡",
			"卡0001-把.pao体检现有体检评测条目逐份整理成.md",
		);
		copyFileSync(realPath, join(cardsDir, "卡0001-把.md"));
		const done = await runCli(["migrate", "--root", cardsDir]);
		expect(done.code).toBe(0);
		expect(done.stdout).toContain('"status":"migrated"');
		const migrated = readFileSync(join(cardsDir, "卡0001-把.md"), "utf8");
		expect(migrated).toContain("status: delivered");
		expect(migrated).toContain("- result: 成功");
		const relativeNote = relative(base, cardsDir);
		expect(relativeNote).toBe("卡");
		rmSync(base, { recursive: true, force: true });
	});
});
