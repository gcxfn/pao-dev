import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
	changeCardStatus,
	loadCard,
	parseCardRef,
	withFileLock,
} from "../../src/pao/cards/index.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	decideNode,
	endDecomposition,
	pauseControlIfUnpaused,
	readControl,
	readControlReport,
	requestRuling,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const isolatedParent = resolve(
	".pao",
	"深度审核重整-20261028",
	"I1-3a-workflow-pending-resolution",
	"pause-completion",
);
mkdirSync(isolatedParent, { recursive: true });
process.env.PAO_HOME = isolatedParent;

function setup(review: boolean) {
	const root = mkdtempSync(join(isolatedParent, "case-"));
	writeFileSync(join(root, "source.txt"), "baseline\n");
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	execFileSync("git", ["add", "source.txt"], { cwd: root });
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "baseline"], {
		cwd: root,
	});
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "暂停完成保护",
			参数: [],
			节点: [
				{
					名字: "审查",
					部门: "审查",
					目标: "检查成果",
					验收: "文件存在",
					审核: review,
					只读: review,
					部门标准: review ? "内容可维护" : undefined,
					允许请求主控裁定: true,
				},
			],
		})}---\n`,
		join(root, "暂停完成保护.md"),
	);
	const options = {
		cardsDir: join(root, ".pao", "卡"),
		ownerSessionId: "owner",
		counterPath: join(root, ".pao", "卡号.txt"),
	};
	return { root, recipe, options };
}

async function prepareCard(s: ReturnType<typeof setup>, status: "in_progress" | "delivered") {
	await startControl(s.recipe, {}, s.options);
	await bindMinister(s.recipe, s.options, "审查", "minister-review");
	const flow = readControl(s.recipe, s.options);
	const identity = {
		实例: flow.实例,
		节点: "审查",
		轮次: flow.节点[0].轮次,
		部长会话: "minister-review",
	};
	const [ref] = await addNodeCards(s.recipe, s.options, identity, [{ goal: "检查", acceptance: "文件存在" }]);
	const card = loadCard(s.options.cardsDir, parseCardRef(ref));
	changeCardStatus(card, {
		操作者: "owner",
		to: "in_progress",
		时间: "2026-10-30 10:00",
	});
	if (status === "delivered") {
		changeCardStatus(loadCard(s.options.cardsDir, parseCardRef(ref)), {
			操作者: "owner",
			to: "delivered",
			时间: "2026-10-30 10:01",
		});
	}
	await endDecomposition(s.recipe, s.options, identity);
	return { ref, identity };
}

async function completedReview(s: ReturnType<typeof setup>) {
	const { identity } = await prepareCard(s, "delivered");
	await requestRuling(s.recipe, s.options, identity, "当前成果需要最终裁定", true);
	await decideNode(
		s.recipe,
		s.options,
		identity,
		{ 结果: "pass", 理由: "未验证运行，采纳当前成果", 引用: ["source.txt:1"] },
		"主控",
	);
}

describe("完成后关闭不得覆盖为挂起", () => {
	it("当前成果仍有效且实例已完成时保守暂停不改控制文件", async () => {
		const s = setup(true);
		await completedReview(s);
		const flow = readControl(s.recipe, s.options);
		expect((await readControlReport(flow, s.options)).status).toBe("completed");
		const path = controlPath(s.recipe, s.options);
		const before = readFileSync(path);

		await expect(pauseControlIfUnpaused(s.recipe, s.options, "关闭命令中止")).resolves.toBe(false);

		expect(readFileSync(path).equals(before)).toBe(true);
		expect(readControl(s.recipe, s.options).暂停).toBeUndefined();
	}, 20_000);

	it("成果变化使旧 pass 失效时仍允许挂起人工恢复", async () => {
		const s = setup(true);
		await completedReview(s);
		writeFileSync(join(s.root, "source.txt"), "changed after review\n");
		const flow = readControl(s.recipe, s.options);
		expect((await readControlReport(flow, s.options)).status).not.toBe("completed");

		await expect(pauseControlIfUnpaused(s.recipe, s.options, "成果版本变化")).resolves.toBe(true);

		expect(readControl(s.recipe, s.options)).toMatchObject({
			状态: "挂起",
			暂停: "成果版本变化",
		});
	}, 20_000);

	it("完成写入等待控制锁时，保守暂停拿到锁后按最新成果放行", async () => {
		const s = setup(false);
		const { ref } = await prepareCard(s, "in_progress");
		const path = controlPath(s.recipe, s.options);
		let releaseLock!: () => void;
		let lockEntered!: () => void;
		const held = new Promise<void>((done) => {
			releaseLock = done;
		});
		const entered = new Promise<void>((done) => {
			lockEntered = done;
		});
		const holder = withFileLock(path, async () => {
			lockEntered();
			await held;
		});
		await entered;

		const pause = pauseControlIfUnpaused(s.recipe, s.options, "并发关闭");
		changeCardStatus(loadCard(s.options.cardsDir, parseCardRef(ref)), {
			操作者: "owner",
			to: "delivered",
			时间: "2026-10-30 10:02",
		});
		releaseLock();
		await holder;

		await expect(pause).resolves.toBe(false);
		expect(readControl(s.recipe, s.options).暂停).toBeUndefined();
		expect((await readControlReport(readControl(s.recipe, s.options), s.options)).status).toBe("completed");
	}, 20_000);
});
