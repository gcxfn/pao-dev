import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHandoff } from "../cards/handoff.ts";
import { normalizedProjectRoot } from "../dept/projects.ts";
import { DEPT_DIR_NAME } from "../dept/registry.ts";
import { recipeFingerprint } from "../dept/render.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { projectName } from "./handle.ts";

/**
 * 短交接落盘(M2-01 设计包 §3,S2 先兑现散场侧;恢复门与「仅历史参考」核对属 S3)。
 *
 * 复用 cards/handoff.ts renderHandoff 四段(当前目标/已发生改动/验证结果/未决事项),
 * 数据源为机械盘点,不新立格式。落 $PAO_HOME/部门/<名>/交接/<项目名>-<根摘要>.md:
 * - 同绑定 key 一文件,新盖旧(散场即覆盖上一轮);
 * - 根摘要＝归一项目根的 sha1 前 8 位,只用于消除同名项目不同根的碰撞(同名不同根不覆盖);
 * - 正文头部带最近服务时间,供恢复读取核对(§2 崩溃窗口:钩子没跑时文件是旧货)。
 * 交接文件不在任何卡目录,listCards/驱动器/队列扫描结构上读不到——不存在被当成任务
 * 真相的通路(R10:不做第二任务真相)。
 */

/** 交接目录:$PAO_HOME/部门/<名>/交接/ */
export function handoffDir(paoHome: string, dept: string): string {
	return join(paoHome, DEPT_DIR_NAME, dept, "交接");
}

/** 交接文件名:<项目名>-<根摘要>.md(根摘要消除同名项目不同根的碰撞) */
export function handoffFileName(projectRoot: string, context?: string): string {
	const summary = createHash("sha1")
		.update(`${normalizedProjectRoot(projectRoot)}${context ? `\u0000${context}` : ""}`)
		.digest("hex")
		.slice(0, 8);
	return `${projectName(projectRoot)}-${summary}.md`;
}

/** 交接页绝对路径(同绑定 key 恒定一文件) */
export function handoffPagePath(paoHome: string, dept: string, projectRoot: string, context?: string): string {
	return join(handoffDir(paoHome, dept), handoffFileName(projectRoot, context));
}

/** 交接页文件头(机械事实:服务时间/绑定 key/配方指纹,供恢复读取核对「仅历史参考」的时效) */
function handoffPageHeader(dept: string, projectRoot: string, time: string, fingerprint: string | null): string {
	return [
		`<!-- 部长会话散场交接|部门:${dept}|项目根:${projectRoot}|最近服务:${time}|配方指纹:${fingerprint ?? "无"} -->`,
		"<!-- 交接页不得被据此自动续跑:恢复唯一入口是主控派新卡,是否续跑由主控裁决 -->",
		"",
	].join("\n");
}

/**
 * 落交接页:renderHandoff 四段＋头部注释,写 PAO_HOME 侧(新盖旧)。
 * 卡目录不可读时 renderHandoff 自带空态兜底;写盘失败上抛——调用方(散场钩子)决定
 * 是否带伤继续树杀(散场不因交接失败而卡死,失败如实通知)。
 */
export async function writeHandoffPage(input: {
	脉络?: string;
	paoHome: string;
	部门: string;
	项目根: string;
	卡目录: string;
	时间?: string;
}): Promise<string> {
	const body = await renderHandoff(input.卡目录);
	const time = input.时间 ?? new Date().toISOString().slice(0, 19).replace("T", " ");
	// 配方指纹内部自算(S3 恢复门):落盘时的配方状态,供恢复读取比对「落盘后配方是否又变过」
	const fingerprint = recipeFingerprint(input.部门, input.paoHome);
	const path = handoffPagePath(input.paoHome, input.部门, input.项目根, input.脉络);
	mkdirSync(handoffDir(input.paoHome, input.部门), { recursive: true });
	writeFileAtomic(path, `${handoffPageHeader(input.部门, input.项目根, time, fingerprint)}${body}\n`);
	return path;
}

/** 交接文件是否存在(指针附进派卡信封的前置:文件在才指针,不在不指针) */
export function handoffPageAt(path: string): boolean {
	return existsSync(path);
}

/**
 * 派卡信封的交接页指针文本(§3 ②:指针带读取目的,防被当成续跑指令)。
 * 文件不存在返回 undefined——历史靠文件幸存,不虚构指针。
 */
export function handoffPointerText(path: string): string | undefined {
	if (!handoffPageAt(path)) return undefined;
	return `背景核对(不是续跑指令,不得据此自行启动任何卡):本部门该项目上一轮部长交接页在 ${path}`;
}

// ── S3 短交接恢复门:时效判定与富指针 ─────────────────────────────────

/**
 * 交接保鲜窗默认值:24 小时。依据(设计规格):崩溃窗口下散场钩子没跑时交接文件是旧货,
 * 跨天冷启动默认按旧货对待——超窗即降级「仅历史参考」;测试经 options 保鲜窗毫秒 覆写。
 */
export const handoffFreshnessMs = 24 * 60 * 60 * 1000;

/** 交接页时效判定结论:新鲜=可参考;不新鲜=仅历史参考,不授权续跑 */
export interface HandoffTimelinessVerdict {
	/** true=新鲜可参考;false=仅历史参考,不授权续跑(fail-closed:任一核对不过即降级) */
	新鲜: boolean;
	/** 降级原因列表(新鲜时为空数组;多项核对同时不过时全部列出,一次说清) */
	原因: string[];
}

/** 交接页头部注释的解析结果(缺项即缺,不做补值) */
interface HandoffPageHeaderFields {
	部门?: string;
	项目根?: string;
	最近服务?: string;
	配方指纹?: string;
}

/** 从页文本解析头部注释字段(找不到头部注释返回空表,各核对按「缺」处理) */
function parseHandoffPageHeader(pageText: string): HandoffPageHeaderFields {
	const header = pageText.match(/<!--\s*部长会话散场交接\|.*?-->/)?.[0];
	if (!header) return {};
	const field: HandoffPageHeaderFields = {};
	for (const section of header
		.replace(/^<!--\s*/, "")
		.replace(/\s*-->$/, "")
		.split("|")) {
		const separator = section.indexOf(":");
		if (separator <= 0) continue;
		const key = section.slice(0, separator);
		if (key === "部门" || key === "项目根" || key === "最近服务" || key === "配方指纹") {
			field[key] = section.slice(separator + 1);
		}
	}
	return field;
}

/**
 * 交接页时效判定(S3 恢复门,纯函数零 IO):输入页文本＋{现在, 当前指纹},输出结论对象。
 * 规则全部 fail-closed,任一命中即降级「仅历史参考,不授权续跑」:
 * 缺最近服务时间 / 时间不可解析 / 缺配方指纹字段 / 指纹不匹配(含一侧「无」) / 超保鲜窗。
 * 恢复唯一入口是主控派新卡——本判定只降级参考价值,不是执行闸门。
 */
export function judgeHandoffTimeliness(
	pageText: string,
	input: { 现在: Date; 当前指纹: string | null; 保鲜窗毫秒?: number },
): HandoffTimelinessVerdict {
	const reason: string[] = [];
	const field = parseHandoffPageHeader(pageText);

	// 时效:缺最近服务时间 / 不可解析 → 降级
	const serviceTime = field.最近服务;
	if (serviceTime === undefined) {
		reason.push("交接页头部缺最近服务时间");
	} else if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(serviceTime)) {
		reason.push(`最近服务时间不可解析(${serviceTime})`);
	} else {
		// 落盘侧时间由 toISOString 派生(UTC),解析同口径按 UTC,不混本地时区
		const moment = Date.parse(`${serviceTime.replace(" ", "T")}Z`);
		if (Number.isNaN(moment)) {
			reason.push(`最近服务时间不可解析(${serviceTime})`);
		} else {
			const freshnessWindow = input.保鲜窗毫秒 ?? handoffFreshnessMs;
			if (input.现在.getTime() - moment > freshnessWindow) {
				reason.push(`超过保鲜窗(最近服务 ${serviceTime},保鲜窗 ${Math.round(freshnessWindow / 3_600_000)} 小时)`);
			}
		}
	}

	// 配方指纹:缺字段 / 不匹配(页上「无」而当前有配方,或反之)→ 降级
	const pageFingerprint = field.配方指纹;
	if (pageFingerprint === undefined) {
		reason.push("交接页头部缺配方指纹字段");
	} else {
		const pageHasFingerprint = pageFingerprint !== "无";
		if (input.当前指纹 === null) {
			if (pageHasFingerprint) reason.push(`配方指纹不匹配(页上 ${pageFingerprint.slice(0, 8)},当前无配方)`);
		} else if (!pageHasFingerprint || pageFingerprint !== input.当前指纹) {
			reason.push(
				`配方指纹不匹配(页上 ${pageHasFingerprint ? pageFingerprint.slice(0, 8) : "无"},当前 ${input.当前指纹.slice(0, 8)})`,
			);
		}
	}

	return { 新鲜: reason.length === 0, 原因: reason };
}

/** 富交接指针:指针文本＋时效判定结论(降级时文本内嵌「仅历史参考,不授权续跑」与原因) */
export interface RichHandoffPointer {
	文本: string;
	判定: HandoffTimelinessVerdict;
}

/**
 * 富交接指针(S3):在 交接指针文本 既有语义之上叠加时效判定——
 * 文件不在返回 undefined(同旧语义,不虚构指针);文件在则读页文本、自算当前配方指纹、
 * 判定时效:新鲜照旧给「背景核对」指针;降级则指针带「仅历史参考,不授权续跑」＋原因。
 * 调用方(主控)据此裁决是否恢复——恢复唯一入口仍是主控派新卡,本函数不是执行闸门。
 */
export function richHandoffPointerText(
	paoHome: string,
	dept: string,
	projectRoot: string,
	options: { 现在?: Date; 保鲜窗毫秒?: number; 脉络?: string } = {},
): RichHandoffPointer | undefined {
	const path = handoffPagePath(paoHome, dept, projectRoot, options.脉络);
	if (!handoffPageAt(path)) return undefined;
	const pageText = readFileSync(path, "utf8");
	const judgement = judgeHandoffTimeliness(pageText, {
		现在: options.现在 ?? new Date(),
		当前指纹: recipeFingerprint(dept, paoHome),
		保鲜窗毫秒: options.保鲜窗毫秒,
	});
	const baseline = handoffPointerText(path);
	if (!baseline) return undefined; // 不可达(文件已在),防御性收口
	const text = judgement.新鲜
		? `${baseline};时效核对通过(新鲜可参考)`
		: `${baseline};该页仅历史参考,不授权续跑(${judgement.原因.join(";")}),是否恢复由主控裁决`;
	return { 文本: text, 判定: judgement };
}
