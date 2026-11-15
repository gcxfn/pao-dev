#!/usr/bin/env node

// 用途：只为本轮核对修复前 a274012ff 已有的失败；保留并单列原 68 失败基线，不替换它。
// 输入：本目录的修复前本体、现有第三方依赖与公开模型数据、修正环境后的当前 JSON 报告。
// 输出：产物中的修复前完整日志、含运行错误键的 JSON、两种基线的差集与执行条件。
// 缺省只检查准备；明确传 --执行 才跑一次离线非 e2e 测试。没有安装、构建或模型调用。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareOutputs, parseVitestFailures, parseVitestJson } from "../../PAO/scripts/check-baseline-failures.mjs";
import beforeConfig from "./修复前本体/packages/coding-agent/vitest.config.ts";
import { workspaceSourcePaths } from "./修复前本体/vitest.base.ts";

const taskRoot = dirname(fileURLToPath(import.meta.url));
const beforeRoot = join(taskRoot, "修复前本体");
const currentRoot = resolve(taskRoot, "..", "..", "PAO");
const outputDir = join(taskRoot, "产物");
const oldBaseline = resolve(taskRoot, "..", "并行实施-20261002", "产物", "基线测试-coding-agent.log");
const defaultCurrent = join(outputDir, "coding-agent全量-2026-10-03-025127119.json");
const revision = "a274012ff580da75d22cc89bd1589fd9b5953280";
const node = "C:/Program Files/nodejs/node.exe";
const toolBin = "C:/Users/ASUS/.pi/agent/bin";

let execute = false;
let currentReport = defaultCurrent;
for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "--执行") execute = true;
	else if (arg === "--检查准备") execute = false;
	else if (arg === "--当前报告" && process.argv[i + 1]) currentReport = resolve(process.argv[++i]);
	else throw new Error(`未知参数或缺值：${arg}；用法：node 修复前同条件核对.mjs [--检查准备|--执行] [--当前报告 JSON路径]`);
}

const normalized = (path) => resolve(path).replaceAll("\\", "/").toLowerCase();
function git(args) {
	const result = spawnSync("git", ["-C", beforeRoot, ...args], { encoding: "utf8", windowsHide: true });
	if (result.error || result.status !== 0) throw new Error(`读取修复前 Git 状态失败：${result.error?.message ?? result.stderr}`);
	return result.stdout.trim();
}

function isolatedEnvironment(testRoot) {
	// 与本轮 check-baseline-failures.mjs 及 实施验证.ps1 完全相同的白名单、隔离目录和工具 PATH。
	const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)", "CI", "GITHUB_ACTIONS", "LANG", "LC_ALL", "TZ"]);
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
	const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
	if ((env[pathKey] ?? "").split(delimiter).some((path) => normalized(path) === normalized(toolBin)) === false) {
		env[pathKey] = `${toolBin}${delimiter}${env[pathKey] ?? ""}`;
	}
	const home = join(testRoot, "home");
	const temp = join(testRoot, "tmp");
	mkdirSync(home);
	mkdirSync(temp);
	const userConfig = join(testRoot, "npm-userconfig");
	const globalConfig = join(testRoot, "npm-globalconfig");
	writeFileSync(userConfig, "");
	writeFileSync(globalConfig, "");
	Object.assign(env, {
		HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
		XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(testRoot, "cache"),
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_TERMINAL_PROMPT: "0", PI_OFFLINE: "1", PI_NO_LOCAL_LLM: "1", AWS_EC2_METADATA_DISABLED: "true",
		NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: join(testRoot, "cache", "npm"),
	});
	return env;
}

function checkPreparation(env) {
	if (git(["rev-parse", "HEAD"]) !== revision) throw new Error("修复前工作树未固定在已声明的提交");
	if (git(["status", "--porcelain"])) throw new Error("修复前工作树存在未声明的源码改动");
	for (const file of [node, join(toolBin, "fd.exe"), join(toolBin, "rg.exe"), oldBaseline, currentReport]) {
		if (!existsSync(file)) throw new Error(`缺少核对输入：${file}`);
	}
	const current = JSON.parse(readFileSync(currentReport, "utf8"));
	if (!Object.hasOwn(current, "paoRuntimeFailures")) throw new Error("当前报告缺少运行错误键，须用基线脚本留档的完整 JSON");
	parseVitestJson(JSON.stringify(current));
	const aliases = beforeConfig.resolve?.alias ?? [];
	const agentAlias = aliases.find((entry) => entry.find instanceof RegExp && entry.find.test("@earendil-works/pi-agent-core"));
	if (!agentAlias || normalized(agentAlias.replacement) !== normalized(workspaceSourcePaths.agentIndex)) {
		throw new Error("Vitest 的 agent 别名未指向修复前源码");
	}
	for (const path of Object.values(workspaceSourcePaths)) {
		if (!normalized(path).startsWith(`${normalized(beforeRoot)}/`) || !existsSync(path)) throw new Error(`源码别名越过基准工作树或不存在：${path}`);
	}
	const resolver = join(beforeRoot, "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
	const probe = spawnSync(node, ["--import", pathToFileURL(resolver).href, "--input-type=module", "-e",
		'console.log(JSON.stringify(Object.fromEntries(["@earendil-works/pi-agent-core","@earendil-works/pi-ai/compat","@earendil-works/pi-coding-agent"].map(name=>[name,import.meta.resolve(name)]))))'], {
		cwd: join(beforeRoot, "packages", "coding-agent"), env, encoding: "utf8", windowsHide: true,
	});
	if (probe.error || probe.status !== 0) throw new Error(`源码解析探针失败：${probe.error?.message ?? probe.stderr}`);
	const resolved = JSON.parse(probe.stdout);
	for (const [name, url] of Object.entries(resolved)) {
		const path = fileURLToPath(url);
		if (!normalized(path).startsWith(`${normalized(beforeRoot)}/`) || !path.endsWith(".ts")) throw new Error(`子进程源码解析越过基准工作树：${name}=${path}`);
	}
	return {
		用途: "修复前同条件补充核对；原 68 失败基线另列，未替换",
		基准提交: revision, 修复前工作树: beforeRoot, 当前报告: currentReport, 原基线: oldBaseline,
		复用依赖目录: realpathSync(join(beforeRoot, "node_modules")),
		公开模型文件数: readdirSync(join(beforeRoot, "packages", "ai", "src", "providers", "data")).length,
		工具目录: toolBin, 环境键: Object.keys(env).sort(),
		Vitest的Agent源码: agentAlias.replacement, 子进程源码解析: resolved,
		Vitest版本: JSON.parse(readFileSync(join(currentRoot, "node_modules", "vitest", "package.json"), "utf8")).version,
		执行参数: ["run", "--exclude", "**/*e2e*", "--maxWorkers", "4", "--reporter=default", "--reporter=json"],
	};
}

const testRoot = mkdtempSync(join(tmpdir(), "pao-baseline-"));
try {
	const env = isolatedEnvironment(testRoot);
	const preparation = checkPreparation(env);
	if (!execute) {
		console.log(JSON.stringify({ ...preparation, 状态: "准备检查通过；尚未执行全量测试" }, null, 2));
	} else {
		mkdirSync(outputDir, { recursive: true });
		const runId = new Date().toISOString().replaceAll(":", "").replace("T", "-").replace("Z", "");
		const prefix = join(outputDir, `修复前同条件-${runId}`);
		const reportPath = join(testRoot, "vitest.json");
		const vitest = join(beforeRoot, "node_modules", "vitest", "vitest.mjs");
		const started = Date.now();
		const result = spawnSync(node, [vitest, "run", "--exclude", "**/*e2e*", "--maxWorkers", "4", "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`], {
			cwd: join(beforeRoot, "packages", "coding-agent"), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env, windowsHide: true,
		});
		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		writeFileSync(`${prefix}.log`, raw, { flag: "wx" });
		if (result.error || result.signal || !existsSync(reportPath)) throw new Error(`修复前测试未产生完整报告：${result.error?.message ?? result.signal ?? result.status}；日志=${prefix}.log`);
		const textResult = parseVitestFailures(raw);
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		report.paoRuntimeFailures = textResult.keys.filter((key) => key.includes(" > [runtime] "));
		const before = JSON.stringify(report);
		const parsed = parseVitestJson(before);
		if (result.status !== 0 && parsed.keys.length === 0) throw new Error("修复前测试异常退出却无失败明细，不能当作通过");
		writeFileSync(`${prefix}.json`, before, { flag: "wx" });
		const current = readFileSync(currentReport, "utf8");
		const legacy = readFileSync(oldBaseline, "utf8");
		const comparison = {
			说明: "修复前差集仅作本轮归因证据；原基线是否扩大独立保留，未改验收阈值",
			条件: preparation, 测试退出码: result.status, 耗时秒: (Date.now() - started) / 1000,
			原基线与修复前: compareOutputs(legacy, before),
			原基线与当前: compareOutputs(legacy, current),
			修复前同条件与当前: compareOutputs(before, current),
		};
		writeFileSync(`${prefix}-对比.json`, JSON.stringify(comparison, null, 2), { flag: "wx" });
		const diff = comparison.修复前同条件与当前;
		console.log(JSON.stringify({
			基准提交: revision, 修复前失败用例: parsed.testsFailed, 修复前失败文件: parsed.testFilesFailed,
			本轮相对修复前新增: diff.added, 本轮相对修复前消失: diff.removed,
			当前相对原基线新增: comparison.原基线与当前.added,
			完整日志: `${prefix}.log`, 修复前结果: `${prefix}.json`, 两种基线对比: `${prefix}-对比.json`,
		}, null, 2));
		process.exitCode = diff.added.length > 0 ? 1 : 0;
	}
} finally {
	// 只清理本脚本本次创建的隔离 HOME/TEMP；保留旧工作树、原基线与所有产物。
	rmSync(testRoot, { recursive: true, force: true });
}
