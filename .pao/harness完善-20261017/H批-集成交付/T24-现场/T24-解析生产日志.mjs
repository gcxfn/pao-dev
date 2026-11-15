/**
 * 用途：解析 T24 production 车道两份日志（旧包 / 新包），产出报告用的逐条表。
 * 输入：命令行参数为日志路径（可多个）。
 * 输出：每个日志的字节数/编码/收尾统计行/失败条数，以及每条失败的 spec:行号 + 用例名 + 首错行。
 * 说明：Playwright line reporter 在 Windows 上重定向出来是 UTF-16LE+BOM，必须按 Unicode 解码，
 *       且要先剥 ANSI 转义（reporter 会把 ESC 插进单词中间做局部重绘）。
 */
import fs from "node:fs";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function readLog(logPath) {
  const bytes = fs.readFileSync(logPath);
  const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const text = utf16
    ? bytes.subarray(2).toString("utf16le")
    : bytes.toString("utf8").replace(/^\uFEFF/, "");
  return { bytes: bytes.length, utf16, text };
}

const strip = (line) => line.replace(ANSI, "").replace(/\r$/, "");

for (const logPath of process.argv.slice(2)) {
  const { bytes, utf16, text } = readLog(logPath);
  const lines = text.split("\n").map(strip);
  const summaryLines = lines.filter((l) => /^\s*\d+\s+(passed|failed|skipped|did not run)/.test(l) || /(passed|failed|skipped).*\(\d/.test(l) && /^\s*\d+/.test(l));
  const failures = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(/^\s*(\d+)\)\s+(.*\S)\s*$/);
    if (!header) continue;
    const body = [];
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j += 1) {
      const line = lines[j].trimEnd();
      if (/^\s*\d+\)\s+/.test(line)) break;
      if (line.trim()) body.push(line.trim());
      if (body.length >= 6) break;
    }
    failures.push({ index: Number(header[1]), title: header[2], body });
  }
  console.log("=".repeat(70));
  console.log("LOG " + logPath);
  console.log(JSON.stringify({ bytes, utf16, summaryLines: summaryLines.slice(-4), failureCount: failures.length }, null, 2));
  for (const failure of failures) {
    console.log(`#${failure.index} ${failure.title}`);
    for (const line of failure.body) console.log("    " + line);
  }
}
