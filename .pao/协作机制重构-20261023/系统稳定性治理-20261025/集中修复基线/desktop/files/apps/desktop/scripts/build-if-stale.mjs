#!/usr/bin/env node
// build-if-stale：输入面比上次成功构建新时才跑完整 `pnpm build`，否则跳过。
// 语义是「拒绝陈旧产物」：宁可误重建，绝不让测试跑在旧产物上（git 换分支等操作会刷新
// 被换文件 mtime，必然触发重建）。S11-C 批为 26 个 test:core:* 去内嵌 5 分钟全量构建而设。
// ponytail: mtime 比对＝make 同级语义，「内容改了但 mtime 被拨旧」检测不到；
// 需要强保证时升级为内容指纹（walk+hash，输入面约万文件量级仍秒级）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // apps/desktop
const repoRoot = path.resolve(desktopDir, "..", "..");
const stampPath = path.join(desktopDir, "node_modules", ".cache", "desktop-build-stamp.json");
const SHARED_PKGS = ["session-driver", "catalogs", "extension-ui", "pi-sdk-driver"]; // build:deps 的四个
// 目录递归时剔除：构建产物与非构建输入（test 改动不影响产物，避免无谓重建）
const SKIP = new Set(["node_modules", "dist", "test", "tests", "out", "release", "test-results", "vendor", ".git"]);

const TOP_FILES = [
  "electron.vite.config.mjs",
  "tsconfig.json",
  "tsconfig.electron.json",
  "tsconfig.lint.json",
  "tsconfig.paths.json",
  "package.json",
  "index.html",
  "scripts/build-notification-status-helper.mjs",
].map((f) => path.join(desktopDir, f));

function maxMtime(p) {
  const s = statSync(p);
  if (!s.isDirectory()) return s.mtimeMs;
  let m = s.mtimeMs;
  for (const e of readdirSync(p)) {
    if (SKIP.has(e)) continue;
    m = Math.max(m, maxMtime(path.join(p, e)));
  }
  return m;
}

function inputMtime() {
  let m = 0;
  const add = (p) => {
    if (existsSync(p)) m = Math.max(m, maxMtime(p));
  };
  for (const f of TOP_FILES) add(f);
  add(path.join(desktopDir, "electron"));
  add(path.join(desktopDir, "src"));
  add(path.join(desktopDir, "contracts"));
  for (const d of SHARED_PKGS) add(path.join(repoRoot, "packages", d));
  add(path.join(repoRoot, "pnpm-lock.yaml"));
  return m;
}

const dryRun = process.argv.includes("--check");
const outMain = path.join(desktopDir, "out", "main", "main.js");
let stamp = null;
try {
  stamp = JSON.parse(readFileSync(stampPath, "utf8"));
} catch {
  // 无 stamp＝视为陈旧
}
const current = inputMtime();
const fresh = Boolean(stamp) && existsSync(outMain) && current <= stamp.maxInputMtime;

if (dryRun) {
  console.log(fresh ? "[build-if-stale] fresh (build will be skipped)" : "[build-if-stale] stale (full build needed)");
  process.exit(fresh ? 0 : 1);
}
if (fresh) {
  console.log("[build-if-stale] up-to-date, skipping build");
  process.exit(0);
}
console.log("[build-if-stale] stale or missing, running full build...");
// pnpm 不在 PATH 时回退 corepack（node 自带；本仓 packageManager 已钉 pnpm@10）
const hasPnpm = spawnSync("pnpm", ["--version"], { shell: process.platform === "win32" }).status === 0;
const cmd = hasPnpm ? ["pnpm", ["run", "build"]] : ["corepack", ["pnpm", "run", "build"]];
const r = spawnSync(cmd[0], cmd[1], { cwd: desktopDir, stdio: "inherit", shell: process.platform === "win32" });
if (r.status !== 0) process.exit(r.status ?? 1);
mkdirSync(path.dirname(stampPath), { recursive: true });
writeFileSync(stampPath, JSON.stringify({ maxInputMtime: inputMtime(), builtAt: new Date().toISOString() }));
console.log("[build-if-stale] build done, stamp updated");
