// T12 门先行·门B：静态导入边界断言。
// B1 CLI 源闭包（src/cli.ts 起）不引入 electron/react（CLI 不携带桌面/前端依赖）
// B2 dist/bundle/cli.js 文本无 electron/react require
// B3 桌面宿主闭包（electron/**）不 import CLI 入口（bundle/cli、src/cli.ts、cli/args），不 spawn 全局 pao/pi
// B4 pi-sdk-driver 源闭包同 B3
// B5 内核公开导出闭包（src/pao/index.ts、src/pao/desktop/index.ts、src/pao/todo/summary.ts）不 import CLI 入口（cli.ts/main.ts）
// B6 package.json exports 表不含 cli 目标
// 用法：自 packages/coding-agent 运行 `node scripts/gate-boundary.mjs` 或 `npm run check:gates`（纯静态，无构建要求）
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelDir = path.resolve(here, "..");
const kernelSrc = path.join(kernelDir, "src");
const repoRoot = path.resolve(kernelDir, "..", "..", "..");
const desktopApp = path.join(repoRoot, "desktop", "apps", "desktop");
const driverSrc = path.join(repoRoot, "desktop", "packages", "pi-sdk-driver", "src");

let failed = 0;
const fail = (id, msg) => { failed++; console.error(`[FAIL] ${id}: ${msg}`); };
const pass = (id, msg) => console.log(`[PASS] ${id}: ${msg}`);

// 相对导入闭包行走（.ts/.tsx，显式扩展名；目录→index.ts）
const importRe = /(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
function walkClosure(entryFiles) {
  const seen = new Set();
  const edges = []; // {from, spec, resolved|null}
  const queue = [...entryFiles];
  while (queue.length) {
    const file = path.resolve(queue.pop());
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(importRe)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      let resolved = null;
      if (spec.startsWith(".")) {
        const base = path.resolve(path.dirname(file), spec);
        for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), `${base}.js`.replace(/src(.*)\.js$/, "src$1.ts")]) {
          if (existsSync(cand) && statSync(cand).isFile()) { resolved = cand; break; }
        }
      }
      edges.push({ from: file, spec, resolved });
      if (resolved) queue.push(resolved);
    }
  }
  return { seen, edges };
}

// B1 CLI 源闭包无 electron/react
{
  const { seen, edges } = walkClosure([path.join(kernelSrc, "cli.ts")]);
  const bad = edges.filter((e) => /^(electron|react|react-dom|ink)(\/.*)?$/.test(e.spec));
  const missing = edges.filter((e) => !e.resolved && !e.spec.startsWith("."));
  if (bad.length) fail("B1", `CLI 闭包引入禁用依赖: ${bad.map((e) => `${path.relative(kernelSrc, e.from)} -> ${e.spec}`).join("; ")}`);
  else pass("B1", `CLI 源闭包 ${seen.size} 文件无 electron/react/ink（裸外部依赖 ${missing.length} 条全为包依赖）`);
}

// B2 dist/bundle/cli.js 文本检查
{
  const bundle = path.join(kernelDir, "dist", "bundle", "cli.js");
  if (!existsSync(bundle)) fail("B2", `缺少构建产物 ${bundle}`);
  else {
    const text = readFileSync(bundle, "utf8");
    const hits = [...text.matchAll(/(?:require\(|from\s*|import\s*)["'](electron|react|react-dom|ink)["']/g)].map((m) => m[1]);
    if (hits.length) fail("B2", `bundle cli 含 ${hits.join(",")} 引用`);
    else pass("B2", `bundle cli.js（${(text.length / 1024 / 1024).toFixed(1)} MB）无 electron/react 引用`);
  }
}

// B3/B4 桌面宿主闭包不 import CLI 入口、不 spawn 全局 pao/pi
function checkHostClosure(id, rootDir, globExts) {
  const files = [];
  const collect = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) collect(full);
      else if (globExts.some((x) => e.name.endsWith(x))) files.push(full);
    }
  };
  collect(rootDir);
  const { seen, edges } = walkClosure(files);
  const cliHits = edges.filter((e) =>
    /bundle[/\\]cli\.js$|[/\\]src[/\\]cli\.ts$|pi-coding-agent[/\\]cli$|\/cli\/args/.test(e.spec),
  );
  const globalSpawn = files.flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return [...text.matchAll(/(?:spawn|spawnSync|execFile|execFileSync)\(\s*["'](pao|pi)["']/g)]
      .map((m) => `${path.relative(rootDir, f)}: spawn 全局 ${m[1]}`);
  });
  if (cliHits.length) fail(id, `宿主闭包 import CLI 入口: ${cliHits.map((e) => `${path.relative(rootDir, e.from)} -> ${e.spec}`).join("; ")}`);
  if (globalSpawn.length) fail(id, globalSpawn.join("; "));
  if (!cliHits.length && !globalSpawn.length) pass(id, `宿主闭包 ${seen.size} 文件无 CLI 入口引用、无全局 pao/pi spawn`);
}
checkHostClosure("B3", path.join(desktopApp, "electron"), [".ts", ".mts"]);
checkHostClosure("B4", driverSrc, [".ts", ".mts"]);

// B5 内核公开导出闭包不 import CLI 入口
for (const entry of ["pao/index.ts", "pao/desktop/index.ts", "pao/todo/summary.ts"]) {
  const { edges } = walkClosure([path.join(kernelSrc, entry)]);
  const hits = edges.filter((e) => /(^|[\\/])(cli|main)\.ts$/.test(e.resolved ?? ""));
  if (hits.length) fail(`B5(${entry})`, `内核公开导出闭包引 CLI 入口: ${hits.map((e) => `${path.relative(kernelSrc, e.from)} -> ${e.resolved}`).join("; ")}`);
  else pass(`B5(${entry})`, `公开导出闭包无 CLI 入口引用`);
}

// B6 package.json exports 无 cli 目标
{
  const pkg = JSON.parse(readFileSync(path.join(kernelDir, "package.json"), "utf8"));
  const targets = Object.entries(pkg.exports ?? {}).map(([k, v]) => [k, Object.values(v).join(" ")]);
  const bad = targets.filter(([, v]) => /(^|[\\/])cli([\\/]|\.|$)/.test(String(v)));
  if (bad.length) fail("B6", `exports 指向 cli: ${JSON.stringify(bad)}`);
  else pass("B6", `exports ${targets.map(([k]) => k).join(", ")} 均不含 cli 目标`);
}

process.exit(failed === 0 ? 0 : 1);
