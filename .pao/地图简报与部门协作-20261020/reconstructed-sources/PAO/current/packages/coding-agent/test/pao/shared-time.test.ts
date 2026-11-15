/**
 * 时间唯一实现(shared/time)的行为钉:
 * - nowString:本地时区「YYYY-MM-DD HH:mm」——卡片协议冻结格式,9 处重复定义合一后不许漂移;
 * - utcNow:UTC ISO(机器字段入库格式,与登记表.登记时间/最近输出时间同源);
 * - utcToLocalDisplay:存的 UTC 转本地展示;坏值原样返回(展示面不抛)。
 * 断言用注入 Date 定值,不依赖宿主时区(本地格式按本地时区渲染是特性,钉形状不钉绝对值)。
 */
import { describe, expect, it } from "vitest";
import { nowString, utcNow, utcToLocalDisplay } from "../../src/pao/shared/time.ts";

/** 本地时区的 2026-10-03 15:04 */
const localMoment = new Date(2026, 9, 3, 15, 4, 5, 678);

describe("nowString(卡片协议冻结格式)", () => {
	it("本地时区 YYYY-MM-DD HH:mm:秒/毫秒截掉,月日时分补零", () => {
		expect(nowString(localMoment)).toBe("2026-10-03 15:04");
		expect(nowString(new Date(2026, 0, 7, 3, 9))).toBe("2026-01-07 03:09");
	});
	it("缺省取当前时间(形状合法,不抛)", () => {
		expect(nowString()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});
});

describe("utcNow(机器字段入库格式)", () => {
	it("UTC ISO 毫秒精度:Date.parse 可无歧义还原(登记表静默基线靠它)", () => {
		const iso = utcNow(localMoment);
		expect(iso).toBe(localMoment.toISOString());
		expect(Number.isFinite(Date.parse(iso))).toBe(true);
	});
});

describe("utcToLocalDisplay(存的 UTC 转给人看)", () => {
	it("UTC ISO → 本地展示格式,与 nowString 同形", () => {
		const iso = utcNow(localMoment);
		expect(utcToLocalDisplay(iso)).toBe(nowString(localMoment));
	});
	it("坏值/空值原样返回,不抛(展示面兜底)", () => {
		expect(utcToLocalDisplay("not-a-date")).toBe("not-a-date");
		expect(utcToLocalDisplay("")).toBe("");
	});
});
