// T12 门先行·门C：worker/部长子进程入口路径解析探针（defaultInvocation 行为清单）。
// 接缝：dist/pao/worker/runner.js 的 defaultInvocation——worker（runner.ts:375）与部长
//（host/host.ts:239）共用的唯一子进程入口解析函数。逐场景改 process.argv[1] 观察解析结果。
// 红线判据：任何场景解析出全局命令 "pao"/"pi" 即 RED（暗退到机器上的另一个 pi）。
// 用法：自 packages/coding-agent 运行 `node scripts/gate-path-probe.mjs` 或 `npm run check:gates`（需先构建 dist）
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelDir = path.resolve(here, "..");
const repoRoot = path.resolve(kernelDir, "..", "..", "..");
const desktopApp = path.join(repoRoot, "desktop", "apps", "desktop");
const cliJs = path.join(kernelDir, "dist", "bundle", "cli.js");
const desktopMain = path.join(desktopApp, "out", "main", "main.js");
const packagedAsar = path.join(desktopApp, "release", "win-unpacked", "resources", "app.asar");

const probeSrc = `
import("node:url").then(async ({ pathToFileURL }) => {
  const runner = await import(pathToFileURL(process.argv[2] + "/dist/pao/worker/runner.js"));
  const { getPackageDir } = await import(pathToFileURL(process.argv[2] + "/dist/config.js"));
  const realArgv1 = process.argv[1];
  const scenarios = [
    ["S1 worker子进程内(argv1=cli.js)", ${JSON.stringify(cliJs)}],
    ["S2 桌面主进程内(argv1=main.js)", ${JSON.stringify(desktopMain)}],
    ["S3 SDK内嵌无脚本(argv1=undefined)", undefined],
    ["S4 argv1指向不存在文件", ${JSON.stringify(path.join(here, "不存在-占位.js"))}],
  ];
  const out = [];
  for (const [name, value] of scenarios) {
    if (value === undefined) delete process.argv[1];
    else process.argv[1] = value;
    try {
      const inv = runner.defaultInvocation(["--mode", "json", "-p", "探针"]);
      out.push({ name, command: inv.command, argsHead: inv.args.slice(0, 2) });
    } catch (e) {
      out.push({ name, error: String(e.message || e).slice(0, 200) });
    }
  }
  process.argv[1] = realArgv1;
  console.log(JSON.stringify({ packageDir: getPackageDir(), scenarios: out }, null, 1));
  process.exit(0);
}).catch((e) => { console.error("PROBE_FAIL:" + e.message); process.exit(3); });
`;
const tmpProbe = path.join(os.tmpdir(), "pao-gate-path-probe-child.mjs");
writeFileSync(tmpProbe, probeSrc);

let failed = 0;
const res = spawnSync(process.execPath, [tmpProbe, kernelDir], { encoding: "utf8", timeout: 60000 });
if (res.status !== 0) {
  console.error(`探针启动失败 rc=${res.status}: ${(res.stderr ?? "").slice(0, 400)}`);
  process.exit(2);
}
const report = JSON.parse(res.stdout);
console.log(`getPackageDir() = ${report.packageDir}`);
for (const s of report.scenarios) {
  const fallsBack = s.command === "pao" || s.command === "pi";
  const verdict = fallsBack ? "RED" : "PASS";
  if (fallsBack) failed++;
  console.log(
    `[${verdict}] ${s.name}: ${s.error ? `抛错: ${s.error}` : `command=${s.command} argsHead=${JSON.stringify(s.argsHead)}`}`,
  );
}

// S5 打包产物 asar 可读性：ELECTRON_RUN_AS_NODE 的 electron 能否读 asar 内内核入口。
// 打包态 defaultInvocation 会解析到 asar 内 cli.js 并以 ELECTRON_RUN_AS_NODE spawn，
// 若 node 模式读不了 asar，打包态 worker/部长 spawn 全断——须在打包前知情。
if (existsSync(packagedAsar)) {
  const electronDir = path.join(repoRoot, "desktop", "node_modules", "electron");
  let electronExe = null;
  try {
    const { readFileSync } = await import("node:fs");
    electronExe = path.join(electronDir, "dist", readFileSync(path.join(electronDir, "path.txt"), "utf8").trim());
  } catch {}
  if (electronExe && existsSync(electronExe)) {
    const inner = path.join(packagedAsar, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "pao", "index.js");
    const r2 = spawnSync(electronExe, ["-e", "console.log(require('fs').existsSync(process.argv[1]))", inner], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const readable = (r2.stdout ?? "").includes("true");
    if (!readable) failed++;
    console.log(
      `[${readable ? "PASS" : "RED"}] S5 ELECTRON_RUN_AS_NODE 读 asar 内内核入口 → ${(r2.stdout ?? r2.status).toString().trim()}` +
        (readable ? "" : "（打包态 spawn asar 内 cli.js 会失败）"),
    );
  } else {
    console.log("[SKIP] S5: 桌面仓 electron 可执行文件不可用");
  }
} else {
  console.log(`[SKIP] S5: 无既有打包产物 ${packagedAsar}`);
}

process.exit(failed === 0 ? 0 : 1);
