/**
 * 用途：为 T24 报告取「新包（2026-10-17 22:24:12）」的实测数字。
 * 输入：D:\AI\workspace\pao-dev\desktop\apps\desktop\release\win-unpacked
 * 输出：解包目录文件数/体积、PAO.exe、resources\app.asar、asar 内内核文件 SHA256，
 *       以及开发仓同路径文件的 SHA256（用于「包内核 == 仓内核」比对）。
 * 只读，不写入任何仓内文件（仅读 + 打印）。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const asar = require("D:/AI/workspace/pao-dev/desktop/node_modules/@electron/asar");

const REL = "D:/AI/workspace/pao-dev/desktop/apps/desktop/release";
const UNPACKED = path.join(REL, "win-unpacked");
const ASAR = path.join(UNPACKED, "resources", "app.asar");
const EXE = path.join(UNPACKED, "PAO.exe");
// asar.listPackage 的路径带前导反斜杠；内核落在打包进 asar 的 pi-coding-agent 包内。
const KERNEL_REL = "\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\pao\\usage\\budget-command.js";
const DEV_KERNEL = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/pao/usage/budget-command.js";

function walk(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walk(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();

const unpacked = walk(UNPACKED);
const exe = fs.statSync(EXE);
const asarStat = fs.statSync(ASAR);

const kernelInAsar = (() => {
  const entry = asar.listPackage(ASAR).find((p) => /budget-command\.js$/.test(p));
  if (!entry) throw new Error("budget-command.js not found in asar");
  const candidates = [entry, entry.replace(/^[\\/]+/, ""), entry.replace(/\\/g, "/"), entry.replace(/^[\\/]+/, "").replace(/\\/g, "/")];
  let lastError;
  for (const candidate of candidates) {
    try {
      const buf = asar.extractFile(ASAR, candidate);
      console.log("KERNEL_ASAR_PATH_USED=" + candidate);
      return buf;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
})();
const asarEntryCount = asar.listPackage(ASAR).length;
const devKernel = fs.readFileSync(DEV_KERNEL);

const header = Buffer.alloc(16);
const fd = fs.openSync(ASAR, "r");
fs.readSync(fd, header, 0, 16, 0);
fs.closeSync(fd);

const out = {
  releaseDir: REL,
  unpackedFiles: unpacked.files,
  unpackedBytes: unpacked.bytes,
  unpackedMiB: Number((unpacked.bytes / 1024 / 1024).toFixed(1)),
  paoExe: { bytes: exe.size, mtime: exe.mtime.toISOString() },
  appAsar: { bytes: asarStat.size, mtime: asarStat.mtime.toISOString() },
  asarHeader: header.toString("latin1"),
  asarEntryCount,
  kernelPathInAsar: KERNEL_REL,
  kernelInAsar: { bytes: kernelInAsar.length, sha256: sha(kernelInAsar) },
  devKernel: { path: DEV_KERNEL, bytes: devKernel.length, sha256: sha(devKernel) },
  kernelIdentical: sha(kernelInAsar) === sha(devKernel),
};
console.log(JSON.stringify(out, null, 2));
