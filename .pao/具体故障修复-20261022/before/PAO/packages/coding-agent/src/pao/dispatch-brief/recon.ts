import { formatCardNumber, loadCard } from "../cards/cardfile.ts";
import { executionContextPath, resolveExecutionContext } from "../cards/execution-context.ts";
import { withFileLock } from "../shared/lock.ts";
import { saveDispatchReconResult } from "./recon-artifact.ts";
import { saveDispatchReconHandoff } from "./recon-handoff.ts";
import type { DispatchBriefRequirements, DispatchReconCommitInput, DispatchReconCommitResult } from "./types.ts";

export interface CommitDispatchReconInput {
	key: DispatchReconCommitInput["key"];
	owner: string;
	id: string;
	markdown: string;
	purpose?: string;
	requirements: DispatchBriefRequirements;
}

/** 保存侦察输出引用到当前 attempt 的独立交接记录，不改源卡定义或执行输入快照。 */
export async function commitDispatchReconResult(input: CommitDispatchReconInput): Promise<DispatchReconCommitResult> {
	const { cardsDir, cardNo, attempt } = input.key;
	const card = loadCard(cardsDir, cardNo);
	return withFileLock(card.path, async () => {
		const current = loadCard(cardsDir, cardNo);
		if (
			current.frontmatter.attempt !== attempt ||
			current.frontmatter.owner !== input.owner ||
			current.frontmatter.status !== "in_progress"
		) {
			throw new Error(`保存侦察结论失败：${formatCardNumber(cardNo)} 的 attempt、owner 或 status 已变化`);
		}
		const binding = await resolveExecutionContext(input.key, {
			expectedCurrentAttempt: attempt,
		});
		const recon = await saveDispatchReconResult({
			cardsDir,
			cardPath: current.path,
			cardNo,
			attempt,
			owner: input.owner,
			id: input.id,
			markdown: input.markdown,
			...(input.purpose ? { purpose: input.purpose } : {}),
			requirements: input.requirements,
		});
		await saveDispatchReconHandoff({
			cardsDir,
			cardPath: current.path,
			cardNo,
			attempt,
			owner: input.owner,
			bindingRef: executionContextPath(input.key),
			bindingDigest: binding.bindingDigest,
			recon,
		});
		return {
			recon,
			binding: {
				key: input.key,
				owner: input.owner,
				bindingRef: executionContextPath(input.key),
				bindingDigest: binding.bindingDigest,
			},
		};
	});
}
