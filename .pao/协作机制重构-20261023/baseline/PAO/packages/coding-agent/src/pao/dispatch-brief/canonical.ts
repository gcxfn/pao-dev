import { createHash } from "node:crypto";

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

/**
 * 摘要输入按 JSON 数据模型规范化：对象键递归排序、数组保持原顺序、忽略 undefined 对象值。
 * 文件实际内容直接用 Buffer 摘要，不经过换行或编码转换。
 */
export function canonicalize(value: unknown, path = "$"): CanonicalValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`${path} 含非有限数字，不能计算规范摘要`);
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) => {
			if (item === undefined) throw new TypeError(`${path}[${index}] 是 undefined，不能计算规范摘要`);
			return canonicalize(item, `${path}[${index}]`);
		});
	}
	if (typeof value === "object") {
		const result: Record<string, CanonicalValue> = {};
		for (const key of Object.keys(value).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item === undefined) continue;
			result[key] = canonicalize(item, `${path}.${key}`);
		}
		return result;
	}
	throw new TypeError(`${path} 的类型 ${typeof value} 不能计算规范摘要`);
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function sha256Text(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function sha256Bytes(value: Uint8Array): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestObject(value: unknown): string {
	return sha256Text(canonicalJson(value));
}

export function digestObjectExcluding<T extends object>(value: T, fields: readonly (keyof T)[]): string {
	const copy = { ...value } as Record<string, unknown>;
	for (const field of fields) delete copy[String(field)];
	return digestObject(copy);
}

export function isSha256Digest(value: string | undefined): value is string {
	return value !== undefined && /^sha256:[0-9a-f]{64}$/.test(value);
}
