// 只读诊断脚本：解析 Electron 目录下 electron.exe 的 PE 结构与编码特征。
// 用途：判断 node_modules/electron/dist/electron.exe 是不是真正的 Electron 可执行文件。
// 输入：命令行参数 1 = electron.exe 绝对路径（可选，默认取 desktop 下的）。
// 输出：stdout 打印JSON；不写任何文件、不修改任何东西。
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const target = resolve(
  process.argv[2] ??
    "D:/AI/workspace/pao-dev/desktop/node_modules/electron/dist/electron.exe",
);

const buf = readFileSync(target);
const out = { path: target, bytes: buf.length };

// ---- 文件头 / PE ----
out.mz = buf.subarray(0, 2).toString("latin1");
const peOff = buf.readUInt32LE(0x3c);
out.peOffset = peOff;
out.peSig = buf.subarray(peOff, peOff + 4).toString("latin1");
out.machine = "0x" + buf.readUInt16LE(peOff + 4).toString(16);
out.numberOfSections = buf.readUInt16LE(peOff + 6);
out.timeDateStamp = "0x" + buf.readUInt32LE(peOff + 8).toString(16);
const sizeOfOptHeader = buf.readUInt16LE(peOff + 20);
out.sizeOfOptionalHeader = sizeOfOptHeader;
const magic = buf.readUInt16LE(peOff + 24);
out.optMagic = "0x" + magic.toString(16); // 0x20b = PE32+

// ---- section table ----
const secStart = peOff + 24 + sizeOfOptHeader;
const secs = [];
for (let i = 0; i < out.numberOfSections; i++) {
  const o = secStart + i * 40;
  const name = buf.subarray(o, o + 8).toString("latin1").replace(/\0+$/, "");
  secs.push({
    index: i,
    name,
    nameHex: buf.subarray(o, o + 8).toString("hex"),
    virtualSize: buf.readUInt32LE(o + 8),
    virtualAddress: buf.readUInt32LE(o + 12),
    sizeOfRawData: buf.readUInt32LE(o + 16),
    pointerToRawData: buf.readUInt32LE(o + 20),
  });
}
out.sections = secs;
out.sectionNamesPrintable = secs.every((s) =>
  /^[.\w$@?]+$/.test(s.name) && s.name.length > 0,
);

// ---- 编码密度：分块统计 ASCII 可打印 / UTF-16LE(高字节为0) ----
function encDensity(start, len) {
  let pairs = 0;
  let nulHigh = 0;
  let ascii = 0;
  const end = Math.min(buf.length, start + len);
  for (let i = start; i + 1 < end; i += 2) {
    pairs++;
    if (buf[i + 1] === 0) nulHigh++;
  }
  for (let i = start; i < end; i++) {
    if (buf[i] >= 0x20 && buf[i] < 0x7f) ascii++;
  }
  const n = end - start;
  return {
    sampled: n,
    pairs,
    nulHighPct: pairs ? +((100 * nulHigh) / pairs).toFixed(2) : null,
    asciiPct: n ? +((100 * ascii) / n).toFixed(2) : null,
  };
}
out.wholeFile = encDensity(0, buf.length);

// ---- 流式扫描标记（ASCII 与 UTF-16LE 两套）----
const markers = [
  "Electron Framework",
  "chrome_elf",
  "v8_context_snapshot",
  "snapshot_blob",
  "libnode",
  "NODE_MODULE_VERSION",
  "ELECTRON_RUN_AS_NODE",
  "electron.asar",
  "remote-debugging-port",
  "--inspect",
  "app.asar",
  "Chrome Legacy Window",
  "Chrome_RenderWidgetHostHWND",
  "icudtl.dat",
  "Default Browser Helper",
];
const hits = {};
function scan(encName, decoder, stepPairs) {
  const text = decoder();
  for (const m of markers) {
    let idx = text.indexOf(m);
    const positions = [];
    while (idx >= 0 && positions.length < 3) {
      positions.push(encName === "utf16le" ? idx * 2 : idx);
      idx = text.indexOf(m, idx + 1);
    }
    if (positions.length) {
      hits[m] ??= {};
      hits[m][encName] = positions.map((p) => "0x" + p.toString(16));
    }
  }
}
// ASCII（latin1 逐字节映射，避免任何多字节误解码）
scan("ascii", () => buf.toString("latin1"), 1);
// UTF-16LE：手工解码，避免 TextDecoder 对非法序列的替换
{
  const chars = new Array((buf.length / 2) | 0);
  for (let i = 0, j = 0; i + 1 < buf.length; i += 2, j++) {
    chars[j] = String.fromCharCode(buf[i] | (buf[i + 1] << 8));
  }
  const text = chars.join("");
  for (const m of markers) {
    const wide = [...m].map((c) => c + "\0").join("");
    let idx = text.indexOf(wide);
    const positions = [];
    while (idx >= 0 && positions.length < 3) {
      positions.push("0x" + (idx * 2).toString(16));
      idx = text.indexOf(wide, idx + 1);
    }
    if (positions.length) {
      hits[m] ??= {};
      hits[m].utf16le = positions;
    }
  }
}
out.markerHits = hits;

// ---- 版本资源片段（UTF-16LE 字符串）----
function wideSearch(term) {
  const wide = [...term].map((c) => c + "\0").join("");
  const chars = new Array((buf.length / 2) | 0);
  for (let i = 0, j = 0; i + 1 < buf.length; i += 2, j++) {
    chars[j] = String.fromCharCode(buf[i] | (buf[i + 1] << 8));
  }
  const text = chars.join("");
  const idx = text.indexOf(wide);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 32);
  return text.slice(start, Math.min(text.length, idx + wide.length + 64)).replace(/\0/g, "\u00b7");
}
out.versionStrings = {};
for (const t of ["FileDescription", "FileVersion", "InternalName", "ProductName", "ProductVersion", "CompanyName", "OriginalFilename"]) {
  out.versionStrings[t] = wideSearch(t);
}

// ---- 哈希 ----
out.sha256 = createHash("sha256").update(buf).digest("hex");
out.mtime = statSync(target).mtime.toISOString();
out.ctime = statSync(target).ctime.toISOString();

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
