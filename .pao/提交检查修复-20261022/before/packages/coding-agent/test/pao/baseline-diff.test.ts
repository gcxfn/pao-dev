import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	compareOutputs,
	diffFailureSets,
	parseVitestFailures,
	parseVitestJson,
	readLogFile,
	stripAnsi,
} from "../../../../scripts/check-baseline-failures.mjs";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-baseline-"));
	tempDirs.push(dir);
	return dir;
}

/** 包一层 ANSI 颜色码，模拟 TTY 下 vitest 的原始输出 */
const red = (text: string) => `\x1b[31m${text}\x1b[39m`;

/** 按真实 vitest 输出结构拼一份夹具日志：失败明细行 + 两条汇总行 */
function makeLog(
	failures: Array<{ file: string; title: string }>,
	testsFailed: number,
	testFilesFailed = failures.length,
): string {
	const failLines = failures.map((f) => ` ${red("FAIL")}  ${f.file} > ${f.title}`);
	return [
		`${red("RUN")} v4.1.11 D:/AI/workspace/pao/PAO/packages/coding-agent`,
		"",
		...failLines,
		"",
		` Failed Tests  ${failures.length}`,
		"",
		` Test Files  ${testFilesFailed} failed | 282 passed | 6 skipped (308)`,
		`      Tests  ${testsFailed} failed | 2572 passed | 55 skipped (2694)`,
		" Start at  02:23:17",
	].join("\n");
}

const baselineFailureList = [
	{ file: "test/trust-selector.test.ts", title: "trust dialog > shows trust parent folder option" },
	{
		file: "test/session-manager/load-entries.test.ts",
		title: "SessionManager.inMemory > creates a header from the options",
	},
];

describe("stripAnsi 去转义", () => {
	test("去掉 CSI 颜色码与 OSC 序列，正文保留", () => {
		expect(stripAnsi("\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m\x1b[22m v4.1.11")).toBe(" RUN  v4.1.11");
		expect(stripAnsi("\x1b]0;标题\x07正文\x1b[31m红\x1b[39m")).toBe("正文红");
	});
});

describe("parseVitestFailures 解析", () => {
	test("带 ANSI 的输出抽出失败键与汇总数，键与无色输出一致", () => {
		const plain = parseVitestFailures(makeLog(baselineFailureList, 2));
		const ansi = parseVitestFailures(makeLog(baselineFailureList, 2));
		expect(ansi).toEqual(plain);
		expect(plain.keys).toEqual([
			"test/trust-selector.test.ts > trust dialog > shows trust parent folder option",
			"test/session-manager/load-entries.test.ts > SessionManager.inMemory > creates a header from the options",
		]);
		expect(plain.testsFailed).toBe(2);
		expect(plain.testFilesFailed).toBe(2);
	});

	test("路径归一：反斜杠与 ./ 前缀归到同一个键", () => {
		const windows = parseVitestFailures(makeLog([{ file: "test\\a\\b.test.ts", title: "用例甲" }], 1));
		const posix = parseVitestFailures(makeLog([{ file: "./test/a/b.test.ts", title: "用例甲" }], 1));
		expect(windows.keys[0]).toBe("test/a/b.test.ts > 用例甲");
		expect(posix.keys[0]).toBe(windows.keys[0]);
	});

	test("同一失败在输出里重复出现时去重", () => {
		const log = `${makeLog(baselineFailureList, 2)}\n FAIL  ${baselineFailureList[0].file} > ${baselineFailureList[0].title}\n`;
		const parsed = parseVitestFailures(log);
		expect(parsed.keys).toHaveLength(2);
	});

	test("全绿输出（0 failed）解析为空集合，不报错", () => {
		const parsed = parseVitestFailures(makeLog([], 0, 0));
		expect(parsed.keys).toEqual([]);
		expect(parsed.testsFailed).toBe(0);
	});

	test("真实全绿格式没有 0 failed，也解析为零失败（R33）", () => {
		const log = " Test Files  3 passed (3)\n      Tests  8 passed | 1 skipped (9)\n";
		expect(parseVitestFailures(log)).toEqual({ keys: [], testsFailed: 0, testFilesFailed: 0 });
	});

	test("文件加载失败只有 suite FAIL，也进入失败集合（R33）", () => {
		const log =
			" Failed Suites 1\n FAIL  test/load.test.ts [ test/load.test.ts ]\n Test Files  1 failed | 2 passed (3)\n Tests  8 passed (8)\n";
		expect(parseVitestFailures(log).keys).toEqual(["test/load.test.ts > [suite]"]);
		expect(compareOutputs(makeLog([], 0, 0), log).added).toEqual(["test/load.test.ts > [suite]"]);
	});

	test("套件名称不是用例名称；重复 suite marker 不重复计数", () => {
		const log =
			" Failed Suites 1\n FAIL  test/load.test.ts > 初始化\n FAIL  test/load.test.ts [ test/load.test.ts ]\n Test Files  1 failed (1)\n Tests  2 skipped (2)\n";
		expect(parseVitestFailures(log).keys).toEqual(["test/load.test.ts > [suite]"]);
	});

	test("失败汇总缺少明细时拒绝通过，但重复明细不要求精确总数", () => {
		expect(() => parseVitestFailures(makeLog([baselineFailureList[0]], 2, 1))).toThrow(/缺少对应 FAIL 明细/);
		expect(() => parseVitestFailures(makeLog([baselineFailureList[0]], 1, 2))).toThrow(/缺少对应 FAIL 明细/);
		const log = `${makeLog(baselineFailureList, 2)}\n FAIL  ${baselineFailureList[0].file} > ${baselineFailureList[0].title}\n`;
		expect(parseVitestFailures(log).keys).toHaveLength(2);
	});

	test("未处理的运行错误不当成全绿", () => {
		expect(() => parseVitestFailures(" Test Files  2 passed (2)\n Tests  3 passed (3)\n Errors  1 error\n")).toThrow(
			/运行错误/,
		);
	});

	test("已详列的运行错误参与差集，临时身份可变但出错文件不能被归一掉", () => {
		const log = (run: string, filename: string) =>
			`${makeLog([], 0, 0)}\n Errors 1 error\n---- Unhandled Rejection ----\nModelsError: Credential store read failed for anthropic: ENOENT '${join(tmpdir(), `pi-concurrent-test-${run}`, filename)}'\nThis error originated in "test/agent-session-concurrent.test.ts" test file.\n`;
		const baseline = log("1790934235571", "auth.json.lock");
		const same = log("1790999999999", "auth.json.lock");
		const different = log("1790999999999", "other.json.lock");
		expect(parseVitestFailures(baseline).keys[0]).toContain(
			"test/agent-session-concurrent.test.ts > [runtime] ModelsError",
		);
		expect(compareOutputs(baseline, same).added).toEqual([]);
		expect(compareOutputs(baseline, different).added).toHaveLength(1);
	});

	test("汇总说有失败却抽不出明细 → 如实报错，不许静默当零失败", () => {
		const log = " Test Files  20 failed | 282 passed (308)\n      Tests  67 failed | 2572 passed (2694)\n";
		expect(() => parseVitestFailures(log)).toThrow(/抽不出任何 FAIL 明细/);
	});

	test("整份输出认不出 vitest 特征（如 spawn 崩溃残留）→ 报错", () => {
		expect(() => parseVitestFailures("Error: spawn UNKNOWN\n")).toThrow(/解析失败/);
		expect(() => parseVitestFailures("")).toThrow(/解析失败/);
	});

	test("只有 FAIL 明细但缺最终汇总 → 拒绝截断 --log，不冒充失败集合没扩大", () => {
		const log = " FAIL  test/a.test.ts > 用例甲\n FAIL  test/b.test.ts > 用例乙\n";
		expect(() => parseVitestFailures(log)).toThrow(/缺少完整.*汇总/);
		expect(() => parseVitestFailures(`${log} Test Files 2 failed (2)\n`)).toThrow(/缺少完整.*汇总/);
		expect(() => compareOutputs(makeLog(baselineFailureList, 2), " FAIL test/a.test.ts > 用例甲\n")).toThrow(/汇总/);
	});
});

describe("diffFailureSets 差集", () => {
	test("新增与消失方向正确，输入顺序无关", () => {
		const diff = diffFailureSets(["a > 1", "b > 2"], ["b > 2", "c > 3"]);
		expect(diff.added).toEqual(["c > 3"]);
		expect(diff.removed).toEqual(["a > 1"]);
	});

	test("集合相同则双空", () => {
		const diff = diffFailureSets(["a > 1", "b > 2"], ["b > 2", "a > 1"]);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
	});
});

describe("compareOutputs 端到端（决定退出码的口径）", () => {
	const baselineOutput = makeLog(baselineFailureList, 2);

	test("出现基线外的新失败 → added 非空（对应退出码非 0）", () => {
		const currentOutput = makeLog([...baselineFailureList, { file: "test/new.test.ts", title: "新引入的失败" }], 3);
		const { added, removed } = compareOutputs(baselineOutput, currentOutput);
		expect(added).toEqual(["test/new.test.ts > 新引入的失败"]);
		expect(removed).toEqual([]);
	});

	test("失败集合与基线一致 → 双空（对应退出码 0）", () => {
		const { added, removed, baseline, current } = compareOutputs(baselineOutput, baselineOutput);
		expect(added).toEqual([]);
		expect(removed).toEqual([]);
		expect(baseline.keys).toEqual(current.keys);
	});

	test("基线里的失败这次没了 → removed 有数、added 为空（不扩大口径下应通过）", () => {
		const currentOutput = makeLog([baselineFailureList[0]], 1);
		const { added, removed } = compareOutputs(baselineOutput, currentOutput);
		expect(added).toEqual([]);
		expect(removed).toEqual([`${baselineFailureList[1].file} > ${baselineFailureList[1].title}`]);
	});

	test("当前输出解析不了 → 抛错而不是当零失败通过", () => {
		expect(() => compareOutputs(baselineOutput, "node:internal spawn UNKNOWN 崩溃")).toThrow(/解析失败/);
	});
});

describe("readLogFile 读日志", () => {
	test("文件不存在 → 报错且信息里带路径", () => {
		const nonexistentPath = join(tempDir(), "不存在的日志.log");
		expect(() => readLogFile(nonexistentPath)).toThrow(nonexistentPath);
	});

	test("文件存在 → 返回内容", () => {
		const dir = tempDir();
		const path = join(dir, "基线.log");
		writeFileSync(path, " Tests  0 failed", "utf8");
		expect(readLogFile(path)).toBe(" Tests  0 failed");
	});
});

describe("Vitest JSON 与历史日志同口径（R33）", () => {
	test("JSON 用例失败与历史 FAIL 键一致，文件加载失败独立计入", () => {
		const report = {
			numFailedTests: 1,
			success: false,
			testResults: [
				{
					name: "D:/repo/packages/coding-agent/test/a.test.ts",
					status: "failed",
					message: "",
					assertionResults: [{ title: "用例甲", ancestorTitles: ["test/a.test.ts", "套件"], status: "failed" }],
				},
				{
					name: "D:/repo/packages/coding-agent/test/load.test.ts",
					status: "failed",
					message: "加载失败",
					assertionResults: [],
				},
			],
		};
		const parsed = parseVitestJson(JSON.stringify(report));
		expect(parsed.keys).toEqual(["test/a.test.ts > 套件 > 用例甲", "test/load.test.ts > [suite]"]);
		expect(parsed.testFilesFailed).toBe(2);
		const log =
			" Failed Suites 1\n FAIL  test/load.test.ts [ test/load.test.ts ]\n Failed Tests 1\n FAIL  test/a.test.ts > 套件 > 用例甲\n Test Files  2 failed (2)\n Tests  1 failed (1)\n";
		expect(compareOutputs(log, JSON.stringify(report)).added).toEqual([]);
	});

	test("JSON 明细缺失或异常无测试报告不能冒充零失败", () => {
		expect(() => parseVitestJson('{"numFailedTests":1,"success":false,"testResults":[]}')).toThrow(/明细/);
		expect(() => parseVitestJson('{"numFailedTests":0,"success":false,"testResults":[]}')).toThrow(/运行异常/);
	});

	test("运行隔离的 Vitest 夹具，实读文件加载失败和全绿 JSON（不运行项目全量）", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "test"));
		const config = join(dir, "vitest.config.mjs");
		const report = join(dir, "report.json");
		const file = join(dir, "test", "fixture.test.ts");
		writeFileSync(config, "export default { test: { globals: true, environment: 'node' } };\n");
		writeFileSync(file, "throw new Error('夹具模块加载失败');\n");
		const args = [
			resolve("../../node_modules/vitest/dist/cli.js"),
			"run",
			"--root",
			dir,
			"--config",
			config,
			"--maxWorkers",
			"1",
			"--reporter=default",
			"--reporter=json",
			`--outputFile.json=${report}`,
		];
		const failed = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", windowsHide: true });
		expect(failed.error).toBeUndefined();
		expect(failed.status).toBe(1);
		expect(parseVitestFailures(readFileSync(report, "utf8")).keys).toEqual(["test/fixture.test.ts > [suite]"]);
		expect(compareOutputs(`${failed.stdout}${failed.stderr}`, readFileSync(report, "utf8")).added).toEqual([]);
		const baseline = join(dir, "baseline.log");
		writeFileSync(baseline, makeLog([], 0, 0));
		const checkArgs = [resolve("../../scripts/check-baseline-failures.mjs"), "--baseline", baseline, "--log", report];
		const incompleteJson = spawnSync(process.execPath, checkArgs, { cwd: dir, encoding: "utf8", windowsHide: true });
		expect(incompleteJson.status).toBe(2);
		expect(incompleteJson.stderr).toContain("不含未处理运行错误");
		writeFileSync(report, JSON.stringify({ ...JSON.parse(readFileSync(report, "utf8")), paoRuntimeFailures: [] }));
		const completeJson = spawnSync(process.execPath, checkArgs, { cwd: dir, encoding: "utf8", windowsHide: true });
		expect(completeJson.status).toBe(1);
		expect(completeJson.stdout).toContain("失败集合较基线扩大");
		writeFileSync(file, "it('全绿夹具', () => {});\n");
		const passed = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", windowsHide: true });
		expect(passed.error).toBeUndefined();
		expect(passed.status).toBe(0);
		expect(parseVitestFailures(readFileSync(report, "utf8")).keys).toEqual([]);
		expect(parseVitestFailures(`${passed.stdout}${passed.stderr}`).keys).toEqual([]);
	}, 30000);
});
