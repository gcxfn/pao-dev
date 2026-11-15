/**
 * 卡0006 验收 2：落卡走 cards 的 createCard（发号＋原子写），状态 待认领，落本部队列；
 * 幂等：同部门未终态（待认领/进行中）巡库卡存在时不重复落——识别约定=目标固定前缀「巡库：」。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createCard, listCards, loadCard, readCard, serializeCard } from "../../src/pao/cards/index.ts";
import { buildPatrolCardDraft, PATROL_CONSTRAINT, type PatrolCardDraft } from "../../src/pao/patrol/draft.ts";
import { dropPatrolCard } from "../../src/pao/patrol/drop.ts";

let root: string;
let cardsDir: string;
let counterPath: string;
const created = "2026-10-02 09:30";

function setup(): void {
	// 卡目录按任务工作区约定放 <根>/.pao/卡，这样 createCard 的缺省计数器推导
	// （<卡目录>/../../卡号.txt）恰好落在临时根内，不污染真实环境
	root = mkdtempSync(join(tmpdir(), "pao-patrol-drop-"));
	cardsDir = join(root, ".pao", "卡");
	counterPath = join(root, "卡号.txt");
	mkdirSync(cardsDir, { recursive: true });
}

function cleanup(): void {
	rmSync(root, { recursive: true, force: true });
}

function draftOf(dept = "后端"): PatrolCardDraft {
	const draft = buildPatrolCardDraft(
		{
			findings: [
				{ flagged: true, problems: ["超期 120 天未核验"], relPath: "教训/超期.md" },
				{ flagged: false, problems: [], relPath: "教训/新鲜.md" },
			],
			flaggedCount: 1,
		},
		{ 部门: dept, 阈值: 1, 知识库路径: join(root, "知识库") },
	);
	if (!draft) throw new Error("测试草稿应为非空");
	return draft;
}

async function seedCard(
	goal: string,
	dept: string,
	status: "unclaimed" | "in_progress" | "delivered" | "failed",
): Promise<void> {
	const card = await createCard(
		cardsDir,
		{ 目标: goal, 部门: dept, 验收: "测试占位", 创建: created },
		{ counterPath },
	);
	// 直接改写状态字段落盘（绕过状态机，仅为构造幂等场景的假数据）
	const mutated = { ...card.frontmatter, status };
	writeFileSync(card.path, serializeCard(mutated, card.body), "utf8");
}

describe("卡0006：落卡与幂等", () => {
	test("落卡：createCard 发号＋原子写，状态 待认领，卡字段与 §6.7 一致", async () => {
		setup();
		try {
			const draft = draftOf();
			const { card, exists } = await dropPatrolCard(cardsDir, draft, created, { counterPath });
			expect(exists).toBe(false);
			expect(existsSync(card.path)).toBe(true);
			expect(card.frontmatter.status).toBe("unclaimed");
			expect(card.frontmatter.attempt).toBe(0);
			expect(card.frontmatter.goal.startsWith("巡库：")).toBe(true);
			expect(card.frontmatter.dept).toBe("后端");
			expect(card.frontmatter.tier).toBe("fast");
			expect(card.frontmatter.constraints).toBe(PATROL_CONSTRAINT);
			// 不经主控、不占协作配额：无 parent、无协作配额
			expect(card.frontmatter.parent).toBeUndefined();
			expect(card.frontmatter.budget?.collab_quota).toBeUndefined();
			// 输入只装指针
			expect(card.frontmatter.inputs).toContain("教训/超期.md");
			// 落在传入的卡目录（本部队列由调用方决定），计数器在约定位置
			expect(card.path.startsWith(cardsDir)).toBe(true);
			expect(readFileSync(counterPath, "utf8").trim()).toBe("1");
		} finally {
			cleanup();
		}
	});

	test("幂等：同部门已有待认领巡库卡 → 不重复落，返回原卡", async () => {
		setup();
		try {
			const first = await dropPatrolCard(cardsDir, draftOf(), created, { counterPath });
			expect(first.exists).toBe(false);
			const second = await dropPatrolCard(cardsDir, draftOf(), "2026-10-02 10:00", { counterPath });
			expect(second.exists).toBe(true);
			expect(second.card.card_no).toBe(first.card.card_no);
			expect(readdirSync(cardsDir).filter((f) => f.endsWith(".md")).length).toBe(1);
			expect(readFileSync(counterPath, "utf8").trim()).toBe("1");
		} finally {
			cleanup();
		}
	});

	test("幂等按部门隔离：他部门巡库卡不阻止本部落卡", async () => {
		setup();
		try {
			await dropPatrolCard(cardsDir, draftOf("前端"), created, { counterPath });
			const mine = await dropPatrolCard(cardsDir, draftOf("后端"), created, { counterPath });
			expect(mine.exists).toBe(false);
			expect(listCards(cardsDir).length).toBe(2);
		} finally {
			cleanup();
		}
	});

	test("幂等只看未终态（待认领/进行中）：已交付/失败 的巡库卡不阻止重派", async () => {
		for (const status of ["delivered", "failed"] as const) {
			// 每个状态用全新卡目录：上一次 drop 落下的新卡是 待认领，会拦截下一次，不能同目录连跑
			setup();
			try {
				await seedCard("巡库：消化 3 条 ⚠️ 标记（初判后待部长终审）", "后端", status);
				const result = await dropPatrolCard(cardsDir, draftOf(), created, { counterPath });
				expect(result.exists).toBe(false);
			} finally {
				cleanup();
			}
		}
		// 进行中仍阻止
		setup();
		try {
			await seedCard("巡库：消化 9 条 ⚠️ 标记（初判后待部长终审）", "后端", "in_progress");
			const blocked = await dropPatrolCard(cardsDir, draftOf(), created, { counterPath });
			expect(blocked.exists).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("普通卡（目标无巡库前缀）即使同部门未终态也不算巡库卡", async () => {
		setup();
		try {
			await seedCard("修复登录页超时", "后端", "unclaimed");
			const result = await dropPatrolCard(cardsDir, draftOf(), created, { counterPath });
			expect(result.exists).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("计数器路径缺省时按 createCard 默认推导，落卡可被 loadCard 读回", async () => {
		setup();
		try {
			const { card } = await dropPatrolCard(cardsDir, draftOf(), created);
			const loaded = loadCard(cardsDir, card.card_no);
			expect(loaded.frontmatter.goal).toBe(card.frontmatter.goal);
			expect(readCard(card.path).frontmatter.status).toBe("unclaimed");
		} finally {
			cleanup();
		}
	});
});
