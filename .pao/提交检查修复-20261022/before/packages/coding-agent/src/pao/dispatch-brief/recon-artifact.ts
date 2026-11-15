import { readCard } from "../cards/cardfile.ts";
import { saveDispatchBriefArtifact } from "./artifacts.ts";
import { DispatchBriefError } from "./errors.ts";
import type { DispatchBriefRequirements } from "./types.ts";

const RESULT_PREFIX = "<!-- pao-dispatch-result -->";

export const DISPATCH_RECON_CATEGORIES = [
	"facts",
	"unknowns",
	"scope",
	"acceptance",
	"risks",
	"evidence",
	"integration",
] as const;

export type DispatchReconCategory = (typeof DISPATCH_RECON_CATEGORIES)[number];

export interface DispatchBriefSaveInput {
	id: string;
	markdown: string;
	purpose?: string;
	owner?: string;
	requirements?: DispatchBriefRequirements;
}

/**
 * 侦察 worker 的最小保存原语。工具注册层与执行绑定提交层共同依赖这里，
 * 保持依赖单向，避免工具模块和提交模块循环导入。
 */
export async function saveDispatchReconResult(
	input: DispatchBriefSaveInput & {
		cardsDir: string;
		cardPath: string;
		cardNo: number;
		attempt: number;
	},
): Promise<{ ref: string; digest: string }> {
	if (!input.owner?.trim()) {
		throw new DispatchBriefError("card_changed", "保存侦察结论需要真实认领 owner", {});
	}
	const card = readCard(input.cardPath);
	if (
		card.card_no !== input.cardNo ||
		card.frontmatter.attempt !== input.attempt ||
		card.frontmatter.owner !== input.owner ||
		card.frontmatter.status !== "in_progress"
	) {
		throw new DispatchBriefError("card_changed", "保存侦察结论时，卡号、attempt、owner 或 status 与当前认领不一致", {
			path: card.path,
			expected: {
				cardNo: input.cardNo,
				attempt: input.attempt,
				owner: input.owner,
				status: "in_progress",
			},
			actual: {
				cardNo: card.card_no,
				attempt: card.frontmatter.attempt,
				owner: card.frontmatter.owner,
				status: card.frontmatter.status,
			},
		});
	}
	if (!input.markdown.trim()) {
		throw new DispatchBriefError("missing_input", "侦察结论正文不能为空", {});
	}
	if (!input.requirements || input.requirements.kind !== "scout" || input.requirements.sections.length === 0) {
		throw new DispatchBriefError("missing_input", "侦察结论必须按 category 保存至少一个结构化段落", {});
	}
	for (const section of input.requirements.sections) {
		if (!DISPATCH_RECON_CATEGORIES.includes(section.category) || !section.title.trim() || !section.markdown.trim()) {
			throw new DispatchBriefError("missing_input", "侦察结论段落必须包含合法 category、非空标题和正文", {
				section,
			});
		}
	}
	return saveDispatchBriefArtifact({
		cardsDir: input.cardsDir,
		id: `scout-${input.id}`,
		cardPath: input.cardPath,
		cardNo: input.cardNo,
		attempt: input.attempt,
		owner: input.owner,
		purpose: input.purpose ?? "侦察结论",
		markdown: `${RESULT_PREFIX}\n${input.markdown.trim()}`,
		requirements: input.requirements,
	});
}
