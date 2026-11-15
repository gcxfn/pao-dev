/**
 * H2 ConPTY 纯 Node 探针（不启动 Electron、不弹窗）
 *
 * 用途：在**没有 Electron 窗口**的前提下，用普通 Node 直接加载 `node-pty`，
 *      验证桌面端集成终端的底层行为。依据：`apps/desktop/electron/platform/terminal-service.ts:1`
 *      是 `import type { WebContents } from "electron"`（纯类型导入、运行时擦除），
 *      真正加载原生插件的是 `:536 require("node-pty")`，因此不需要 Electron ABI。
 *
 * 输入：无（自动定位 `desktop/node_modules/node-pty`）
 * 输出：stdout 三组探针的结论行 + 一行 `H2_PROBE {json}`
 *
 * 跑法：
 *   node "D:\AI\workspace\pao-dev\.pao\harness完善-20261017\H批-集成交付\探针-conpty.mjs"
 *
 * 注意：本脚本在**无 tty 宿主**下运行（`node xxx.mjs`），因此 node-pty 内部的
 *      `conpty_console_list_agent.js` 会因 AttachConsole 失败而报错——这是**环境现象**，
 *      不是桌面端产品行为，结论里单列，不计入探针失败。
 */

import { createRequire } from "node:module";
import path from "node:path";

const DESKTOP_ROOT = "D:\\AI\\workspace\\pao-dev\\desktop";
const require = createRequire(path.join(DESKTOP_ROOT, "package.json"));
const pty = require("node-pty");

const COMSPEC = process.env.ComSpec || "cmd.exe";
const CWD = "D:\\AI\\workspace\\pao-dev\\.pao";
const results = {};

/** 从 raw 流里按“可见文本”提取 mode con 的行列。
 *  注意：小窗口下 cmd 会把输出折行并插入光标定位序列，所以这里用
 *  「去掉所有 ESC 序列后再拼接线尾」的容错做法，而不是简单正则匹配连续文本。 */
function extractSize(raw) {
  const visible = raw
    .replace(/\u001b\][^\u0007]*\u0007/g, "") // OSC
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "") // CSI
    .replace(/\r/g, "");
  const rows = (visible.match(/行:[^\d]*(\d+)/) || [])[1];
  const cols = (visible.match(/列:[^\d]*(\d+)/) || [])[1];
  return { rows: rows === undefined ? undefined : Number(rows), cols: cols === undefined ? undefined : Number(cols) };
}

function probeExit() {
  return new Promise((resolve) => {
    const out = [];
    const p = pty.spawn(COMSPEC, ["/c", "echo CONPTY_PROBE_OK"], {
      cols: 80,
      rows: 24,
      cwd: CWD,
      env: process.env,
    });
    p.onData((d) => out.push(d));
    p.onExit((e) => {
      const text = out.join("");
      resolve({
        exitEventKeys: Object.keys(e).sort(),
        exitCode: e.exitCode,
        hasSignalKey: Object.prototype.hasOwnProperty.call(e, "signal"),
        signal: e.signal,
        outputContainsToken: text.includes("CONPTY_PROBE_OK"),
        rawHead: JSON.stringify(text.slice(0, 160)),
      });
    });
    setTimeout(() => resolve({ timeout: true }), 15000);
  });
}

function probeSize(cols, rows) {
  return new Promise((resolve) => {
    const out = [];
    const p = pty.spawn(COMSPEC, ["/k"], { cols, rows, cwd: CWD, env: process.env });
    p.onData((d) => out.push(d));
    setTimeout(() => p.write("mode con\r"), 700);
    setTimeout(() => {
      const size = extractSize(out.join(""));
      resolve({
        requested: { cols, rows },
        reported: size,
        match: size.cols === cols && size.rows === rows,
      });
      try {
        p.kill();
      } catch {
        /* 无 tty 环境下 kill 可能失败，不影响尺寸结论 */
      }
    }, 3200);
    setTimeout(() => resolve({ requested: { cols, rows }, timeout: true, match: false }), 15000);
  });
}

const t0 = Date.now();
results.exit = await probeExit();
results.size100x30 = await probeSize(100, 30);
results.size500x200 = await probeSize(500, 200);
results.size10x4 = await probeSize(10, 4);
results.elapsedMs = Date.now() - t0;

console.log("=== 探针 1：spawn + 退出码 ===");
console.log(JSON.stringify(results.exit, null, 2));
for (const key of ["size100x30", "size500x200", "size10x4"]) {
  console.log(`=== 探针 2：窗口尺寸 ${key} ===`);
  console.log(JSON.stringify(results[key], null, 2));
}
console.log("H2_PROBE " + JSON.stringify(results));
