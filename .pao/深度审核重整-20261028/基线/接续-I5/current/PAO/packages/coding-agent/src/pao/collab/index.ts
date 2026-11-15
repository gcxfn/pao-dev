/**
 * pao 协作卡中转（卡0005）：协作卡星型中转的机械校验放行 ＋ /派 用户快捷建卡。
 *
 * 导出两层：
 * - registerCollab(pi, options)：注册 pao_collab_relay 工具与 /派 命令（注册给主控会话；无 worker 再派发入口）；
 * - 纯库函数与类型：校验协作卡 / 落协作卡 / 审计追加。
 */
import { isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { loadCardBodyTemplate, resolveCardTemplatePath } from "../cards/cardfile.ts";
import { createCard, formatCardNumber, parseCardRef, scanCards } from "../cards/index.ts";
import type { ParsedCard } from "../cards/types.ts";
import { CARD_PRIORITIES, CARD_TIERS } from "../cards/types.ts";
import { addPaoSubcommand } from "../command-router.ts";
import { DEPT_DIR_NAME, type DeptRegistryRow, REGISTRY_FILE_NAME, readRegistry } from "../dept/index.ts";
import { recordFrictionDraft } from "../friction/drafts.ts";
import { resolvePaoHome } from "../routing/config.ts";
import { withFileLock } from "../shared/lock.ts";
import { nowString } from "../shared/time.ts";
import { auditAppend, type CollabAuditRecord, USER_DIRECT_VERDICT } from "./audit.ts";
import { writeCollabCard } from "./dispatch.ts";
import {
	type CollabCardDraft,
	type CollabRejectionReason,
	type CollabReviewResult,
	validateCollabCard,
} from "./review.ts";

export * from "./audit.ts";
export * from "./dispatch.ts";
export * from "./review.ts";

/** pao_collab_relay 工具的注册与路径解析配置；全部路径注入，不硬编码。 */
export interface CollabToolsOptions {
	/** 当前任务工作区卡目录（与 A 卡工具同款注入）；缺省时工具与 /pao collab 都给配置缺失提示 */
	resolveCardsDir?: () => string;
	/**
	 * 目标部门卡目录解析；缺省＝与 resolveCardsDir 同一卡目录
	 * （§2.1 平铺布局：卡/ 内部门以 frontmatter.部门 区分，/队列 按部门分组）。
	 */
	resolveDeptCardsDir?: (dept: string) => string;
	/** 审计 JSONL 路径；缺省 <卡目录>/../协作审计.jsonl（任务工作区根） */
	resolveAuditPath?: () => string;
	/** 部门注册表路径；缺省 $PAO_HOME/部门/注册表.md */
	resolveRegistryPath?: () => string;
	/** PAO_HOME 解析（协作卡「模板」按名查 <PAO_HOME>/pao配置/卡模板/）；未注入时模板名不可用 */
	resolvePaoHome?: () => string;
}

function formatReasons(result: CollabReviewResult): string {
	return result.原因.map((reason) => `- [${reason.类型}] ${reason.说明}`).join("\n");
}

// ============================================================================
// pao_collab_relay
// ============================================================================

const collabParams = Type.Object({
	goal: Type.String({ description: "一句话目标" }),
	dept: Type.String({ description: "目标部门名（须在部门注册表中）" }),
	acceptance: Type.String({ description: "可判验收条件，尽量机械化" }),
	parent: Type.String({ description: "归属父卡引用（卡#N）：发起方自己那张卡；协作卡必填" }),
	inputs: Type.Optional(Type.Array(Type.String(), { description: "指针列表：路径/卡#N/知识库条目，不装内容" })),
	constraints: Type.Optional(Type.String({ description: "引用规则文件，不复述标准" })),
	depends_on: Type.Optional(Type.Array(Type.String(), { description: "前置卡引用（卡#N），全部已交付才放行" })),
	template: Type.Optional(
		Type.String({
			description:
				"已批准模板名（M2-09 卡模板库，只收 PAO_HOME/pao配置/卡模板/ 库内名字，不收任意路径）：模板正文骨架（机械验收句式＋约束引用）带入卡正文——模板绑定既有授权范围，字段填齐不扩大授权",
		}),
	),
	tier: Type.Optional(
		Type.Union(
			CARD_TIERS.map((tier) => Type.Literal(tier)),
			{ description: "模型档位：快/主力" },
		),
	),
	budget: Type.Optional(
		Type.Object({
			turns: Type.Optional(Type.Number()),
			toolCalls: Type.Optional(Type.Integer({ minimum: 0 })),
			cost: Type.Optional(Type.Number()),
			collab_quota: Type.Optional(Type.Number()),
		}),
	),
	priority: Type.Optional(
		Type.Union(
			CARD_PRIORITIES.map((p) => Type.Literal(p)),
			{ description: "高/中/低，缺省中" },
		),
	),
	source_dept: Type.Optional(Type.String({ description: "起草部门（审计用）；主控代递交时填「主控」，缺省同" })),
	jump_queue: Type.Optional(
		Type.String({ description: "裁决标记声明：请求插队及理由。声明后机械放行失效，转主控裁决" }),
	),
	new_permissions: Type.Optional(
		Type.String({ description: "裁决标记声明：所需新权限及说明。声明后机械放行失效，转主控裁决" }),
	),
	budget_override: Type.Optional(
		Type.String({ description: "裁决标记声明：超出父卡预算池的覆写请求。声明后机械放行失效，转主控裁决" }),
	),
	acceptance_dispute: Type.Optional(
		Type.String({ description: "裁决标记声明：验收条件何处存疑。声明后机械放行失效，转主控裁决" }),
	),
	cards_dir: Type.Optional(Type.String({ description: "既有卡所在的任务工作区卡目录；已配置默认卡目录时可省略" })),
});

type CollabRelayParams = Static<typeof collabParams>;

function toDraft(params: CollabRelayParams): CollabCardDraft {
	return {
		目标: params.goal,
		部门: params.dept,
		验收: params.acceptance,
		parent: params.parent,
		输入: params.inputs,
		约束: params.constraints,
		depends_on: params.depends_on,
		模板: params.template,
		档位: params.tier,
		预算: params.budget,
		优先级: params.priority,
		插队: params.jump_queue,
		新权限: params.new_permissions,
		超预算覆写: params.budget_override,
		验收存疑: params.acceptance_dispute,
	};
}

/**
 * 解析协作卡的「模板」为已批准模板正文（§8.2 机械条件「用已批准模板」，M2-02 绑定授权范围）。
 * 只收已批准模板库（<PAO_HOME>/pao配置/卡模板/）内的模板名；绝对路径一律拒——
 * 任意路径＝任意内容＝让「字段填齐」成为任意操作的通行证，与绑定既有授权范围相悖。
 * 返回 { 正文 } 或 { 拒绝原因 }；本函数只读文件，不落任何改动。
 */
function resolveApprovedTemplateBody(
	template: string,
	paoHome?: string,
): { 正文: string } | { 拒绝原因: CollabRejectionReason } {
	const trimmed = template.trim();
	if (trimmed.length === 0) {
		return { 拒绝原因: { 类型: "模板未批准", 字段: "模板", 说明: "模板参数为空白" } };
	}
	if (isAbsolute(trimmed)) {
		return {
			拒绝原因: {
				类型: "模板未批准",
				字段: "模板",
				说明: `协作卡的模板只收已批准模板库内的模板名（PAO_HOME/pao配置/卡模板/），不收绝对路径「${trimmed}」——模板绑定既有授权范围，不接受来路不明的正文`,
			},
		};
	}
	try {
		const path = resolveCardTemplatePath(trimmed, paoHome);
		// 相对路径穿越防线：解析后的路径必须仍落在模板库目录内
		//（resolveCardTemplatePath 的 join 不拦 ../../，库外 .md 不得混进「已批准」出处）
		const libDir = resolve((paoHome ?? "").trim(), "pao配置", "卡模板");
		const normalize = (value: string): string[] => value.split(/[\\/]/).filter(Boolean);
		const parsed = normalize(path).join("/");
		const libPrefix = normalize(libDir).join("/");
		if (!parsed.startsWith(`${libPrefix}/`) || parsed.slice(libPrefix.length + 1).includes("..")) {
			return {
				拒绝原因: {
					类型: "模板未批准",
					字段: "模板",
					说明: `模板「${trimmed}」解析后越出已批准模板库（${libDir}），拒绝——协作卡模板只收库内名字`,
				},
			};
		}
		const body = loadCardBodyTemplate(path);
		if (body.trim().length === 0) {
			return {
				拒绝原因: {
					类型: "模板未批准",
					字段: "模板",
					说明: `模板「${trimmed}」没有正文骨架（只有 frontmatter 的文件不算已批准模板）`,
				},
			};
		}
		return { 正文: body };
	} catch (error) {
		return {
			拒绝原因: {
				类型: "模板未批准",
				字段: "模板",
				说明: `模板「${trimmed}」不是可用的已批准模板：${error instanceof Error ? error.message : String(error)}`,
			},
		};
	}
}

async function executeCollabRelay(
	params: CollabRelayParams,
	options: CollabToolsOptions,
): Promise<{ text: string; result: CollabReviewResult }> {
	const cardsDir = params.cards_dir ?? options.resolveCardsDir?.();
	if (!cardsDir) {
		throw new Error("[INVALID_CARD] 缺少 cards_dir 参数，且未配置默认卡目录（CollabToolsOptions.resolveCardsDir）");
	}
	const registryPath = options.resolveRegistryPath?.() ?? join(resolvePaoHome(), DEPT_DIR_NAME, REGISTRY_FILE_NAME);
	const targetDir = options.resolveDeptCardsDir?.(params.dept) ?? cardsDir;
	const registry: DeptRegistryRow[] = readRegistry(registryPath);
	const now = nowString();
	const auditPath = options.resolveAuditPath?.() ?? join(cardsDir, "..", "协作审计.jsonl");

	// 审查第 8 项：读卡查重、配额校验与落卡必须在同一个跨进程临界区内完成。旧实现先读卡校验、
	// 再异步建卡，两个主控会话可同时看到「尚未建卡」而各落一张子卡（配额形同虚设）。
	// 锁挂在主卡目录上、与发号器的卡号锁不是同一把，避免嵌套卡号锁死锁。
	const 落卡 = await withFileLock(join(cardsDir, "协作落卡.txt"), async () => {
		// 既有卡状态：当前卡目录＋目标卡目录（分目录布局时合并；平铺布局两者相同）
		const primaryScan = scanCards(cardsDir);
		const targetScan = targetDir === cardsDir ? { cards: [], problems: [] } : scanCards(targetDir);
		const existingCardStatus: ParsedCard[] = [...primaryScan.cards, ...targetScan.cards];
		const scanProblems = [...primaryScan.problems, ...targetScan.problems];
		// 坏卡读不出来时查重结论必然不完整：显式披露，别让「放行」看着像查过全部卡（审查第 5 项）
		const scanNote =
			scanProblems.length > 0
				? `\n注意：有 ${scanProblems.length} 张卡读不出来，本次查重未包含它们：${scanProblems.map((p) => `${p.path}（${p.reason}）`).join("；")}`
				: "";
		const draft = toDraft(params);
		let result = validateCollabCard(draft, registry, existingCardStatus);
		// 已批准模板（§8.2 机械条件之一）：文件系统校验在工具层做，拒绝并入机械校验结果同一结构
		let templateBody: string | undefined;
		if (typeof params.template === "string") {
			const parsed = resolveApprovedTemplateBody(params.template, options.resolvePaoHome?.());
			if ("拒绝原因" in parsed) {
				result = { ...result, 裁决: "拒绝", 原因: [...result.原因, parsed.拒绝原因] };
			} else {
				templateBody = parsed.正文;
			}
		}
		if (result.裁决 !== "放行") return { result, scanNote, created: undefined as ParsedCard | undefined };
		const created = await writeCollabCard(targetDir, draft, now, { 模板正文: templateBody });
		return { result, scanNote, created };
	});
	const { result, scanNote, created } = 落卡;

	if (created) {
		const record: CollabAuditRecord = {
			时间: now,
			来源部门: params.source_dept?.trim() || "主控",
			目标部门: params.dept,
			卡号: created.card_no,
			校验结果: "放行",
			目标: params.goal,
		};
		// 审查第 15 项：卡已落盘、审计只是旁挂留痕。审计失败必须如实报「卡已创建＋审计失败」，
		// 不能只抛一个笼统失败——调用方重试会再落一张子卡（与 /派 用户直派分支同款处理）。
		try {
			await auditAppend(auditPath, record);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				text: `机械校验通过，已落目标部门队列：${created.filename}（${targetDir}），状态 unclaimed，parent=${params.parent}。（审计写入失败：${reason}；卡号 ${formatCardNumber(created.card_no)} 已创建，不要重复派卡）${scanNote}`,
				result,
			};
		}
		return {
			text: `机械校验通过，已落目标部门队列：${created.filename}（${targetDir}），状态 unclaimed，parent=${params.parent}。主控可经 /pao queue 查看。${scanNote}`,
			result,
		};
	}

	const record: CollabAuditRecord = {
		时间: now,
		来源部门: params.source_dept?.trim() || "主控",
		目标部门: params.dept,
		卡号: result.已有卡号 ?? null,
		校验结果: result.裁决,
		目标: params.goal,
		原因:
			result.裁决 === "拒绝"
				? result.原因.map((r) => `[${r.类型}] ${r.说明}`)
				: Object.entries(result.裁决声明).map(([flag, description]) => `${flag}：${description}`),
	};
	// 未落卡的裁决也留审计；这里没有已创建的卡，审计失败只如实附注，不影响裁决本身的结论
	let 审计告警 = "";
	try {
		await auditAppend(auditPath, record);
	} catch (error) {
		审计告警 = `\n（审计写入失败：${error instanceof Error ? error.message : String(error)}）`;
	}
	if (result.裁决 === "拒绝") {
		// 打回（M0-08）：协作卡递交被机械校验拒绝＝审核打回的落定点；草稿失败不抛（recordFrictionDraft 内部已兜）
		await recordFrictionDraft(
			"打回",
			result.已有卡号 !== undefined ? formatCardNumber(result.已有卡号) : "无",
			`协作卡递交被机械校验拒绝：${result.原因.map((r) => `[${r.类型}] ${r.说明}`).join("；")}`,
			cardsDir,
		);
		return {
			text: `协作卡已拒绝（未落队列），原因：\n${formatReasons(result)}\n补齐/修正后可重新递交。${scanNote}${审计告警}`,
			result,
		};
	}
	// 升级人（M0-08）：机械校验全过但带裁决标记、不落队列转主控裁决＝交人工处理的落定点
	await recordFrictionDraft(
		"升级人",
		formatCardNumber(parseCardRef(params.parent)),
		`协作卡带裁决标记转主控裁决：${Object.entries(result.裁决声明)
			.map(([flag, description]) => `${flag}：${description}`)
			.join("；")}`,
		cardsDir,
	);
	return { text: `${result.裁决摘要 ?? "协作卡待主控裁决（未落队列）。"}${scanNote}${审计告警}`, result };
}

// ============================================================================
// /派 命令
// ============================================================================

const DISPATCH_USAGE = [
	"用法：/pao collab 目标 | 部门 | 验收",
	"或：/pao collab 目标 | 部门 | 输入指针（多个用顿号分隔） | 验收",
	"例：/pao collab 修好登录超时 | 后端 | src/login.ts 第 40 行的超时设置 | 全部登录测试绿",
].join("\n");

/**
 * /派 用户快捷建卡（架构 §3：直接落卡，主控零参与——用户＝最高授权，机械中转不拦用户）。
 * M2-02 补齐：落卡同样留审计（校验结果＝用户直派），审计线不缺用户直派的账；
 * 审计写入失败不回滚落卡，只在回执文本上如实标注（卡是任务真相，审计是旁挂留痕）。
 */
async function executeDispatch(
	args: string,
	cardsDir: string | undefined,
	options: CollabToolsOptions,
): Promise<string> {
	if (!cardsDir) {
		return `未配置默认卡目录（CollabToolsOptions.resolveCardsDir），无法落卡。\n${DISPATCH_USAGE}`;
	}
	const parts = args.split("|").map((part) => part.trim());
	if (
		(parts.length !== 3 && parts.length !== 4) ||
		parts[0] === "" ||
		parts[1] === "" ||
		parts[parts.length - 1] === ""
	) {
		return `参数不全，未落卡（不落半残卡）。\n${DISPATCH_USAGE}`;
	}
	const [goal, dept, third, fourth] = parts;
	const input =
		fourth === undefined
			? []
			: third
					.split(/[、,，;；]/)
					.map((s) => s.trim())
					.filter(Boolean);
	const acceptance = fourth ?? third;
	const card = await createCard(cardsDir, {
		目标: goal,
		部门: dept,
		验收: acceptance,
		输入: input,
		创建: nowString(),
	});
	const record: CollabAuditRecord = {
		时间: nowString(),
		来源部门: "用户",
		目标部门: dept,
		卡号: card.card_no,
		校验结果: USER_DIRECT_VERDICT,
		目标: goal,
	};
	try {
		await auditAppend(options.resolveAuditPath?.() ?? join(cardsDir, "..", "协作审计.jsonl"), record);
		return `已派卡：${card.filename}（${cardsDir}），状态 unclaimed，部门「${dept}」。`;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `已派卡：${card.filename}（${cardsDir}），状态 unclaimed，部门「${dept}」。（审计写入失败：${reason}）`;
	}
}

// ============================================================================
// 注册入口
// ============================================================================

/**
 * 注册协作中转工具与 /派 命令（注册给主控会话；worker 装载清单不装本模块即无再派发入口）。
 * 工具：pao_collab_relay（协作卡机械校验 → 放行落队列 / 拒绝 / 待主控裁决，全程留审计）。
 * 命令：/派（用户快捷建卡，直接落当前任务工作区卡目录，主控零参与）。
 */
export function registerCollab(pi: ExtensionAPI, options: CollabToolsOptions = {}): void {
	pi.registerTool({
		name: "pao_collab_relay",
		label: "协作中转",
		description:
			"协作卡星型中转正门：对部门起草的协作卡（带 parent）做机械校验——部门在注册表、信封字段齐全、协作配额未超（默认 2，父卡可覆写）、依赖全部已交付、同 parent 同目标无活卡（幂等）、协作卡不得再生协作卡；通过即落目标部门队列并留审计（JSONL）。带插队/新权限/超预算覆写/验收存疑任一裁决标记时不落队列，返回裁决摘要交主控判断。",
		parameters: collabParams,
		execute: async (_toolCallId, params) => {
			const { text, result } = await executeCollabRelay(params, options);
			return { content: [{ type: "text", text }], details: result };
		},
	});

	addPaoSubcommand(pi, {
		name: "collab",
		label: "协作建卡",
		description: "快捷建卡：直接落到当前任务工作区卡目录（不经主控裁决）",
		run: async (pi, args) => {
			let text: string;
			try {
				text = await executeDispatch(args, options.resolveCardsDir?.(), options);
			} catch (error) {
				text = String(error);
			}
			pi.sendMessage({
				customType: "pao-dispatch",
				content: [{ type: "text", text }],
				display: true,
			});
		},
	});
}
