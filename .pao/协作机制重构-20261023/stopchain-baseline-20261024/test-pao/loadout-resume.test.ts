/**
 * M1-04 恢复会话时虚拟模型丢失的行为(docs/virtual-models.md 失注册语义):
 * 1) 选择不再成立,回退到最后作答的物理模型(不是 undefined,也不是设置里的底层默认)——pi 原生安全网;
 * 2) pao 侧守卫把这次回退喊出来(结构化警告),不静默绕过档位规则。
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { getBranchSelection, VIRTUAL_MODEL_API } from "../../src/core/virtual-models.ts";
import type { TierConfig } from "../../src/pao/routing/config.ts";
import {
	findLostTierSelections,
	formatLostTierWarning,
	registerTierLossGuard,
} from "../../src/pao/routing/session-guard.ts";

const T = "2026-10-02T00:00:00.000Z";

function branchWithVirtualSelection(): SessionEntry[] {
	return [
		{ type: "model_change", id: "e1", timestamp: T, provider: "pao", modelId: "快" } as SessionEntry,
		{
			type: "message",
			id: "e2",
			timestamp: T,
			message: {
				role: "assistant",
				stopReason: "end",
				provider: "faux",
				model: "m-fast",
				api: "openai-completions",
			},
		} as unknown as SessionEntry,
	];
}

/** 虚拟模型标记对象:isVirtualModel 只认 api === VIRTUAL_MODEL_API */
const fakeSnap = { api: VIRTUAL_MODEL_API, provider: "pao", id: "快", name: "档位:快" };

describe("分支选择恢复(getBranchSelection,pi 原生失注册语义)", () => {
	it("虚拟模型仍在注册表:选择成立(pao/快)", () => {
		const getModel = (provider: string, id: string) =>
			provider === "pao" && id === "快" ? (fakeSnap as never) : undefined;
		expect(getBranchSelection(branchWithVirtualSelection(), getModel)).toEqual({ provider: "pao", modelId: "快" });
	});

	it("虚拟模型已失注册:回退到最后作答的物理模型,不是 undefined、不是设置默认", () => {
		const getModel = () => undefined; // pao/快 已不在注册表
		expect(getBranchSelection(branchWithVirtualSelection(), getModel)).toEqual({
			provider: "faux",
			modelId: "m-fast",
		});
	});
});

describe("pao 档位失注册守卫(把回退喊出来,不静默)", () => {
	const config: TierConfig = {
		provider: "pao",
		档位: [{ 名: "主力", provider: "zai-coding-cn", model: "glm-5.3", thinkingLevel: "high" }],
	};

	it("扫出指向已失效档位的 model_change(去重)", () => {
		const branch: SessionEntry[] = [
			{ type: "model_change", id: "e1", timestamp: T, provider: "pao", modelId: "快" } as SessionEntry,
			{ type: "model_change", id: "e2", timestamp: T, provider: "pao", modelId: "快" } as SessionEntry,
			{ type: "model_change", id: "e3", timestamp: T, provider: "pao", modelId: "主力" } as SessionEntry,
			{ type: "model_change", id: "e4", timestamp: T, provider: "faux", modelId: "m-fast" } as SessionEntry,
		];
		expect(findLostTierSelections(branch, config)).toEqual([{ provider: "pao", modelId: "快" }]);
	});

	it("全部档位仍存在:无失注册", () => {
		const branch: SessionEntry[] = [
			{ type: "model_change", id: "e1", timestamp: T, provider: "pao", modelId: "主力" } as SessionEntry,
		];
		expect(findLostTierSelections(branch, config)).toEqual([]);
	});

	it("session_start 时发结构化警告(含失效档位名与现有档位);无失注册不吵", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			const pi = {
				on: (event: string, handler: (event: unknown, ctx: unknown) => void) => void handlers.set(event, handler),
			};
			registerTierLossGuard(pi as never, config);

			const lostBranch = branchWithVirtualSelection();
			handlers.get("session_start")!(undefined, { sessionManager: { getBranch: () => lostBranch } } as never);
			expect(warn).toHaveBeenCalledTimes(1);
			const text = warn.mock.calls[0]?.[0] as string;
			expect(text).toContain("档位「快」");
			expect(text).toContain("主力");
			expect(text).toContain("/model");

			warn.mockClear();
			handlers.get("session_start")!(undefined, { sessionManager: { getBranch: () => [] } } as never);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("警告文案说明回退性质与恢复动作", () => {
		const text = formatLostTierWarning([{ modelId: "快" }], config);
		expect(text).toContain("物理模型");
		expect(text).toContain("pao配置/档位.json");
		expect(text).toContain("/model");
	});
});
