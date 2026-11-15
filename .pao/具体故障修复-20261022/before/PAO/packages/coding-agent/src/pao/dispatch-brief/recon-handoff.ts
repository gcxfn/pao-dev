import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { executionContextPath } from "../cards/execution-context.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { dispatchArtifactsRoot, loadDispatchBriefArtifact } from "./artifacts.ts";
import { digestObjectExcluding } from "./canonical.ts";
import { DispatchBriefError, errorMessage } from "./errors.ts";
import type { DispatchArtifactReference } from "./types.ts";

export interface DispatchReconHandoff {
	schemaVersion: 1;
	kind: "dispatch-recon-handoff";
	cardsDir: string;
	cardPath: string;
	cardNo: number;
	attempt: number;
	owner: string;
	bindingRef: string;
	bindingDigest: string;
	outputs: DispatchArtifactReference[];
	recordDigest: string;
}

export interface AttemptReconOutputs {
	key: { cardsDir: string; cardNo: number; attempt: number };
	owner: string;
	bindingRef: string;
	bindingDigest: string;
	outputs: DispatchArtifactReference[];
	handoffRef: string;
}

export function dispatchReconHandoffPath(cardsDir: string, cardNo: number, attempt: number): string {
	if (!Number.isInteger(cardNo) || cardNo < 1 || !Number.isInteger(attempt) || attempt < 1) {
		throw new DispatchBriefError("bad_reference", "侦察交接记录的卡号和尝试号必须为正整数", {
			cardNo,
			attempt,
		});
	}
	return join(
		dispatchArtifactsRoot({ cardsDir }),
		"recon-handoffs",
		`card-${String(cardNo).padStart(4, "0")}-attempt-${attempt}.json`,
	);
}

export async function saveDispatchReconHandoff(input: {
	cardsDir: string;
	cardPath: string;
	cardNo: number;
	attempt: number;
	owner: string;
	bindingRef: string;
	bindingDigest: string;
	recon: DispatchArtifactReference;
}): Promise<DispatchReconHandoff> {
	const cardsDir = realpathSync(input.cardsDir);
	const cardPath = realpathSync(input.cardPath);
	const artifact = loadDispatchBriefArtifact(input.recon.ref, { cardsDir });
	if (
		artifact.requirements?.kind !== "scout" ||
		artifact.cardNo !== input.cardNo ||
		artifact.attempt !== input.attempt ||
		artifact.owner !== input.owner ||
		realpathSync(artifact.cardPath) !== cardPath
	) {
		throw new DispatchBriefError("bad_reference", "侦察交接记录引用的产物不属于当前卡、attempt 与 owner", {
			ref: input.recon.ref,
			path: cardPath,
		});
	}
	const path = dispatchReconHandoffPath(cardsDir, input.cardNo, input.attempt);
	mkdirSync(dirname(path), { recursive: true });
	return withFileLock(path, () => {
		if (existsSync(path)) {
			const existing = loadDispatchReconHandoff(cardsDir, input.cardNo, input.attempt);
			if (!existing) throw new DispatchBriefError("bad_reference", "侦察交接记录读取失败", { path });
			if (
				existing.owner !== input.owner ||
				existing.bindingRef !== input.bindingRef ||
				existing.bindingDigest !== input.bindingDigest ||
				existing.cardPath !== cardPath
			) {
				throw new DispatchBriefError("execution_binding_invalid", "同一 attempt 的侦察交接记录执行身份已变化", {
					path,
				});
			}
			if (existing.outputs.some((output) => output.ref === input.recon.ref)) return existing;
			const conflicting = existing.outputs.find(
				(output) => output.ref.split("?")[0] === input.recon.ref.split("?")[0],
			);
			if (conflicting) {
				throw new DispatchBriefError("artifact_conflict", "同一侦察产物 ID 已关联不同摘要", {
					path,
					ref: input.recon.ref,
				});
			}
			const outputs = [...existing.outputs, input.recon];
			const base = {
				...existing,
				outputs,
			};
			const { recordDigest: _recordDigest, ...content } = base;
			const record: DispatchReconHandoff = {
				...content,
				recordDigest: digestObjectExcluding(content, []),
			};
			writeFileAtomic(path, `${JSON.stringify(record, null, "\t")}\n`);
			return record;
		}
		const content = {
			schemaVersion: 1 as const,
			kind: "dispatch-recon-handoff" as const,
			cardsDir,
			cardPath,
			cardNo: input.cardNo,
			attempt: input.attempt,
			owner: input.owner,
			bindingRef: input.bindingRef,
			bindingDigest: input.bindingDigest,
			outputs: [input.recon],
		};
		const record: DispatchReconHandoff = {
			...content,
			recordDigest: digestObjectExcluding(content, []),
		};
		writeFileAtomic(path, `${JSON.stringify(record, null, "\t")}\n`);
		return record;
	});
}

export function loadDispatchReconHandoff(
	cardsDir: string,
	cardNo: number,
	attempt: number,
): DispatchReconHandoff | undefined {
	const normalizedCardsDir = resolve(cardsDir);
	const path = dispatchReconHandoffPath(normalizedCardsDir, cardNo, attempt);
	if (!existsSync(path)) return undefined;
	let record: DispatchReconHandoff;
	try {
		record = JSON.parse(readFileSync(path, "utf8")) as DispatchReconHandoff;
	} catch (error) {
		throw new DispatchBriefError("bad_reference", `侦察交接记录不是合法 JSON：${path}`, {
			path,
			cause: errorMessage(error),
		});
	}
	if (
		record.schemaVersion !== 1 ||
		record.kind !== "dispatch-recon-handoff" ||
		record.cardNo !== cardNo ||
		record.attempt !== attempt
	) {
		throw new DispatchBriefError("bad_reference", "侦察交接记录身份不符", { path });
	}
	const actual = digestObjectExcluding(record, ["recordDigest"]);
	if (actual !== record.recordDigest) {
		throw new DispatchBriefError("bad_reference", "侦察交接记录摘要不符", { path });
	}
	for (const output of record.outputs) {
		const artifact = loadDispatchBriefArtifact(output.ref, { cardsDir: normalizedCardsDir });
		if (
			artifact.artifactDigest !== output.digest ||
			artifact.requirements?.kind !== "scout" ||
			artifact.cardNo !== cardNo ||
			artifact.attempt !== attempt
		) {
			throw new DispatchBriefError("bad_reference", "侦察交接记录中的产物身份或摘要不符", {
				path,
				ref: output.ref,
			});
		}
	}
	return record;
}

/** dispatch-core 的只读入口：只返回当前 attempt 已封装、身份一致的侦察输出。 */
export function resolveAttemptReconRefs(input: {
	cardsDir: string;
	cardNo: number;
	attempt: number;
}): DispatchArtifactReference[] {
	const handoff = loadDispatchReconHandoff(input.cardsDir, input.cardNo, input.attempt);
	return handoff ? handoff.outputs.map((output) => ({ ...output })) : [];
}

export function readAttemptReconHandoff(input: {
	cardsDir: string;
	cardNo: number;
	attempt: number;
}): AttemptReconOutputs | undefined {
	const handoff = loadDispatchReconHandoff(input.cardsDir, input.cardNo, input.attempt);
	if (!handoff) return undefined;
	return {
		key: {
			cardsDir: handoff.cardsDir,
			cardNo: handoff.cardNo,
			attempt: handoff.attempt,
		},
		owner: handoff.owner,
		bindingRef: handoff.bindingRef,
		bindingDigest: handoff.bindingDigest,
		outputs: handoff.outputs.map((output) => ({ ...output })),
		handoffRef: dispatchReconHandoffPath(handoff.cardsDir, handoff.cardNo, handoff.attempt),
	};
}

/**
 * 只返回与当前 execution-context 精确关联的侦察输出。
 * 无交接记录返回空；记录存在但绑定引用或摘要不一致时明确失败。
 */
export function resolveCurrentAttemptReconRefs(input: {
	cardsDir: string;
	cardNo: number;
	attempt: number;
	executionBindingDigest: string;
	executionBindingRef?: string;
	requireHandoff?: boolean;
}): DispatchArtifactReference[] {
	const handoff = readAttemptReconHandoff(input);
	if (!handoff) {
		if (input.requireHandoff) {
			throw new DispatchBriefError("missing_input", "当前 attempt 缺少侦察交接记录，不能使用旧卡 inputs 代替", {
				cardNo: input.cardNo,
				attempt: input.attempt,
			});
		}
		return [];
	}
	const expectedBindingRef = executionContextPath({
		cardsDir: input.cardsDir,
		cardNo: input.cardNo,
		attempt: input.attempt,
	});
	const normalize = (value: string) => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value));
	if (
		handoff.bindingDigest !== input.executionBindingDigest ||
		(input.executionBindingRef !== undefined &&
			normalize(handoff.bindingRef) !== normalize(input.executionBindingRef)) ||
		normalize(handoff.bindingRef) !== normalize(expectedBindingRef)
	) {
		throw new DispatchBriefError("execution_binding_invalid", "侦察交接记录的执行绑定与当前 attempt 不一致", {
			path: handoff.handoffRef,
			expectedDigest: input.executionBindingDigest,
			actualDigest: handoff.bindingDigest,
		});
	}
	return handoff.outputs.map((output) => ({ ...output }));
}
