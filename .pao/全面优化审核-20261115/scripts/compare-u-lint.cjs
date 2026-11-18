const fs = require("node:fs");
const path = require("node:path");

const checks = path.resolve(__dirname, "../checks");
let file = "";
const baseline = [];
for (const line of fs.readFileSync(path.join(checks, "D-final-lint-complete.log"), "utf8").split(/\r?\n/)) {
  if (/^[A-Za-z]:\\/.test(line)) {
    file = line.trim().toLowerCase();
    continue;
  }
  const row = line.match(/^\s*\d+:\d+\s+(error|warning)\s+(.*?)\s*$/);
  if (!row) continue;
  const rule = row[2].match(/\s{2,}([@\w/-]+)$/);
  baseline.push({
    file,
    severity: row[1] === "error" ? 2 : 1,
    message: rule ? row[2].slice(0, rule.index).trimEnd() : row[2],
    ruleId: rule ? rule[1] : null,
  });
}
const current = JSON.parse(fs.readFileSync(path.join(checks, "U-final-lint.json"), "utf8"))
  .flatMap((entry) => entry.messages.map((message) => ({
    file: entry.filePath.toLowerCase(),
    severity: message.severity,
    message: message.message.replace(/([^ ])\.$/u, "$1"),
    ruleId: message.ruleId,
  })));
const remaining = [...baseline];
const added = [];
for (const row of current) {
  const index = remaining.findIndex((previous) =>
    previous.file === row.file && previous.severity === row.severity &&
    previous.message === row.message && previous.ruleId === row.ruleId);
  if (index === -1) added.push(row);
  else remaining.splice(index, 1);
}
const result = { baseline: baseline.length, current: current.length, added, removed: remaining };
fs.writeFileSync(path.join(checks, "U-lint-comparison.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ baseline: result.baseline, current: result.current, added: added.length, removed: remaining.length }));
if (added.length) process.exitCode = 1;
