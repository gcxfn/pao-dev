import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { parseFrontmatter, stripFrontmatter } from "../../utils/frontmatter.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { formatCardNumber, nextCardNumber, parseCardRef } from "./counter.ts";
import { PaoCardError } from "./errors.ts";
import type { CardBudget, CardFrontmatter, CardPriority, CardStatus, CardTier, ParsedCard, Receipt } from "./types.ts";
import { CARD_PRIORITIES, CARD_STATUSES, CARD_TIERS, FAILURE_TYPES } from "./types.ts";

const DATE_TIME_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function paoDirForCards(cardsDir: string): string | undefined {
	let current = resolve(cardsDir);
	while (dirname(current) !== current) {
		if (basename(current).toLowerCase() === ".pao") return current;
		current = dirname(current);
	}
	return undefined;
}

/** 平铺 .pao/卡 与任务 .pao/<任务>/卡 都以同一项目根解析执行和回执产物。 */
export function projectRootForCards(cardsDir: string): string {
	return realpathSync(dirname(paoDirForCards(cardsDir) ?? resolve(cardsDir)));
}

/** frontmatter 键的固定输出顺序（协议 §2 顺序，便于人读与 diff）。 */
const FIELD_ORDER: (keyof CardFrontmatter)[] = [
	"goal",
	"dept",
	"inputs",
	"constraints",
	"acceptance",
	"depends_on",
	"parent",
	"tier",
	"budget",
	"priority",
	"owner",
	"attempt",
	"created",
	"completed",
	"status",
];

/** 必需字段：缺任何一个 = 结构化错误（验收条目 2）。 */
const REQUIRED_FIELDS: (keyof CardFrontmatter)[] = ["goal", "dept", "acceptance", "attempt", "created", "status"];

/**
 * 值必须是字符串的字段（审查第 3 项）：YAML 会把 `123`/`true`/`null` 这类裸排标量解析成数字、
 * 布尔或空值，卡写出去再读回来就不是用户写的那个字符串。此前只查「有没有」，没查「是什么类型」。
 */
const STRING_FIELDS: (keyof CardFrontmatter)[] = [
	"goal",
	"dept",
	"acceptance",
	"constraints",
	"parent",
	"owner",
	"completed",
];

/** 值必须是字符串数组的字段（缺省合法，空数组合法）。 */
const STRING_ARRAY_FIELDS: (keyof CardFrontmatter)[] = ["inputs", "depends_on"];

/** 报错里描述实际类型，不把原始值整段打印出来（长正文不进错误详情）。 */
function describeValueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "数组";
	return typeof value;
}

export function validateFrontmatter(value: unknown): CardFrontmatter {
	if (typeof value !== "object" || value === null) {
		throw new PaoCardError("INVALID_CARD", "卡 frontmatter 缺失或不是映射", { frontmatter: value });
	}
	const fm = value as Record<string, unknown>;
	const missing = REQUIRED_FIELDS.filter((key) => fm[key] === undefined || fm[key] === null || fm[key] === "");
	if (missing.length > 0) {
		throw new PaoCardError("INVALID_CARD", `卡 frontmatter 缺必需字段：${missing.join("、")}`, { missing });
	}
	const wrongType = STRING_FIELDS.filter((key) => fm[key] !== undefined && typeof fm[key] !== "string");
	if (wrongType.length > 0) {
		throw new PaoCardError(
			"INVALID_CARD",
			`卡 frontmatter 字段类型应为字符串：${wrongType.map((key) => `${key} 实际是 ${describeValueType(fm[key])}`).join("、")}`,
			{ wrongType },
		);
	}
	const wrongArray = STRING_ARRAY_FIELDS.filter(
		(key) =>
			fm[key] !== undefined &&
			!(Array.isArray(fm[key]) && (fm[key] as unknown[]).every((item) => typeof item === "string")),
	);
	if (wrongArray.length > 0) {
		throw new PaoCardError("INVALID_CARD", `卡 frontmatter 字段类型应为字符串数组：${wrongArray.join("、")}`, {
			wrongArray,
		});
	}
	if (!CARD_STATUSES.includes(fm.status as CardStatus)) {
		throw new PaoCardError("INVALID_CARD", `状态非法：${String(fm.status)}`, { status: fm.status });
	}
	if (!Number.isInteger(fm.attempt) || (fm.attempt as number) < 0) {
		throw new PaoCardError("INVALID_CARD", `尝试必须是 >=0 的整数：${String(fm.attempt)}`, { attempt: fm.attempt });
	}
	if (typeof fm.created !== "string" || !DATE_TIME_FORMAT.test(fm.created)) {
		throw new PaoCardError("INVALID_CARD", `创建时间格式应为 YYYY-MM-DD HH:mm：${String(fm.created)}`, {
			created: fm.created,
		});
	}
	if (fm.priority !== undefined && !CARD_PRIORITIES.includes(fm.priority as CardPriority)) {
		throw new PaoCardError("INVALID_CARD", `优先级非法：${String(fm.priority)}`, { priority: fm.priority });
	}
	if (fm.tier !== undefined && !CARD_TIERS.includes(fm.tier as CardTier)) {
		throw new PaoCardError("INVALID_CARD", `档位非法：${String(fm.tier)}`, { tier: fm.tier });
	}
	validateCardBudget(fm.budget);
	if (fm.失败类型 !== undefined && !FAILURE_TYPES.includes(fm.失败类型 as never)) {
		throw new PaoCardError("INVALID_CARD", `失败类型非法：${String(fm.失败类型)}`, { 失败类型: fm.失败类型 });
	}
	return fm as unknown as CardFrontmatter;
}

/** 只校验预算的单位和值，不替主控判断任务应该花多少。 */
export function validateCardBudget(value: unknown): CardBudget | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new PaoCardError("INVALID_CARD", "预算须为对象，使用 turns/toolCalls/cost/collab_quota", {});
	}
	const budget = value as Record<string, unknown>;
	for (const key of ["turns", "toolCalls", "cost", "collab_quota"] as const) {
		const limit = budget[key];
		if (limit === undefined) continue;
		if (
			typeof limit !== "number" ||
			!Number.isFinite(limit) ||
			limit < 0 ||
			(key !== "cost" && !Number.isInteger(limit))
		) {
			throw new PaoCardError("INVALID_CARD", `预算 ${key} 须为非负${key === "cost" ? "数值" : "整数"}`, {});
		}
	}
	return budget as CardBudget;
}

/** 目标简述 → 文件名安全片段：去 Windows 非法字符与空白，截 20 字符。 */
export function slugifyGoal(goal: string): string {
	const cleaned = goal.replace(/[\s/\\:*?"<>|]+/g, "").slice(0, 20);
	return cleaned.length > 0 ? cleaned : "未命名";
}

export function cardFileName(cardNo: number, goal: string): string {
	return `${formatCardNumber(cardNo)}-${slugifyGoal(goal)}.md`;
}

/** 从卡文件名解析卡号（卡0017-xxx.md → 17）。 */
export function cardNumberFromFileName(fileName: string): number | undefined {
	const match = /^卡0*(\d+)-/.exec(fileName);
	return match ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * 序列化卡文件：YAML frontmatter（信封字段）+ 正文（回执区）。
 * 创建/完成存 "YYYY-MM-DD HH:mm" 字符串；时间由调用方传入，本模块不取当前时钟（保持纯函数可测）。
 */
export function serializeCard(frontmatter: CardFrontmatter, body: string): string {
	const lines: string[] = ["---"];
	for (const key of FIELD_ORDER) {
		const value = (frontmatter as unknown as Record<string, unknown>)[key];
		if (value === undefined) continue;
		lines.push(`${key}: ${formatYamlValue(value)}`);
	}
	lines.push("---");
	// 正文与 frontmatter 间空一行；正文结尾保证单换行
	const trimmedBody = body.trim();
	return `${lines.join("\n")}\n\n${trimmedBody.length > 0 ? `${trimmedBody}\n` : ""}`;
}

export function formatYamlValue(value: unknown): string {
	if (typeof value === "string") {
		return yamlSafeString(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		// 数组逐项 JSON 序列化（裸中文项会让整串非法 JSON，parseScalar 只能回读成字符串）：
		// 产物路径/证据（字符串）与 verification/changes（对象）统一 JSON.parse 还原
		return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
	}
	if (typeof value === "object" && value !== null) {
		// 对象用 JSON 序列化：合法 YAML flow mapping，且回执解析端可 JSON.parse 还原
		return JSON.stringify(value);
	}
	return String(value);
}

/**
 * 该裸排在 YAML 里回读是否仍是同一个字符串（审查第 3 项）。
 * `123`/`true`/`null`/`01`/`1e3` 会被解析成数字、布尔或空值，必须加引号才能保持原值；
 * 判据直接问解析器本身，不自己维护一份「哪些词像数字」的清单。
 */
function yamlPlainStaysString(text: string): boolean {
	try {
		return parseYaml(text) === text;
	} catch {
		return false;
	}
}

/** 含 YAML 特殊字符、或裸排会被解析成非字符串时加双引号；简单中文/字母数字裸排，可读性优先。 */
export function yamlSafeString(text: string): string {
	return /^[\w\u4e00-\u9fff.-]+$/.test(text) && yamlPlainStaysString(text) ? text : JSON.stringify(text);
}

/** 解析卡文件内容（字符串）。frontmatter 走 fork 内 utils/frontmatter（yaml 包），缺必需字段报结构化错误。 */
export function parseCardContent(content: string, filePath: string): ParsedCard {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	let fm: CardFrontmatter;
	try {
		fm = validateFrontmatter(frontmatter);
	} catch (error) {
		// 工具输出纪律(M1-04):关键失败必须带完整文件路径,坏卡错误不让用户猜是哪张卡
		if (error instanceof PaoCardError) {
			throw new PaoCardError(error.code, `${error.message}（文件：${filePath}）`, { ...error.details, filePath });
		}
		throw error;
	}
	const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
	const cardNo = cardNumberFromFileName(fileName);
	if (cardNo === undefined) {
		throw new PaoCardError("INVALID_CARD", `卡文件名不符合 卡NNNN-目标简述.md：${fileName}`, { filePath });
	}
	return {
		path: filePath,
		filename: fileName,
		card_no: cardNo,
		frontmatter: fm,
		body: body,
		receipts: parseReceipts(body, cardNo),
	};
}

export function readCard(filePath: string): ParsedCard {
	return parseCardContent(readFileSync(filePath, "utf8"), filePath);
}

/** 在卡目录内按卡号找卡文件。 */
export function findCardFile(cardsDir: string, cardNo: number): string | undefined {
	const prefix = formatCardNumber(cardNo);
	return readdirSync(cardsDir).find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".md"));
}

export function loadCard(cardsDir: string, cardNo: number): ParsedCard {
	const fileName = findCardFile(cardsDir, cardNo);
	if (!fileName) {
		throw new PaoCardError("CARD_NOT_FOUND", `在 ${cardsDir} 找不到卡${formatCardNumber(cardNo)}`, {
			cardsDir,
			card_no: cardNo,
		});
	}
	return readCard(join(cardsDir, fileName));
}

/** 卡目录扫描问题：坏卡或目录不可读的具体位置与原因（供交接页/待办如实披露，不冒充「没有任务」）。 */
export interface CardScanProblem {
	path: string;
	reason: string;
}

export interface CardScanResult {
	cards: ParsedCard[];
	problems: CardScanProblem[];
}

function scanErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 扫描卡目录：同时给出可读卡片与遇到的问题（审查第 5 项）。
 * - 目录不存在＝空队列（真没有任务），不算问题；
 * - 目录存在却读不到（权限/IO/同名文件占位）＝问题，不能当成空队列；
 * - 单张卡解析或校验失败＝该卡计入问题，其余卡照常返回（坏卡不阻断队列可用性）。
 */
export function scanCards(cardsDir: string): CardScanResult {
	let entries: string[];
	try {
		entries = readdirSync(cardsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cards: [], problems: [] };
		return { cards: [], problems: [{ path: cardsDir, reason: `卡目录不可读：${scanErrorText(error)}` }] };
	}
	const cards: ParsedCard[] = [];
	const problems: CardScanProblem[] = [];
	for (const name of entries.filter((name) => /^卡0*\d+-.*\.md$/.test(name))) {
		const filePath = join(cardsDir, name);
		try {
			cards.push(readCard(filePath));
		} catch (error) {
			// 坏卡跳过但记账：队列渲染优先可用，坏卡修复属于治理动作
			problems.push({ path: filePath, reason: scanErrorText(error) });
		}
	}
	return { cards: cards.sort((a, b) => a.card_no - b.card_no), problems };
}

/** 列出卡目录内全部可读卡（按卡号升序）。目录不存在视为空队列；坏卡跳过不炸整队。 */
export function listCards(cardsDir: string): ParsedCard[] {
	return scanCards(cardsDir).cards;
}

export interface CardCreateInput {
	目标: string;
	部门: string;
	验收: string;
	输入?: string[];
	约束?: string;
	depends_on?: string[];
	parent?: string;
	档位?: CardTier;
	预算?: CardBudget;
	优先级?: CardPriority;
	owner?: string;
	创建: string;
	状态?: CardStatus;
}

export interface CreateCardOptions {
	/** 卡号计数器路径；缺省在最近 .pao/ 下，非标准布局沿用 `<卡目录>/../../卡号.txt`。 */
	counterPath?: string;
	/** 等待发号期间取消后不再落卡；已经完成的原子写保留。 */
	signal?: AbortSignal;
	/**
	 * 卡正文骨架（可选，M2-09 卡模板库）：来自已批准模板（`<PAO_HOME>/pao配置/卡模板/`，
	 * 经 loadCardBodyTemplate 取出）。只贡献正文，frontmatter 仍由 input 生成，卡协议字段不因模板增减。
	 * 给了但剥空（模板只有 frontmatter/空白）视为坏模板，结构化报错不静默。
	 */
	模板正文?: string;
}

/**
 * 建卡：发号（文件锁）→ 命名 卡NNNN-目标简述.md → 原子写入卡目录。
 * 新卡默认状态 待认领、尝试 0（真实启动才递增，见 statemachine.ts）。
 */
export async function createCard(
	cardsDir: string,
	input: CardCreateInput,
	options?: CreateCardOptions,
): Promise<ParsedCard> {
	options?.signal?.throwIfAborted();
	validateCardBudget(input.预算);
	if (input.owner !== undefined && (typeof input.owner !== "string" || !input.owner.trim())) {
		throw new PaoCardError("INVALID_CARD", "owner 不能为空白；未认领的新卡请省略 owner", {});
	}
	const counterPath = options?.counterPath ?? join(paoDirForCards(cardsDir) ?? join(cardsDir, "..", ".."), "卡号.txt");
	const templateBody = options?.模板正文;
	if (templateBody !== undefined && templateBody.trim().length === 0) {
		throw new PaoCardError(
			"INVALID_CARD",
			"模板正文为空：模板须提供正文骨架（只有 frontmatter 的模板不算已批准模板）",
			{
				模板正文长度: templateBody.length,
			},
		);
	}
	const cardNo = await nextCardNumber(counterPath, options?.signal);
	options?.signal?.throwIfAborted();
	const frontmatter: CardFrontmatter = {
		goal: input.目标,
		dept: input.部门,
		inputs: input.输入 ?? [],
		constraints: input.约束,
		acceptance: input.验收,
		depends_on: input.depends_on ?? [],
		parent: input.parent,
		tier: input.档位,
		budget: input.预算,
		priority: input.优先级 ?? "medium",
		owner: input.owner,
		attempt: 0,
		created: input.创建,
		status: input.状态 ?? "unclaimed",
	};
	const fileName = cardFileName(cardNo, input.目标);
	const filePath = join(cardsDir, fileName);
	writeFileAtomic(filePath, serializeCard(frontmatter, templateBody ?? ""));
	return readCard(filePath);
}

// ============================================================================
// 卡模板库（M2-09 件3：`<PAO_HOME>/pao配置/卡模板/` 已批准模板，建卡「模板」参数带出正文骨架。
// 架构 §8.2 机械放行引用「已批准模板」——模板本体住使用现场，开发仓不建副本）
// ============================================================================

/** 模板目录相对 PAO_HOME 的路径（使用现场；PAO_HOME 由工具接线层解析传入，本模块不读环境变量）。 */
export const CARD_TEMPLATE_DIR = join("pao配置", "卡模板");

/** 列出模板目录下可用模板名（文件名去 .md，排序）；目录不存在视为空。 */
export function listCardTemplates(templateDir: string): string[] {
	if (!existsSync(templateDir)) return [];
	return readdirSync(templateDir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.slice(0, -3))
		.sort();
}

/**
 * 解析建卡「模板」参数：绝对路径（盘符/根开头）直接用；否则视为模板名，
 * 找 `<paoHome>/pao配置/卡模板/<名>.md`（带不带 .md 后缀都收）。
 * 缺 paoHome 时只收绝对路径——给名字即结构化报错，不静默降级为无模板；
 * 找不到报错并附现有模板名清单，不让人猜。
 */
export function resolveCardTemplatePath(template: string, paoHome?: string): string {
	const trimmed = template.trim();
	if (trimmed.length === 0) {
		throw new PaoCardError("INVALID_CARD", "模板参数为空", { 模板: template });
	}
	if (!isAbsolute(trimmed)) {
		if (!paoHome || paoHome.trim().length === 0) {
			throw new PaoCardError(
				"INVALID_CARD",
				`模板「${trimmed}」不是绝对路径，且未配置 PAO_HOME（缺 PAO_HOME 时模板只收绝对路径）`,
				{ 模板: trimmed },
			);
		}
		const dir = join(paoHome, CARD_TEMPLATE_DIR);
		const path = join(dir, trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`);
		if (!existsSync(path)) {
			const available = listCardTemplates(dir);
			throw new PaoCardError(
				"CARD_NOT_FOUND",
				`找不到卡模板：${path}${available.length > 0 ? `（可用：${available.join("、")}）` : "（模板目录为空或不存在）"}`,
				{ 模板: trimmed, 路径: path, 可用: available },
			);
		}
		return path;
	}
	if (!existsSync(trimmed)) {
		throw new PaoCardError("CARD_NOT_FOUND", `找不到卡模板（绝对路径）：${trimmed}`, { 模板: trimmed });
	}
	return trimmed;
}

/**
 * 读模板文件并取出正文骨架：模板若带 frontmatter 只取正文——卡 frontmatter 仍由建卡流程生成，
 * 模板只贡献正文骨架（架构 §8.2「已批准模板」的使用面）。读取失败结构化报错。
 */
export function loadCardBodyTemplate(templatePath: string): string {
	let content: string;
	try {
		content = readFileSync(templatePath, "utf8");
	} catch (error) {
		throw new PaoCardError(
			"CARD_NOT_FOUND",
			`卡模板不可读：${templatePath}（${String((error as Error).message).slice(0, 160)}）`,
			{ 模板路径: templatePath },
		);
	}
	return stripFrontmatter(content).trim();
}

// ============================================================================
// 回执区（正文）序列化与解析
// ============================================================================

/** 回执段标题格式冻结：`## 回执 尝试N YYYY-MM-DD HH:mm`，解析与追加都靠它。 */
export const RECEIPT_HEADING_PATTERN = /^## 回执 尝试(\d+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;

export function serializeReceipt(receipt: Receipt): string {
	const lines = [`## 回执 尝试${receipt.attempt} ${receipt.time}`];
	if (receipt.archive_flag) lines.push(`- archive_flag: ${receipt.archive_flag}`);
	if (receipt.result !== undefined) lines.push(`- result: ${yamlSafeString(receipt.result)}`);
	if (receipt.summary !== undefined) lines.push(`- summary: ${yamlSafeString(receipt.summary)}`);
	if (receipt.artifact_path?.length) lines.push(`- artifact_path: ${formatYamlValue(receipt.artifact_path)}`);
	if (receipt.evidence?.length) lines.push(`- evidence: ${formatYamlValue(receipt.evidence)}`);
	if (receipt.usage !== undefined) lines.push(`- usage: ${formatYamlValue(receipt.usage)}`);
	if (receipt.worth_distilling !== undefined)
		lines.push(`- worth_distilling: ${yamlSafeString(receipt.worth_distilling)}`);
	if (receipt.failure_type !== undefined) lines.push(`- failure_type: ${receipt.failure_type}`);
	if (receipt.任务态 !== undefined) lines.push(`- 任务态: ${receipt.任务态}`);
	if (receipt.verification?.length) lines.push(`- verification: ${formatYamlValue(receipt.verification)}`);
	if (receipt.changes?.length) lines.push(`- changes: ${formatYamlValue(receipt.changes)}`);
	return lines.join("\n");
}

function parseScalar(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed;
		}
	}
	return trimmed;
}

/** 从正文解析全部回执段（按出现顺序）。卡号按所在卡补齐。 */
export function parseReceipts(body: string, cardNo: number): Receipt[] {
	const receipts: Receipt[] = [];
	const lines = body.split("\n");
	let current: { attempt: number; time: string; fields: Record<string, unknown> } | undefined;
	const flush = () => {
		if (!current) return;
		const fields = current.fields;
		receipts.push({
			card_no: cardNo,
			attempt: current.attempt,
			time: current.time,
			result: fields.result as string | undefined,
			summary: fields.summary as string | undefined,
			artifact_path: fields.artifact_path as string[] | undefined,
			evidence: fields.evidence as string[] | undefined,
			usage: fields.usage as Record<string, unknown> | undefined,
			worth_distilling: fields.worth_distilling as string | undefined,
			failure_type: fields.failure_type as Receipt["failure_type"],
			任务态: fields.任务态 as Receipt["任务态"],
			verification: fields.verification as Receipt["verification"],
			changes: fields.changes as Receipt["changes"],
			archive_flag: fields.archive_flag as Receipt["archive_flag"],
		});
	};
	for (const line of lines) {
		const heading = RECEIPT_HEADING_PATTERN.exec(line.trim());
		if (heading) {
			flush();
			current = { attempt: Number.parseInt(heading[1], 10), time: heading[2], fields: {} };
			continue;
		}
		if (!current) continue;
		const field = /^- ([^:]+): ?(.*)$/.exec(line.trim());
		if (field) {
			current.fields[field[1].trim()] = parseScalar(field[2]);
		}
	}
	flush();
	return receipts;
}

export { formatCardNumber, nextCardNumber, parseCardRef };
