import { afterEach, describe, expect, test, vi } from "vitest";

import { logError, logWarn } from "../../src/pao/shared/log.ts";

/**
 * 警告/错误单点出口（P2 清账）:pao 内散点 console.warn/error 收口到 shared/log。
 * 当前实现仍是 console 直写（行为不变）;桌面宿主要接管展示时只改 shared/log.ts 一处。
 * 本测试钉住「单点确实经过 console」——升级成宿主通道转发时同步改这里。
 */

afterEach(() => vi.restoreAllMocks());

describe("shared/log 单点出口", () => {
	test("logWarn 经 console.warn 原样输出消息", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		logWarn("[pao] 测试警告");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("[pao] 测试警告");
	});

	test("logError 经 console.error 原样输出消息", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		logError("[pao] 测试错误");
		expect(error).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith("[pao] 测试错误");
	});
});
