/**
 * 用途：T24 报告 §包内容与仓内容一致性——逐文件比对「打包进 asar 的文件」与开发仓同路径文件。
 * 只读。输入：
 *   包：D:\AI\workspace\pao-dev\desktop\apps\desktop\release\win-unpacked\resources\app.asar
 *   仓：PAO/packages/coding-agent/、desktop/packages/*、desktop/apps/desktop/out/
 * 输出：每组的计数（相同/不同/仓内缺失）+ 前 20 条差异明细。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const asar = require("D:/AI/workspace/pao-dev/desktop/node_modules/@electron/asar");

const ASAR = "D:/AI/workspace/pao-dev/desktop/apps/desktop/release/win-unpacked/resources/app.asar";
const GROUPS = [
  { label: "内核 @earendil-works/pi-coding-agent", asarPrefix: "node_modules/@earendil-works/pi-coding-agent/", repoRoot: "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/" },
  { label: "应用自身构建产物 out/", asarPrefix: "out/", repoRoot: "D:/AI/workspace/pao-dev/desktop/apps/desktop/out/" },
  { label: "工作区包 @pi-gui/extension-ui", asarPrefix: "node_modules/@pi-gui/extension-ui/", repoRoot: "D:/AI/workspace/pao-dev/desktop/packages/extension-ui/" },
  { label: "工作区包 @pi-gui/session-driver", asarPrefix: "node_modules/@pi-gui/session-driver/", repoRoot: "D:/AI/workspace/pao-dev/desktop/packages/session-driver/" },
  { label: "工作区包 @pi-gui/catalogs", asarPrefix: "node_modules/@pi-gui/catalogs/", repoRoot: "D:/AI/workspace/pao-dev/desktop/packages/catalogs/" },
  { label: "工作区包 @pi-gui/pi-sdk-driver", asarPrefix: "node_modules/@pi-gui/pi-sdk-driver/", repoRoot: "D:/AI/workspace/pao-dev/desktop/packages/pi-sdk-driver/" },
];

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
const normalize = (p) => p.replace(/^[\\/]+/, "").replace(/\\/g, "/");
// extractFile 需要 Windows 反斜杠分隔（本机 path.sep）且不带前导分隔符；比对用正斜杠。
const entries = asar.listPackage(ASAR).map((p) => ({
  raw: p.replace(/^[\\/]+/, ""),
  norm: normalize(p),
}));

const summary = [];
for (const { label, asarPrefix, repoRoot } of GROUPS) {
  const mine = entries.filter((e) => e.norm.startsWith(asarPrefix));
  let identical = 0;
  let different = 0;
  let missingInRepo = 0;
  let directories = 0;
  const differences = [];
  for (const entry of mine) {
    const rel = entry.norm.slice(asarPrefix.length);
    const repoPath = path.join(repoRoot, rel);
    if (!fs.existsSync(repoPath)) {
      missingInRepo += 1;
      if (differences.length < 20) differences.push({ rel, kind: "missing-in-repo" });
      continue;
    }
    if (fs.statSync(repoPath).isDirectory()) {
      directories += 1;
      continue;
    }
    let packed;
    try {
      packed = asar.extractFile(ASAR, entry.raw);
    } catch (error) {
      different += 1;
      if (differences.length < 20) differences.push({ rel, kind: "extract-failed", detail: String(error && error.message) });
      continue;
    }
    const repo = fs.readFileSync(repoPath);
    if (sha(packed) === sha(repo) && packed.length === repo.length) {
      identical += 1;
    } else {
      different += 1;
      if (differences.length < 20) differences.push({ rel, kind: "content-differs", packedBytes: packed.length, repoBytes: repo.length });
    }
  }
  summary.push({ label, entries: mine.length, directories, identical, different, missingInRepo, differences });
}

console.log(JSON.stringify(summary, null, 2));

const topLevel = new Map();
for (const entry of entries) {
  const first = entry.norm.split("/")[0];
  topLevel.set(first, (topLevel.get(first) ?? 0) + 1);
}
console.log("ASAR_TOP_LEVEL=" + JSON.stringify([...topLevel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)));
console.log("ASAR_TOTAL_ENTRIES=" + entries.length);
