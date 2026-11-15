/**
 * /pao 面板设置项读写（命令统一批·B 线）：4 个设置项落在两个配置文件,
 * 面板翻转/循环后即时写盘。
 *
 * 读写口径与现有读取函数严格同源（不另立语义）:
 * - 保温.json「toast 通知」（布尔）:host/config.ts toastEnabled——缺省开,显式 false 才关
 *   （与保温功能键「缺文件=不保温」的缺省语义相反,勿混）;
 * - 保温.json「上游并发上限」（可选数字）:worker/dispatch-core readUpstreamConcurrencyCap——
 *   键缺失＝不启用配置层（派单缺省 2 照旧）;
 * - 记忆供应商.json「自动召回」「自动交接」（布尔）:memory/memory-vendor.ts
 *   loadMemoryVendorConfig——缺省关。
 *
 * 写保护（写坏配置文件是事故）:
 * - 只改目标键,其余键（含记忆供应商的「供应商」「参数」等连接配置）原样保留——整读整保;
 * - 文件存在但坏 JSON/顶层非对象 → 拒绝写并抛错,绝不整文件覆盖;
 * - 记忆供应商.json 缺失 → 拒绝写（新建只剩开关的文件缺「供应商」字段＝坏配置,
 *   下一会话记忆模块直接警告降级——先去文件里配置供应商再开开关）;
 * - 原子写（同目录临时文件＋rename,复用 shared/atomic writeFileAtomic）。
 *
 * 生效时机（侦查结论,面板 description 据此如实标注）:
 * - toast 通知:每次 toast 发送时读盘（fanout/workflow）→ 即时生效;
 * - 上游并发上限:每次派发时读盘（dispatch-core 名额检查）→ 即时生效;
 * - 自动召回/自动交接:registerResidentMemory 注册期一次定型 → 重启会话后生效。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { WARM_CONFIG_RELATIVE_PATH } from "../host/config.ts";
import { MEMORY_CONFIG_RELATIVE_PATH } from "../memory/memory-vendor.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { readJsonRaw } from "../shared/json.ts";

/** 保温.json 全路径（相对路径与 host/config 同源） */
export function resolveWarmConfigPath(paoHome: string): string {
	return join(paoHome, WARM_CONFIG_RELATIVE_PATH);
}

/** 记忆供应商.json 全路径 */
export function resolveMemoryHomeConfigPath(paoHome: string): string {
	return join(paoHome, MEMORY_CONFIG_RELATIVE_PATH);
}

/** 整读配置对象:文件缺失 → null（调用方决定可否新建）;坏 JSON/顶层非对象 → 抛错（拒绝写） */
function loadConfigObject(configPath: string, chineseName: string): Record<string, unknown> | null {
	if (!existsSync(configPath)) return null;
	let parsed: unknown;
	try {
		// throw 型读点走 shared readJsonRaw:坏 JSON 的 SyntaxError 消息与裸 JSON.parse 一致,
		// 调用方包装文案不变;唯一直径差按 shared 口径是改进——BOM 文件不再误判为坏 JSON
		parsed = readJsonRaw(configPath);
	} catch (error) {
		throw new Error(
			`${chineseName} ${configPath} 不是合法 JSON,拒绝写入（请手工修复后再用面板改）:${(error as Error).message}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${chineseName} ${configPath} 顶层应为 JSON 对象,拒绝写入`);
	}
	return parsed as Record<string, unknown>;
}

/** 原子写回（2 空格缩进＋结尾换行）;写坏文件是事故,序列化失败直接抛、不留半成品 */
function saveConfigObject(configPath: string, obj: Record<string, unknown>): void {
	writeFileAtomic(configPath, `${JSON.stringify(obj, null, "  ")}\n`);
}

/**
 * 写保温.json 的一个键。文件缺失 → 新建只含该键的文件（注意:保温.json 一旦存在,
 * host 保温功能即按机械缺省启用——面板 description 已如实标注此副作用）;
 * value 传 undefined ＝ 删键（「上游并发上限」循环回「默认」时还原为键缺失）。
 */
export function writeWarmSetting(
	paoHome: string,
	key: "toast 通知" | "上游并发上限",
	value: boolean | number | undefined,
): string {
	const configPath = resolveWarmConfigPath(paoHome);
	const obj = loadConfigObject(configPath, "保温配置") ?? {};
	if (value === undefined) delete obj[key];
	else obj[key] = value;
	saveConfigObject(configPath, obj);
	return configPath;
}

/**
 * 写记忆供应商.json 的一个布尔键。文件缺失 → 拒绝写抛错（新建只剩开关的文件是坏配置,
 * 见头注释）;文件存在 → 只翻目标键,「供应商」「参数」等连接配置原样保留。
 */
export function writeMemorySetting(paoHome: string, key: "自动召回" | "自动交接", value: boolean): string {
	const configPath = resolveMemoryHomeConfigPath(paoHome);
	const obj = loadConfigObject(configPath, "记忆供应商配置");
	if (!obj) {
		throw new Error(
			`记忆供应商配置 ${configPath} 不存在——先在文件里配置「供应商」等字段,再用面板开开关（面板不代建坏配置）`,
		);
	}
	obj[key] = value;
	saveConfigObject(configPath, obj);
	return configPath;
}
