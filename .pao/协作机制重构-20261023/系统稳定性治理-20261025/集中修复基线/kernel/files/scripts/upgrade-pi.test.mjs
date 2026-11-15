import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ensureAnchor, parseArgs, run } from "./upgrade-pi.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "upgrade-pi.mjs");

test("R34: npm/npx version 入口真实运行，不安装依赖或升级", () => {
	assert.match(run("npm 入口", "npm", ["--version"]), /^\d+\.\d+\.\d+/);
	assert.match(run("npx 入口", "npx", ["--version"]), /^\d+\.\d+\.\d+/);
});

test("R34: 找不到命令或子进程失败如实报错", () => {
	assert.throws(() => run("缺失命令夹具", "pao-upgrade-missing-test-command", []), /ENOENT|not recognized|找不到/);
	assert.throws(() => run("非零退出夹具", process.execPath, ["-e", "console.error('fixture error'); process.exit(7)"]), /退出码 7[\s\S]*fixture error/);
});

test("R34: dry-run 只打印，安装遵循 ignore-scripts，任意 cwd 可启动", () => {
	const dir = mkdtempSync(join(tmpdir(), "pao-upgrade-dry-"));
	try {
		const output = execFileSync(process.execPath, [script, "v1.0.1", "--dry-run"], { cwd: dir, encoding: "utf8", windowsHide: true });
		assert.match(output, /npm install --ignore-scripts/);
		assert.match(output, /npx --no-install vitest run test\/pao\/ --maxWorkers 4/);
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R34: 升级锚点仅在确实已存在时复用；git 错误不吞", () => {
	const dir = mkdtempSync(join(tmpdir(), "pao-upgrade-anchor-"));
	const git = (args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@local", ...args], { cwd: dir, encoding: "utf8", windowsHide: true });
	try {
		git(["init"]);
		writeFileSync(join(dir, "fixture.txt"), "夹具\n");
		git(["add", "--", "fixture.txt"]);
		git(["commit", "--no-gpg-sign", "-m", "fixture"]);
		ensureAnchor("upgrade-anchor-fixture", { cwd: dir });
		const before = git(["rev-parse", "upgrade-anchor-fixture"]);
		ensureAnchor("upgrade-anchor-fixture", { cwd: dir });
		assert.equal(git(["rev-parse", "upgrade-anchor-fixture"]), before);
		assert.throws(() => ensureAnchor("invalid..anchor", { cwd: dir }), /fatal|不是一个有效/);
		assert.throws(() => ensureAnchor("upgrade-anchor-fixture", { cwd: join(dir, "missing") }), /ENOENT/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R34: 未知参数与多目标不能被静默忽略", () => {
	assert.deepEqual(parseArgs(["v1.0.1", "--dry-run"]), { tag: "v1.0.1", dryRun: true });
	assert.throws(() => parseArgs(["v1.0.1", "--wrong"]), /参数不对/);
	assert.throws(() => parseArgs(["v1.0.1", "v1.0.2"]), /参数不对/);
});
