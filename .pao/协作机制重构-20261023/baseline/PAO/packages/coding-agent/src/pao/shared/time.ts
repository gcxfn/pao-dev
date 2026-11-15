/**
 * 时刻字符串的唯一实现(时间统一:此前 9 处同格式重复定义合一)。
 * - nowString:本地时区「YYYY-MM-DD HH:mm」——卡片协议冻结格式(回执段标题、交接/协作页
 *   时间戳都按它解析),是给人读的展示面,不改语义不改格式;
 * - utcNow/utcToLocalDisplay:机器可读字段的存取面——登记表.登记时间/最近输出时间、live
 *   头尾等结构化时间一律存 UTC ISO(跨时区可比、Date.parse 无歧义),要给人看时再转本地,
 *   不拿本地字符串当机器字段存。
 * 本模块不 import 任何东西,任何层可安全引用。
 */
export function nowString(date = new Date()): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 机器可读时间字段统一取 UTC ISO(登记表、回执头、live 界标等入库字段用它,别散写 toISOString) */
export function utcNow(date = new Date()): string {
	return date.toISOString();
}

/** 已存的 UTC ISO 转本地展示格式(与 nowString 同形;坏值/空值原样返回——展示面不抛) */
export function utcToLocalDisplay(iso: string): string {
	const parsed = new Date(iso).getTime();
	return Number.isFinite(parsed) ? nowString(new Date(parsed)) : iso;
}
