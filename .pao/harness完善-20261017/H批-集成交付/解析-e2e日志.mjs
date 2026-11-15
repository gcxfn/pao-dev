// 用途：解析 Playwright line reporter 的 E2E 日志，剥掉 ANSI，抽出逐条失败块。
// 输入：日志文件绝对路径（argv[2]）
// 输出：stdout 上的 JSON（failures + 计数 + 进度）
// 说明：日志文件在 playwright 运行期间被独占，故用 FileShare 方式由调用方先复制；本脚本用 readFileSync 读副本。
//       为免踩坑，本脚本不自己处理共享读——由调用方先把日志快照到一个临时副本再传给本脚本。
import fs from "node:fs";

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: node 解析-e2e日志.mjs <logfile>");
  process.exit(2);
}

// Windows 上 Playwright line reporter 的重定向输出是 **UTF-16LE + BOM（FF FE）**：
// 直接 readFileSync(...,"utf8") 会得到每个字符间夹 NUL 的乱码，任何正则都数不到东西。
// 所以先看 BOM 再决定解码方式。
const bytes = fs.readFileSync(logPath);
const raw =
  bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString("utf16le")
    : bytes.toString("utf8").replace(/^\uFEFF/, "");
const clean = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const lines = clean.split(/\r?\n/);

const prog = [...clean.matchAll(/\[(\d+)\/(\d+)\]/g)];
const lastProg = prog.length ? prog[prog.length - 1][0] : "-";
const total = prog.length ? Number(prog[prog.length - 1][2]) : null;

const isHeader = (l) => /^\s*\d+\)\s+\S*spec\.ts/.test(l);
const isProgress = (l) => /^\[\d+\/\d+\]/.test(l);
const isNoise = (l) =>
  /^\(node:\d+\)\s+Warning:/.test(l) ||
  /^\(Use `node --trace-warnings/.test(l);

const starts = [];
lines.forEach((l, i) => {
  if (isHeader(l)) starts.push(i);
});

const failures = [];
for (let k = 0; k < starts.length; k++) {
  const i = starts[k];
  const header = lines[i].trim();
  const m = header.match(/^(\d+)\)\s+(.*?spec\.ts):(\d+):(\d+)\s+›\s+(.*?)\s*$/);
  const block = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (isHeader(l) || isProgress(l) || isNoise(l)) break;
    if (/^\s*[─]{5,}\s*$/.test(l)) break;
    block.push(l);
  }

  // 首个错误行：优先找 Error/TimeoutError 之类
  let firstError = "";
  for (const l of block) {
    if (/^\s{2,}(Error|TimeoutError|AssertionError|Test timeout|Test ended|expect\b)/.test(l)) {
      firstError = l.trim();
      break;
    }
  }
  if (!firstError) {
    for (const l of block) {
      if (l.trim() && !/^\s*\d+\s*\|/.test(l) && !/^\s*at\s/.test(l)) {
        firstError = l.trim();
        break;
      }
    }
  }

  // 用户代码定位行（at ...spec.ts:NNN:CC）
  let atLine = "";
  for (const l of block) {
    const a = l.match(/^\s*at .*?(spec\.ts:\d+:\d+)/);
    if (a) {
      atLine = a[1];
      break;
    }
  }

  // 附件目录
  const attachments = [];
  for (const l of block) {
    const p = l.match(/apps\\desktop\\test-results\\[^\s]+/);
    if (p) attachments.push(p[0]);
  }

  failures.push({
    index: m ? Number(m[1]) : k + 1,
    spec: m ? m[2] : "",
    line: m ? Number(m[3]) : null,
    col: m ? Number(m[4]) : null,
    name: m ? m[5] : header,
    firstError,
    atLine,
    attachments: [...new Set(attachments)],
  });
}

const bySpec = {};
for (const f of failures) {
  const key = f.spec.replace(/^apps\\desktop\\tests\\core\\/, "");
  bySpec[key] = (bySpec[key] || 0) + 1;
}

console.log(
  JSON.stringify(
    {
      logPath,
      logBytes: fs.statSync(logPath).size,
      progress: lastProg,
      total,
      failureCount: failures.length,
      bySpec,
      failures,
    },
    null,
    2,
  ),
);
