/** 桌面只读投影：每次从卡与执行映射重读，不保存第二份任务状态。 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionEntry } from "../../core/session-manager.ts";
import { readCard } from "../cards/cardfile.ts";
import { renderQueue } from "../cards/render.ts";
import type { ParsedCard } from "../cards/types.ts";
import { redactContext } from "../context/index.ts";
import { listProjects } from "../dept/projects.ts";
import { nativeEntryUsage } from "../worker/native-usage.ts";
import { readDesktopWorkerActivity } from "./owners.ts";
import { buildEnvelope, type ViewEnvelope } from "./view-envelope.ts";
import { type DesktopFlow, readDesktopFlows, readDesktopFlowsFresh } from "./workflow.ts";

export interface DesktopReadIssue {
	路径: string;
	说明: string;
}
export interface DesktopExecution {
	执行标识: string;
	卡路径: string;
	尝试: number;
	状态: string;
	时间: string;
	映射路径: string;
	会话路径?: string;
	当前尝试: boolean;
}
/** 一张卡当前登记表活性（同进程只读；缺省＝无信号，不用卡时间兜底）。 */
export interface DesktopCardActivity {
	/** 关联卡的 路径 原值（与卡列表同源，便于按路径合并） */
	卡路径: string;
	/** 派出 worker 的桌面会话（owner）标识 */
	会话: string;
	/** 执行标识（登记缺失时为空串） */
	执行标识: string;
	/** 登记条目的尝试号（-1=未记） */
	尝试: number;
	/** 登记时间（ISO） */
	登记时间: string;
	/** 最近输出时间（ISO；没有则为空） */
	最近输出时间?: string;
	/** 是否仍在运行 */
	运行中: boolean;
	/** 静默阈值（分钟；0=关） */
	静默分钟: number;
	/** 登记条目尝试号是否等于卡面当前尝试 */
	当前尝试: boolean;
	/** 认领租约四字段（S5 包3；claimAt=认领时间/leaseExpiresAt=租约到期/claimGeneration=认领代数/接管标记=被接管）。条目未带则缺省，S7-B 桌面按到期呈现 amber、被接管拒旧 worker 状态覆盖。 */
	认领时间?: string;
	租约到期?: string;
	认领代数?: number;
	被接管?: boolean;
}
export interface DesktopProjectSnapshot {
	// 容器/载荷/作用域键（定名表 §10 收口批迁英）；行内字段（执行映射/活性行等持久或行级键）保持原样
	projectRoot: string;
	session: string;
	读取时间: string;
	/** 视图信封（S6-K4）：传输/视图信息，不替代卡状态；作用域＝项目根＋会话，切会话即换代际 */
	envelope: ViewEnvelope;
	cards: ParsedCard[];
	execution: DesktopExecution[];
	/** 同进程桌面会话派出的 worker 活性；按卡路径对齐，历史尝试也带出但标 当前尝试=false。 */
	liveness: DesktopCardActivity[];
	issues: DesktopReadIssue[];
	queue: string;
	workflow: DesktopFlow[];
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function inside(root: string, path: string): boolean {
	const delta = relative(root, path);
	return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("记录不是对象");
	return value as Record<string, unknown>;
}
function entries(directory: string, issues: DesktopReadIssue[]): string[] {
	try {
		return readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch (error) {
		if (!isMissing(error)) issues.push({ 路径: directory, 说明: String(error) });
		return [];
	}
}

/** 半行只标等待；已换行的坏 JSON 必须显式报错，不把坏文件解释为空。 */
export function parseLiveJsonl(text: string): { rows: Record<string, unknown>[]; pending: boolean } {
	const lines = text.split("\n");
	const pending = (lines.pop() ?? "").length > 0;
	const rows = lines.filter((line) => line.trim()).map((line) => object(JSON.parse(line)));
	return { rows, pending };
}

type DesktopWorkflowRead = {
	工作流: DesktopFlow[];
	问题: DesktopReadIssue[];
};

function buildDesktopProject(
	projectRoot: string,
	sessionId: string,
	workflows: DesktopWorkflowRead,
): DesktopProjectSnapshot {
	const root = realpathSync(resolve(projectRoot));
	const result: Omit<DesktopProjectSnapshot, "envelope"> = {
		projectRoot: root,
		session: sessionId,
		读取时间: new Date().toISOString(),
		cards: [],
		execution: [],
		liveness: [],
		issues: [],
		queue: "",
		workflow: [],
	};
	result.workflow = workflows.工作流;
	result.issues.push(...workflows.问题);
	const cardDirectories = new Set([join(root, ".pao", "卡"), ...workflows.工作流.map((entry) => entry.控制.卡目录)]);
	for (const cardsDir of cardDirectories) {
		for (const name of entries(cardsDir, result.issues).filter((name) => /^卡\d+-.*\.md$/.test(name))) {
			const path = join(cardsDir, name);
			try {
				if (!inside(root, realpathSync(path))) throw new Error("卡路径越出所属项目");
				result.cards.push(readCard(path));
			} catch (error) {
				result.issues.push({ 路径: path, 说明: String(error) });
			}
		}
	}
	result.cards.sort((a, b) => a.card_no - b.card_no);
	const cardByRealPath = new Map<string, ParsedCard>();
	for (const card of result.cards) {
		try {
			cardByRealPath.set(realpathSync(card.path), card);
		} catch {
			// 卡文件在读取后消失：本轮不并入活性，交给下一次刷新重读
		}
	}
	for (const row of readDesktopWorkerActivity(root)) {
		const card = cardByRealPath.get(row.卡路径);
		if (!card) continue;
		result.liveness.push({
			卡路径: card.path,
			会话: row.会话,
			执行标识: row.执行标识,
			尝试: row.尝试,
			登记时间: row.登记时间,
			最近输出时间: row.最近输出时间,
			运行中: row.运行中,
			静默分钟: row.静默分钟,
			当前尝试: card.frontmatter.attempt === row.尝试,
			// S5 包3 租约四字段透出（内核 read-model 层为止；desktop 仓消费归 S7-B）
			认领时间: row.认领时间,
			租约到期: row.租约到期,
			认领代数: row.认领代数,
			被接管: row.被接管,
		});
	}
	// 本次读取内复用卡路径索引和 worker 会话目录清单：映射文件可能很多，不能每份映射
	// 重新遍历所有卡、重新读取同一个会话目录。索引只活在本次读取内，不改变磁盘状态真相。
	const sessionDir = join(root, ".pao", "worker会话");
	const pendingExecutions: {
		row: Record<string, unknown>;
		path: string;
		cardPath: string;
		card: ParsedCard;
	}[] = [];
	const mapsDir = join(root, ".pao", "执行映射");
	for (const name of entries(mapsDir, result.issues).filter((name) => name.endsWith(".jsonl"))) {
		const path = join(mapsDir, name);
		try {
			if (!inside(root, realpathSync(path))) throw new Error("映射路径越出所属项目");
			const { rows, pending } = parseLiveJsonl(readFileSync(path, "utf8"));
			if (pending) result.issues.push({ 路径: path, 说明: "末行尚未写完，等待下次刷新；不推断完成。" });
			const row = rows.at(-1);
			if (!row) continue;
			if (
				typeof row.执行标识 !== "string" ||
				name !== `${row.执行标识}.jsonl` ||
				typeof row.项目根 !== "string" ||
				realpathSync(row.项目根) !== root ||
				typeof row.卡路径 !== "string" ||
				typeof row.状态 !== "string" ||
				typeof row.时间 !== "string" ||
				!Number.isInteger(row.尝试) ||
				Number(row.尝试) < 1
			) {
				throw new Error("执行映射身份或字段不完整");
			}
			const cardPath = realpathSync(row.卡路径);
			if (!inside(root, cardPath)) throw new Error("执行映射引用其他项目的卡");
			const card = cardByRealPath.get(cardPath);
			if (!card) throw new Error("执行映射所指卡不存在或无法读取");
			pendingExecutions.push({ row, path, cardPath, card });
		} catch (error) {
			result.issues.push({ 路径: path, 说明: String(error) });
		}
	}
	if (pendingExecutions.length > 0) {
		const executionIds = new Set(pendingExecutions.map(({ row }) => String(row.执行标识)));
		const sessionNamesByExecution = new Map<string, string[]>();
		for (const executionId of executionIds) sessionNamesByExecution.set(executionId, []);
		const sessionNames = entries(sessionDir, result.issues).filter((file) => file.endsWith(".jsonl"));
		// 会话文件约定为“任意前缀_执行标识.jsonl”。按文件中的下划线后缀建索引，
		// 每份会话只按自身长度扫描一次，避免“映射数 × 会话目录文件数”的重复过滤。
		for (const file of sessionNames) {
			if (!file.endsWith(".jsonl")) continue;
			const stem = file.slice(0, -".jsonl".length);
			for (
				let underscore = stem.lastIndexOf("_");
				underscore >= 0;
				underscore = underscore > 0 ? stem.lastIndexOf("_", underscore - 1) : -1
			) {
				const executionId = stem.slice(underscore + 1);
				if (executionIds.has(executionId)) sessionNamesByExecution.get(executionId)!.push(file);
			}
		}
		for (const { row, path, cardPath, card } of pendingExecutions) {
			try {
				const sessions = sessionNamesByExecution.get(String(row.执行标识)) ?? [];
				if (sessions.length > 1) throw new Error("同一执行标识对应多份会话，不能任选一份");
				const sessionPath = sessions[0] ? realpathSync(join(sessionDir, sessions[0])) : undefined;
				if (sessionPath && !inside(root, sessionPath)) throw new Error("worker 会话路径越出所属项目");
				result.execution.push({
					执行标识: String(row.执行标识),
					卡路径: cardPath,
					尝试: Number(row.尝试),
					状态: String(row.状态),
					时间: String(row.时间),
					映射路径: path,
					会话路径: sessionPath,
					当前尝试: card.frontmatter.attempt === row.尝试,
				});
			} catch (error) {
				result.issues.push({ 路径: path, 说明: String(error) });
			}
		}
	}
	result.queue = renderQueue(
		result.cards.map((card) => ({
			card_no: card.card_no,
			...card.frontmatter,
			priority: card.frontmatter.priority ?? "medium",
			depends_on: card.frontmatter.depends_on ?? [],
			pending_review:
				card.frontmatter.status === "in_progress" &&
				card.receipts.some((receipt) => receipt.attempt === card.frontmatter.attempt),
		})),
	);
	const snapshot = redactContext(result) as DesktopProjectSnapshot;
	// 信封只盖内容六段（读取时间每次变，不参与指纹）；publishedAt＝读取时间同值
	const { cards, execution, liveness, issues, queue, workflow } = snapshot;
	return {
		...snapshot,
		envelope: buildEnvelope(
			{ projectRoot: snapshot.projectRoot, session: snapshot.session },
			{ cards, execution, liveness, issues, queue, workflow },
			snapshot.读取时间,
		),
	};
}

/**
 * 同步兼容读面：卡、执行映射和流程身份为当前盘面，但流程完成状态未经当前内容树核对。
 * 真实桌面 RPC 应调用 readDesktopProjectFresh。
 */
export function readDesktopProject(projectRoot: string, sessionId: string): DesktopProjectSnapshot {
	const root = realpathSync(resolve(projectRoot));
	return buildDesktopProject(root, sessionId, readDesktopFlows(root));
}

/** 真实桌面读面：每个流程经 readControlView 核对当前内容树后投影。 */
export async function readDesktopProjectFresh(
	projectRoot: string,
	sessionId: string,
	deadMinisters?: ReadonlySet<string>,
): Promise<DesktopProjectSnapshot> {
	const root = realpathSync(resolve(projectRoot));
	return buildDesktopProject(root, sessionId, await readDesktopFlowsFresh(root, deadMinisters));
}

function pendingProjectPaths(
	paoHome: string,
	currentProject: string,
): { paths: Set<string>; issues: DesktopReadIssue[] } {
	const issues: DesktopReadIssue[] = [];
	const paths = new Set([resolve(currentProject)]);
	try {
		for (const entry of listProjects(paoHome)) {
			if (!isAbsolute(entry.项目根)) {
				issues.push({
					路径: join(paoHome, "项目清单.md"),
					说明: `项目 ${entry.项目名} 的根路径不是绝对路径，未猜测其归属`,
				});
				continue;
			}
			paths.add(resolve(entry.项目根));
		}
	} catch (error) {
		issues.push({ 路径: join(paoHome, "项目清单.md"), 说明: String(error) });
	}
	return { paths, issues };
}

/** 兼容同步读面：项目发现范围正确，但各项目流程状态未经当前内容树核对。 */
export function readDesktopPending(
	paoHome: string,
	currentProject: string,
): { projects: DesktopProjectSnapshot[]; issues: DesktopReadIssue[] } {
	const discovered = pendingProjectPaths(paoHome, currentProject);
	const result: { projects: DesktopProjectSnapshot[]; issues: DesktopReadIssue[] } = {
		projects: [],
		issues: discovered.issues,
	};
	for (const path of discovered.paths) {
		try {
			result.projects.push(readDesktopProject(path, "跨会话只读；owner 见卡面"));
		} catch (error) {
			result.issues.push({ 路径: path, 说明: String(error) });
		}
	}
	return result;
}

/** 真实跨项目读面：每个项目独立核对当前内容树，单项目失败隔离。 */
export async function readDesktopPendingFresh(
	paoHome: string,
	currentProject: string,
): Promise<{ projects: DesktopProjectSnapshot[]; issues: DesktopReadIssue[] }> {
	const discovered = pendingProjectPaths(paoHome, currentProject);
	const result: { projects: DesktopProjectSnapshot[]; issues: DesktopReadIssue[] } = {
		projects: [],
		issues: discovered.issues,
	};
	for (const path of discovered.paths) {
		try {
			result.projects.push(await readDesktopProjectFresh(path, "跨会话只读；owner 见卡面"));
		} catch (error) {
			result.issues.push({ 路径: path, 说明: String(error) });
		}
	}
	return result;
}

export interface DesktopSessionIncrement {
	会话路径: string;
	下次偏移: number;
	末行未完: boolean;
	还有更多: boolean;
	行: { 类型: string; 角色?: string; 内容?: unknown; 模型?: string; 思考强度?: string; 用量?: unknown }[];
	本段统计: { 响应: number; 工具: number; token: number; 未知用量: number };
}

/**
 * 只定位一份执行对应的会话文件（阶段 7 性能候选 2）。
 * 增量读取原先每次都要重读整个项目（全部卡、全部映射、全部会话、活性与队列），
 * 500 份映射时单次净增约 0.55 秒；这里收窄到「只读这一份映射 + 只枚举会话目录」，
 * 身份检查一条不省：映射文件名＝执行标识、项目根与当前项目一致、卡路径在工作区内且是普通文件、
 * 会话路径在工作区内、同一执行标识对应多份会话时拒绝任选。
 */
function locateExecutionSession(projectRoot: string, executionId: string): string {
	const root = realpathSync(resolve(projectRoot));
	if (!executionId.trim() || executionId.includes("/") || executionId.includes("\\"))
		throw new Error("执行标识不合法，未找到可读的执行会话：拒绝按任意文件名读取");
	const mappingPath = join(root, ".pao", "执行映射", `${executionId}.jsonl`);
	let text: string;
	try {
		text = readFileSync(mappingPath, "utf8");
	} catch (error) {
		if (isMissing(error)) throw new Error("未找到可读的执行会话，请刷新映射并查看问题列表");
		throw new Error(`执行映射读不出来：${String(error)}`);
	}
	if (!inside(root, realpathSync(mappingPath))) throw new Error("映射路径越出所属项目");
	const { rows, pending } = parseLiveJsonl(text);
	if (pending) throw new Error("执行映射末行尚未写完，等待下次刷新；不推断完成。");
	const row = rows.at(-1);
	if (!row) throw new Error("执行映射没有完整记录，请刷新映射并查看问题列表");
	let declaredRoot: string | undefined;
	try {
		declaredRoot = typeof row.项目根 === "string" ? realpathSync(row.项目根) : undefined;
	} catch {
		declaredRoot = undefined;
	}
	if (
		typeof row.执行标识 !== "string" ||
		row.执行标识 !== executionId ||
		declaredRoot !== root ||
		typeof row.卡路径 !== "string" ||
		typeof row.状态 !== "string" ||
		typeof row.时间 !== "string" ||
		!Number.isInteger(row.尝试) ||
		Number(row.尝试) < 1
	)
		throw new Error("执行映射身份或字段不完整");
	let cardPath: string;
	try {
		cardPath = realpathSync(row.卡路径);
	} catch {
		throw new Error("执行映射所指卡不存在或无法读取");
	}
	if (!inside(root, cardPath)) throw new Error("执行映射引用其他项目的卡");
	if (!statSync(cardPath).isFile()) throw new Error("执行映射所指卡不存在或无法读取");
	const sessionDir = join(root, ".pao", "worker会话");
	const matches: string[] = [];
	for (const file of entries(sessionDir, [])) {
		if (!file.endsWith(".jsonl")) continue;
		const stem = file.slice(0, -".jsonl".length);
		for (
			let underscore = stem.lastIndexOf("_");
			underscore >= 0;
			underscore = underscore > 0 ? stem.lastIndexOf("_", underscore - 1) : -1
		) {
			if (stem.slice(underscore + 1) === executionId) {
				matches.push(file);
				break;
			}
		}
	}
	if (matches.length > 1) throw new Error("同一执行标识对应多份会话，不能任选一份");
	const name = matches[0];
	if (!name) throw new Error("未找到可读的执行会话，请刷新映射并查看问题列表");
	const sessionPath = realpathSync(join(sessionDir, name));
	if (!inside(root, sessionPath)) throw new Error("worker 会话路径越出所属项目");
	return sessionPath;
}

/** 浏览器只提交已发现的执行ID，不能指定任意磁盘文件。偏移按字节且只跨过完整行。 */
export function readDesktopExecution(
	projectRoot: string,
	sessionId: string,
	executionId: string,
	offset = 0,
): DesktopSessionIncrement {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("会话偏移必须是非负整数");
	// sessionId 保留在签名里（调用方按位置传参、旧行为把它写进整项目信封）；
	// 增量读取不再需要它构造信封，所以这里只显式忽略。
	void sessionId;
	return readDesktopSessionIncrement(locateExecutionSession(projectRoot, executionId), offset);
}

/** 从当前控制正本定位部长会话；只读查询不要求原主控进程仍在运行。 */
export function readDesktopWorkflowMinister(
	projectRoot: string,
	instanceId: string,
	nodeName: string,
	round: number,
	offset = 0,
): DesktopSessionIncrement {
	const root = realpathSync(resolve(projectRoot));
	const flows = readDesktopFlows(root).工作流.filter((row) => row.控制.实例 === instanceId);
	if (flows.length !== 1) throw new Error("工作流实例不在当前项目唯一发现，请刷新");
	const flow = flows[0];
	const node = flow.控制.节点.find((row) => row.名字 === nodeName && row.轮次 === round);
	const ministerId = node?.部长会话;
	if (!ministerId || /[\\/]/.test(ministerId)) throw new Error("本轮尚无可定位的部长会话，请刷新");
	const directory = realpathSync(join(dirname(flow.路径), "部长会话", flow.控制.实例));
	if (!inside(root, directory)) throw new Error("部长会话目录越出所属项目");
	const matches = readdirSync(directory).filter((name) => name.endsWith(`_${ministerId}.jsonl`));
	if (matches.length !== 1) throw new Error("部长会话未唯一定位，不能任选一份");
	const path = realpathSync(join(directory, matches[0]));
	if (dirname(path) !== directory) throw new Error("部长会话路径越出所属目录");
	return readDesktopSessionIncrement(path, offset);
}

/** 内核调用者已核对所属会话身份；桌面服务不暴露原始路径参数。 */
export function readDesktopSessionIncrement(path: string, offset = 0): DesktopSessionIncrement {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("会话偏移必须是非负整数");
	const size = statSync(path).size;
	if (offset > size) throw new Error("会话文件已截短，需明确重新读取，不能悄悄拼接历史");
	const fd = openSync(path, "r");
	const buffer = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
	let count: number;
	try {
		if (offset > 0) {
			const previous = Buffer.alloc(1);
			readSync(fd, previous, 0, 1, offset - 1);
			if (previous[0] !== 10) throw new Error("偏移不在完整行边界，不能拼接残缺消息");
		}
		count = readSync(fd, buffer, 0, buffer.length, offset);
	} finally {
		closeSync(fd);
	}
	const data = buffer.subarray(0, count);
	const end = data.lastIndexOf(10) + 1;
	if (end === 0 && count === 1024 * 1024) throw new Error("单行超过 1 MiB，请打开原始会话文件查看");
	const parsed = parseLiveJsonl(data.subarray(0, end).toString("utf8"));
	const statistics = { 响应: 0, 工具: 0, token: 0, 未知用量: 0 };
	for (const row of parsed.rows) {
		const message = row.type === "message" ? object(row.message) : {};
		if (row.type === "message" && message.role === "assistant") {
			statistics.响应++;
			statistics.工具 += Array.isArray(message.content)
				? message.content.filter((block: { type?: string }) => block.type === "toolCall").length
				: 0;
		}
		// 用量走内核同一份归一化规则（审查第 16 项）：压缩、分支摘要、带用量的工具结果、
		// 「请求未返回用量」事件都要算进来，只认助手消息会把这部分用量整段漏掉。
		// 会话日志行就是会话条目本体（同一种落盘格式），这里按条目喂给原生规则，不另写一套分类。
		const value = nativeEntryUsage(row as unknown as SessionEntry);
		if (!value) continue;
		const totalTokens = value.raw?.totalTokens;
		if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) statistics.token += totalTokens;
		else {
			// 旧记录/扩展事件可能只给分项不给总数：能加就先加，一点都拿不到才算「未知用量」
			const parts = value.usage.input + value.usage.output + value.usage.cacheRead + value.usage.cacheWrite;
			if (parts > 0) statistics.token += parts;
			else statistics.未知用量++;
		}
	}
	return {
		本段统计: statistics,
		会话路径: path,
		下次偏移: offset + end,
		末行未完: end < count,
		还有更多: offset + count < size,
		行: parsed.rows.map((row) => {
			if (row.type === "thinking_level_change") return { 类型: row.type, 思考强度: String(row.thinkingLevel) };
			if (row.type === "model_change") return { 类型: row.type, 模型: `${row.provider}/${row.modelId}` };
			if (row.type === "usage")
				return { 类型: row.type, 模型: `${row.provider}/${row.model}`, 用量: redactContext(row.usage) };
			if (row.type !== "message") return { 类型: String(row.type ?? "未知") };
			const message = object(row.message);
			const content = Array.isArray(message.content)
				? message.content.filter(
						(block) =>
							block &&
							typeof block === "object" &&
							"type" in block &&
							(block.type === "text" || block.type === "toolCall"),
					)
				: typeof message.content === "string"
					? message.content
					: undefined;
			return {
				类型: "message",
				角色: String(message.role ?? "未知"),
				内容: redactContext(content),
				模型: message.role === "assistant" ? `${message.provider ?? "未知"}/${message.model ?? "未知"}` : undefined,
				用量: redactContext(message.usage),
			};
		}),
	};
}
