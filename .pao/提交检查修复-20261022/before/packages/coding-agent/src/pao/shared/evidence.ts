import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const COMPRESSION_THRESHOLD_BYTES = 256 * 1024;
const GZIP_EXTENSIONS = [".live.jsonl.gz", ".live.stderr.log.gz"] as const;
const LIVE_EXTENSIONS = [".live.jsonl", ".live.stderr.log"] as const;

export interface WorkerEvidenceArchiveResult {
	path: string;
	warning?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function warning(stage: string, filePath: string, error: unknown, consequence: string): string {
	return `${stage}失败：${errorMessage(error)}；文件：${filePath}；${consequence}`;
}

function isLiveEvidence(path: string): boolean {
	const name = basename(path).toLowerCase();
	return LIVE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function toGzipPath(path: string): string {
	return `${path}.gz`;
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

/** 判断路径是否为已归档的 worker 证据压缩文件。 */
export function isCompressedWorkerEvidence(path: string): boolean {
	const name = basename(path).toLowerCase();
	return GZIP_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * 解析 worker 证据路径，但不替任意普通文件猜测后缀。
 * 原文件存在时优先返回原路径，让运行中的 live 文件仍可读取；只有原 live 路径确认缺失后才尝试同名 .gz。
 */
export async function resolveWorkerEvidencePath(path: string): Promise<string> {
	try {
		await fsPromises.access(path);
		return path;
	} catch (error) {
		if (!isNodeError(error, "ENOENT") || !isLiveEvidence(path)) throw error;
	}

	const compressedPath = toGzipPath(path);
	await fsPromises.access(compressedPath);
	return compressedPath;
}

/** 读取 worker 证据；已归档的 live gzip 自动解压。 */
export async function readWorkerEvidenceFile(path: string): Promise<Buffer> {
	if (isCompressedWorkerEvidence(path)) {
		return readCompressedWorkerEvidence(path);
	}

	try {
		return await fsPromises.readFile(path);
	} catch (error) {
		if (!isNodeError(error, "ENOENT") || !isLiveEvidence(path)) throw error;
	}
	return readCompressedWorkerEvidence(toGzipPath(path));
}

async function readCompressedWorkerEvidence(path: string): Promise<Buffer> {
	const chunks: Buffer[] = [];
	await pipeline(
		createReadStream(path),
		createGunzip(),
		new Writable({
			write(chunk, _encoding, callback) {
				try {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					callback();
				} catch (error) {
					callback(error instanceof Error ? error : new Error(String(error)));
				}
			},
		}),
	);
	return Buffer.concat(chunks);
}

/**
 * 压缩已结算的 live 证据，不覆盖原文或既有目标。
 * gzip 完整关闭并独占发布后，才移除本次原文。
 */
export async function archiveWorkerEvidence(path: string): Promise<WorkerEvidenceArchiveResult> {
	let fileSize: number;
	try {
		fileSize = (await fsPromises.stat(path)).size;
	} catch (error) {
		return {
			path,
			warning: warning("读取证据文件大小", path, error, "原文未压缩"),
		};
	}
	if (fileSize < COMPRESSION_THRESHOLD_BYTES) return { path };

	const destinationPath = toGzipPath(path);
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let tempCreated = false;
	try {
		const output = createWriteStream(tempPath, { flags: "wx" });
		await once(output, "open");
		tempCreated = true;
		await pipeline(createReadStream(path), createGzip(), output);
	} catch (error) {
		const cleanupWarning = await removeTemporaryFile(tempPath, tempCreated);
		return {
			path,
			warning: `${warning("压缩证据", path, error, "原文保留")}${cleanupWarning}`,
		};
	}

	try {
		await fsPromises.link(tempPath, destinationPath);
	} catch (error) {
		const cleanupWarning = await removeTemporaryFile(tempPath, tempCreated);
		return {
			path,
			warning: `${warning("发布压缩证据", path, error, "原文保留，已有目标未被覆盖")}${cleanupWarning}`,
		};
	}
	let tempCleanupWarning = "";
	try {
		await fsPromises.unlink(tempPath);
	} catch (error) {
		tempCleanupWarning = warning("清理临时压缩文件", tempPath, error, "原文保留，压缩副本可重试发布");
	}

	if (tempCleanupWarning) {
		return { path, warning: tempCleanupWarning };
	}

	try {
		await fsPromises.unlink(path);
	} catch (error) {
		return {
			path: destinationPath,
			warning: warning("删除原文", path, error, `压缩文件有效：${destinationPath}；原文与 .gz 均存在`),
		};
	}
	return { path: destinationPath };
}

async function removeTemporaryFile(path: string, created: boolean): Promise<string> {
	if (!created) return "";
	try {
		await fsPromises.unlink(path);
		return "";
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return "";
		return `；${warning("清理临时压缩文件", path, error, "临时文件可能残留")}`;
	}
}
