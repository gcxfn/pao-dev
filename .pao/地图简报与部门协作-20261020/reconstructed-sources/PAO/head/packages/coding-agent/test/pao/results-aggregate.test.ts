/**
 * D8c 结果页聚合＋恢复摘要单测（设计包 2026-10-04，§4 hermetic 口径）：
 * 临时目录造 fixture——真实 startControl/addNodeCards 链路落 v2 控制正本与卡，基线/暂停/裁定等
 * 停因字段直写正本（真停因字段口径同 pending.test.ts 改流）；git 输出经 options.runGit 注入假值，
 * 不触真实仓库。断言：四态判据逐条命中/不误报；缺基线/缺验收/坏实例各出如实错误行不伪装空；
 * 孤儿卡与越界结论透传；diff 文件级清单与新增未跟踪排除面。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { baselineSnapshotPath } from "../../src/pao/cards/baseline.ts";
import { createCard, loadCard, parseCardRef, serializeCard } from "../../src/pao/cards/index.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { collectInstanceResults, type InstanceResultRow, type ResultsRunGit } from "../../src/pao/status/results.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	endDecomposition,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

interface Scenario {
	home: string;
	项目根: string;
	paoDir: string;
	cardsDir: string;
	recipe: ReturnType<typeof parseRecipe>;
	options: Parameters<typeof startControl>[2];
}

/** 落一个真实布局：PAO_HOME 里登记项目，项目根下 .pao 放卡目录与控制正本（平布局,扫描同源） */
function buildScenario(): Scenario {
	const home = tempDir("pao-results-home-");
	const projectRoot = tempDir("pao-results-proj-");
	const paoDir = join(projectRoot, ".pao");
	const cardsDir = join(paoDir, "卡");
	mkdirSync(cardsDir, { recursive: true });
	writeFileSync(
		join(home, "项目清单.md"),
		`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| 项目甲 | ${projectRoot} | 2026-10-04 10:00 | 2026-10-04 10:00 |\n`,
		"utf8",
	);
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "验流",
			参数: [],
			节点: [{ 名字: "开发", 部门: "开发", 目标: "改代码", 验收: "文件存在", 人工确认: true }],
		})}---\n`,
		join(projectRoot, "验流.md"),
	);
	const options = {
		cardsDir,
		ownerSessionId: "owner",
		counterPath: join(paoDir, "卡号.txt"),
		workspaceDir: paoDir,
	};
	return { home, 项目根: projectRoot, paoDir, cardsDir, recipe, options };
}

/** 真实链路推到人工门前：启动→部长绑定（临时目录非 git 仓库→基线留错误,无基线）→落卡→卡交付→拆解结束 */
async function pushToHumanGate(s: Scenario, goals: string[] = ["任务"]): Promise<string> {
	await startControl(s.recipe, {}, s.options);
	await bindMinister(s.recipe, s.options, "开发", "minister-开发");
	const flow = readControl(s.recipe, s.options);
	const identity = {
		实例: flow.实例,
		节点: "开发",
		轮次: flow.节点.find((n) => n.名字 === "开发")!.轮次,
		部长会话: "minister-开发",
	};
	const refs = await addNodeCards(
		s.recipe,
		s.options,
		identity,
		goals.map((goal) => ({ goal: goal, acceptance: "文件存在" })),
	);
	for (const ref of refs) {
		const card = loadCard(s.cardsDir, parseCardRef(ref));
		writeFileSync(card.path, serializeCard({ ...card.frontmatter, status: "delivered" }, card.body), "utf8");
	}
	await endDecomposition(s.recipe, s.options, identity);
	return identity.实例;
}

/** 直写控制正本（真停因/基线字段），模拟运行中现场 */
function changeFlow(s: Scenario, change: (flow: ReturnType<typeof readControl>) => void): void {
	const flow = readControl(s.recipe, s.options);
	change(flow);
	writeFileSync(controlPath(s.recipe, s.options), `---\n${stringify(flow)}---\n`, "utf8");
}

/** 写 v1 假清单（driver serializeManifest 同构；清单无停因字段） */
function writeV1Manifest(s: Scenario, name: string, status: string): void {
	writeFileSync(
		join(s.paoDir, `工作流实例-${name}.md`),
		`---\n工作流: ${name}\n卡目录: ${s.cardsDir}\n启动: 2026-10-04 10:00\n状态: ${status}\n参数: {}\n节点: []\n---\n<!-- 测试实例 -->\n`,
		"utf8",
	);
}

/** git 注入点假件：按子命令回假输出（diff name-status/stat、ls-files、status） */
function fakeGit(
	mapping: {
		diffNameStatus?: string;
		diffStat?: string;
		untracked?: string;
		status?: string;
		diff失败?: boolean;
		status失败?: boolean;
	} = {},
): ResultsRunGit {
	return async (args: string[]) => {
		if (args[0] === "diff") {
			if (mapping.diff失败) return { code: 1, stdout: "", stderr: "假 git:diff 失败" };
			if (args.includes("--name-status")) return { code: 0, stdout: mapping.diffNameStatus ?? "", stderr: "" };
			return { code: 0, stdout: mapping.diffStat ?? "", stderr: "" };
		}
		if (args[0] === "ls-files") return { code: 0, stdout: mapping.untracked ?? "", stderr: "" };
		if (args[0] === "status") {
			if (mapping.status失败) return { code: 1, stdout: "", stderr: "假 git:status 失败" };
			return { code: 0, stdout: mapping.status ?? "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

function findLine(rows: InstanceResultRow[], workflow: string): InstanceResultRow {
	const row = rows.find((entry) => entry.工作流 === workflow);
	expect(row, `应找到工作流「${workflow}」的结果行`).toBeDefined();
	return row!;
}

/** 给卡正文追加机械验收段（verifier 段标题格式冻结：## 机械验收 YYYY-MM-DD HH:mm） */
function writeMechanicalAcceptance(s: Scenario, ref: string, verdict = "全过自动交付"): void {
	const card = loadCard(s.cardsDir, parseCardRef(ref));
	writeFileSync(
		card.path,
		serializeCard(card.frontmatter, `${card.body}\n## 机械验收 2026-10-04 12:00\n- 结论: ${verdict}\n`),
		"utf8",
	);
}

describe("collectInstanceResults（D8c 结果页聚合）", () => {
	it("空 PAO_HOME：无行无异常", async () => {
		const home = tempDir("pao-results-empty-");
		expect(await collectInstanceResults(home)).toEqual({ line: [], exception: [] });
	});

	it("人工门实例：已中断＋拟续跑确认命令（零动作文案）；缺 diff 基线与缺验收记录如实，不误报已改未验", async () => {
		const s = buildScenario();
		const instance = await pushToHumanGate(s);
		const { line, exception } = await collectInstanceResults(s.home);
		expect(exception).toEqual([]);
		const row = findLine(line, "验流");
		expect(row.项目).toBe("项目甲");
		expect(row.实例).toBe(instance);
		expect(row.状态).toBe("运行中"); // controlReport 口径：门未点头仍报运行中，但恢复摘要如实亮已中断
		expect(row.恢复.已完成).toBe(false);
		expect(row.恢复.已中断).toBe(true);
		expect(row.恢复.已改未验).toBe(false); // 缺基线无法核验改动 → 不误报
		expect(row.恢复.拟续跑).toBe(true);
		const gateLine = row.恢复.行.find((line) => line.态 === "已中断");
		expect(gateLine?.文案).toContain("等待人工确认");
		const suggestionLine = row.恢复.行.find((line) => line.态 === "拟续跑");
		expect(suggestionLine?.文案).toContain(`action=confirm name=验流 instance=${instance}`);
		expect(suggestionLine?.文案).toContain("须你在界面确认");
		expect(suggestionLine?.证据).toEqual([row.路径]);
		const node = row.节点结果[0]!;
		expect(node.要求.卡面轴).toBe("文件存在"); // 冻结配方验收轴（判定包同源）
		expect(node.要求.部门标准轴).toBe("未声明");
		expect(node.实际diff.可用).toBe(false);
		if (node.实际diff.可用) return;
		expect(node.实际diff.原因).toContain("缺 diff 基线");
		expect(node.验收.缺失说明).toBe("缺验收记录");
		expect(node.验收.记录).toEqual([]);
		expect(node.验收.判定).toBeUndefined();
		// 缺基线＋无验收段：两判据并列如实展示，不取其一冒充
		const parallel = row.恢复.行.find((line) => line.态 === "已改未验");
		expect(parallel?.文案).toContain("缺 diff 基线无法核验改动");
		expect(parallel?.文案).toContain("无判定");
	});

	it("已完成实例：完成判据命中（卡全交付＋人工门已确认），无中断无拟续跑", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		changeFlow(s, (flow) => {
			flow.节点[0]!.确认 = "2026-10-04 12:00";
		});
		const { line } = await collectInstanceResults(s.home);
		const row = findLine(line, "验流");
		expect(row.状态).toBe("已完成");
		expect(row.恢复.已完成).toBe(true);
		expect(row.恢复.已中断).toBe(false);
		expect(row.恢复.拟续跑).toBe(false);
		expect(row.恢复.行.some((line) => line.态 === "已完成")).toBe(true);
		expect(row.恢复.行.some((line) => line.态 === "拟续跑")).toBe(false);
	});

	it("无门挂起实例：拟续跑＝恢复命令；超限暂停走放行文案，不冒充人工门", async () => {
		const s = buildScenario();
		await startControl(s.recipe, {}, s.options);
		changeFlow(s, (flow) => {
			flow.暂停 = "手工暂停:等现场核查";
		});
		let snap = await collectInstanceResults(s.home);
		let row = findLine(snap.line, "验流");
		expect(row.状态).toBe("挂起");
		expect(row.恢复.已中断).toBe(true);
		const resumeLine = row.恢复.行.find((line) => line.文案.includes("action=resume"));
		expect(resumeLine?.文案).toContain("reason=<现场核查>");
		// 恢复三件套给真值：resumeControl 硬校验 prev_owner,照抄必含控制正本 owner
		expect(resumeLine?.文案).toContain("prev_owner=owner");
		changeFlow(s, (flow) => {
			flow.暂停 = "回边 审查→开发 超限 3:连续两轮不达标";
		});
		snap = await collectInstanceResults(s.home);
		row = findLine(snap.line, "验流");
		const approvedLine = row.恢复.行.find((line) => line.态 === "拟续跑");
		expect(approvedLine?.文案).toContain("改配方");
		expect(approvedLine?.文案).not.toContain("动作=恢复");
	});

	it("有基线节点：diff 文件级清单＋stat 摘要＋新增未跟踪排除面；基线外改动＋无验收 → 已改未验命中", async () => {
		const s = buildScenario();
		const instance = await pushToHumanGate(s);
		changeFlow(s, (flow) => {
			flow.节点[0]!.基线 = { 项目根: s.项目根, 提交: "b".repeat(40), 未跟踪: ["既有未跟踪.txt"] };
		});
		const { line } = await collectInstanceResults(s.home, {
			runGit: fakeGit({
				diffNameStatus: "M\tsrc/a.ts\nA\tsrc/new.ts",
				diffStat: " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
				untracked: "新增.txt\0.pao/内部.txt\0既有未跟踪.txt\0",
			}),
		});
		const row = findLine(line, "验流");
		const node = row.节点结果[0]!;
		expect(node.实际diff.可用).toBe(true);
		if (!node.实际diff.可用) return;
		expect(node.实际diff.摘要).toContain("1 file changed");
		expect(node.实际diff.文件).toEqual([
			{ 状态: "M", 文件: "src/a.ts" },
			{ 状态: "A", 文件: "src/new.ts" },
		]);
		// 新增未跟踪排除 .pao/ 编排区与基线已有未跟踪（control.ts:658-661 同口径）
		expect(node.实际diff.新增未跟踪).toEqual(["新增.txt"]);
		// 基线已有未跟踪 → 遗留透传（内容变化未能归因）
		expect(node.遗留.some((line) => line.includes("基线已有未跟踪文件（1 个）"))).toBe(true);
		expect(row.恢复.已改未验).toBe(true);
		const markUnverifiedLine = row.恢复.行.find((line) => line.态 === "已改未验");
		// 改动数＝已跟踪 diff 文件 2＋新增未跟踪 1（都是基线外改动）
		expect(markUnverifiedLine?.文案).toContain("基线外改动 3 处");
		expect(markUnverifiedLine?.文案).toContain("无判定");
		expect(row.实例).toBe(instance);
	});

	it("已改未验两判据冲突并列：有改动但卡有机械验收段 → 不冒充已改未验，判据并列展示", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		changeFlow(s, (flow) => {
			flow.节点[0]!.基线 = { 项目根: s.项目根, 提交: "c".repeat(40), 未跟踪: [] };
		});
		for (const ref of readControl(s.recipe, s.options).节点[0]!.卡) writeMechanicalAcceptance(s, ref);
		const { line } = await collectInstanceResults(s.home, {
			runGit: fakeGit({ diffNameStatus: "M\tsrc/a.ts", diffStat: " 1 file changed" }),
		});
		const row = findLine(line, "验流");
		expect(row.恢复.已改未验).toBe(false);
		const node = row.节点结果[0]!;
		expect(node.验收.记录[0]?.结论).toBe("全过自动交付");
		expect(node.验收.缺失说明).toBeUndefined();
		const parallel = row.恢复.行.find((line) => line.态 === "已改未验");
		expect(parallel?.文案).toContain("判据并列");
		expect(parallel?.文案).toContain("「未验」不成立");
	});

	it("git diff 失败：diff 段降级为如实错误行，不伪装空差异", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		changeFlow(s, (flow) => {
			flow.节点[0]!.基线 = { 项目根: s.项目根, 提交: "d".repeat(40), 未跟踪: [] };
		});
		const { line } = await collectInstanceResults(s.home, { runGit: fakeGit({ diff失败: true }) });
		const node = findLine(line, "验流").节点结果[0]!;
		expect(node.实际diff.可用).toBe(false);
		if (node.实际diff.可用) return;
		expect(node.实际diff.原因).toContain("diff 读取失败");
		expect(node.实际diff.原因).toContain("假 git:diff 失败");
	});

	it("孤儿卡透传：标记指向本流但节点不在配方（配方改版遗留，点名不丢弃）", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		const orphan = await createCard(
			s.cardsDir,
			{ 目标: "旧版遗留卡", 部门: "开发", 验收: "无", 创建: "2026-10-04 09:00" },
			{ counterPath: s.options.counterPath },
		);
		writeFileSync(
			orphan.path,
			serializeCard(orphan.frontmatter, `<!-- pao-workflow:流=验流/节点=已删除节点 -->\n${orphan.body}`),
			"utf8",
		);
		const { line } = await collectInstanceResults(s.home);
		const row = findLine(line, "验流");
		expect(row.孤儿卡).toHaveLength(1);
		expect(row.孤儿卡[0]!.节点).toBe("已删除节点");
		expect(row.孤儿卡[0]!.卡状态).toBe("unclaimed");
	});

	it("越界核查透传：git 真值 − 认领基线 vs 回执声明，非干净结论进遗留", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		const ref = readControl(s.recipe, s.options).节点[0]!.卡[0]!;
		const card = loadCard(s.cardsDir, parseCardRef(ref));
		// 回执通道要求尝试号为正且 ≤ 卡面尝试，声明产物须真实存在（相对项目根）
		writeFileSync(card.path, serializeCard({ ...card.frontmatter, attempt: 1 }, card.body), "utf8");
		mkdirSync(join(s.项目根, "src"), { recursive: true });
		writeFileSync(join(s.项目根, "src", "declared.ts"), "产物\n", "utf8");
		appendReceipt(loadCard(s.cardsDir, parseCardRef(ref)), {
			尝试号: 1,
			时间: "2026-10-04 12:05",
			结果: "成功",
			摘要: "改了声明内的文件",
			产物路径: ["src/declared.ts"],
		});
		// 认领基线快照：既有 1 条（既有.txt 不计 worker 的账）；条目行 = "XY\t路径"
		const snapshotPath = baselineSnapshotPath(s.cardsDir, card.card_no);
		mkdirSync(dirname(snapshotPath), { recursive: true });
		writeFileSync(
			snapshotPath,
			`# 卡${String(card.card_no).padStart(4, "0")} 认领基线\n# 项目根: ${s.项目根}\n# 既有条目数: 1\nM\t既有.txt\n`,
			"utf8",
		);
		const { line } = await collectInstanceResults(s.home, {
			// git status --porcelain -z 真格式：XY+空格+路径，NUL 分隔
			runGit: fakeGit({ status: "M  src/declared.ts\0?? extra.txt\0 M 既有.txt\0" }),
		});
		const node = findLine(line, "验流").节点结果[0]!;
		const outOfScope = node.遗留.find((line) => line.includes("越界核查"));
		expect(outOfScope).toContain("越界核查 越界");
		expect(outOfScope).toContain("extra.txt");
		// 声明与真值相符的部分不算越界
		expect(outOfScope).toContain("相符 1 项");
	});

	it("越界核查全新目录文件级比对（S6-K4 顺带修）：git status 须带 -uall，未跟踪目录展开到文件级，声明相符不算越界（真实 git）", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		const ref = readControl(s.recipe, s.options).节点[0]!.卡[0]!;
		const card = loadCard(s.cardsDir, parseCardRef(ref));
		writeFileSync(card.path, serializeCard({ ...card.frontmatter, attempt: 1 }, card.body), "utf8");
		// worker 在全新目录产出声明文件：真实 git 不带 -uall 时 status 只报目录级 `?? 产出/`，
		// 与回执的文件级声明 `产出/new.txt` 比对不上 → 目录级条目虚报越界（与 baseline.ts:98-110 同口径修）
		mkdirSync(join(s.项目根, "产出"), { recursive: true });
		writeFileSync(join(s.项目根, "产出", "new.txt"), "产物\n", "utf8");
		appendReceipt(loadCard(s.cardsDir, parseCardRef(ref)), {
			尝试号: 1,
			时间: "2026-10-07 12:05",
			结果: "成功",
			摘要: "全新目录产物",
			产物路径: ["产出/new.txt"],
		});
		const snapshotPath = baselineSnapshotPath(s.cardsDir, card.card_no);
		mkdirSync(dirname(snapshotPath), { recursive: true });
		writeFileSync(
			snapshotPath,
			`# 卡${String(card.card_no).padStart(4, "0")} 认领基线\n# 项目根: ${s.项目根}\n# 既有条目数: 0\n`,
			"utf8",
		);
		// 真实 git 仓库（不注入 runGit）：认领时非仓库无节点基线，越界核查走真 git status
		execFileSync("git", ["init"], { cwd: s.项目根, stdio: "ignore" });
		const { line } = await collectInstanceResults(s.home);
		const node = findLine(line, "验流").节点结果[0]!;
		expect(node.遗留.some((entry) => entry.includes("越界核查"))).toBe(false);
	}, 60_000);

	it("越界比对无法进行：快照在而 git 失败 / 快照缺项目根，各出如实错误行不冒充干净", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		const ref = readControl(s.recipe, s.options).节点[0]!.卡[0]!;
		const card = loadCard(s.cardsDir, parseCardRef(ref));
		const snapshotPath = baselineSnapshotPath(s.cardsDir, card.card_no);
		mkdirSync(dirname(snapshotPath), { recursive: true });
		writeFileSync(snapshotPath, `# 卡${String(card.card_no).padStart(4, "0")} 认领基线\n# 项目根: ${s.项目根}\n`);
		const fail = await collectInstanceResults(s.home, { runGit: fakeGit({ status失败: true }) });
		expect(findLine(fail.line, "验流").节点结果[0]!.遗留.join("\n")).toContain("越界比对无法进行：git 状态不可用");
		writeFileSync(snapshotPath, `# 卡${String(card.card_no).padStart(4, "0")} 认领基线\n# 既有条目数: 0\n`);
		const missingRoot = await collectInstanceResults(s.home, { runGit: fakeGit({ status: "?? x.txt\0" }) });
		expect(findLine(missingRoot.line, "验流").节点结果[0]!.遗留.join("\n")).toContain(
			"越界比对无法进行：快照缺项目根",
		);
	});

	it("无认领基线快照的卡不做越界比对（不猜不误报）", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		const { line } = await collectInstanceResults(s.home, { runGit: fakeGit({ status: "?? new.txt\0" }) });
		const node = findLine(line, "验流").节点结果[0]!;
		expect(node.遗留.some((line) => line.includes("越界"))).toBe(false);
	});

	it("坏实例如实进异常行，不拖垮同项目其他实例行", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		writeFileSync(join(s.paoDir, "工作流实例-坏流.md"), `---\n版本: 2\n工作流: 坏流\n---\n`, "utf8");
		writeFileSync(join(s.paoDir, "随手笔记.md"), "无关文件\n", "utf8");
		const { line, exception } = await collectInstanceResults(s.home);
		expect(findLine(line, "验流").节点结果.length).toBe(1);
		expect(line.some((entry) => entry.工作流 === "坏流")).toBe(false);
		expect(exception).toHaveLength(1);
		expect(exception[0]!.文件).toBe("工作流实例-坏流.md");
		expect(exception[0]!.原因).toContain("卡目录");
	});

	it("v1 旧实例如实降级：四样不可读、挂起亮已中断＋人工重建建议；v1 已完成按清单口径亮完成", async () => {
		const s = buildScenario();
		writeV1Manifest(s, "旧流", "挂起");
		let snap = await collectInstanceResults(s.home);
		let row = findLine(snap.line, "旧流");
		expect(row.状态).toBe("挂起");
		expect(row.实例).toBe("");
		expect(row.说明).toContain("旧版实例（v1）");
		expect(row.节点结果).toEqual([]);
		expect(row.恢复.已中断).toBe(true);
		expect(row.恢复.已改未验).toBe(false);
		const suggestionLine = row.恢复.行.find((line) => line.态 === "拟续跑");
		expect(suggestionLine?.文案).toContain("不可自动续跑");
		expect(suggestionLine?.文案).toContain("人工重建");
		writeV1Manifest(s, "旧流", "已完成");
		snap = await collectInstanceResults(s.home);
		row = findLine(snap.line, "旧流");
		expect(row.恢复.已完成).toBe(true);
		expect(row.恢复.行[0]!.文案).toContain("清单口径");
	});

	it("登记了不存在项目根：无 .pao 目录如实跳过，不进行也不进异常", async () => {
		const home = tempDir("pao-results-ghost-");
		writeFileSync(
			join(home, "项目清单.md"),
			`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| 幽灵 | ${join(home, "不存在")} | 2026-10-04 10:00 | 2026-10-04 10:00 |\n`,
			"utf8",
		);
		expect(await collectInstanceResults(home)).toEqual({ line: [], exception: [] });
	});
});
