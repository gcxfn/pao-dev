import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createEvidenceReadToolDefinition, registerEvidenceReadTool } from "../../src/pao/worker/evidence-read-tool.ts";
import { createTestExtensionToolContext } from "../extension-tool-context.ts";

const processImage = vi.hoisted(() =>
	vi.fn(async (_bytes: Uint8Array, mimeType: string) => ({
		ok: true as const,
		data: Buffer.from("normalized").toString("base64"),
		mimeType,
		hints: [],
	})),
);
vi.mock("../../src/utils/image-process.ts", () => ({ processImage }));

const tempDirs: string[] = [];
const TEST_TEMP_ROOT = join(process.cwd(), "..", "..", "..", "..", "临时文件夹", "evidence-read-tool-20261020");
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
afterEach(() => {
	processImage.mockClear();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	rmSync(TEST_TEMP_ROOT, { recursive: true, force: true });
});

function tempDir(): string {
	mkdirSync(TEST_TEMP_ROOT, { recursive: true });
	const dir = mkdtempSync(join(TEST_TEMP_ROOT, "case-"));
	tempDirs.push(dir);
	return dir;
}

describe("PAO evidence read tool", () => {
	it("reads gzip, plain, old live-path fallback, and offset/limit", async () => {
		const dir = tempDir();
		const plain = join(dir, "run.live.jsonl");
		const compressed = join(dir, "run.live.jsonl.gz");
		const fallback = join(dir, "settled.live.jsonl");
		writeFileSync(plain, "one\ntwo\nthree\n");
		writeFileSync(compressed, gzipSync("alpha\nbeta\ngamma\n"));
		writeFileSync(`${fallback}.gz`, gzipSync("old\npointer\n"));
		const tool = createEvidenceReadToolDefinition(join(dir, "unused-default"));
		const ctx = await createTestExtensionToolContext(dir);

		const plainResult = await tool.execute(
			"plain",
			{ path: basename(plain), offset: 2, limit: 1 },
			undefined,
			undefined,
			ctx,
		);
		const compressedResult = await tool.execute(
			"compressed",
			{ path: basename(compressed), offset: 2, limit: 1 },
			undefined,
			undefined,
			ctx,
		);
		const fallbackResult = await tool.execute("fallback", { path: basename(fallback) }, undefined, undefined, ctx);

		expect(textOf(plainResult)).toBe("two\n\n[2 more lines in file. Use offset=3 to continue.]");
		expect(textOf(compressedResult)).toBe("beta\n\n[2 more lines in file. Use offset=3 to continue.]");
		expect(fallbackResult.content[0]).toMatchObject({ type: "text", text: "old\npointer\n" });
	});

	it("does not guess zipped suffixes for ordinary files and reveals corrupt gzip", async () => {
		const dir = tempDir();
		const tool = createEvidenceReadToolDefinition(dir);
		const ctx = await createTestExtensionToolContext(dir);
		await expect(
			tool.execute("missing", { path: join(dir, "ordinary.txt") }, undefined, undefined, ctx),
		).rejects.toMatchObject({ code: "ENOENT" });

		const corrupt = join(dir, "broken.live.jsonl.gz");
		writeFileSync(corrupt, "not gzip");
		await expect(tool.execute("broken", { path: corrupt }, undefined, undefined, ctx)).rejects.toThrow();
	});

	it("does not bypass custom read operations", async () => {
		const dir = tempDir();
		const calls: string[] = [];
		const tool = createEvidenceReadToolDefinition(dir, {
			operations: {
				access: async () => {
					calls.push("access");
				},
				readFile: async () => {
					calls.push("readFile");
					return Buffer.from("custom");
				},
				detectImageMimeType: async () => {
					calls.push("detectImage");
					return null;
				},
			},
		});
		const result = await tool.execute(
			"custom",
			{ path: join(dir, "not-local.live.jsonl.gz") },
			undefined,
			undefined,
			await createTestExtensionToolContext(dir),
		);

		expect(textOf(result)).toBe("custom");
		expect(calls).toEqual(["access", "detectImage", "readFile"]);
	});

	it("keeps image reads and cancellation", async () => {
		const dir = tempDir();
		const image = join(dir, "pixel.png");
		writeFileSync(image, Buffer.from(TINY_PNG_BASE64, "base64"));
		const evidenceWithImageBytes = join(dir, "binary.live.jsonl");
		writeFileSync(evidenceWithImageBytes, Buffer.from(TINY_PNG_BASE64, "base64"));
		const tool = createEvidenceReadToolDefinition(dir);
		const ctx = await createTestExtensionToolContext(dir);
		const result = await tool.execute("image", { path: image }, undefined, undefined, ctx);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(textOf(result)).toContain("Read image file");
		expect(result.content.some((content) => content.type === "image")).toBe(true);

		const evidenceResult = await tool.execute(
			"evidence",
			{ path: evidenceWithImageBytes },
			undefined,
			undefined,
			ctx,
		);
		expect(evidenceResult.content.every((content) => content.type === "text")).toBe(true);

		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("abort", { path: image }, controller.signal, undefined, ctx)).rejects.toThrow(
			"Operation aborted",
		);
	});

	it("replaces enabled read while keeping a disabled read disabled", async () => {
		const dir = tempDir();
		const settings = SettingsManager.inMemory({ defaultTools: ["read", "bash"] });
		const load = async (tools?: string[], excludeTools?: string[]) => {
			const resourceLoader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: join(dir, "agent"),
				settingsManager: settings,
				extensionFactories: [(pi) => registerEvidenceReadTool(pi)],
			});
			await resourceLoader.reload();
			return createAgentSession({
				cwd: dir,
				agentDir: join(dir, "agent"),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager: settings,
				sessionManager: SessionManager.inMemory(dir),
				resourceLoader,
				tools,
				excludeTools,
			});
		};

		const enabled = await load();
		const enabledRead = enabled.session.getAllTools().find((tool) => tool.name === "read");
		expect(enabledRead?.sourceInfo.source).toBe("inline");
		expect(enabled.session.getActiveToolNames()).toEqual(["read", "bash"]);
		enabled.session.dispose();

		const allowlisted = await load(["read"]);
		expect(allowlisted.session.getAllTools().find((tool) => tool.name === "read")?.sourceInfo.source).toBe("inline");
		expect(allowlisted.session.getActiveToolNames()).toEqual(["read"]);
		allowlisted.session.dispose();

		const excluded = await load(undefined, ["read"]);
		expect(excluded.session.getAllTools().some((tool) => tool.name === "read")).toBe(false);
		expect(excluded.session.getActiveToolNames()).toEqual(["bash"]);
		excluded.session.dispose();
	});

	it("uses and refreshes the session image autoResize setting for the same read tool", async () => {
		const dir = tempDir();
		const image = join(dir, "pixel.png");
		writeFileSync(image, Buffer.from(TINY_PNG_BASE64, "base64"));
		const settings = SettingsManager.inMemory({
			defaultTools: ["read"],
			images: { autoResize: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: join(dir, "agent"),
			settingsManager: settings,
			extensionFactories: [(pi) => registerEvidenceReadTool(pi)],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: join(dir, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: settings,
			sessionManager: SessionManager.inMemory(dir),
			resourceLoader,
			tools: ["read"],
		});

		const read = session.getToolDefinition("read");
		if (!read) throw new Error("Expected the PAO read definition");
		expect(read.defaultActive).toBe(false);
		const ctx = await createTestExtensionToolContext(dir);

		await read.execute("image-disabled", { path: image }, undefined, undefined, ctx);
		expect(processImage).toHaveBeenLastCalledWith(
			expect.any(Uint8Array),
			"image/png",
			expect.objectContaining({ autoResizeImages: false }),
		);

		settings.setImageAutoResize(true);
		await read.execute("image-enabled", { path: image }, undefined, undefined, ctx);
		expect(processImage).toHaveBeenLastCalledWith(
			expect.any(Uint8Array),
			"image/png",
			expect.objectContaining({ autoResizeImages: true }),
		);
		session.dispose();
	});
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}
