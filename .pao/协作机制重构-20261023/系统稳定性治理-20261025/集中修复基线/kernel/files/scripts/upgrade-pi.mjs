#!/usr/bin/env node

/**
 * pi 升级 driver（C2 预案，2026-10-02 升 1.0.0 实操沉淀）——把「适配四步」里的机械环节串成一条命令。
 *
 * 做什么（每步失败即停，绝不带病往下走）：
 *   0 前置：工作树干净（未跟踪文件不挡）、目标 tag 存在、记录当前版本；
 *   1 锚点：建 upgrade-anchor-<日期> 分支（已存在则复用）——rebase 改写提交号后的回退入口；
 *   2 rebase 到目标 tag——冲突时停，人工解决后 `git rebase --continue`，再重跑本脚本续走后续步骤；
 *   3 npm install --ignore-scripts（锁文件随依赖同步，不执行安装生命周期脚本）；
 *   4 npm run build——必须全仓按序构建，单 `-w packages/coding-agent` 会因兄弟包 dist 过期而挂（2026-10-02 实测坑）；
 *   5 test/pao/ 全绿门；
 *   6 全量基线比对（check-baseline-failures.mjs）——有新增失败时停，人工定性后处理：
 *     上游自变（如新增测试的 Windows POSIX 债）→ 该脚本 --save-log 重建基线并入外层仓库；
 *     并发计时轮换失败 → 隔离复跑判定（环境抖动）。
 *
 * 不做什么：不 fetch（git 走代理是用户自己的事，慢操作用户爱自己接手）；不 commit、不 push
 * （主会话审后统一提交，push 永远用户手动）；不自动改 AGENTS/断言（④ 同步是人工环节）。
 *
 * 用法：
 *   node scripts/upgrade-pi.mjs <目标tag>          # 例：v1.0.1
 *   node scripts/upgrade-pi.mjs <目标tag> --dry-run # 只打印步骤不执行
 *
 * 退出码：0 = 全部步骤通过；1 = 某步失败（看输出定位）；2 = 用法/前置错误。
 * 验证方式：命令入口与隔离夹具测试；dry-run 只确认步骤，不代表真实升级成功。
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import spawn from "cross-spawn";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = "用法：node scripts/upgrade-pi.mjs <目标tag> [--dry-run]（先 git fetch --tags 拿到目标 tag）";

export function parseArgs(argv) {
	const dryRun = argv.includes("--dry-run");
	const tags = argv.filter((a) => a !== "--dry-run");
	const tag = tags[0];
	if (tags.length !== 1) throw new Error(`参数不对\n${USAGE}`);
	if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
		throw new Error(`目标 tag 缺失或格式不对（形如 v1.0.1）\n${USAGE}`);
	}
	return { tag, dryRun };
}

/** 跑命令；dryRun 只打印。返回 stdout（dryRun 返回空串） */
export function run(label, command, args, options = {}) {
	const 描述 = `${command} ${args.join(" ")}`;
	console.log(`\n▶ ${label}\n  $ ${描述}${options.cwd ? `（in ${options.cwd}）` : ""}`);
	if (options.dryRun) return "";
	const result = spawn.sync(command, args, {
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
		cwd: options.cwd ?? REPO_ROOT,
		windowsHide: true,
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${描述} 退出码 ${result.status ?? `未知（信号 ${result.signal}）`}\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
	}
	const output = result.stdout ?? "";
	if (output.trim()) console.log(output.trim().split("\n").slice(-6).join("\n"));
	return output;
}

/** 先查是否确实存在；其他 git 错误必须停止，不能一律冒充“锚点已存在”。 */
export function ensureAnchor(anchor, options = {}) {
	const existing = run("查升级锚点", "git", ["branch", "--list", "--format=%(refname:short)", anchor], options);
	if (existing.trim().split(/\r?\n/).includes(anchor)) {
		console.log(`  ${anchor} 已存在，复用`);
		return;
	}
	run(`锚点分支 ${anchor}`, "git", ["branch", anchor], options);
}

function fail(step, detail) {
	console.error(`\n✗ 第${step}步失败：${detail}`);
	console.error("  修复后从头重跑本脚本（各步幂等：锚点已存在则复用，rebase 已完成则无事可做）。");
	process.exit(1);
}

function main() {
	const { tag, dryRun } = parseArgs(process.argv.slice(2));
	console.log(`pi 升级 driver${dryRun ? "（dry-run，只打印不执行）" : ""}：目标 ${tag}`);

	// 0 前置
	let head = "";
	let status = "";
	let tags = "";
	try {
		head = run("记录当前 HEAD", "git", ["log", "-1", "--oneline"], { dryRun });
		status = run("查工作树", "git", ["status", "--short"], { dryRun });
		tags = run("确认目标 tag 存在", "git", ["tag", "-l", tag], { dryRun });
	} catch (error) {
		fail(0, error.message);
	}
	const 脏 = status
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("??"));
	if (脏.length > 0) {
		fail(0, `工作树有已跟踪文件的未提交改动（${脏.length} 处），先提交或收好再升级`);
	}
	if (!dryRun && !tags.includes(tag)) {
		fail(0, `本地没有 tag ${tag}——先 git fetch --tags（走你自己的代理）`);
	}
	console.log(`  当前：${head.trim() || "(dry-run)"}`);

	// 1 锚点分支
	const anchor = `upgrade-anchor-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
	try {
		ensureAnchor(anchor, { dryRun });
	} catch (error) {
		fail(1, error.message);
	}

	// 2 rebase
	try {
		run(`rebase 到 ${tag}`, "git", ["rebase", tag], { dryRun });
	} catch (error) {
		fail(2, `rebase 冲突——人工解决后 git rebase --continue，再重跑本脚本。详情：${error.message}`);
	}

	// 3 依赖
	try {
		run("npm install（锁文件同步，跳过安装脚本）", "npm", ["install", "--ignore-scripts"], { dryRun });
	} catch (error) {
		fail(3, error.message);
	}

	// 4 全仓按序构建（不可单 -w，见头部注释）
	try {
		run("全仓按序构建", "npm", ["run", "build"], { dryRun });
	} catch (error) {
		fail(4, `构建失败——先看是否兄弟包 dist 过期/类型不匹配：${error.message}`);
	}

	// 5 pao 模块门
	try {
		run("test/pao/ 全绿门", "npx", ["--no-install", "vitest", "run", "test/pao/", "--maxWorkers", "4"], { dryRun, cwd: join(REPO_ROOT, "packages", "coding-agent") });
	} catch (error) {
		fail(5, `pao 模块测试不绿，升级引入回归，先修或回锚点分支：${error.message}`);
	}

	// 6 基线比对
	try {
		run("全量基线比对", process.execPath, [join(REPO_ROOT, "scripts", "check-baseline-failures.mjs")], { dryRun, stdio: "inherit" });
	} catch (error) {
		fail(6, `基线门未通过：${error.message}\n先区分新增失败与脚本/环境错误；上游自变再重建基线，环境抖动隔离复跑判定。`);
	}

	console.log(`
✓ 机械步骤全过。人工环节（需求 §5.4 第④步「同步」，脚本不碰）：
  1) AGENTS.md 版本断言同批订正（fork 基线/Commands/Working Rules/Verification 基线数）
  2) 如重建了基线：新日志入外层仓库，M 计划/决策笔记记缘由
  3) 外层 plans 记录升级（提交号、预研结论、真跑证据——建议 pao_health_check 跑一次当收尾代表任务）
  4) 提交由主会话审后统一做；push 你自己来`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		main();
	} catch (error) {
		console.error(`[pi 升级] ${error instanceof Error ? error.message : error}`);
		process.exit(2);
	}
}
