/**
 * `/pao budget` 子命令：总预算的人工巡检与显式归还（H0-B）。
 *
 * 为什么挂在命令面而不是工具面：这条命令能**改钱账**（把停着的预留额度放回去）。
 * 工具面是 agent 自己能调的，把钱账的写入口交给 agent，等于让它自己给自己提额度。
 * 命令面只有人敲得到，与 `role.ts` 里 worker「零命令装载面」的纪律也天然一致
 * ——worker 会话不装载本模块，agent 连这条路都看不见。
 *
 * 分工：本文件只做「解析参数 + 排版文本」，钱账事实全部来自 `dispatch-gate.ts` 的两个
 * 薄封装（`listReservedReservations` / `releaseReservationExplicit`），一笔账逻辑都不复制。
 */
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { addPaoSubcommand } from "../command-router.ts";
import { listReservedReservations, releaseReservationExplicit } from "./dispatch-gate.ts";

export interface BudgetCommandOptions {
	/** 取 PAO_HOME（与 status/queue 同口径，惰性调用——装配时文件可能还不存在）。 */
	resolvePaoHome: () => string;
	/** 现在（ISO 生成器）；测试注入固定时间用。 */
	现在?: () => string;
}

/** 归还参数的正确形状，错的时候原样报出来给人看。 */
const 归还格式 = "/pao budget 归还 <卡号>:<尝试号>（例：/pao budget 归还 7:1）";

/**
 * 巡检页：每一笔停着的预留都要能回答「谁、卡几、尝试几、多少钱、什么时候、什么状态、下一步做什么」。
 * 空态要说人话（「账上没有任何停着的预留」），不许留一片空白让人以为命令坏了。
 */
function renderReservationList(rows: ReturnType<typeof listReservedReservations>): string {
	if (rows.length === 0) {
		return [
			"总预算巡检:账上没有任何停着的预留。",
			"（这表示眼下没有派发占着额度；不等于「没花过钱」——已结算的记录不在此列表，看 /pao status 的用量账。）",
		].join("\n");
	}
	const lines = rows.map((row, index) => {
		const 谁 = row.卡号 ? `卡${row.卡号}` : "（无卡号：总量预留）";
		const 尝试 = row.尝试号 === undefined ? "尝试号未标注" : `尝试 ${row.尝试号}`;
		return [
			`${index + 1}. ${谁} · ${尝试}`,
			`   多少：预留 $${row.预留额.toFixed(2)}（这笔钱现在占着额度，别人用不了）`,
			`   何时：${row.预留时间}`,
			`   状态：reserved（已预留、还没结算——进程可能还在跑，也可能是崩了的结果不明）`,
			`   判据：${row.idempotencyKey}`,
		].join("\n");
	});
	return [
		`总预算巡检:${rows.length} 笔预留仍停在 reserved（共占 $${rows.reduce((sum, row) => sum + row.预留额, 0).toFixed(2)}）。`,
		...lines,
		"下一步（任选，都要人自己判断）:",
		"  · 进程还在跑 → 什么都不用做，它会自己结算；",
		"  · 确认那次派发根本没派出去、也没花钱 → 显式归还（下面第一条）；",
		"  · 不确定花没花 → 先查回执/卡状态，**不要**归还（结果不明时归还会让额度虚高）。",
		`  · 归还命令：${归还格式}（例如上面第 1 笔就是 归还 ${
			rows[0]!.卡号 ?? "<卡号>"
		}:${rows[0]!.尝试号 ?? "<尝试号>"}）`,
	].join("\n");
}

/**
 * 注册 `/pao budget`（原 `/pao 预算`；中文命令名早已全删，见 command-router.ts 头注）。
 *
 * 两个动作：
 * - `/pao budget` 或 `/pao budget 巡检`：**只报不写**；
 * - `/pao budget 归还 <卡号>:<尝试号>`：人显式下命令才写，参数缺一或格式不对直接拒绝。
 *
 * **没有任何自动归还**：本模块不比较「预留时间到现在多久」，不因为一笔看起来旧了就归还。
 */
export function registerBudgetCommand(pi: ExtensionAPI, options: BudgetCommandOptions): void {
	addPaoSubcommand(pi, {
		name: "budget",
		label: "预算",
		description:
			"总预算人工巡检:列出停在 reserved 的派发预留(谁/卡几/尝试几/多少钱/何时),并按 <卡号>:<尝试号> 显式归还;只报不自动归还",
		run: async (pi2, args) => {
			const text = await renderBudgetReply(args, options);
			pi2.sendMessage({ customType: "pao-budget", content: [{ type: "text", text }], display: true });
		},
	});
}

/** 把 `/pao budget` 的参数翻成一屏可读文本（导出供测试直测，不经消息通道）。 */
export async function renderBudgetReply(args: string, options: BudgetCommandOptions): Promise<string> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const verb = parts[0] ?? "巡检";
	const home = options.resolvePaoHome();
	try {
		// 裸 `/pao budget`（router 无参时传空串，故这里 `verb` 可能是 "" 也可能是兜底出的 "巡检"）
		// 与 `/pao budget 巡检` **刻意等价**：巡检是只读动作，用户敲 budget 要的必然是「给我看看」，
		// 给两个名字干同一件事只是多一层选择负担。下一个人别以为这里漏了分支。
		if (verb === "巡检" || verb === "") return renderReservationList(listReservedReservations(home));
		if (verb === "归还") {
			const target = parts[1];
			if (!target) {
				return `归还没给对象：不知道要还哪一笔。\n正确格式：${归还格式}\n（先敲 /pao budget 巡检 看当前停着的判据键。）`;
			}
			const matched = /^(\d+):(\d+)$/.exec(target);
			if (!matched) {
				return `归还参数格式不对：「${target}」。\n正确格式：${归还格式}\n（要 <卡号>:<尝试号> 两个数字，中间一个英文冒号。）`;
			}
			const result = await releaseReservationExplicit(home, {
				卡号: matched[1]!,
				尝试号: Number(matched[2]),
				...(options.现在 ? { 现在: options.现在() } : {}),
			});
			if (result.ok) {
				return [
					`已归还：卡${matched[1]} 尝试 ${matched[2]}，$${result.reservation.预留额.toFixed(2)} 已放回可用额度。`,
					`判据：${result.reservation.idempotencyKey}`,
					`归还时间：${result.reservation.结算时间 ?? "（账上未记时间）"}`,
					"下一步：这笔额度现在别人可以用了；如果那次派发其实还在跑，请立刻停掉它——钱已经放回去了，再花就是超出总预算。",
				].join("\n");
			}
			if (result.kind === "没有这笔预留") {
				return [
					`账上没有这一笔：卡${matched[1]} 尝试 ${matched[2]}（判据 派发:卡${matched[1]}:尝试${matched[2]}）。`,
					"没做任何修改。",
					result.reservedKeys.length === 0
						? "当前账上没有任何停着的预留——如果刚才是手滑，敲 /pao budget 巡检 再确认一遍。"
						: `当前停着的判据键（照抄一个再归还）：\n${result.reservedKeys.map((key) => `  - ${key}`).join("\n")}`,
				].join("\n");
			}
			if (result.kind === "不许归还") {
				return [
					`这笔不能归还：${result.reason}`,
					"没做任何修改。",
					"下一步：结果不明的那笔要先查清（看回执、卡状态、后台进程）再决定；已结算的那笔钱已经花了，归还会让账面少一笔真实支出。",
				].join("\n");
			}
			return [
				`归还失败（账没改动，原记录仍在盘上）：${result.reason}`,
				`错误码：${result.code}`,
				"下一步：若是账被占用可以稍后重试；若是账坏了请先修 总预算账.json（坏账不会被静默重置）。",
			].join("\n");
		}
		return [
			`未知的 budget 子动作：「${verb}」。`,
			"可用：",
			"  · /pao budget            巡检（只报不写）",
			`  · ${归还格式}`,
		].join("\n");
	} catch (error) {
		// 坏账/读盘失败一律显式报出来，不伪装成「没有停着的预留」。
		return `/pao budget 读取失败：${error instanceof Error ? error.message : String(error)}\n下一步：先修 总预算账.json（坏账不会被静默重置）；在修好之前预算门禁也会拒绝派发。`;
	}
}
