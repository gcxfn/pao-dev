import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { createReadToolDefinition, type ReadOperations, type ReadToolOptions } from "../../core/tools/index.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { isCompressedWorkerEvidence, readWorkerEvidenceFile, resolveWorkerEvidencePath } from "../shared/evidence.ts";

type EvidenceKind = "live" | "compressed";

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;
type ReadExecute = ReadDefinition["execute"];

function workerEvidenceKind(path: string): EvidenceKind | undefined {
	if (isCompressedWorkerEvidence(path)) return "compressed";
	if (isCompressedWorkerEvidence(`${basename(path)}.gz`)) return "live";
	return undefined;
}

function defaultOperations(): ReadOperations {
	return {
		access: (path) => access(path, constants.R_OK),
		readFile: (path) => readFile(path),
		detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	};
}

/**
 * 只替换本地文件读取操作。参数结构、渲染、图片、分页、取消、动态 cwd 和工具钩子
 * 继续走 pi 原有的 read 实现。
 *
 * 自定义 operations 可能代表远端存储，不能改用本地文件系统兜底，因此在这种模式下
 * 仍原样使用 pi 的 read 执行逻辑，只增强本地读取操作。
 */
export function createEvidenceReadToolDefinition(cwd: string, options: ReadToolOptions = {}): ReadDefinition {
	const definition = options.operations
		? createReadToolDefinition(cwd, options)
		: createReadToolDefinition(cwd, {
				...options,
				operations: evidenceOperations(),
			});
	return {
		...definition,
		defaultActive: false,
	};
}

/**
 * 保留 pi 原 read 定义的全部行为，只在每次执行前从会话公开的有效设置读取图片缩放开关。
 * 动态读取保证运行中修改设置后，下一次 read 立即使用新值。
 */
export function createEvidenceReadToolDefinitionWithSettings(
	cwd: string,
	getSettings: () => { images?: { autoResize?: boolean } },
	options: ReadToolOptions = {},
): ReadDefinition {
	const definition = createEvidenceReadToolDefinition(cwd, options);
	const executeWithSettings: ReadExecute = (toolCallId, params, signal, onUpdate, ctx) => {
		const autoResizeImages = getSettings().images?.autoResize ?? true;
		const runtimeOptions = { ...options, autoResizeImages };
		const runtimeDefinition = options.operations
			? createReadToolDefinition(ctx?.cwd || cwd, runtimeOptions)
			: createReadToolDefinition(ctx?.cwd || cwd, {
					...runtimeOptions,
					operations: evidenceOperations(),
				});
		return runtimeDefinition.execute(toolCallId, params, signal, onUpdate, ctx);
	};
	return {
		...definition,
		execute: executeWithSettings,
	};
}

function evidenceOperations(): ReadOperations {
	const localOperations = defaultOperations();
	return {
		access: async (path) => {
			if (workerEvidenceKind(path) === "live") {
				await access(await resolveWorkerEvidencePath(path), constants.R_OK);
				return;
			}
			await localOperations.access(path);
		},
		readFile: async (path) => {
			if (workerEvidenceKind(path)) return readWorkerEvidenceFile(path);
			return localOperations.readFile(path);
		},
		detectImageMimeType: async (path) => {
			// 证据始终按文本读取，避免原文件刚被压缩后仍探测旧路径的图片魔数。
			if (workerEvidenceKind(path)) return null;
			return detectSupportedImageMimeTypeFromFile(path);
		},
	};
}

/**
 * 注册同名 read 增强。会话会按原有 allowlist 和初始工具清单同时筛选内置定义与
 * 扩展定义，因此已经启用的 read 会被替换，原本禁用的 read 仍保持禁用。
 */
export function registerEvidenceReadTool(pi: ExtensionAPI, options: ReadToolOptions = {}): void {
	pi.registerTool(createEvidenceReadToolDefinitionWithSettings(process.cwd(), () => pi.getSettings(), options));
}
