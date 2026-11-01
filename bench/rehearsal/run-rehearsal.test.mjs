// 用途：验证 rehearsal 入口的 --scenario 选项：缺省仍是 normal.json、显式场景被真实读取、坏路径快速失败。
// 输入：临时场景文件（错误 kit 哈希）；输出：node:test 断言；不联网、不碰正式 PAO_HOME。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_SCENARIO_RELATIVE, resolveScenarioPath } from "./cli-args.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SCRIPT = join(HERE, "run-rehearsal.mjs");
const NORMAL = join(REPO_ROOT, "bench/rehearsal/scenarios/normal.json");
const WORKSPACE_TEMP = resolve(REPO_ROOT, "../临时文件夹/PAO彩排-20261030");
const cleanups = [];

process.on("exit", () => {
  for (const path of cleanups) rmSync(path, { recursive: true, force: true });
});

test("缺省场景与既有硬编码一致：bench/rehearsal/scenarios/normal.json", () => {
  assert.equal(DEFAULT_SCENARIO_RELATIVE, "bench/rehearsal/scenarios/normal.json");
  assert.equal(resolveScenarioPath(undefined, { repoRoot: REPO_ROOT }), NORMAL);
});

test("显式 --scenario 解析为绝对路径，相对路径按 cwd 解析", () => {
  const root = mkdtempSync(join(tmpdir(), "pao-scenario-args-"));
  cleanups.push(root);
  const scenarioPath = join(root, "自定义场景.json");
  writeFileSync(scenarioPath, "{}\n", "utf8");
  assert.equal(resolveScenarioPath(scenarioPath, { repoRoot: REPO_ROOT }), scenarioPath);
  assert.equal(resolveScenarioPath("自定义场景.json", { repoRoot: REPO_ROOT, cwd: root }), scenarioPath);
  assert.throws(
    () => resolveScenarioPath(join(root, "不存在.json"), { repoRoot: REPO_ROOT }),
    /--scenario 指向的场景文件不存在/,
  );
});

test("真实 CLI：--scenario 生效且坏场景在启动产品前失败", () => {
  const root = mkdtempSync(join(tmpdir(), "pao-scenario-cli-"));
  cleanups.push(root);
  const scenario = JSON.parse(readFileSync(NORMAL, "utf8"));
  const fixture = join(root, "wrong-kit.json");
  writeFileSync(fixture, `${JSON.stringify({ ...scenario, name: "test-wrong-kit", kitSha256: "0".repeat(64) }, null, 2)}\n`, "utf8");
  mkdirSync(WORKSPACE_TEMP, { recursive: true });
  const output = join(WORKSPACE_TEMP, `scenario-test-${process.pid}-${Date.now()}`);
  cleanups.push(output);
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--scenario", fixture, "--output", output],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, windowsHide: true },
  );
  assert.equal(result.status, 1, `期望退出码 1，实际 ${result.status}；stdout=${result.stdout} stderr=${result.stderr}`);
  // kit 哈希不匹配只可能来自「指定文件被真正读取」：默认 normal.json 的 kitSha256 与当前 kit 一致，
  // 用它跑不会出现这句错误；同时 stdout 为空说明产品服务器与主控进程都没启动。
  assert.match(result.stderr, /场景冻结的 kit 哈希与当前 kit 不一致/);
  assert.equal(result.stdout.trim(), "");
  assert.equal(existsSync(join(output, "evidence", "preflight.json")), false);
});
