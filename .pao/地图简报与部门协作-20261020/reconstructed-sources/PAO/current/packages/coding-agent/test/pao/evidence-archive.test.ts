import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	archiveWorkerEvidence,
	isCompressedWorkerEvidence,
	readWorkerEvidenceFile,
	resolveWorkerEvidencePath,
} from "../../src/pao/shared/evidence.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		access: vi.fn(original.access),
		link: vi.fn(original.link),
		unlink: vi.fn(original.unlink),
	};
});

vi.mock("node:crypto", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:crypto")>();
	return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

const fixtureRoots: string[] = [];
const fixtureBase = join("D:", "AI", "workspace", "临时文件夹", "日志压缩验收-20261020");

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function resetMockCalls(): void {
	vi.mocked(fsPromises.access).mockClear();
	vi.mocked(fsPromises.link).mockClear();
	vi.mocked(fsPromises.unlink).mockClear();
	vi.mocked(randomUUID).mockClear();
}

function fixtureDir(): string {
	mkdirSync(fixtureBase, { recursive: true });
	const dir = mkdtempSync(join(fixtureBase, "case-"));
	fixtureRoots.push(dir);
	return dir;
}

function bytesAtLeast(threshold: number): Buffer {
	const bytes = Buffer.alloc(threshold);
	for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
	return bytes;
}

function writeLiveFile(root: string, name: string, bytes: Buffer): string {
	const path = join(root, name);
	writeFileSync(path, bytes);
	return path;
}

describe("worker 证据归档", () => {
	it("compresses a threshold-sized live JSONL and reads identical bytes", async () => {
		const root = fixtureDir();
		const original = writeLiveFile(root, "卡0001.live.jsonl", bytesAtLeast(256 * 1024));
		const archive = await archiveWorkerEvidence(original);
		const compressed = `${original}.gz`;

		expect(archive).toEqual({ path: compressed });
		expect(existsSync(original)).toBe(false);
		expect(isCompressedWorkerEvidence(compressed)).toBe(true);
		expect(await readWorkerEvidenceFile(original)).toEqual(bytesAtLeast(256 * 1024));
		expect(await readWorkerEvidenceFile(compressed)).toEqual(bytesAtLeast(256 * 1024));
	});

	it("compresses threshold-sized live stderr bytes without changing content", async () => {
		const root = fixtureDir();
		const original = writeLiveFile(root, "卡0002.live.stderr.log", bytesAtLeast(256 * 1024));
		const archive = await archiveWorkerEvidence(original);

		expect(archive.path).toBe(`${original}.gz`);
		expect(await readWorkerEvidenceFile(archive.path)).toEqual(bytesAtLeast(256 * 1024));
		expect(existsSync(original)).toBe(false);
	});

	it("leaves files below 256 KiB uncompressed", async () => {
		const root = fixtureDir();
		const original = writeLiveFile(root, "卡0003.live.jsonl", bytesAtLeast(256 * 1024 - 1));
		const before = readFileSync(original);

		expect(await archiveWorkerEvidence(original)).toEqual({ path: original });
		expect(readFileSync(original)).toEqual(before);
		expect(existsSync(`${original}.gz`)).toBe(false);
	});

	it("does not overwrite an existing gzip destination", async () => {
		const root = fixtureDir();
		const original = writeLiveFile(root, "卡0004.live.jsonl", bytesAtLeast(256 * 1024));
		const destination = `${original}.gz`;
		const existing = Buffer.from("既有 gzip 不得被覆盖");
		writeFileSync(destination, existing);
		const archive = await archiveWorkerEvidence(original);

		expect(archive.path).toBe(original);
		expect(archive.warning).toMatch(/发布压缩证据失败/);
		expect(existsSync(original)).toBe(true);
		expect(readFileSync(destination)).toEqual(existing);
		expect(statSync(original).size).toBe(256 * 1024);
	});

	it("falls back only for old live paths whose same-name gzip exists", async () => {
		const root = fixtureDir();
		const livePath = join(root, "卡0005.live.jsonl");
		const compressedPath = `${livePath}.gz`;
		writeFileSync(compressedPath, gzipSync(Buffer.from("compressed evidence")));

		expect(await resolveWorkerEvidencePath(livePath)).toBe(compressedPath);
		expect(await readWorkerEvidenceFile(livePath)).toEqual(Buffer.from("compressed evidence"));

		const ordinaryPath = join(root, "ordinary.jsonl");
		writeFileSync(`${ordinaryPath}.gz`, gzipSync(Buffer.from("must not resolve")));
		await expect(resolveWorkerEvidencePath(ordinaryPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("prefers the original live path while it exists", async () => {
		const root = fixtureDir();
		const original = writeLiveFile(root, "卡0006.live.stderr.log", Buffer.from("still streaming"));
		writeFileSync(`${original}.gz`, gzipSync(Buffer.from("old finalized copy")));

		expect(await resolveWorkerEvidencePath(original)).toBe(original);
		expect(await readWorkerEvidenceFile(original)).toEqual(Buffer.from("still streaming"));
	});

	it("falls back when the original live path disappears after resolve", async () => {
		const root = fixtureDir();
		const livePath = join(root, "卡0014.live.jsonl");
		const compressedPath = `${livePath}.gz`;
		writeFileSync(livePath, "raw evidence");
		writeFileSync(compressedPath, gzipSync(Buffer.from("archived evidence")));
		expect(await resolveWorkerEvidencePath(livePath)).toBe(livePath);
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.spyOn(fsPromises, "readFile").mockImplementationOnce(async () => {
			await actual.unlink(livePath);
			throw Object.assign(new Error("读取时原文件已被归档"), { code: "ENOENT" });
		});

		expect(await readWorkerEvidenceFile(livePath)).toEqual(Buffer.from("archived evidence"));
		expect(existsSync(livePath)).toBe(false);
		expect(existsSync(compressedPath)).toBe(true);
	});

	it("accepts uppercase finalized live extensions", async () => {
		const root = fixtureDir();
		const compressedPath = join(root, "卡0015.LIVE.JSONL.GZ");
		writeFileSync(compressedPath, gzipSync(Buffer.from("uppercase evidence")));

		expect(isCompressedWorkerEvidence(compressedPath)).toBe(true);
		expect(await readWorkerEvidenceFile(compressedPath)).toEqual(Buffer.from("uppercase evidence"));
	});

	it("does not hide a non-ENOENT access failure behind gzip fallback", async () => {
		const root = fixtureDir();
		const livePath = join(root, "卡0010.live.jsonl");
		writeFileSync(`${livePath}.gz`, gzipSync(Buffer.from("fallback must not mask EACCES")));
		vi.mocked(fsPromises.access).mockRejectedValueOnce(Object.assign(new Error("模拟 EACCES"), { code: "EACCES" }));

		await expect(resolveWorkerEvidencePath(livePath)).rejects.toMatchObject({
			message: "模拟 EACCES",
			code: "EACCES",
		});
	});

	it("surfaces corrupt gzip instead of swallowing decompression failure", async () => {
		const root = fixtureDir();
		const corrupt = writeLiveFile(root, "卡0007.live.jsonl.gz", Buffer.from("not gzip"));

		expect(isCompressedWorkerEvidence(corrupt)).toBe(true);
		await expect(readWorkerEvidenceFile(corrupt)).rejects.toThrow();
	});

	it("propagates source stream errors through pipeline", async () => {
		const root = fixtureDir();
		const corruptSource = join(root, "卡0011.live.jsonl.gz");
		mkdirSync(corruptSource);

		await expect(readWorkerEvidenceFile(corruptSource)).rejects.toThrow();
	});

	it("does not mark a temp file as created until open succeeds", async () => {
		const root = fixtureDir();
		const original = writeLiveFile(root, "卡0012.live.jsonl", bytesAtLeast(256 * 1024));
		const uuid = "open-failure";
		const tempPath = join(root, `.${basename(original)}.${process.pid}.${uuid}.tmp`);
		writeFileSync(tempPath, "preexisting temp file");
		vi.mocked(randomUUID).mockReturnValueOnce(uuid);
		resetMockCalls();

		const archive = await archiveWorkerEvidence(original);

		expect(archive.path).toBe(original);
		expect(archive.warning).toMatch(/压缩证据失败/);
		expect(fsPromises.unlink).not.toHaveBeenCalled();
		expect(readFileSync(tempPath, "utf8")).toBe("preexisting temp file");
	});

	it("does not overwrite a destination that appears before publish", async () => {
		const root = fixtureDir();
		const original = writeLiveFile(root, "卡0013.live.jsonl", bytesAtLeast(256 * 1024));
		const destination = `${original}.gz`;
		const existing = Buffer.from("竞态时出现的既有 gzip");
		resetMockCalls();
		const linkMock = vi.mocked(fsPromises.link).mockImplementation(() => {
			throw Object.assign(new Error("竞态出现目标"), { code: "EEXIST" });
		});
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		const unlinkMock = vi.mocked(fsPromises.unlink).mockImplementation(async (path) => {
			await actual.unlink(path);
		});
		writeFileSync(destination, existing);

		const archive = await archiveWorkerEvidence(original);

		expect(archive.path).toBe(original);
		expect(archive.warning).toMatch(/发布压缩证据失败/);
		expect(readFileSync(destination)).toEqual(existing);
		expect(readFileSync(original)).toEqual(bytesAtLeast(256 * 1024));
		expect(linkMock).toHaveBeenCalledOnce();
		expect(unlinkMock).toHaveBeenCalledOnce();
		linkMock.mockImplementation(actual.link);
	});

	it("preserves the original and warns when compression fails", async () => {
		const root = fixtureDir();
		const original = writeLiveFile(root, "卡0008.live.jsonl", bytesAtLeast(256 * 1024));
		const before = readFileSync(original);
		writeFileSync(`${original}.gz`, "existing output");

		const archive = await archiveWorkerEvidence(original);

		expect(archive.path).toBe(original);
		expect(archive.warning).toMatch(/发布压缩证据失败/);
		expect(readFileSync(original)).toEqual(before);
		expect(existsSync(`${original}.gz`)).toBe(true);
	});

	it("reports both copies when source removal fails after publication", async () => {
		const root = fixtureDir();
		const original = writeLiveFile(root, "卡0009.live.jsonl", bytesAtLeast(256 * 1024));
		resetMockCalls();
		const unlinkMock = vi.mocked(fsPromises.unlink);
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(fsPromises.link).mockImplementation(actual.link);
		unlinkMock.mockImplementation(async (path) => {
			if (path !== original) return actual.unlink(path);
			throw Object.assign(new Error("模拟删除原文失败"), { code: "EACCES" });
		});
		const archive = await archiveWorkerEvidence(original);
		const compressed = `${original}.gz`;

		expect(archive.path).toBe(compressed);
		expect(archive.warning).toMatch(/模拟删除原文失败/);
		expect(archive.warning).toMatch(/原文与 \.gz 均存在/);
		expect(existsSync(original)).toBe(true);
		expect(existsSync(compressed)).toBe(true);
		expect(await readWorkerEvidenceFile(compressed)).toEqual(bytesAtLeast(256 * 1024));
	});
});
