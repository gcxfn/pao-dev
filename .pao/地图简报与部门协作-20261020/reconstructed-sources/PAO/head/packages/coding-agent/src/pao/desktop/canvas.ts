/**
 * 桌面工作流画布数据桥（P4-1，设计包 2026-10-05 §1.3/§2 数据面）。
 * 与 readDesktopResults 同模式：纯读聚合、redact 后直返，不落盘、不做任何续跑动作。
 *
 * 红线（driver.ts 头注纪律）：实例清单永不反向成为任务真相——节点卡状态一律从卡现读；
 * 配方段坏配方显错误不拖全页；实例段坏文件进异常行不拖另一段（照 workflow-instances 扫描惯例）。
 * 关联键（件3）：worker 会话标识＝派发执行标识（runner 以 --session-id 传给子进程，runner.ts），
 * 派发预埋＝`<项目根>/.pao/执行映射/<执行标识>.jsonl`（session-bridge 落卡路径+尝试），
 * 结果回填＝卡回执「用量.执行标识」（dispatch-core appendDispatchReceipt）。本模块只做查询面，
 * 不重造双写——两级钻取第二级（节点→会话跳转）从这里取 会话标识/会话路径。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { loadCard, parseCardRef, projectRootForCards } from "../cards/index.ts";
import type { ParsedCard } from "../cards/types.ts";
import { redactContext } from "../context/index.ts";
import { listProjects } from "../dept/projects.ts";
import { checkPreflight, type PreflightReport } from "../preflight/index.ts";
import { pathKey } from "../shared/path-key.ts";
import { controlView, readControl } from "../workflow/control.ts";
import { parseManifest } from "../workflow/driver.ts";
import {
	isWorkflowRecipeError,
	listRecipes,
	loadRecipe,
	parseRecipe,
	requireParams,
	substituteParams,
	type WorkflowRecipe,
} from "../workflow/recipe.ts";
import { buildEnvelope, type ViewEnvelope } from "./view-envelope.ts";

// ── 画布契约（中文键；桌面 contracts 侧由前端批次对接） ──────────────────────

/** 配方节点概要（画布 DAG 渲染所需的最小字段，不搬运目标/验收正文） */
export interface CanvasNodeSummary {
	名字: string;
	部门: string;
	depends_on: string[];
	人工确认: boolean;
	模型?: string;
	思考强度?: string;
}

/** 配方精简摘要（向导与画布左侧列表共用） */
export interface CanvasRecipeSummary {
	ui?: WorkflowRecipe["ui"];
	版本: 1 | 2;
	自动执行: boolean;
	参数: string[];
	占位符: string[];
	拓扑序: string[];
	节点: CanvasNodeSummary[];
}

/** 配方条目：坏配方显错误不拖全页 */
export type CanvasRecipeEntry =
	| { 名字: string; 可用: true; 配方: CanvasRecipeSummary }
	| { 名字: string; 可用: false; 错误: { 代码: string; 说明: string } };

/** 实例节点：清单映射＋卡现读状态；会话标识为关联键解析结果（缺省＝暂无可靠会话锚点） */
export interface CanvasNodeInstance {
	名字: string;
	卡号?: string;
	/** 节点现读状态；无卡＝no_card（S10 投影单域英文），卡缺失/损坏＝「读取异常」（清单不作数） */
	状态: string;
	挂起?: string;
	确认?: string;
	/** 关联键：worker 会话标识（＝派发执行标识） */
	会话标识?: string;
	/** worker 会话 JSONL 绝对路径（执行映射结算行给定时才有） */
	会话路径?: string;
	/** 关联键来源状态：执行映射最近一条状态，或「卡回执」（仅回执回填可得） */
	会话状态?: string;
}

/** 画布实例：清单字段＋逐节点卡现读快照 */
export interface CanvasInstance {
	frozenRecipe?: CanvasRecipeSummary;
	frozenRecipeError?: string;
	/** 实例名（文件名去「工作流实例-」前缀与 .md 后缀） */
	名字: string;
	路径: string;
	工作流: string;
	卡目录: string;
	启动: string;
	状态: string;
	参数: Record<string, string>;
	节点: CanvasNodeInstance[];
}

/** 画布整页视图：配方段＋实例段＋异常行（一段坏不拖另一段） */
export interface CanvasView {
	配方: CanvasRecipeEntry[];
	实例: CanvasInstance[];
	/** 实例文件坏/版本不识别/目录不可读的显式异常行（不与「无实例」混同） */
	异常: { 路径: string; 原因: string }[];
	/** 配方目录整段不可读等顶层错误（配方段为空时说明原因） */
	错误?: string;
	/** 视图信封（S6-K4）：传输/视图信息，不替代卡状态；作用域＝PAO_HOME，实例级代际用 sessionGenerationOf 现算 */
	envelope: ViewEnvelope;
}

// ── 关联键查询面（件3：双写已由派发链承担，这里只解析） ────────────────────

/** 一条「卡↔会话」关联记录 */
export interface CardExecutionRef {
	/** worker 会话标识（＝派发执行标识，runner 以 --session-id 传入子进程） */
	执行标识: string;
	/** 执行映射最近一条状态（启动/运行中/成功/失败/取消/停止未确认…）；仅卡回执可得时缺省 */
	映射状态?: string;
	/** worker 会话 JSONL 路径（执行映射结算行给定时才有） */
	会话路径?: string;
	/** 最近一条记录时间（映射为 UTC ISO，卡回执为本地「YYYY-MM-DD HH:mm」——仅作展示排序提示） */
	时间?: string;
	来源: "执行映射" | "卡回执";
}

function normalizedPath(path: string): string {
	// 比对键：resolve＋反斜杠折叠正斜杠后，大小写折叠走 shared/path-key 正本
	// （win32 大小写不敏感；posix 保原样，大小写是两个文件）。
	return pathKey(resolve(path).replace(/\\/g, "/"));
}

/**
 * 解析一张卡的全部执行会话锚点（纯只读）：
 * 1) 扫 `<项目根>/.pao/执行映射/*.jsonl`（派发预埋；逐行 JSON，坏行跳过），按卡路径匹配，
 *    同一执行标识取文件内最近一条（启动→运行中→结算 的追加序）；
 * 2) 卡回执「用量.执行标识」（结果回填）补缺口——映射日志缺失（如项目挪动）时仍能查到跑过它的会话。
 * 映射记录优先（带会话路径），回执只补映射里没有的执行标识。
 */
export function locateCardExecutions(projectRoot: string, card: ParsedCard): CardExecutionRef[] {
	const results = new Map<string, CardExecutionRef>();
	const dir = join(resolve(projectRoot), ".pao", "执行映射");
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		// 无执行映射目录＝本项目还没有过派发，如实空
	}
	const target = normalizedPath(card.path);
	for (const file of files) {
		let lines: string[];
		try {
			lines = readFileSync(join(dir, file), "utf8").split(/\r?\n/);
		} catch {
			continue; // 单文件读失败不拖其他映射
		}
		for (const line of lines) {
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue; // 坏行跳过（崩溃残留半行不拖全文件）
			}
			if (typeof record.执行标识 !== "string" || record.执行标识 === "") continue;
			if (typeof record.卡路径 !== "string" || normalizedPath(record.卡路径) !== target) continue;
			results.set(record.执行标识, {
				执行标识: record.执行标识,
				映射状态: typeof record.状态 === "string" ? record.状态 : undefined,
				会话路径: typeof record.会话路径 === "string" ? record.会话路径 : undefined,
				时间: typeof record.时间 === "string" ? record.时间 : undefined,
				来源: "执行映射",
			});
		}
	}
	for (const receipt of card.receipts) {
		const id = receipt.usage?.run_id;
		if (typeof id !== "string" || id === "" || results.has(id)) continue;
		results.set(id, {
			执行标识: id,
			时间: typeof receipt.time === "string" ? receipt.time : undefined,
			来源: "卡回执",
		});
	}
	return [...results.values()];
}

/** 挑「哪个会话在跑它」：运行中优先，其余按最近时间提示序；都无时间则保序兜底。 */
function pickSession(refs: CardExecutionRef[]): CardExecutionRef | undefined {
	if (refs.length === 0) return undefined;
	const running = refs.find((ref) => ref.映射状态 === "运行中");
	if (running) return running;
	return [...refs].sort((a, b) => (b.时间 ?? "").localeCompare(a.时间 ?? ""))[0];
}

// ── 件1：readDesktopCanvas ──────────────────────────────────────────────────

function recipeSummary(recipe: WorkflowRecipe): CanvasRecipeSummary {
	return {
		...(recipe.ui !== undefined ? { ui: recipe.ui } : {}),
		版本: recipe.版本 ?? 1,
		自动执行: recipe.自动执行,
		参数: recipe.参数,
		占位符: recipe.占位符,
		拓扑序: recipe.拓扑序,
		节点: recipe.节点.map((node) => ({
			名字: node.名字,
			部门: node.部门,
			depends_on: node.depends_on,
			人工确认: node.人工确认,
			模型: node.模型,
			思考强度: node.思考强度,
		})),
	};
}

/** 只读控制入口验证冻结图；不从最新配方补造历史图。 */
function readFrozenControl(content: string, path: string) {
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
	if (!frontmatter.冻结配方 || typeof frontmatter.冻结配方 !== "object" || typeof frontmatter.卡目录 !== "string") {
		throw new Error("实例缺少冻结配方或卡目录");
	}
	return readControl(frontmatter.冻结配方 as WorkflowRecipe, {
		cardsDir: frontmatter.卡目录,
		workspaceDir: dirname(path),
	});
}

function recipeError(error: unknown): { 代码: string; 说明: string } {
	if (isWorkflowRecipeError(error)) return { 代码: error.code, 说明: error.message };
	return { 代码: "未知", 说明: error instanceof Error ? error.message : String(error) };
}

/** 画布配方段：逐个 parseRecipe 校验，坏配方显错误不拖全页。 */
function readRecipeSection(paoHome: string): { 配方: CanvasRecipeEntry[]; 错误?: string } {
	let names: string[];
	try {
		names = listRecipes(paoHome);
	} catch (error) {
		return { 配方: [], 错误: `配方目录不可读：${error instanceof Error ? error.message : String(error)}` };
	}
	const recipe: CanvasRecipeEntry[] = [];
	for (const name of names) {
		const path = join(paoHome, "工作流", `${name}.md`);
		try {
			recipe.push({ 名字: name, 可用: true, 配方: recipeSummary(parseRecipe(readFileSync(path, "utf8"), path)) });
		} catch (error) {
			recipe.push({ 名字: name, 可用: false, 错误: recipeError(error) });
		}
	}
	return { 配方: recipe };
}

/** 画布实例段节点：卡现读为准＋关联键解析。单节点失败（卡缺失/损坏）如实标注不拖整实例。 */
function readInstanceNode(manifest: ReturnType<typeof parseManifest>): CanvasNodeInstance[] {
	return manifest.节点.map((entry) => {
		const node: CanvasNodeInstance = {
			名字: entry.名字,
			状态: "no_card",
			...(entry.挂起 !== undefined ? { 挂起: entry.挂起 } : {}),
			...(entry.确认 !== undefined ? { 确认: entry.确认 } : {}),
		};
		if (entry.卡号 === undefined) return node;
		node.卡号 = entry.卡号;
		try {
			const card = loadCard(manifest.卡目录, parseCardRef(entry.卡号));
			node.状态 = card.frontmatter.status;
			const picked = pickSession(locateCardExecutions(projectRootForCards(manifest.卡目录), card));
			if (picked) {
				node.会话标识 = picked.执行标识;
				if (picked.会话路径 !== undefined) node.会话路径 = picked.会话路径;
				node.会话状态 = picked.映射状态 ?? picked.来源;
			}
		} catch {
			node.状态 = "读取异常"; // 卡文件缺失/损坏如实报，清单里的卡号不作数
		}
		return node;
	});
}

/**
 * 画布实例段：扫项目清单各项目 `.pao` 顶层＋一层子目录的 `工作流实例-*.md`（与
 * workflow-instances 同一落点口径）。坏文件/v2 控制正本进异常行不拖另一段；
 * v2 实例须经控制入口读取（parseManifest 明拒），画布不降级伪装。
 */
function readInstanceSection(paoHome: string, exception: CanvasView["异常"]): CanvasInstance[] {
	const instance: CanvasInstance[] = [];
	for (const project of listProjects(paoHome)) {
		const paoDir = join(project.项目根, ".pao");
		let candidates: string[];
		try {
			candidates = [
				paoDir,
				...readdirSync(paoDir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(paoDir, entry.name)),
			];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // 无 .pao＝无实例，如实跳过
			exception.push({
				路径: paoDir,
				原因: `目录读取失败:${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		for (const dir of candidates) {
			let files: string[];
			try {
				files = readdirSync(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // 扫描间隙被删，如实反映
				exception.push({
					路径: dir,
					原因: `目录读取失败:${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
			for (const file of files) {
				if (!file.startsWith("工作流实例-") || !file.endsWith(".md")) continue;
				const path = join(dir, file);
				try {
					const content = readFileSync(path, "utf8");
					const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
					if (frontmatter.版本 === 2) {
						const flow = readFrozenControl(content, path);
						const view = controlView(flow);
						const nodes = readInstanceNode({
							工作流: flow.工作流,
							卡目录: flow.卡目录,
							启动: flow.启动,
							状态: flow.状态,
							参数: flow.参数,
							节点: view.节点.map((node) => ({
								名字: node.名字,
								卡号: node.卡号,
								挂起: node.挂起,
								确认: node.已确认,
							})),
						}).map((node, index) => ({ ...node, 状态: view.节点[index].状态 }));
						instance.push({
							名字: file.slice("工作流实例-".length, -3),
							路径: path,
							工作流: flow.工作流,
							卡目录: flow.卡目录,
							启动: flow.启动,
							状态: view.状态,
							参数: flow.参数,
							节点: nodes,
							frozenRecipe: recipeSummary(flow.冻结配方),
						});
						continue;
					}
					const manifest = parseManifest(content);
					instance.push({
						名字: file.slice("工作流实例-".length, -".md".length),
						路径: path,
						工作流: manifest.工作流,
						卡目录: manifest.卡目录,
						启动: manifest.启动,
						状态: manifest.状态,
						参数: manifest.参数,
						节点: readInstanceNode(manifest),
						frozenRecipeError: "旧实例没有冻结配方，仅展示卡映射；不能确定启动时的依赖与坐标。",
					});
				} catch (error) {
					exception.push({
						路径: path,
						原因: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	}
	return instance;
}

/**
 * D7 画布整页数据桥（设计包 §1.3）：配方列表（含校验错误项）＋实例数组（清单字段＋按卡号
 * 现读的节点卡状态快照＋关联键会话标识）。只读零落盘，输出过 redactContext（与桌面快照同口径脱敏）。
 */
export function readDesktopCanvas(paoHome: string): CanvasView {
	const recipeSection = readRecipeSection(paoHome);
	const exception: CanvasView["异常"] = [];
	const instance = readInstanceSection(paoHome, exception);
	const view: Omit<CanvasView, "envelope"> = { 配方: recipeSection.配方, 实例: instance, 异常: exception };
	if (recipeSection.错误 !== undefined) view.错误 = recipeSection.错误;
	const redacted = redactContext(view) as CanvasView;
	const { 配方, 实例, 异常, 错误 } = redacted;
	return {
		...redacted,
		envelope: buildEnvelope(
			{ paoHome },
			{ 配方, 实例, 异常, ...(错误 !== undefined ? { 错误 } : {}) },
			new Date().toISOString(),
		),
	};
}

// ── 件2：readDesktopPreflight ───────────────────────────────────────────────

/** 预检桥结果：报告直返（桌面自渲染，不走 renderPreflight）；配方问题结构化返回不 throw 到顶层 */
export type DesktopPreflightResult =
	| { 可用: true; 报告: PreflightReport }
	| { 可用: false; 错误: { 代码: string; 说明: string } };

/**
 * D2 向导预检桥（设计包 §2）：loadRecipe→requireParams 校验→从配方节点聚合
 * departments/skills（去重）→checkPreflight 同源结果透传。配方不存在/校验失败/缺参
 * 均为结构化错误返回，不 throw 到顶层（向导步骤流按 错误.代码 分流提示）。
 */
export function readDesktopPreflight(
	paoHome: string,
	project: string,
	recipeName: string,
	params: Record<string, string>,
): DesktopPreflightResult {
	let recipe: WorkflowRecipe;
	try {
		recipe = loadRecipe(paoHome, recipeName);
		requireParams(recipe, params);
	} catch (error) {
		return { 可用: false, 错误: recipeError(error) };
	}
	const report = checkPreflight({
		project,
		paoHome,
		departments: [...new Set(recipe.节点.map((node) => node.部门))],
		skills: [...new Set(recipe.节点.flatMap((node) => node.技能 ?? []))],
		parameters: params,
		requiredParameters: recipe.参数,
	});
	return { 可用: true, 报告: report };
}

// ── 件4：readDesktopNodeDetail（D8d 节点详情，设计包 2026-10-05 §3） ─────────

/** D8d 回执轮次行：打回差异原始记录（留档标记区分旧尝试/迟到回执）。 */
export interface DesktopNodeReceiptRound {
	尝试号: number;
	时间: string;
	结果?: string;
	失败类型?: string;
	摘要?: string;
	证据?: string[];
	留档标记?: string;
}

/** D8d 节点详情：模板值（参数代入后）vs 卡面实际值＋执行锚点＋升档理由。 */
export interface DesktopNodeDetail {
	节点: string;
	实例: string;
	/** 配方模板值（实例参数代入后的生效值；配方不可读时缺省并记错误，不编造） */
	模板?: {
		部门: string;
		模型?: string;
		档位?: string;
		思考强度?: string;
		预算?: Record<string, unknown>;
		技能?: string[];
	};
	/** 卡面实际值（未落卡＝缺省；卡缺失/损坏记错误） */
	卡?: {
		卡号: string;
		状态: string;
		档位?: string;
		预算?: Record<string, unknown>;
		尝试: number;
		创建: string;
		完成?: string;
		路径: string;
		/** 回执轮次（按尝试号序）：两轮打回差异的原始记录，证据字段原样带出 */
		回执: DesktopNodeReceiptRound[];
	};
	/** 执行会话锚点全集（节点→会话跳转数据源；不只挑运行中） */
	执行: CardExecutionRef[];
	/** 升档理由：卡正文里带的说明行；没有＝缺省（界面如实显示「无记录」，不编造） */
	升档理由?: string;
	/** 结构化错误（实例坏/节点不在清单/卡读取失败等；部分字段仍尽力给出） */
	错误?: string;
}

/** 卡正文升档说明行：既有落卡格式里凡带「升档/档位变更」的记录行原样透出，不解析不推断。 */
function readUpgradeReason(body: string): string | undefined {
	const lines = body
		.split(/\r?\n/)
		.filter((line) => /升档|档位变更/.test(line))
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * D8d 节点详情深读（画布右栏）：实例清单定位节点→配方模板值（参数代入）→卡面实际值
 * （frontmatter＋回执轮次）→执行锚点全集→升档理由（卡正文记录，无则缺省）。
 * 纯读零落盘，输出过 redactContext；各段失败记错误不拖其他段（模板坏照给卡面，反之亦然）。
 */
export function readDesktopNodeDetail(_paoHome: string, instancePath: string, nodeName: string): DesktopNodeDetail {
	const detail: DesktopNodeDetail = { 节点: nodeName, 实例: instancePath, 执行: [] };
	let manifest: ReturnType<typeof parseManifest>;
	let frozenRecipe: WorkflowRecipe | undefined;
	try {
		const content = readFileSync(instancePath, "utf8");
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
		if (frontmatter.版本 === 2) {
			const flow = readFrozenControl(content, instancePath);
			frozenRecipe = flow.冻结配方;
			manifest = {
				工作流: flow.工作流,
				卡目录: flow.卡目录,
				启动: flow.启动,
				状态: flow.状态,
				参数: flow.参数,
				节点: flow.节点.map((node) => ({ 名字: node.名字, 卡号: node.卡[0], 确认: node.确认 })),
			};
			const selected = flow.节点.find((node) => node.名字 === nodeName);
			if (selected && selected.卡.length > 1)
				detail.错误 = `此节点有 ${selected.卡.length} 张卡；当前详情显示第一张 ${selected.卡[0]}，其余卡须在看板查看。`;
		} else {
			manifest = parseManifest(content);
		}
	} catch (error) {
		detail.错误 = `实例清单不可读：${error instanceof Error ? error.message : String(error)}`;
		return redactContext(detail) as DesktopNodeDetail;
	}
	const entry = manifest.节点.find((item) => item.名字 === nodeName);
	if (!entry) {
		detail.错误 = `节点「${nodeName}」不在实例清单`;
		return redactContext(detail) as DesktopNodeDetail;
	}
	try {
		if (!frozenRecipe) throw new Error("旧实例没有冻结配方，不能以最新配方代替启动时模板");
		const recipe = frozenRecipe;
		const node = recipe.节点.find((item) => item.名字 === nodeName);
		if (node) {
			const params = manifest.参数;
			detail.模板 = {
				部门: substituteParams(node.部门, params),
				...(node.模型 !== undefined ? { 模型: substituteParams(node.模型, params) } : {}),
				...(node.档位 !== undefined ? { 档位: substituteParams(node.档位, params) } : {}),
				...(node.思考强度 !== undefined ? { 思考强度: substituteParams(node.思考强度, params) } : {}),
				...(node.预算 !== undefined ? { 预算: node.预算 as Record<string, unknown> } : {}),
				...(node.技能 !== undefined ? { 技能: node.技能.map((skill) => substituteParams(skill, params)) } : {}),
			};
		} else {
			detail.错误 = `配方「${manifest.工作流}」中无该节点（配方已改？实例冻结不回写）`;
		}
	} catch (error) {
		detail.错误 = `配方模板值不可读：${error instanceof Error ? error.message : String(error)}`;
	}
	if (entry.卡号 !== undefined) {
		try {
			const card = loadCard(manifest.卡目录, parseCardRef(entry.卡号));
			detail.卡 = {
				卡号: entry.卡号,
				状态: card.frontmatter.status,
				...(card.frontmatter.tier !== undefined ? { 档位: card.frontmatter.tier } : {}),
				...(card.frontmatter.budget !== undefined
					? { 预算: card.frontmatter.budget as Record<string, unknown> }
					: {}),
				尝试: card.frontmatter.attempt,
				创建: card.frontmatter.created,
				...(card.frontmatter.completed !== undefined ? { 完成: card.frontmatter.completed } : {}),
				路径: card.path,
				回执: [...card.receipts]
					.sort((a, b) => a.attempt - b.attempt)
					.map((receipt) => ({
						尝试号: receipt.attempt,
						时间: receipt.time,
						...(receipt.result !== undefined ? { 结果: receipt.result } : {}),
						...(receipt.failure_type !== undefined ? { 失败类型: receipt.failure_type } : {}),
						...(receipt.summary !== undefined ? { 摘要: receipt.summary } : {}),
						...(receipt.evidence !== undefined ? { 证据: receipt.evidence } : {}),
						...(receipt.archive_flag !== undefined ? { 留档标记: receipt.archive_flag } : {}),
					})),
			};
			const rationale = readUpgradeReason(card.body);
			if (rationale !== undefined) detail.升档理由 = rationale;
			try {
				detail.执行 = locateCardExecutions(projectRootForCards(manifest.卡目录), card);
			} catch {
				// 执行映射目录不可读＝锚点空，如实（卡面字段不受影响）
			}
		} catch (error) {
			detail.错误 = `${detail.错误 ? `${detail.错误}；` : ""}卡面不可读：${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return redactContext(detail) as DesktopNodeDetail;
}
