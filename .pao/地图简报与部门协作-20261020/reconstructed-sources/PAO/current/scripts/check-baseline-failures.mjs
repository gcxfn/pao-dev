#!/usr/bin/env node

/**
 * 基线失败比对（M0-09）——把「coding-agent 全量测试失败集合较基线不扩大」这条验收口径变成一条命令。
 *
 * 做什么：新跑测试优先读取 Vitest JSON（离线、非 e2e）；--log 同时支持 JSON 和历史文本。
 * 与基线解析出「文件 > 用例」失败键，另含文件/套件失败及未处理运行错误，再做差集：
 *   - 新增失败（基线里没有、这次有）→ 一条一行列出，退出码 1；
 *   - 基线里有、这次没有的失败 → 只报数量（口径是「不扩大」，修好了不影响退出码）。
 *
 * 用法：
 *   node scripts/check-baseline-failures.mjs                   # 自己调 vitest 跑 coding-agent 全量再比对
 *   node scripts/check-baseline-failures.mjs --log <文件>      # 直接读现成 vitest 输出（CI / 离线比对）
 *   node scripts/check-baseline-failures.mjs --save-log <文件> # 留档 JSON 和运行错误键（下次可作 --log 输入或新基线）
 *   可用 --baseline <文件> 覆盖基线路径；默认指向仓库外的基线留档（见 DEFAULT_BASELINE）。
 *
 * 退出码：0 = 无新增失败；1 = 有新增失败；2 = 用法错误 / 基线缺失 / 输出解析失败。
 *
 * 已知坑：vitest forks 池在 Windows 偶发 spawn UNKNOWN，属环境性 flaky 而非代码回归。
 * 本脚本刻意不做自动重试——遇到可疑失败，重跑一次再下结论。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CODING_AGENT_DIR = join(REPO_ROOT, "packages", "coding-agent");
// 基线留档在仓库外的 .pao 编排目录，仓库内不存第二份（「一个事实一个家」）；搬走了就用 --baseline 指新路径
const DEFAULT_BASELINE = resolve(REPO_ROOT, "..", ".pao", "并行实施-20261002", "产物", "基线测试-coding-agent.log");
const USAGE = `用法：
  node scripts/check-baseline-failures.mjs                   自己跑全量 vitest 再比对
  node scripts/check-baseline-failures.mjs --log <文件>      读现成 vitest 输出比对
  可选：--baseline <文件> 指定基线；--save-log <文件> 跑测试时留档 JSON 结果与运行错误键`;

/**
 * 去掉 ANSI 转义序列（CSI 颜色码与 OSC 序列），vitest 输出在 TTY 下带颜色，落盘日志里也常有残留。
 */
export function stripAnsi(text) {
	return String(text)
		.replaceAll(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replaceAll(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function normalizeFile(file) {
	const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
	const testDir = normalized.indexOf("/test/");
	return testDir >= 0 ? normalized.slice(testDir + 1) : normalized;
}

/** Vitest JSON 不含 unhandled errors；从默认报告保留来源、类型与主错误消息。 */
function parseRuntimeFailures(output) {
	const count = Number(/^\s*Errors\s+(\d+)\s+errors?\b/m.exec(output)?.[1] ?? 0);
	if (count === 0) return [];
	const errors = [];
	let current;
	for (const line of output.split("\n")) {
		if (/\b(?:Unhandled Rejection|Unhandled Error|Uncaught Exception)\b/.test(line)) {
			current = {};
			errors.push(current);
			continue;
		}
		if (!current) continue;
		const detail = /^([A-Za-z][\w]*(?:\s*\[[^\]]+\])?):\s*(.+)$/.exec(line);
		if (!current.message && detail && /Error|Exception/.test(detail[1])) {
			// 只归一 TEMP 根、测试运行目录的随机身份，保留锁文件等实际出错路径。
			const tempRoot = tmpdir().replaceAll("\\", "/").replace(/\/$/, "");
			const message = detail[2].replaceAll("\\", "/").replaceAll(tempRoot, "<TEMP>")
				.replace(/<TEMP>\/pao-baseline-[A-Za-z0-9]{6}\/tmp\//g, "<TEMP>/")
				.replace(/\b((?:pi|pao)-[\w-]+?)-\d{10,}(?:-[A-Za-z0-9]+)?(?=\/)/g, "$1-<run>");
			current.message = `${detail[1]}: ${message}`;
		}
		const origin = /This error originated in "(.+?)" test file/.exec(line);
		if (origin) current.file = normalizeFile(origin[1]);
	}
	const detailed = errors.filter((error) => error.message);
	if (detailed.length < count) throw new Error("解析失败：运行错误汇总缺少类型和主错误详情");
	return [...new Set(detailed.map((error) => `${error.file ?? "[vitest]"} > [runtime] ${error.message}`))];
}

/** Vitest JSON 的套件计数包含嵌套 describe，失败文件数从 testResults 派生。 */
export function parseVitestJson(output) {
	const report = JSON.parse(output);
	if (!Array.isArray(report.testResults) || !Number.isInteger(report.numFailedTests) || report.numFailedTests < 0 || typeof report.success !== "boolean") {
		throw new Error("解析失败：不是完整的 Vitest JSON 报告");
	}
	const keys = new Set();
	let failedAssertions = 0;
	let testFilesFailed = 0;
	for (const file of report.testResults) {
		if (typeof file.name !== "string" || !Array.isArray(file.assertionResults) || !["failed", "passed"].includes(file.status)) {
			throw new Error("解析失败：Vitest JSON 缺少文件或用例结果");
		}
		const filename = normalizeFile(file.name);
		const failed = file.assertionResults.filter((test) => test.status === "failed");
		for (const test of failed) {
			if (typeof test.title !== "string" || !Array.isArray(test.ancestorTitles)) {
				throw new Error("解析失败：Vitest JSON 缺少失败用例名称");
			}
			const ancestors = [...test.ancestorTitles];
			if (ancestors.length > 0 && normalizeFile(ancestors[0]) === filename) ancestors.shift();
			keys.add(`${filename} > ${[...ancestors, test.title].join(" > ")}`);
			failedAssertions += 1;
		}
		if (file.status === "failed" || failed.length > 0) {
			testFilesFailed += 1;
			// 文件加载/套件 hook 失败与用例失败分开记，不能只看失败用例数。
			if (file.message || failed.length === 0) keys.add(`${filename} > [suite]`);
		}
	}
	if (failedAssertions !== report.numFailedTests) {
		throw new Error(`解析失败：Vitest JSON 显示 ${report.numFailedTests} 个失败用例，实际明细 ${failedAssertions} 个`);
	}
	const runtimeKeys = report.paoRuntimeFailures ?? [];
	if (!Array.isArray(runtimeKeys) || runtimeKeys.some((key) => typeof key !== "string")) {
		throw new Error("解析失败：运行错误键格式不对");
	}
	if ((!report.success && keys.size === 0 && runtimeKeys.length === 0) || (report.success && keys.size > 0)) {
		throw new Error("解析失败：Vitest JSON 成败与失败明细不一致（可能没有执行测试或运行异常）");
	}
	for (const key of runtimeKeys) keys.add(key);
	return { keys: [...keys], testsFailed: report.numFailedTests, testFilesFailed };
}

/**
 * 从 vitest 输出解析失败集合。
 *
 * 返回 keys（「文件 > 用例」键数组，已做路径分隔符归一）与汇总行数字。
 * 解析不出可信结果时抛错——宁可报错退出，不许静默当零失败。
 */
export function parseVitestFailures(output) {
	if (String(output).trimStart().startsWith("{")) return parseVitestJson(output);
	const clean = stripAnsi(output).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	const keys = [];
	const seen = new Set();
	const failedFiles = new Set();
	let failureLines = 0;
	let suiteSection = false;
	let testsFailed = null;
	let testFilesFailed = null;

	for (const line of clean.split("\n")) {
		if (/Failed Suites\s+\d+/.test(line)) suiteSection = true;
		if (/Failed Tests\s+\d+/.test(line)) suiteSection = false;
		// 失败明细行：` FAIL  test/foo.test.ts > 套件 > 用例名`
		const failMatch = line.match(/^\s*FAIL\s+(.+?)\s*>\s*(.+?)\s*$/);
		if (failMatch) {
			const file = normalizeFile(failMatch[1]);
			const key = `${file} > ${suiteSection ? "[suite]" : failMatch[2]}`;
			failedFiles.add(file);
			if (!suiteSection) failureLines += 1;
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
			continue;
		}
		const suiteMatch = line.match(/^\s*FAIL\s+(.+?\.[cm]?[jt]sx?)(?:\s+\[\s*.+?\s*\])?\s*$/);
		if (suiteMatch) {
			const file = normalizeFile(suiteMatch[1]);
			const key = `${file} > [suite]`;
			failedFiles.add(file);
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
			continue;
		}
		// 汇总行：` Tests  67 failed | 2572 passed | 55 skipped (2694)`
		const testsMatch = line.match(/^\s*Tests\s+(.+)$/);
		if (testsMatch) {
			const failed = testsMatch[1].match(/\b(\d+)\s+failed\b/);
			if (failed || /\b\d+\s+(passed|skipped|todo)\b/.test(testsMatch[1]) || /^no tests\s*$/.test(testsMatch[1])) testsFailed = Number(failed?.[1] ?? 0);
			continue;
		}
		// 汇总行：` Test Files  20 failed | 282 passed | 6 skipped (308)`
		const filesMatch = line.match(/^\s*Test Files\s+(.+)$/);
		if (filesMatch) {
			const failed = filesMatch[1].match(/\b(\d+)\s+failed\b/);
			if (failed || /\b\d+\s+(passed|skipped|todo)\b/.test(filesMatch[1])) testFilesFailed = Number(failed?.[1] ?? 0);
		}
	}

	// FAIL 明细也可能来自中断/截断日志；必须有两条最终汇总才允许比较。
	if (testsFailed === null || testFilesFailed === null) {
		throw new Error("解析失败：缺少完整的 Tests / Test Files 汇总行，不能用中断或截断日志下验收结论");
	}
	// 汇总说有失败却抽不出明细：输出被截断或格式不认识，拒绝当零失败处理
	if (testsFailed !== null && testsFailed > 0 && keys.length === 0) {
		throw new Error(`解析失败：汇总显示 ${testsFailed} 个失败用例，但抽不出任何 FAIL 明细行，无法建立失败集合`);
	}
	// 同一错误/名称可以重复打印；只拒绝汇总指出明细确实缺失，不要求两次运行总数相等。
	if ((testsFailed !== null && testsFailed > failureLines) || (testFilesFailed !== null && testFilesFailed > failedFiles.size)) {
		throw new Error(`解析失败：失败汇总缺少对应 FAIL 明细（用例 ${testsFailed ?? "未知"}/${failureLines}，文件 ${testFilesFailed ?? "未知"}/${failedFiles.size}）`);
	}
	keys.push(...parseRuntimeFailures(clean));

	return { keys, testsFailed, testFilesFailed };
}

/**
 * 失败集合差集：added = 这次新出现的失败；removed = 基线里有、这次没有的失败（仅提示用）。
 */
export function diffFailureSets(baselineKeys, currentKeys) {
	const baseline = new Set(baselineKeys);
	const current = new Set(currentKeys);
	return {
		added: [...current].filter((key) => !baseline.has(key)),
		removed: [...baseline].filter((key) => !current.has(key)),
	};
}

/**
 * 两份 vitest 输出的完整比对：各自解析后做差集。任何一份解析失败都会抛错。
 */
export function compareOutputs(baselineOutput, currentOutput) {
	const baseline = parseVitestFailures(baselineOutput);
	const current = parseVitestFailures(currentOutput);
	return { baseline, current, ...diffFailureSets(baseline.keys, current.keys) };
}

/**
 * 读一份日志文件；不存在时给出带路径的明确报错（基线缺失是用户可修复的问题，不许静默当空基线）。
 */
export function readLogFile(filePath) {
	if (!existsSync(filePath)) {
		throw new Error(`基线/日志文件不存在：${filePath}（可用 --baseline <文件> 指定）`);
	}
	return readFileSync(filePath, "utf8");
}

/**
 * 跑 coding-agent 离线非 e2e 测试，返回 JSON 结果及原报告补取的运行错误键。
 * 直接用 node 调 vitest.mjs 入口，绕开 Windows 下 npx / .CMD / shell 转义的坑。
 */
function runVitest(rawLogPath) {
	const vitestEntry = [
		join(CODING_AGENT_DIR, "node_modules", "vitest", "vitest.mjs"),
		join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"),
	].find((path) => existsSync(path));
	if (!vitestEntry) {
		throw new Error(`找不到 vitest 入口（既不在包内也不在仓库根 node_modules），先安装依赖：${CODING_AGENT_DIR}`);
	}

	const testRoot = mkdtempSync(join(tmpdir(), "pao-baseline-"));
	try {
		const home = join(testRoot, "home");
		const temp = join(testRoot, "tmp");
		mkdirSync(home);
		mkdirSync(temp);
		const userConfig = join(testRoot, "npm-userconfig");
		const globalConfig = join(testRoot, "npm-globalconfig");
		writeFileSync(userConfig, "");
		writeFileSync(globalConfig, "");
		// 与 test.sh 同样从空环境起步，不带真实端点、凭证或用户配置跑全量。
		const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)", "CI", "GITHUB_ACTIONS", "LANG", "LC_ALL", "TZ"]);
		const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
		Object.assign(env, {
			HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
			XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(testRoot, "cache"),
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
			GIT_TERMINAL_PROMPT: "0", PI_OFFLINE: "1", PI_NO_LOCAL_LLM: "1", AWS_EC2_METADATA_DISABLED: "true",
			NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: join(testRoot, "cache", "npm"),
		});
		const reportPath = join(testRoot, "vitest.json");
		const result = spawnSync(process.execPath, [vitestEntry, "run", "--exclude", "**/*e2e*", "--maxWorkers", "4", "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`], {
			cwd: CODING_AGENT_DIR, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env, windowsHide: true,
		});
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		// JSON只含断言和归一错误键；保留原stdout/stderr，供定位环境与安装失败。
		// 两个流按捕获结果拼接，不声称逐行时序；中断时也先保存已有输出。
		if (rawLogPath) {
			mkdirSync(dirname(rawLogPath), { recursive: true });
			writeFileSync(rawLogPath, output, "utf8");
		}
		if (result.error || result.signal || !existsSync(reportPath)) {
			throw new Error(`vitest 未产生完整报告：${result.error?.message ?? result.signal ?? `退出码 ${result.status}`}\n${tail(output, 30)}`);
		}
		const reportData = JSON.parse(readFileSync(reportPath, "utf8"));
		reportData.paoRuntimeFailures = parseRuntimeFailures(stripAnsi(output));
		const report = JSON.stringify(reportData);
		const parsed = parseVitestJson(report);
		if (result.status !== 0 && parsed.keys.length === 0) {
			throw new Error(`vitest 运行异常，不能作基线通过：退出码 ${result.status}\n${tail(output, 30)}`);
		}
		return report;
	} finally {
		rmSync(testRoot, { recursive: true, force: true });
	}
}

/**
 * 取文本末尾 count 行，报错时给上下文用。
 */
function tail(text, count) {
	const lines = stripAnsi(text).replaceAll("\r\n", "\n").trimEnd().split("\n");
	return lines.slice(-count).join("\n");
}

/**
 * 解析命令行参数；未知参数直接报错，避免手滑后静默比对错东西。
 */
function parseArgs(argv) {
	const args = { log: null, baseline: null, saveLog: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const takeValue = (name) => {
			i += 1;
			if (i >= argv.length) {
				throw new Error(`参数 ${name} 缺少值\n${USAGE}`);
			}
			return argv[i];
		};
		if (arg === "--log") {
			args.log = takeValue(arg);
		} else if (arg === "--baseline") {
			args.baseline = takeValue(arg);
		} else if (arg === "--save-log") {
			args.saveLog = takeValue(arg);
		} else if (arg === "--help" || arg === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else {
			throw new Error(`未知参数：${arg}\n${USAGE}`);
		}
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));

	const baselinePath = args.baseline ?? DEFAULT_BASELINE;
	const baselineOutput = readLogFile(baselinePath);
	const currentOutput = args.log ? readLogFile(args.log) : runVitest(args.saveLog ? `${args.saveLog}.raw.log` : undefined);
	for (const [label, output] of [["基线", baselineOutput], ["当前", currentOutput]]) {
		if (output.trimStart().startsWith("{") && !Object.hasOwn(JSON.parse(output), "paoRuntimeFailures")) {
			throw new Error(`${label}原生 Vitest JSON 不含未处理运行错误；请用完整文本日志，或本脚本 --save-log 留档的 JSON 结果`);
		}
	}

	if (args.saveLog && !args.log) {
		mkdirSync(dirname(args.saveLog), { recursive: true });
		writeFileSync(args.saveLog, currentOutput, "utf8");
		console.log(`已留档测试结果与运行错误键：${args.saveLog}`);
	}
	if (args.log && args.saveLog) {
		console.error("[警告] --log 模式下 --save-log 无效（没有跑测试，无新输出可留档）");
	}

	const { baseline, current, added, removed } = compareOutputs(baselineOutput, currentOutput);
	const baselineLabel = args.baseline ?? DEFAULT_BASELINE;
	const currentLabel = args.log ?? `vitest run（${CODING_AGENT_DIR}）`;

	console.log(`基线：${baselineLabel}`);
	console.log(`  失败用例 ${baseline.testsFailed ?? "未知"} 个 / 失败文件 ${baseline.testFilesFailed ?? "未知"} 个`);
	console.log(`当前：${currentLabel}`);
	console.log(`  失败用例 ${current.testsFailed ?? "未知"} 个 / 失败文件 ${current.testFilesFailed ?? "未知"} 个`);

	if (added.length > 0) {
		console.log(`\n新增失败 ${added.length} 处（基线里没有，本次有）：`);
		for (const key of added) {
			console.log(`  FAIL ${key}`);
		}
	} else {
		console.log("\n新增失败：无");
	}
	if (removed.length > 0) {
		// 口径是「不扩大」：比基线修好了不算事，只报个数供参考
		console.log(`基线中已消失的失败 ${removed.length} 处（已修复或不再复现，仅提示，不影响退出码）`);
	}

	if (added.length > 0) {
		console.log("\n结论：失败集合较基线扩大，验收不通过");
		process.exit(1);
	}
	console.log("结论：失败集合较基线没有扩大，通过");
	process.exit(0);
}

// 直接被 node 执行时才进 main；被测试 import 时不执行
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		main();
	} catch (error) {
		console.error(`[基线比对] ${error instanceof Error ? error.message : error}`);
		process.exit(2);
	}
}
