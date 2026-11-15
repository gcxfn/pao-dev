import type { DispatchPreflightIssue } from "./types.ts";

export type DispatchBriefErrorCode =
	| "missing_input"
	| "bad_reference"
	| "stale_map"
	| "contract_changed"
	| "execution_binding_invalid"
	| "snapshot_digest_mismatch"
	| "card_changed"
	| "artifact_conflict"
	| "unsafe_path";

export class DispatchBriefError extends Error {
	readonly code: DispatchBriefErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: DispatchBriefErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "DispatchBriefError";
		this.code = code;
		this.details = details;
	}
}

export function issueFromError(error: unknown): DispatchPreflightIssue {
	if (error instanceof DispatchBriefError) {
		const ref = typeof error.details.ref === "string" ? error.details.ref : undefined;
		const path = typeof error.details.path === "string" ? error.details.path : undefined;
		const field = typeof error.details.field === "string" ? error.details.field : undefined;
		const expectedDigest =
			typeof error.details.expectedDigest === "string" ? error.details.expectedDigest : undefined;
		const actualDigest = typeof error.details.actualDigest === "string" ? error.details.actualDigest : undefined;
		return {
			code: error.code === "artifact_conflict" || error.code === "unsafe_path" ? "bad_reference" : error.code,
			message: error.message,
			...(ref ? { ref } : {}),
			...(path ? { path } : {}),
			...(field ? { field } : {}),
			...(expectedDigest ? { expectedDigest } : {}),
			...(actualDigest ? { actualDigest } : {}),
		};
	}
	return {
		code: "bad_reference",
		message: error instanceof Error ? error.message : String(error),
	};
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
