// D6 发行：把 fork 内核与其 @earendil-works 兄弟运行时物化到桌面仓 vendor/。
// - vendor/pao-kernel/：fork 内核本体（package.json＋dist）——打包异机/无 fork 目录时的
//   兜底材料＋版本冻结证据。开发态不使用（pnpm overrides link 即时联动）。
// - vendor/pao-runtime/node_modules/@earendil-works/*：内核的兄弟运行时包（按 fork
//   package.json dependencies 推导，如 pi-agent-core/pi-ai/pi-tui/pi-mcp/pi-codemode）。
//   这些包装在 PAO 仓自己的 workspace 里，桌面端 workspace 解析不到，electron-builder
//   的 node-module-collector 收不进 asar（打包产物运行时 import 会缺）——由本脚本从
//   PAO 仓按其锁定的版本物化，electron-builder.yml 以 files→node_modules 并进 asar
//   （同源字节，不走 registry、不引版本漂移）。
// 打包冒烟由 assert-packaged-runtime-deps.mjs fail-closed 把关（asar 缺 pao 定制即失败）。
//
// 用法：node scripts/vendor-pao-kernel.mjs
//   前置：fork 已跑过 pnpm build:offline（dist 完整）＋PAO 仓已 pnpm install；否则退出码 1。
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const forkRoot = path.resolve(desktopDir, "..", "..", "..", "PAO");
const forkKernelDir = path.join(forkRoot, "packages", "coding-agent");
const vendorDir = path.join(desktopDir, "vendor", "pao-kernel");
const runtimeVendorDir = path.join(desktopDir, "vendor", "pao-runtime", "node_modules");

const distDir = path.join(forkKernelDir, "dist");
const paoEntry = path.join(distDir, "pao", "index.js");
if (!existsSync(paoEntry)) {
  console.error(
    `[vendor-pao-kernel] fork 内核未构建或缺失：${paoEntry} 不存在。` +
      "先在 fork 根跑 pnpm build:offline 再重试。",
  );
  process.exit(1);
}

// ---- 陈旧 dist 门（修复波2 P1）：内核源码（src/**＋package.json）任一文件比 dist 全部产物都新
// ＝ dist 陈旧，fail-closed 拒绝物化——改了内核没重跑 build:offline 时，本地打包在此被拒，
// 过期内核产物不可能静默进安装包。判据用 mtime。本门面向「本机开发树改了 src 忘重建」：
// fresh clone/CI 没有已构建的 dist，在本脚本更早的 paoEntry 存在性检查处即失败（dist 不入库），
// 到不了这里的 mtime 比较，属预期。兄弟运行时包按 PAO 仓 node_modules 现状物化，
// 其源码新鲜度不在本门范围。
const newestUnder = (dir) => {
  let newest = { file: null, mtime: 0 };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const info = statSync(full);
    if (info.isDirectory()) {
      const nested = newestUnder(full);
      if (nested.mtime > newest.mtime) newest = nested;
    } else if (info.mtimeMs > newest.mtime) newest = { file: full, mtime: info.mtimeMs };
  }
  return newest;
};
const kernelSrcDir = path.join(forkKernelDir, "src");
if (!existsSync(kernelSrcDir)) {
  console.error(`[vendor-pao-kernel] fork 内核目录布局异常：${kernelSrcDir} 不存在。`);
  process.exit(1);
}
const kernelManifest = path.join(forkKernelDir, "package.json");
const manifestMtime = statSync(kernelManifest).mtimeMs;
const newestSource = newestUnder(kernelSrcDir);
const newestDist = newestUnder(distDir);
const sourceStamp = Math.max(newestSource.mtime, manifestMtime);
if (sourceStamp > newestDist.mtime) {
  const offender = manifestMtime > newestSource.mtime ? kernelManifest : newestSource.file;
  console.error(
    `[vendor-pao-kernel] 内核 dist 陈旧：${offender} 比最新 dist 产物（${newestDist.file}）新。` +
      "先在 fork 根跑 pnpm build:offline 再打包；陈旧产物不进包。",
  );
  process.exit(1);
}

cpSync(path.join(forkKernelDir, "package.json"), path.join(vendorDir, "package.json"), {
  force: true,
});
cpSync(distDir, path.join(vendorDir, "dist"), { recursive: true, force: true });

// ---- 兄弟运行时物化（D6：collector 收不到跨仓 link 的依赖树） ----
const forkPkg = JSON.parse(readFileSync(path.join(forkKernelDir, "package.json"), "utf8"));
const siblingNames = Object.keys(forkPkg.dependencies ?? {}).filter(
  (name) => name.startsWith("@earendil-works/") && name !== "@earendil-works/pi-coding-agent",
);

rmSync(runtimeVendorDir, { recursive: true, force: true });
for (const name of siblingNames) {
  // PAO workspace 顶层是符号链接（.pnpm 店），必须 dereference 拷真身
  const src = path.join(forkRoot, "node_modules", name);
  if (!existsSync(src)) {
    console.error(`[vendor-pao-kernel] PAO 仓缺兄弟运行时包：${src}。先在 PAO 根跑 pnpm install。`);
    process.exit(1);
  }
  cpSync(src, path.join(runtimeVendorDir, name), {
    recursive: true,
    force: true,
    dereference: true,
  });
}

// ---- 缺失依赖补扫：内核＋兄弟的直接依赖里，桌面仓完全解析不到的包从 PAO 仓补拷 ----
// （版本错位不在此处理——那类由 pnpm-workspace.yaml overrides 对齐，避免与 collector
// 收录的同名包在 asar 里打架；assert-packaged-runtime-deps 的版本游走会兜底报错。）
const desktopRootModules = path.resolve(desktopDir, "..", "..", "node_modules");
const vendorNames = new Set(["@earendil-works/pi-coding-agent", ...siblingNames]);
const sweepSources = [
  path.join(forkKernelDir, "package.json"),
  ...siblingNames.map((name) => path.join(runtimeVendorDir, name, "package.json")),
];
const extraNames = new Set();
for (const manifestPath of sweepSources) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (vendorNames.has(name) || extraNames.has(name)) continue;
    if (existsSync(path.join(desktopRootModules, name))) continue;
    if (!existsSync(path.join(forkRoot, "node_modules", name))) continue;
    extraNames.add(name);
  }
}
for (const name of extraNames) {
  cpSync(path.join(forkRoot, "node_modules", name), path.join(runtimeVendorDir, name), {
    recursive: true,
    force: true,
    dereference: true,
  });
}

let total = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else total += statSync(full).size;
  }
};
walk(path.join(vendorDir, "dist"));
walk(runtimeVendorDir);
console.log(
  `[vendor-pao-kernel] 已物化：kernel dist＋${siblingNames.length} 个兄弟运行时（${siblingNames.join("、")}）` +
    `${extraNames.size > 0 ? `＋缺失补扫 ${extraNames.size} 包（${[...extraNames].join("、")}）` : ""}，合计约 ${(total / 1024 / 1024).toFixed(1)} MB。`,
);
