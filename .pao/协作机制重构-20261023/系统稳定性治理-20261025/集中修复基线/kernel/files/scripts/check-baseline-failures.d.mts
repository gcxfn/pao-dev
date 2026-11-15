/**
 * check-baseline-failures.mjs 的类型声明（供 test/pao 下的 TS 单元测试导入）。
 */

export interface VitestParseResult {
	/** 失败键数组；用例为「文件 > 套件 > 用例」，另含 [suite]/[runtime]，路径分隔符已归一为 / */
	keys: string[];
	/** 汇总行的失败用例数；输出里没有该行时为 null */
	testsFailed: number | null;
	/** 汇总行的失败文件数；输出里没有该行时为 null */
	testFilesFailed: number | null;
}

export interface FailureDiff {
	/** 这次新出现的失败（基线里没有） */
	added: string[];
	/** 基线里有、这次没有的失败（已修复或不再复现，仅提示用） */
	removed: string[];
}

export interface OutputComparison extends FailureDiff {
	baseline: VitestParseResult;
	current: VitestParseResult;
}

/** 去掉 ANSI 转义序列（CSI 颜色码与 OSC 序列） */
export declare function stripAnsi(text: string): string;

/** 从 vitest 输出解析失败集合；解析不出可信结果时抛错 */
export declare function parseVitestFailures(output: string): VitestParseResult;

/** 从 Vitest JSON 解析用例/文件失败；CLI 总体验收另要求本脚本附带的 paoRuntimeFailures。 */
export declare function parseVitestJson(output: string): VitestParseResult;

/** 失败集合差集 */
export declare function diffFailureSets(baselineKeys: readonly string[], currentKeys: readonly string[]): FailureDiff;

/** 两份 vitest 输出的完整比对；任何一份解析失败都会抛错 */
export declare function compareOutputs(baselineOutput: string, currentOutput: string): OutputComparison;

/** 读日志文件；不存在时抛带路径的错 */
export declare function readLogFile(filePath: string): string;
