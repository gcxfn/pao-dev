/**
 * 计量口径三分（计划 §8.2）：每个数字必须标明自己属于哪种口径，绝不混着算。
 *
 * - **Token**（`token`）：从原生日志数出来的 token 数。它是"数出来的"，不是估的。
 * - **已知费用**（`knownCost`）：供应商/模型目录真实回了单价或真实扣费，可以直接报。
 * - **未知**（`unknown`）：拿不到依据（没配价格、接口没回 usage、该轮缺账）。
 *   未知**必须**如实说未知，绝不能显示成 $0 或"免费"——这是本批硬红线。
 * - **估计**（`estimated`）：有依据但不精确（例如只有 token 数、按目录单价折算）。
 *   估计必须带依据说明，不得当成准确费用报。
 *
 * 为什么单独一个文件：口径是跨模块契约（预算门禁、用量汇总、界面显示都要用同一份），
 * 散在各自模块里就会各自发明一套字符串，最后没人说得清"$0"到底是免费还是不知道。
 */

/** 一条数字的口径。 */
export type UsageBasis = "token" | "knownCost" | "unknown" | "estimated";

/** 中文展示名（界面/文案统一用这一份，不要在别处再写一遍映射）。 */
export const USAGE_BASIS_LABEL: Readonly<Record<UsageBasis, string>> = {
	token: "Token",
	knownCost: "已知费用",
	unknown: "未知",
	estimated: "估计",
};

/**
 * 一条带口径的数量。`value` 只在已知/估计时有意义；
 * `unknown` 口径下 value 恒为 undefined（不是 0——0 会被当成"免费"）。
 */
export interface MeteredAmount {
	readonly basis: UsageBasis;
	/** 数值；`unknown` 口径下必须为 undefined。 */
	readonly value?: number;
	/** 为什么是这个口径（未知/估计必须有；已知/token 可选）。 */
	readonly note?: string;
}

/** Token 数（数出来的）。 */
export function tokenAmount(value: number, note?: string): MeteredAmount {
	return { basis: "token", value, ...(note ? { note } : {}) };
}

/** 已知费用（真实单价/真实扣费）。 */
export function knownCostAmount(value: number, note?: string): MeteredAmount {
	return { basis: "knownCost", value, ...(note ? { note } : {}) };
}

/** 估计费用（有依据但不精确，note 必填说明依据）。 */
export function estimatedCostAmount(value: number, note: string): MeteredAmount {
	return { basis: "estimated", value, note };
}

/** 未知（拿不到依据）。note 必填：说清"为什么不知道"。 */
export function unknownAmount(note: string): MeteredAmount {
	return { basis: "unknown", note };
}

/** 这个口径是否可用于"已经花了多少钱"的断言。未知与估计都不能当准确费用用。 */
export function isExactCost(amount: MeteredAmount): boolean {
	return amount.basis === "knownCost";
}

/**
 * 费用文案：**唯一的费用渲染入口**。
 *
 * 红线：`unknown` 一律渲染成"未知"＋原因，**绝不出现 $0 / 免费**；
 * `estimated` 带"约"与前缀说明，不当准确值；只有 `knownCost` 才给出 $ 数字。
 * 返回值里永远不出现裸的 "$0"（当已知费用恰好是 0 时写成"已知 $0.00（供应商回 0）"，
 * 让读的人知道这是"确实不收钱"而不是"不知道"）。
 */
export function formatMeteredCost(amount: MeteredAmount): string {
	switch (amount.basis) {
		case "knownCost": {
			const value = amount.value ?? 0;
			// 已知 0 与未知 0 必须长得不一样：这里明确说"已知"，且补 note 说明来源。
			const text = value === 0 ? "已知 0（供应商回 0）" : `$${formatUsd(value)}`;
			return amount.note ? `${text}（${amount.note}）` : text;
		}
		case "estimated": {
			const value = amount.value ?? 0;
			return `约 $${formatUsd(value)}（估计：${amount.note ?? "依据未说明"}）`;
		}
		case "unknown":
			return `未知（${amount.note ?? "未给依据"}）`;
		case "token":
			return `${amount.value ?? 0} token（token 数不等于费用）`;
	}
}

/** 美元数字格式：两位小数；极小非零值加精度，避免显示成 0.00 被误读为零。 */
export function formatUsd(value: number): string {
	const text = value.toFixed(2);
	if (text !== "0.00") return text;
	return value > 0 ? value.toFixed(4) : "0.00";
}

/** 口径 + 说明 → 一行"这是哪类数字"的标注（界面上跟在数字后面的那截）。 */
export function describeBasis(amount: MeteredAmount): string {
	return amount.note ? `${USAGE_BASIS_LABEL[amount.basis]}：${amount.note}` : USAGE_BASIS_LABEL[amount.basis];
}

/**
 * 把一堆同口径的金额合并。规则（保守优先，绝不把未知洗成已知）：
 * - 任一为 `unknown` → 合计为 `unknown`（说清几项未知）；
 * - 否则任一为 `estimated` → 合计为 `estimated`（说清有几项是估的）；
 * - 否则 → `knownCost`。
 */
export function sumMeteredCosts(amounts: readonly MeteredAmount[]): MeteredAmount {
	const unknownCount = amounts.filter((item) => item.basis === "unknown").length;
	const estimatedCount = amounts.filter((item) => item.basis === "estimated").length;
	if (unknownCount > 0) {
		return unknownAmount(`${unknownCount} 项费用拿不到依据，合计只能报未知`);
	}
	const total = amounts.reduce((sum, item) => sum + (item.value ?? 0), 0);
	if (estimatedCount > 0) {
		return estimatedCostAmount(total, `${estimatedCount} 项为按目录单价折算的估计值，非真实扣费`);
	}
	return knownCostAmount(total);
}
