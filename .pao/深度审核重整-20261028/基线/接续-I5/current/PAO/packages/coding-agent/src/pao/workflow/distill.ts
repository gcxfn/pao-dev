/**
 * 工作流配方蒸馏与落盘（2026-10-03 拍板「走完一次存配方」的机械半边）。
 *
 * - distillRecipe：扫卡目录→配方草稿（**逐字**提取——目标/部门/验收/约束/输入/档位/预算/优先级
 *   原样进节点，依赖卡号映射为节点名；人工确认一律 false：手动跑的任务没有确认留痕，
 *   审草稿时人工标）。草稿必须过 parseRecipe 全量校验（依赖成环拒绝出稿）才返回，**不落盘**——
 *   参数化建议（项目名/路径换 {参数} 占位符）留给主控/用户审时定，机械层不猜。
 * - saveRecipe：内容过 parseRecipe 全量校验（frontmatter 可解析、文件名与「名字」一致、
 *   依赖无环、占位符全部已声明）才原子写 `<PAO_HOME>/工作流/<名字>.md`；同名默认拒绝，
 *   显式覆盖先备份 `.bak-时间戳`（与 档位.json 编辑器同款纪律）。蒸馏路与对话起草路共用此闸。
 *
 * 纯函数纪律：不取当前时钟——蒸馏时间/备份时间由调用方传入（工具层取，测试注入）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readCard } from "../cards/cardfile.ts";
import { parseCardRef } from "../cards/counter.ts";
import type { CardBudget, CardPriority, CardTier, ParsedCard } from "../cards/types.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { nowString } from "../shared/time.ts";
import { parseRecipe, type RecipeNode, recipePath, type WorkflowRecipe, WorkflowRecipeError } from "./recipe.ts";

/** 蒸馏节点＝RecipeNode 的可发射形态（全部字段已从卡面定值,无占位符加工）。 */
interface DistilledNode
	extends Pick<
		RecipeNode,
		| "执行方式"
		| "工人数量"
		| "审核"
		| "部门标准"
		| "允许请求主控裁定"
		| "模型"
		| "思考强度"
		| "回边"
		| "技能"
		| "只读"
		| "parallelGroupId"
		| "branchId"
		| "joinId"
	> {
	名字: string;
	目标: string;
	部门: string;
	验收: string;
	输入?: string[];
	约束?: string;
	档位?: CardTier;
	预算?: CardBudget;
	优先级?: CardPriority;
	depends_on: string[];
	人工确认: boolean;
}

export interface DistillResult {
	/** 完整配方 markdown（frontmatter＋说明正文）,已过 parseRecipe 校验 */
	content: string;
	cardCount: number;
	edgeCount: number;
	/** 非卡文件与坏卡（原样点名,不静默丢弃） */
	skipped: string[];
}

/** YAML 双引号标量:JSON 字符串是合法 YAML（yaml 包按 YAML 1.2 双引风格解析,转义同源）。 */
function yamlString(value: string): string {
	return JSON.stringify(value);
}

function yamlStringArray(values: string[]): string {
	return `[${values.map(yamlString).join(", ")}]`;
}

/** 配方 markdown 发射器（字段顺序与手工配方一致;串一律双引号,数组/预算用 flow 风格）。 */
export function emitRecipeMarkdown(input: {
	ui?: { positions: Record<string, { x: number; y: number }> };
	版本?: 1 | 2;
	名字: string;
	自动执行: boolean;
	参数: string[];
	节点: DistilledNode[];
	parallelGroups?: WorkflowRecipe["parallelGroups"];
	说明: string;
}): string {
	const lines: string[] = ["---"];
	if (input.版本 !== undefined) lines.push(`版本: ${input.版本}`);
	lines.push(`名字: ${yamlString(input.名字)}`);
	lines.push(`自动执行: ${input.自动执行}`);
	lines.push(`参数: ${yamlStringArray(input.参数)}`);
	if (input.parallelGroups !== undefined) lines.push(`parallelGroups: ${JSON.stringify(input.parallelGroups)}`);
	if (input.ui !== undefined) lines.push(`ui: ${JSON.stringify(input.ui)}`);
	lines.push("节点:");
	for (const node of input.节点) {
		lines.push(`  - 名字: ${yamlString(node.名字)}`);
		lines.push(`    目标: ${yamlString(node.目标)}`);
		lines.push(`    部门: ${yamlString(node.部门)}`);
		lines.push(`    验收: ${yamlString(node.验收)}`);
		if (node.输入) lines.push(`    输入: ${yamlStringArray(node.输入)}`);
		if (node.约束) lines.push(`    约束: ${yamlString(node.约束)}`);
		if (node.档位) lines.push(`    档位: ${node.档位}`);
		if (node.预算) lines.push(`    预算: ${JSON.stringify(node.预算)}`);
		if (node.优先级) lines.push(`    优先级: ${node.优先级}`);
		for (const key of [
			"执行方式",
			"只读",
			"工人数量",
			"审核",
			"部门标准",
			"允许请求主控裁定",
			"模型",
			"思考强度",
			"回边",
			"技能",
			"parallelGroupId",
			"branchId",
			"joinId",
		] as const) {
			if (node[key] !== undefined) lines.push(`    ${key}: ${JSON.stringify(node[key])}`);
		}
		lines.push(`    depends_on: ${yamlStringArray(node.depends_on)}`);
		lines.push(`    人工确认: ${node.人工确认}`);
	}
	lines.push("---");
	lines.push(input.说明);
	return `${lines.join("\n")}\n`;
}

/** 卡文件名 → 节点名：去「卡NNNN-」前缀取 slug;空 slug 或撞名时退回含卡号全名保唯一。 */
function nodeName(card: ParsedCard, taken: Set<string>): string {
	const stem = card.filename.replace(/\.md$/, "");
	const slug = stem.replace(/^卡0*\d+-/, "");
	const candidate = slug.length > 0 ? slug : `节点${card.card_no}`;
	return taken.has(candidate) ? stem : candidate;
}

/**
 * 任务窗（最早创建~最晚完成,均 YYYY-MM-DD HH:mm 字符串比较）内部门知识库新增条目点名。
 * mtime 口径:机械可查、不依赖入库是否记时间字段;没有完成时间时窗只设下界。
 */
function collectDeptKnowledge(paoHome: string, cards: ParsedCard[]): string[] {
	const created = cards.map((c) => c.frontmatter.created).filter((v): v is string => typeof v === "string");
	if (created.length === 0) return [];
	const lower = created.reduce((a, b) => (a < b ? a : b));
	const done = cards.map((c) => c.frontmatter.completed).filter((v): v is string => typeof v === "string");
	const upper = done.length > 0 ? done.reduce((a, b) => (a > b ? a : b)) : undefined;
	const hits: string[] = [];
	for (const dept of new Set(cards.map((c) => c.frontmatter.dept).filter(Boolean))) {
		const root = join(paoHome, "部门", dept, "知识库");
		if (!existsSync(root)) continue;
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith(".md")) {
					const mtime = nowString(new Date(statSync(path).mtimeMs));
					if (mtime >= lower && (upper === undefined || mtime <= upper))
						hits.push(`${dept}/知识库/${relative(root, path).split(/[\\/]/).join("/")}`);
				}
			}
		};
		walk(root);
	}
	return hits;
}

/**
 * 蒸馏卡目录为配方草稿。依赖引用指向本目录外的卡（卡号查无）→ 拒绝出稿；
 * 蒸馏出的依赖图成环 → parseRecipe 抛 RECIPE_CYCLE。空目录/无有效卡 → 抛错。
 *
 * 蒸馏增强（§11.6,2026-10-03 拍板「提取时也要提取部门、工人里面的工作流程」）:
 * - 卡树:frontmatter.parent（协作母卡）也映射为依赖边（与 depends_on 合并去重）;
 * - 实施记录:每卡末次成功回执的摘要＋产物路径进说明正文,重跑照抄有据;
 * - 部门经验:给了 paoHome 时,任务时间窗内（最早创建~最晚完成,mtime 口径）部门知识库
 *   新增条目点名进说明正文——点名不搬内容,细节仍查知识库本体。
 */
export function distillRecipe(
	cardsDir: string,
	recipeName: string,
	distillTime: string,
	paoHome?: string,
): DistillResult {
	const entries = readdirSync(cardsDir); // 目录不存在直接抛 ENOENT（调用方转人话）
	const cardFiles = entries.filter((name) => /^卡0*\d+-.*\.md$/.test(name));
	const skipped = entries.filter((name) => !/^卡0*\d+-.*\.md$/.test(name));

	const cards: ParsedCard[] = [];
	for (const name of cardFiles) {
		try {
			cards.push(readCard(join(cardsDir, name)));
		} catch (error) {
			skipped.push(`${name}（坏卡:${error instanceof Error ? error.message : String(error)}）`);
		}
	}
	if (cards.length === 0) {
		throw new WorkflowRecipeError(
			"RECIPE_FIELD",
			`卡目录没有可蒸馏的有效卡：${cardsDir}${skipped.length > 0 ? `（${skipped.length} 个非卡/坏文件已点名）` : ""}`,
			{ cardsDir, 跳过: skipped },
		);
	}

	const taken = new Set<string>();
	const nameByCard = new Map<number, string>();
	for (const card of cards) {
		const name = nodeName(card, taken);
		taken.add(name);
		nameByCard.set(card.card_no, name);
	}

	const nodes: DistilledNode[] = [];
	let edgeCount = 0;
	for (const card of cards) {
		const depends_on: string[] = [];
		for (const ref of card.frontmatter.depends_on ?? []) {
			// 手编卡常见裸数字依赖,YAML 往返后是 number 不是 string——先归一再解析
			const refText = String(ref);
			const cardNo = parseCardRef(refText); // 引用形态非法（非卡号）→ PaoCardError 原样上抛
			const mapped = nameByCard.get(cardNo);
			if (mapped === undefined) {
				throw new WorkflowRecipeError(
					"RECIPE_DEP_UNKNOWN",
					`卡「${card.filename}」的依赖「${refText}」不在本卡目录（蒸馏只收目录内卡链,外部依赖先清掉再蒸馏）`,
					{ cardsDir, 卡: card.filename, 引用: refText },
				);
			}
			if (!depends_on.includes(mapped)) depends_on.push(mapped);
		}
		// 卡树边（§11.6 蒸馏增强）:parent＝协作母卡,协作关系也是依赖关系——同一映射、同一拒绝口径
		if (card.frontmatter.parent) {
			const parentRef = String(card.frontmatter.parent);
			const rootCardNo = parseCardRef(parentRef);
			const mapped = nameByCard.get(rootCardNo);
			if (mapped === undefined) {
				throw new WorkflowRecipeError(
					"RECIPE_DEP_UNKNOWN",
					`卡「${card.filename}」的 parent「${parentRef}」不在本卡目录（蒸馏只收目录内卡链,外部协作先清掉再蒸馏）`,
					{ cardsDir, 卡: card.filename, 引用: parentRef },
				);
			}
			if (!depends_on.includes(mapped)) depends_on.push(mapped);
		}
		edgeCount += depends_on.length;
		const f = card.frontmatter;
		nodes.push({
			名字: nameByCard.get(card.card_no)!,
			目标: f.goal,
			部门: f.dept,
			验收: f.acceptance,
			输入: f.inputs,
			约束: f.constraints,
			档位: f.tier,
			预算: f.budget,
			优先级: f.priority,
			depends_on,
			人工确认: false,
		});
	}

	// 实施记录（§11.6 蒸馏增强）:每卡末次成功回执的摘要＋产物——工人实际怎么干的留痕
	const cardByNode = new Map(
		nodes.map((node) => [node.名字, cards.find((c) => nameByCard.get(c.card_no) === node.名字)!]),
	);
	const implementationRecord: string[] = [];
	for (const node of nodes) {
		const card = cardByNode.get(node.名字);
		const last = card
			? [...card.receipts].reverse().find((r) => r.result === "success" && !r.archive_flag)
			: undefined;
		if (!last) continue;
		const artifact = last.artifact_path?.length ? `（产物:${last.artifact_path.join("、")}）` : "";
		implementationRecord.push(`- ${node.名字}:${last.summary ?? "（无摘要）"}${artifact}`);
	}
	// 部门经验（§11.6 蒸馏增强）:任务窗内部门知识库新增条目点名（要 paoHome）
	const deptExperience = paoHome ? collectDeptKnowledge(paoHome, cards) : [];

	const description = [
		"## 蒸馏说明",
		"",
		`- 来源：卡目录 ${cardsDir}（${cards.length} 张卡、${edgeCount} 条依赖边）,蒸馏时间 ${distillTime}。`,
		"- 本草稿为逐字提取（未参数化）：审时建议把项目名/路径等可变处换成 `{参数}` 占位符,并在 frontmatter「参数」表声明。",
		"- 「人工确认」未检测（手动跑的任务没有确认留痕）,全部默认 false——审时按实际人工点头处标 true。",
		"- 自动执行缺省 false：确认手动链无误后,如需全链自动（派发→验收→交卷）再改 true。",
		"",
		"## 实施记录（蒸馏自末次成功回执,重跑可照抄）",
		"",
		...(implementationRecord.length > 0 ? implementationRecord : ["- （无成功回执——手动任务未留回执或全失败）"]),
		...(paoHome
			? [
					"",
					"## 部门经验（任务窗内知识库新增条目点名,mtime 口径）",
					"",
					...(deptExperience.length > 0
						? deptExperience.map((entry) => `- ${entry}`)
						: ["- （窗内无新增——无对应部门知识库目录或条目都在窗外）"]),
				]
			: []),
		"",
		"## 使用说明",
		"",
		"（蒸馏草稿:描述这个工作流适合什么场景、怎么起参数）",
	].join("\n");

	const content = emitRecipeMarkdown({ 名字: recipeName, 自动执行: false, 参数: [], 节点: nodes, 说明: description });
	// 发射即校验（roundtrip）：环/字段问题在这里拦下,不把坏草稿交给审的人。
	parseRecipe(content, join("工作流", `${recipeName}.md`));
	return { content, cardCount: cards.length, edgeCount: edgeCount, skipped: skipped };
}

/** 配方文件名安全：非空、≤64、无路径分隔符/Windows 非法字符、不是点名字。 */
export function validateRecipeName(name: string): void {
	const trimmed = name.trim();
	if (trimmed === "" || trimmed !== name) throw new Error(`配方名不能为空或带首尾空白：${JSON.stringify(name)}`);
	if (name.length > 64) throw new Error(`配方名过长（≤64）:${name}`);
	if (/[\\/:*?"<>|]/.test(name) || name === "." || name === "..") {
		throw new Error(`配方名含非法字符（路径分隔符/:*?"<>|）或为点名字：${name}`);
	}
}

export interface SaveRecipeResult {
	路径: string;
	/** 覆盖时的旧文件备份路径 */
	备份?: string;
	节点数: number;
}

/**
 * 校验并落盘配方。校验＝parseRecipe 全量（含文件名与「名字」一致、无环、占位符声明一致）;
 * 原子写;同名默认拒绝,覆盖时先备份（备份时间由调用方传入,保持本函数可测）。
 */
export function saveRecipe(
	paoHome: string,
	name: string,
	content: string,
	options: { 覆盖?: boolean; 备份时间: string },
): SaveRecipeResult {
	validateRecipeName(name);
	const path = recipePath(paoHome, name);
	const recipe = parseRecipe(content, path); // 校验不过即抛,目录与文件零改动
	let backup: string | undefined;
	if (existsSync(path)) {
		if (!options.覆盖) {
			throw new Error(`配方已存在:${path}（要覆盖旧版请显式传 覆盖:true,旧文件会先备份 .bak-时间戳）`);
		}
		backup = `${path}.bak-${options.备份时间}`;
		copyFileSync(path, backup);
	}
	mkdirSync(join(paoHome, "工作流"), { recursive: true });
	writeFileAtomic(path, content);
	return { 路径: path, 备份: backup, 节点数: recipe.节点.length };
}
