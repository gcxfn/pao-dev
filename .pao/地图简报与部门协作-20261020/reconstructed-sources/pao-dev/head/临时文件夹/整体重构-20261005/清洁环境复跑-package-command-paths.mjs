// 用途：按 PAO/scripts/check-baseline-failures.mjs L250-267 的清洁环境构造法（env 白名单 + HOME/USERPROFILE 重定向到临时目录 + PI_OFFLINE=1 等），
//       复跑单个测试文件 test/package-command-paths.test.ts，为现状与基线.md §④g「清洁环境失败复现」补留档。
// 输入：PAO/packages/coding-agent/test/package-command-paths.test.ts（只读）
// 输出：stdout 全文（由调用方重定向落日志 T00-隔离复验-package-command-paths-清洁环境.log）；退出码=vitest 退出码。
// 注意：临时环境目录按约保留不删（日志需可复现），路径打印在末尾。
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CODING_AGENT_DIR = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent";
const REPO_ROOT = "D:/AI/workspace/pao-dev/PAO";
const TEST_FILE = "test/package-command-paths.test.ts";

const vitestEntry = [
	join(CODING_AGENT_DIR, "node_modules", "vitest", "vitest.mjs"),
	join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"),
].find((path) => existsSync(path));
if (!vitestEntry) {
	console.error("找不到 vitest 入口");
	process.exit(2);
}

const testRoot = mkdtempSync(join(tmpdir(), "pao-cleanenv-pcp-"));
const home = join(testRoot, "home");
const temp = join(testRoot, "tmp");
mkdirSync(home);
mkdirSync(temp);
const userConfig = join(testRoot, "npm-userconfig");
const globalConfig = join(testRoot, "npm-globalconfig");
writeFileSync(userConfig, "");
writeFileSync(globalConfig, "");
// 与 check-baseline-failures.mjs runVitest 同款：从空环境起步，不带真实端点、凭证或用户配置。
const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)", "CI", "GITHUB_ACTIONS", "LANG", "LC_ALL", "TZ"]);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
Object.assign(env, {
	HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
	XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(testRoot, "cache"),
	GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
	GIT_TERMINAL_PROMPT: "0", PI_OFFLINE: "1", PI_NO_LOCAL_LLM: "1", AWS_EC2_METADATA_DISABLED: "true",
	NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: join(testRoot, "cache", "npm"),
});

console.log(`命令: node ${vitestEntry} run ${TEST_FILE} --maxWorkers=1`);
console.log(`清洁环境: env 白名单继承（PATH/SYSTEMROOT 等 12 项）+ HOME/USERPROFILE→${home} + PI_OFFLINE=1 + 空 npm userconfig/globalconfig + GIT_CONFIG_GLOBAL=NUL`);
const started = new Date();
const result = spawnSync(process.execPath, [vitestEntry, "run", TEST_FILE, "--maxWorkers", "1"], {
	cwd: CODING_AGENT_DIR, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env, windowsHide: true,
});
const elapsed = Math.round((Date.now() - started.getTime()) / 1000);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
console.log(`\n临时环境目录（按约保留）: ${testRoot}`);
console.log(`退出码: ${result.status ?? (result.error ? result.error.message : "null")}`);
console.log(`耗时: ${elapsed} 秒`);
process.exitCode = result.status === null ? 1 : result.status;
