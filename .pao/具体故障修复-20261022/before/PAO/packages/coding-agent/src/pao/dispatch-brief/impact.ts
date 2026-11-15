import { existsSync } from "node:fs";
import { loadCard, scanCards } from "../cards/cardfile.ts";
import { parseCardRef } from "../cards/counter.ts";
import type { ParsedCard } from "../cards/types.ts";
import { loadDispatchBriefArtifact } from "./artifacts.ts";
import { DispatchBriefError, errorMessage } from "./errors.ts";
import { dispatchInputSnapshotPath, loadDispatchInputSnapshot } from "./snapshot.ts";
import type { DispatchInputSnapshot, DispatchReferenceImpact } from "./types.ts";
import { isDispatchUri, parseDispatchUri } from "./uri.ts";

interface SourceReference {
	ref: string;
	source: "card-inputs" | "attempt-snapshot" | "dependency-snapshot" | "brief-identity";
	attempt?: number;
	dependencyCardNo?: number;
}

function loadExistingSnapshot(
	cardsDir: string,
	cardNo: number,
	attempt: number,
): DispatchInputSnapshot | undefined {
	if (attempt < 1) return undefined;
	const path = dispatchInputSnapshotPath(cardsDir, cardNo, attempt);
	if (!existsSync(path)) return undefined;
	try {
		return loadDispatchInputSnapshot(path);
	} catch (error) {
		throw new DispatchBriefError(
			"bad_reference",
			`不能判定输入升版影响：尝试快照不可核验：${path}`,
			{ path, cause: errorMessage(error) },
		);
	}
}

function snapshotRefs(
	snapshot: DispatchInputSnapshot,
	source: SourceReference["source"],
	dependencyCardNo?: number,
): SourceReference[] {
	return [
		...(snapshot.map ? [{ ref: snapshot.map.ref, source, attempt: snapshot.card.attempt, dependencyCardNo }] : []),
		...snapshot.contracts.map((contract) => ({
			ref: contract.ref,
			source,
			attempt: snapshot.card.attempt,
			dependencyCardNo,
		})),
		...snapshot.evidence.map((entry) => ({
			ref: entry.ref,
			source,
			attempt: snapshot.card.attempt,
			dependencyCardNo,
		})),
		...(snapshot.cardDefinition?.inputs ?? []).map((ref) => ({
			ref,
			source,
			attempt: snapshot.card.attempt,
			dependencyCardNo,
		})),
	]
		.filter((entry) => isDispatchUri(entry.ref))
		.map((entry) => ({
			ref: parseDispatchUri(entry.ref).canonical,
			source: entry.source,
			attempt: entry.attempt,
			...(entry.dependencyCardNo !== undefined ? { dependencyCardNo: entry.dependencyCardNo } : {}),
		}));
}

function loadSourceCards(cardsDir: string): ParsedCard[] {
	const scan = scanCards(cardsDir);
	if (scan.problems.length > 0) {
		throw new DispatchBriefError(
			"bad_reference",
			`卡目录含无法核验的卡，不能判定升版影响：${scan.problems.map((item) => item.path).join("、")}`,
			{ problems: scan.problems },
		);
	}
	return scan.cards;
}

function directCardRefs(card: ParsedCard): SourceReference[] {
	return (card.frontmatter.inputs ?? [])
		.filter(isDispatchUri)
		.map((ref) => ({ ref: parseDispatchUri(ref).canonical, source: "card-inputs" as const }));
}

function dependencyRefs(cardsDir: string, card: ParsedCard, cardsByNo: Map<number, ParsedCard>): SourceReference[] {
	const refs: SourceReference[] = [];
	for (const value of card.frontmatter.depends_on ?? []) {
		let cardNo: number;
		try {
			cardNo = parseCardRef(value);
		} catch {
			// 不可解析的依赖由 prepare 的依赖门明确失败；这里不猜它的引用语义。
			continue;
		}
		const dependency = cardsByNo.get(cardNo) ?? (() => {
			try {
				return loadCard(cardsDir, cardNo);
			} catch {
				return undefined;
			}
		})();
		if (!dependency) continue;
		const snapshot = loadExistingSnapshot(cardsDir, dependency.card_no, dependency.frontmatter.attempt);
		if (!snapshot) continue;
		refs.push(...snapshotRefs(snapshot, "dependency-snapshot", dependency.card_no));
	}
	return refs;
}

function briefIdentityRefs(
	cardsDir: string,
	ref: string,
): SourceReference[] {
	const artifact = loadDispatchBriefArtifact(ref, { cardsDir });
	const snapshot = loadExistingSnapshot(cardsDir, artifact.cardNo, artifact.attempt);
	if (!snapshot) return [];
	// 简报身份来源属于该简报卡自己的 attempt，不能拿消费卡当前 attempt 判断。
	return snapshotRefs(snapshot, "brief-identity");
}

function sourceIdentity(
	cardsDir: string,
	entry: SourceReference,
): { cardNo: number; attempt?: number } | undefined {
	if (entry.source === "dependency-snapshot") {
		return entry.dependencyCardNo === undefined
			? undefined
			: { cardNo: entry.dependencyCardNo, attempt: entry.attempt };
	}
	if (entry.source !== "brief-identity") return undefined;
	try {
		const artifact = loadDispatchBriefArtifact(entry.ref, { cardsDir });
		return { cardNo: artifact.cardNo, attempt: artifact.attempt };
	} catch {
		return undefined;
	}
}

function expandTransitiveRefs(
	cardsDir: string,
	initial: SourceReference[],
): SourceReference[] {
	const expanded = [...initial];
	const seen = new Set(expanded.map((entry) => `${entry.source}:${entry.ref}`));
	for (let index = 0; index < expanded.length; index++) {
		const entry = expanded[index];
		if (!entry.ref.startsWith("pao-brief://")) continue;
		for (const nested of briefIdentityRefs(cardsDir, entry.ref)) {
			const key = `${nested.source}:${nested.ref}`;
			if (seen.has(key)) continue;
			seen.add(key);
			expanded.push(nested);
		}
	}
	return expanded;
}

/** 只扫描项目自己的卡目录；不遍历代码库，也不建立后台索引。 */
export function findDispatchReferenceImpact(input: {
	cardsDir: string;
	ref: string;
	previousRef?: string;
	reason?: string;
}): DispatchReferenceImpact {
	const refs = [input.ref, input.previousRef]
		.filter((value): value is string => Boolean(value))
		.map((value) => parseDispatchUri(value).canonical);
	const cards = loadSourceCards(input.cardsDir);
	const cardsByNo = new Map(cards.map((card) => [card.card_no, card]));
	const affected: DispatchReferenceImpact["affected"] = [];
	const ignored: number[] = [];
	for (const card of cards) {
		const direct = directCardRefs(card);
		const currentSnapshot = loadExistingSnapshot(input.cardsDir, card.card_no, card.frontmatter.attempt);
		const snapshot = currentSnapshot ? snapshotRefs(currentSnapshot, "attempt-snapshot") : [];
		const dependencies = dependencyRefs(input.cardsDir, card, cardsByNo);
		const allRefs = expandTransitiveRefs(
			input.cardsDir,
			[...direct, ...snapshot, ...dependencies],
		);
		const matches = allRefs.filter((entry) => refs.includes(entry.ref));
		if (matches.length === 0) {
			ignored.push(card.card_no);
			continue;
		}
		const matched = matches.find((entry) => {
			const identity = sourceIdentity(input.cardsDir, entry);
			return identity?.cardNo !== card.card_no || identity.attempt === card.frontmatter.attempt;
		}) ?? matches[0];
		if (card.frontmatter.status === "delivered" || card.frontmatter.status === "canceled") {
			ignored.push(card.card_no);
			continue;
		}
		const sourceLabel = {
			"card-inputs": "卡 inputs",
			"attempt-snapshot": "当前尝试快照",
			"dependency-snapshot": "前置卡当前尝试快照",
			"brief-identity": "上游简报身份",
		}[matched.source];
		affected.push({
			cardNo: card.card_no,
			cardPath: card.path,
			status: card.frontmatter.status,
			attempt: card.frontmatter.attempt,
			...(card.frontmatter.owner ? { owner: card.frontmatter.owner } : {}),
			matchedRef: matched.ref,
			action: "checkpoint",
			message:
				`dispatch 输入已升版：${input.previousRef ?? "旧来源"} → ${input.ref}` +
				`${input.reason ? `；原因：${input.reason}` : ""}。` +
				`命中来源：${sourceLabel}。当前任务须回到复核点，旧 attempt 的输入与证据保留；复核后再开新尝试。`,
		});
	}
	return {
		ref: input.ref,
		...(input.previousRef ? { previousRef: input.previousRef } : {}),
		...(input.reason ? { reason: input.reason } : {}),
		affected,
		ignored: [...new Set(ignored)].sort((left, right) => left - right),
	};
}

export function formatDispatchReferenceImpact(impact: DispatchReferenceImpact): string | undefined {
	if (impact.affected.length === 0) return undefined;
	return [
		`[dispatch 输入升版复核] ${impact.previousRef ?? "旧来源"} → ${impact.ref}`,
		impact.reason ? `原因：${impact.reason}` : undefined,
		...impact.affected.map(
			(card) =>
				`- 卡${String(card.cardNo).padStart(4, "0")}（${card.status}，attempt ${card.attempt}）：${card.message}`,
		),
		"旧输入、旧快照和旧证据均保留；无关任务不受影响。",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}
