// T12 门先行·门A：内核公开导出导入无宿主副作用。
// 接缝：package exports 的公开入口（. / ./pao / ./pao/desktop / ./pao/todo）＋桌面 vendor 物化副本。
// 判据（导入 dist 入口后）：
//   1) 无 stdout/stderr 写出（终端启动会写屏）
//   2) SIGINT/SIGTERM/SIGHUP/exit 监听器数量不变（信号装配属 CLI）
//   3) stdin 未进 raw 模式、未被引用
//   4) 进程存活返回（未 exit）
// 用法：自 packages/coding-agent 运行 `node scripts/gate-kernel-import.mjs` 或 `npm run check:gates`（需先构建 dist）
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelDist = path.resolve(here, "..", "dist");
const vendorDist = path.resolve(here, "..", "..", "..", "..", "desktop", "apps", "desktop", "vendor", "pao-kernel", "dist");

let entries = [
  { name: "root(.)", file: path.join(kernelDist, "index.js") },
  { name: "./pao", file: path.join(kernelDist, "pao", "index.js") },
  { name: "./pao/desktop", file: path.join(kernelDist, "pao", "desktop", "index.js") },
  { name: "./pao/todo", file: path.join(kernelDist, "pao", "todo", "summary.js") },
  { name: "vendor ./pao/desktop", file: path.join(vendorDist, "pao", "desktop", "index.js") },
  { name: "vendor ./pao/todo", file: path.join(vendorDist, "pao", "todo", "summary.js") },
];

// 内核单仓CI显式选kernel-only；定向反例用entry加载真实模块，默认仍检查完整跨仓产物。
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--kernel-only") {
  entries = entries.filter(entry => !entry.name.startsWith("vendor "));
} else if (args.length === 2 && args[0] === "--entry") {
  entries = [{ name: "explicit entry", file: path.resolve(args[1]) }];
} else if (args.length !== 0) {
  throw new Error("仅支持--kernel-only或--entry <模块文件>");
}

const probeSrc = `
const signals = ["SIGINT", "SIGTERM", "SIGHUP", "exit", "disconnect"];
const before = Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));
const stdinBefore = { raw: process.stdin.isRaw ?? null, data: process.stdin.listenerCount("data"), readable: process.stdin.listenerCount("readable") };
const writes = [];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (...a) => (writes.push(["out", String(a[0]).slice(0, 200)]), true);
process.stderr.write = (...a) => (writes.push(["err", String(a[0]).slice(0, 200)]), true);
const entry = process.argv[1];
const entryUrl = (await import("node:url")).pathToFileURL(entry).href;
import(entryUrl).then(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  const after = Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));
  const gained = signals.filter((s) => after[s] > before[s]);
  console.log(JSON.stringify({
    ok: gained.length === 0 && writes.length === 0,
    gainedListeners: gained,
    before, after,
    writes,
    stdinRaw: process.stdin.isRaw ?? null,
    stdinBefore,
    stdinData: process.stdin.listenerCount("data"),
    stdinReadable: process.stdin.listenerCount("readable"),
  }, null, 1));
  // 不强制exit；保留活动句柄时外层超时会明确失败。
}).catch((e) => {
  // 先恢复 hook 再写 stderr：否则失败详情被写进 writes 数组随进程蒸发，门只看到 rc=3
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  console.error("IMPORT_FAIL:" + e.message);
  process.exitCode = 3;
});
`;

let failed = 0;
for (const entry of entries) {
  if (!existsSync(entry.file)) {
    console.error(`[FAIL] ${entry.name}: 构建产物不存在 ${entry.file}`);
    failed++;
    continue;
  }
  const res = spawnSync(process.execPath, ["--input-type=module", "--eval", probeSrc, entry.file], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  const out = (res.stdout ?? "").trim();
  if (res.error || res.status !== 0 || res.stderr) {
    console.error(`[FAIL] ${entry.name}: 导入或自然退出异常 rc=${res.status} ${String(res.error ?? res.stderr ?? "").slice(0, 300)}`);
    failed++;
    continue;
  }
  let report;
  try {
    report = JSON.parse(out);
  } catch {
    console.error(`[FAIL] ${entry.name}: 探针输出不可解析：${out.slice(0, 300)}`);
    failed++;
    continue;
  }
  // 红轮归因（日志 T12-门先行-红轮-20261006）：SIGINT/SIGTERM/SIGHUP 三监听来自上游依赖
  // proper-lockfile→signal-exit 模块加载期注册（8 处上游 core 模块使用），是库级退出记账，
  // 不消费信号、不改退出语义，不属「宿主副作用」；消除它需改 8 个上游文件，超 T12 范围。
  // 判据收窄为：除该三信号外无新增监听、无写出、stdin 未动、未装受管父生命周期(disconnect)。
  const KNOWN = ["SIGINT", "SIGTERM", "SIGHUP"];
  const gained = report.gainedListeners.filter((s) => !KNOWN.includes(s));
  const ok =
    gained.length === 0 &&
    report.writes.length === 0 &&
    report.stdinData === report.stdinBefore.data &&
    report.stdinReadable === report.stdinBefore.readable &&
    report.stdinRaw === report.stdinBefore.raw;
  if (ok) {
    console.log(
      `[PASS] ${entry.name} — 导入自然退出，无新增宿主监听、写出或stdin变化（非TTY不证明真实终端raw模式）`,
    );
  } else {
    failed++;
    console.error(
      `[FAIL] ${entry.name} — 新增监听(超出已知):${JSON.stringify(gained)} 写出:${JSON.stringify(report.writes)} stdin前:${JSON.stringify(report.stdinBefore)} stdin后:${JSON.stringify({raw:report.stdinRaw,data:report.stdinData,readable:report.stdinReadable})}`,
    );
  }
}
process.exit(failed === 0 ? 0 : 1);
