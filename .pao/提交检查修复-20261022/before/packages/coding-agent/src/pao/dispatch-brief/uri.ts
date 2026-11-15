import { posix, win32 } from "node:path";
import { isSha256Digest } from "./canonical.ts";
import { DispatchBriefError } from "./errors.ts";
import type {
	DispatchArtifactReference,
	DispatchBriefUriScheme,
	DispatchContractBinding,
	DispatchMapReference,
	DispatchMapStatus,
} from "./types.ts";

export interface ParsedDispatchUri {
	scheme: DispatchBriefUriScheme;
	id: string;
	digest: string;
	version?: string;
	status?: DispatchMapStatus;
	canonical: string;
}

const URIS = new Set<DispatchBriefUriScheme>(["pao-brief", "pao-map", "pao-contract"]);

export function isDispatchUri(value: string): boolean {
	return /^(?:pao-brief|pao-map|pao-contract):\/\//.test(value.trim());
}

export function parseDispatchUri(value: string): ParsedDispatchUri {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new DispatchBriefError("bad_reference", `受控引用格式错误：${value}`, {
			ref: value,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	const scheme = url.protocol.slice(0, -1) as DispatchBriefUriScheme;
	if (!URIS.has(scheme) || !url.hostname) {
		throw new DispatchBriefError("bad_reference", `不支持的 dispatch 引用：${value}`, { ref: value });
	}
	if (url.username || url.password || url.port || (url.pathname && url.pathname !== "/")) {
		throw new DispatchBriefError("bad_reference", `dispatch 引用只能使用固定 ID 和查询参数：${value}`, {
			ref: value,
		});
	}
	const digest = url.searchParams.get("digest");
	if (!isSha256Digest(digest ?? undefined)) {
		throw new DispatchBriefError("bad_reference", `dispatch 引用缺少合法 sha256 摘要：${value}`, { ref: value });
	}
	const version = url.searchParams.get("version") ?? undefined;
	if (scheme === "pao-contract" && !version) {
		throw new DispatchBriefError("bad_reference", `契约引用缺少 version：${value}`, { ref: value });
	}
	const rawStatus = url.searchParams.get("status") ?? undefined;
	const status =
		scheme === "pao-map" && (rawStatus === "valid" || rawStatus === "stale" || rawStatus === "unknown")
			? rawStatus
			: undefined;
	if (scheme === "pao-map" && rawStatus !== undefined && status === undefined) {
		throw new DispatchBriefError("bad_reference", `地图状态非法：${rawStatus}`, { ref: value });
	}
	return {
		scheme,
		id: decodeURIComponent(url.hostname),
		digest: digest!,
		...(version ? { version } : {}),
		...(status ? { status } : {}),
		canonical: normalizeDispatchUri(value),
	};
}

export function briefUri(id: string, digest: string): string {
	assertToken(id, "简报 ID");
	if (!isSha256Digest(digest)) throw new DispatchBriefError("bad_reference", "简报摘要格式错误", { digest });
	return `pao-brief://${encodeURIComponent(id)}?digest=${encodeURIComponent(digest)}`;
}

export function mapUri(id: string, digest: string, status: DispatchMapStatus): string {
	assertToken(id, "地图 ID");
	if (!isSha256Digest(digest)) throw new DispatchBriefError("bad_reference", "地图摘要格式错误", { digest });
	return `pao-map://${encodeURIComponent(id)}?digest=${encodeURIComponent(digest)}&status=${status}`;
}

export function contractUri(id: string, version: string, digest: string): string {
	assertToken(id, "契约 ID");
	if (!version.trim()) throw new DispatchBriefError("bad_reference", "契约 version 不能为空", { version });
	if (!isSha256Digest(digest)) throw new DispatchBriefError("bad_reference", "契约摘要格式错误", { digest });
	return `pao-contract://${encodeURIComponent(id)}?version=${encodeURIComponent(version)}&digest=${encodeURIComponent(digest)}`;
}

export function normalizeDispatchUri(value: string): string {
	const parsed = parseDispatchUriInner(value);
	if (parsed.scheme === "pao-brief") return briefUri(parsed.id, parsed.digest);
	if (parsed.scheme === "pao-map") return mapUri(parsed.id, parsed.digest, parsed.status ?? "unknown");
	return contractUri(parsed.id, parsed.version ?? "", parsed.digest);
}

function parseDispatchUriInner(value: string): ParsedDispatchUri {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new DispatchBriefError("bad_reference", `受控引用格式错误：${value}`, { ref: value });
	}
	const scheme = url.protocol.slice(0, -1) as DispatchBriefUriScheme;
	if (!URIS.has(scheme) || !url.hostname) {
		throw new DispatchBriefError("bad_reference", `不支持的 dispatch 引用：${value}`, { ref: value });
	}
	const digest = url.searchParams.get("digest") ?? "";
	const version = url.searchParams.get("version") ?? "";
	const rawStatus = url.searchParams.get("status");
	const status = rawStatus === "valid" || rawStatus === "stale" || rawStatus === "unknown" ? rawStatus : undefined;
	return { scheme, id: decodeURIComponent(url.hostname), digest, version, status, canonical: value };
}

function assertToken(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		throw new DispatchBriefError("bad_reference", `${label} 只能包含字母、数字、点、下划线和短横线：${value}`, {
			id: value,
		});
	}
}

export function toArtifactReference(uri: string): DispatchArtifactReference {
	const parsed = parseDispatchUri(uri);
	if (parsed.scheme !== "pao-brief") {
		throw new DispatchBriefError("bad_reference", `不是简报引用：${uri}`, { ref: uri });
	}
	return { ref: parsed.canonical, digest: parsed.digest };
}

export function toMapReference(
	uri: string,
	coverage: DispatchMapReference["coverage"],
	scopeBasis: string[] | undefined,
	scopeReviewRequired: boolean,
	previousRef?: string,
	supersessionReason?: string,
): DispatchMapReference {
	const parsed = parseDispatchUri(uri);
	if (parsed.scheme !== "pao-map") throw new DispatchBriefError("bad_reference", `不是地图引用：${uri}`, { ref: uri });
	return {
		ref: parsed.canonical,
		digest: parsed.digest,
		status: parsed.status ?? "unknown",
		coverage,
		...(scopeBasis?.length ? { scopeBasis: [...scopeBasis] } : {}),
		scopeReviewRequired,
		...(previousRef ? { previousRef } : {}),
		...(supersessionReason ? { supersessionReason } : {}),
	};
}

export function toContractBinding(uri: string): DispatchContractBinding {
	const parsed = parseDispatchUri(uri);
	if (parsed.scheme !== "pao-contract") {
		throw new DispatchBriefError("bad_reference", `不是契约引用：${uri}`, { ref: uri });
	}
	return {
		ref: parsed.canonical,
		id: parsed.id,
		version: parsed.version ?? "",
		digest: parsed.digest,
	};
}

export function isSafeArtifactId(value: string): boolean {
	return (
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
		!value.includes("..") &&
		!posix.isAbsolute(value) &&
		!win32.isAbsolute(value)
	);
}
