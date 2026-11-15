import type { CardFrontmatter } from "../cards/types.ts";
import { digestObjectExcluding } from "./canonical.ts";
import { DispatchBriefError } from "./errors.ts";
import type { DispatchCardDefinitionSnapshot } from "./types.ts";

/**
 * 只捕获任务定义，不包含 attempt/owner/status/completed 和正文回执。
 * 数组保留原顺序，因此 inputs 的增删或重排都会产生不同摘要。
 */
export function captureCardDefinition(card: {
	path: string;
	frontmatter: CardFrontmatter;
}): DispatchCardDefinitionSnapshot {
	const frontmatter = card.frontmatter;
	const base = {
		goal: frontmatter.goal,
		dept: frontmatter.dept,
		inputs: [...(frontmatter.inputs ?? [])],
		...(frontmatter.constraints !== undefined ? { constraints: frontmatter.constraints } : {}),
		acceptance: frontmatter.acceptance,
		depends_on: [...(frontmatter.depends_on ?? [])],
		...(frontmatter.parent !== undefined ? { parent: frontmatter.parent } : {}),
		...(frontmatter.tier !== undefined ? { tier: frontmatter.tier } : {}),
		...(frontmatter.budget !== undefined ? { budget: { ...frontmatter.budget } } : {}),
		...(frontmatter.priority !== undefined ? { priority: frontmatter.priority } : {}),
		created: frontmatter.created,
	};
	return {
		...base,
		definitionDigest: digestObjectExcluding(base, []),
	};
}

export function assertCardDefinitionDigest(definition: DispatchCardDefinitionSnapshot, path?: string): void {
	const actual = digestObjectExcluding(definition, ["definitionDigest"]);
	if (actual !== definition.definitionDigest) {
		throw new DispatchBriefError("card_changed", "冻结的卡定义摘要与规范化内容不符", {
			...(path ? { path } : {}),
			expectedDigest: definition.definitionDigest,
			actualDigest: actual,
		});
	}
}
