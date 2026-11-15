/**
 * 知识库工具注册（卡0004）：pao_query_kb / pao_restricted_query / pao_ingest_kb / pao_inspect_kb。
 * 可见性按架构 §6.3：注册时全量，角色过滤由主控接线时做（M1 靠纪律+回执审计兜底）。
 * 目录路径作参数传入，不依赖建部工具；嵌入端点与外发许可从环境/配置读。
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEPT_DIR_NAME, REGISTRY_FILE_NAME, readRegistry } from "../dept/registry.ts";
import type { MemoryHit } from "../memory/memory-vendor.ts";
import {
	AUTO_PER_LIB_TOP_K,
	AUTO_SEMANTIC_LIMIT,
	AUTO_TOTAL_LIMIT,
	type AutoRouteResult,
	autoPatrol,
	formatAutoRouteResult,
} from "./auto-route.ts";
import { type EmbedClient, type FetchLike, loadEmbedConfig } from "./embed.ts";
import { createRestrictedGate, type RestrictedQueryAuth } from "./gate.ts";
import { ingestEntry } from "./ingest.ts";
import { type InspectionReport, inspectLibrary } from "./inspect.ts";
import { loadOutboundConfig, type OutboundConfig, projectFromCwd } from "./outbound.ts";
import { paoHome } from "./paths.ts";
import { searchLibrary } from "./search.ts";
import { ENTRY_TYPES, type SearchResult } from "./types.ts";

/** 户口字段以英文键返回给模型（path/title_path/summary/status/scope/last_verified/source/degraded；值为磁盘数据面，保留中文）。 */
export function formatResult(result: SearchResult): string {
	const lines: string[] = [];
	if (result.degraded) lines.push(`[降级] ${result.degradeReason ?? "语义路未参与"}`);
	if (result.emptyReason) lines.push(result.emptyReason);
	if (result.hits.length > 0)
		lines.push(`正式依据 ${result.hits.length} 条（一次最多应用 3 条，不够用就明说，不硬做）：`);
	for (const h of result.hits) {
		lines.push(JSON.stringify(hitAsJson(h)));
	}
	if (result.riskHits.length > 0)
		lines.push(`风险提示 ${result.riskHits.length} 条（待验证、待复核或未知，只提示不作依据）：`);
	for (const h of result.riskHits) {
		lines.push(JSON.stringify(hitAsJson(h)));
	}
	return lines.join("\n");
}

function hitAsJson(h: SearchResult["hits"][number]): Record<string, unknown> {
	return {
		path: h.relPath,
		title_path: h.titlePath,
		summary: h.summary,
		status: h.status,
		scope: h.scope ?? "未知",
		last_verified: h.lastVerified ?? "未知",
		source: h.source ?? "未知",
		degraded: h.degraded,
	};
}

export interface KnowledgeToolsOptions {
	/** 嵌入客户端；缺省从 EMBED_* 环境变量读，未配置 → 词法独跑 */
	embed?: EmbedClient | null;
	fetchImpl?: FetchLike;
	/** 外发许可配置；缺省从 PAO_HOME/知识库配置/外发许可.json 读 */
	outbound?: OutboundConfig | null;
	/** 宿主已绑定的任务项目；优先于 cwd 推导，模型工具参数不能覆盖。 */
	defaultProject?: string;
	/** 受限补查授权（由主控从任务上下文绑定；未配置时 pao_restricted_query 一律拒绝） */
	restricted?: {
		deptName: string;
		libRoot: string;
		auth: RestrictedQueryAuth;
		/** 回执落盘路径；缺省 PAO_HOME/.pao/补查回执.jsonl */
		receiptPath?: string;
	} | null;
	/**
	 * 巡检后回调（巡库卡接线，卡0006）：收巡检报告与所巡知识库根路径，
	 * 可触发落巡库卡并返回提示文本（追加进 pao_inspect_kb 输出）。
	 * 缺省时不调用，pao_inspect_kb 行为与未接线完全一致（仿 cards/tools.ts 的 appendQueueSections 先例）。
	 */
	afterInspect?: (
		report: InspectionReport,
		libRoot: string,
	) => string | null | undefined | Promise<string | null | undefined>;
	/**
	 * 语义库召回接缝（架构 §18.3 真·并行两路，M2-05）：pao_query_kb 传 路由:"自动" 时，
	 * 除部门库文件检索外，再经此回调向记忆供应商召回语义记忆（缺省上限 3 条）。
	 * 缺省不接时自动模式仍工作，只是没有语义库那一路，输出标注「语义库未接」
	 * （仿 afterInspect 先例：接线由主控统一写，回调异常由本工具兜底标注，不抛出）。
	 */
	vendorRecall?: (query: string, limit: number) => Promise<MemoryHit[]>;
}

const LIB_ROOT_DESC =
	"知识库根目录（含 教训/导览/做法/评测/待验证/归档 与 索引.md）；一般留空，改传 部门 让工具从 PAO_HOME 解析";
const DEPT_DESC = "部门名（如 平台评测）：工具自动解析为 $PAO_HOME/部门/<部门名>/知识库，不要自己拼路径";

/**
 * 库路径解析（使用现场分仓后补的防猜错层）：优先显式 kb_path，其次 dept 名从
 * PAO_HOME 解析；两者皆无或目录不存在时返回错误——绝不静默当空库处理。
 */
function resolveLibRoot(params: { dept?: string; kb_path?: string }): { libRoot: string } | { error: string } {
	let libRoot: string;
	if (params.kb_path) libRoot = params.kb_path;
	else if (params.dept) libRoot = join(paoHome(), "部门", params.dept, "知识库");
	else return { error: "缺少库定位：请传 dept 名（推荐），或显式传 kb_path。" };
	try {
		const st = statSync(libRoot);
		if (!st.isDirectory()) return { error: `知识库路径不是目录：${libRoot}（PAO_HOME=${paoHome() || "未设置"}）` };
	} catch {
		return {
			error:
				`知识库目录不存在：${libRoot}。请核对部门名；当前 PAO_HOME=${paoHome() || "未设置"}。` +
				"不要凭会话 cwd 猜路径。",
		};
	}
	return { libRoot };
}

function libRootError(error: string): { content: { type: "text"; text: string }[]; details: undefined; isError: true } {
	return { content: [{ type: "text", text: error }], details: undefined, isError: true };
}

export function registerKnowledgeTools(pi: ExtensionAPI, options: KnowledgeToolsOptions = {}): void {
	function embedClient(): EmbedClient | null {
		if (options.embed !== undefined) return options.embed;
		const config = loadEmbedConfig();
		return config ? { config, fetchImpl: options.fetchImpl ?? fetch } : null;
	}
	function outbound(): OutboundConfig | undefined {
		return options.outbound === undefined ? loadOutboundConfig() : (options.outbound ?? undefined);
	}

	/**
	 * 自动路由分支（架构 §18.3 门面，M2-05）：读部门注册表 → 机械路由 → 并行查库＋语义召回 →
	 * 合并带来源。只在 路由:"自动" 时进入；不传该参数时走原路径，现有行为逐字节不变。
	 * 注册表只读（readRegistry）；「主控部」按注册表行照常参与路由，查无就如实不含，不造特殊分支。
	 */
	async function runAutoPatrol(
		params: { query: string; top_k?: number; expected_version?: string },
		ctx: { cwd?: string },
	): Promise<
		{ content: { type: "text"; text: string }[]; details: AutoRouteResult } | ReturnType<typeof libRootError>
	> {
		const home = paoHome();
		const registryPath = join(home, DEPT_DIR_NAME, REGISTRY_FILE_NAME);
		const rows = readRegistry(registryPath);
		if (rows.length === 0) {
			return libRootError(
				`部门注册表不存在或为空（${registryPath}）：自动路由无库可查。请先建部，或显式传 dept/kb_path。`,
			);
		}
		const result = await autoPatrol({
			查询: params.query,
			注册表行: rows,
			paoHome目录: home,
			topK: params.top_k,
			期望版本: params.expected_version,
			project: options.defaultProject ?? projectFromCwd(ctx?.cwd),
			embed: embedClient(),
			outbound: outbound(),
			fetchImpl: options.fetchImpl,
			vendorRecall: options.vendorRecall,
		});
		return { content: [{ type: "text", text: formatAutoRouteResult(result) }], details: result };
	}

	pi.registerTool({
		name: "pao_query_kb",
		label: "查库",
		description:
			"查部门知识库：词法+语义双路混合检索，返回每条命中带完整户口（path/summary/status/scope/last_verified/source）。" +
			"云端嵌入未配置或失败时自动降级为词法独跑并标注 degraded。一次最多应用 3 条命中，不够用就明说。" +
			"归档区不进检索；待验证、待复核或未知命中只作风险提示。查询项目由宿主工作目录绑定。" +
			`传 routing:"auto" 进自动路由（架构 §18.3 门面）：按部门注册表能力标签/部门名机械匹配相关库（含主控部，查无就如实不含），` +
			"并行查多个库＋记忆供应商语义召回（若已接线），合并结果带来源部门；无标签命中退化为查全部注册库并标注；" +
			"注册表为空则报错。自动模式忽略 部门/知识库路径。自动模式总量上限：每库缺省 " +
			`${AUTO_PER_LIB_TOP_K} 条、合并正式依据最多 ${AUTO_TOTAL_LIMIT} 条、语义召回最多 ${AUTO_SEMANTIC_LIMIT} 条，防上下文爆。` +
			"单库失败不拖垮整次查询，失败库如实标注。",
		parameters: Type.Object({
			query: Type.String({ description: "查询词；含可检索的具体名词（模块名/工具名/报错码）效果最好" }),
			dept: Type.Optional(Type.String({ description: DEPT_DESC })),
			kb_path: Type.Optional(Type.String({ description: LIB_ROOT_DESC })),
			top_k: Type.Optional(Type.Number({ description: "返回条数上限，默认 5；自动模式下是每库条数上限，缺省 3" })),
			expected_version: Type.Optional(
				Type.String({ description: "仅查询与来源版本有关的资料时填写；版本不符或未注明版本的命中只作风险提示" }),
			),
			routing: Type.Optional(
				Type.Literal("auto", {
					description:
						'传 "auto" 进自动路由模式：按注册表能力标签并行查相关库＋语义库（若已接线），合并带来源部门；忽略 部门/知识库路径',
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.routing === "auto") return runAutoPatrol(params, ctx);
			const resolved = resolveLibRoot(params);
			if ("error" in resolved) return libRootError(resolved.error);
			const result = await searchLibrary({
				libRoot: resolved.libRoot,
				query: params.query,
				topK: params.top_k,
				expectedVersion: params.expected_version,
				project: options.defaultProject ?? projectFromCwd(ctx.cwd),
				embed: embedClient(),
				outbound: outbound(),
				fetchImpl: options.fetchImpl,
			});
			return { content: [{ type: "text", text: formatResult(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "pao_restricted_query",
		label: "受限补查",
		description:
			"worker 一次受限补查：只查本部、只读、限一次（按卡号+授权轮次计，重试不恢复额度）、查询词记进回执。" +
			"只准在派卡指针不够用、发现明确缺口时用；仍不够再报部长补指针。部门参数只接受本部名，全部/别名一律拒绝。",
		parameters: Type.Object({
			query: Type.String({ description: "查询词，只查本部知识库" }),
			top_k: Type.Optional(Type.Number({ description: "返回条数上限，默认 5" })),
			expected_version: Type.Optional(
				Type.String({ description: "仅查询与来源版本有关的资料时填写；版本不符或未注明版本的命中只作风险提示" }),
			),
			dept: Type.Optional(Type.String({ description: "只接受本部名；传全部/别名会被拒绝" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!options.restricted) {
				return {
					content: [
						{ type: "text", text: "受限补查未授权：本会话没有绑定补查授权（卡号+授权轮次），工具不可用。" },
					],
					details: undefined,
					isError: true,
				};
			}
			const gate = createRestrictedGate({
				libRoot: options.restricted.libRoot,
				deptName: options.restricted.deptName,
				auth: options.restricted.auth,
				receiptPath: options.restricted.receiptPath,
				embed: embedClient(),
				outbound: outbound(),
				project: options.defaultProject ?? projectFromCwd(ctx.cwd),
			});
			try {
				const result = await gate.query(params.query, {
					topK: params.top_k,
					dept: params.dept,
					expectedVersion: params.expected_version,
				});
				return { content: [{ type: "text", text: formatResult(result) }], details: result };
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "pao_ingest_kb",
		label: "入库",
		description:
			"知识入库转正（部长专用纪律通道）：把 待验证/ 候选条目移入类型目录、子索引加行、触发机械巡检，三件事一次完成；" +
			"同批机械订正条目内候选语义的状态行为「状态: 正式」。幂等可重放：重复执行或中断后重跑都只修复、不重复生成。" +
			"多条目钩子同文时检索区分度弱，可传 新钩子 改写条目首行钩子（子索引行随之用它）提升区分度。" +
			"可传 适用范围 落「适用范围:」标记行（禁外发门禁键，语义查库靠它放行云端嵌入）。" +
			"入库只获得建议资格，不获得扩大权限的资格。",
		parameters: Type.Object({
			dept: Type.Optional(Type.String({ description: DEPT_DESC })),
			kb_path: Type.Optional(Type.String({ description: LIB_ROOT_DESC })),
			candidate_path: Type.String({ description: "候选条目文件路径（通常在 待验证/ 下）" }),
			type: Type.Union(
				ENTRY_TYPES.map((t) => Type.Literal(t)),
				{ description: "目标类型区：教训/导览/做法/评测" },
			),
			new_filename: Type.Optional(Type.String({ description: "落位文件名；缺省沿用原名" })),
			new_hook: Type.Optional(
				Type.String({
					description:
						"改写条目首行钩子（子索引行随之用它）：写成含可检索具体名词的一句话（部门/模块/工具/报错码），" +
						"并保留最后核验日期（如 「…手法 2026-10-02」）；缺日期巡检会标 ⚠️。不传沿用原首行",
				}),
			),
			scope: Type.Optional(
				Type.String({
					description:
						"落/改条目「适用范围:」标记行（禁外发门禁键）：值须与 PAO_HOME/知识库配置/外发许可.json 白名单键一致" +
						"（如 PAO），语义查库按它放行云端嵌入。无行则插入、值不同则改写、一致则不动。不传不动",
				}),
			),
			verification_source: Type.Optional(
				Type.String({
					description:
						"落/改条目「验证出处:」标记行（借鉴③）：写清这条做法由哪张卡、哪次真实验证过（如「卡0007 2026-10-04 真机验收」）。" +
						"无出处的旧条目标注「未验证」，不删除、不参与高置信引用；与「来源:」不同——来源是抄自哪，验证出处是本地哪次真跑过。无行则插入、值不同则改写、一致则不动。不传不动",
				}),
			),
			expected_version: Type.Optional(Type.String({ description: "期望的来源版本，巡检时比对" })),
			stale_days: Type.Optional(Type.Number({ description: "巡检超期阈值（天），默认 90" })),
		}),
		async execute(_id, params) {
			const resolved = resolveLibRoot(params);
			if ("error" in resolved) return libRootError(resolved.error);
			const result = await ingestEntry({
				libRoot: resolved.libRoot,
				candidatePath: params.candidate_path,
				type: params.type,
				newFileName: params.new_filename,
				新钩子: params.new_hook,
				适用范围: params.scope,
				验证出处: params.verification_source,
				expectedVersion: params.expected_version,
				staleDays: params.stale_days,
			});
			const text = [
				`入库完成：${result.targetPath}`,
				`重放：${result.alreadyPromoted ? "是（条目已在目标位）" : "否（本次执行了移动）"}`,
				...result.actions.map((a) => `- ${a}`),
			].join("\n");
			return { content: [{ type: "text", text }], details: result };
		},
	});

	pi.registerTool({
		name: "pao_inspect_kb",
		label: "巡检",
		description:
			"知识库机械巡检：扫全库条目首行的日期与来源版本，超期未核或版本不符 → 子索引行标 ⚠️。" +
			"纯比对、开销极小；机器只说多久没核/版本对不上，不说错了。⚠️ 的消化（更新/退役/打回）由部长终审。",
		parameters: Type.Object({
			dept: Type.Optional(Type.String({ description: DEPT_DESC })),
			kb_path: Type.Optional(Type.String({ description: LIB_ROOT_DESC })),
			expected_version: Type.Optional(Type.String({ description: "期望的来源版本（如 pi 升级后的新版本）" })),
			stale_days: Type.Optional(Type.Number({ description: "超期阈值（天），默认 90" })),
		}),
		async execute(_id, params) {
			const resolved = resolveLibRoot(params);
			if ("error" in resolved) return libRootError(resolved.error);
			const report = await inspectLibrary(resolved.libRoot, {
				expectedVersion: params.expected_version,
				staleDays: params.stale_days,
			});
			const lines = report.findings.filter((f) => f.flagged).map((f) => `- ${f.relPath}：${f.problems.join("；")}`);
			const parts = [
				`巡检完成：共 ${report.findings.length} 条，⚠️ ${report.flaggedCount} 条（已标进子索引）`,
				...lines,
			];
			if (options.afterInspect) {
				// 巡库卡接线（卡0006）：回调返回的提示文本追加在巡检结果之后；回调异常由接线方在回调内兜底
				const hint = await options.afterInspect(report, resolved.libRoot);
				if (hint) parts.push(hint);
			}
			const text = parts.join("\n");
			return { content: [{ type: "text", text }], details: report };
		},
	});
}
