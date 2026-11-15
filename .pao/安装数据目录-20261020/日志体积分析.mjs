// 用途：只读分析历史执行日志膨胀来源；输入：项目 .pao；输出：数字统计，不输出日志正文。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
const outputDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(outputDir, '..');
function findLogs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? findLogs(path) : entry.isFile() && entry.name.endsWith('.live.jsonl') ? [path] : [];
  });
}
const bytes = value => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
const types = {};
const updateFields = {};
const updateSubtypes = {};
const files = [];
let totalBytes = 0, gzipBytes = 0, invalidLines = 0, snapshotBytes = 0, partialBytes = 0, deltaBytes = 0;
for (const path of findLogs(root)) {
  const raw = readFileSync(path);
  const compressedBytes = gzipSync(raw).length;
  totalBytes += raw.length;
  gzipBytes += compressedBytes;
  let lineCount = 0;
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    lineCount++;
    let event;
    try { event = JSON.parse(line); } catch { invalidLines++; continue; }
    const type = event.type ?? 'unknown';
    const row = types[type] ??= { count: 0, bytes: 0, keys: Object.keys(event) };
    row.count++;
    row.bytes += Buffer.byteLength(line) + 1;
    if (type === 'message_update') {
      for (const [key, value] of Object.entries(event)) updateFields[key] = (updateFields[key] ?? 0) + bytes(value);
      const subtype = event.assistantMessageEvent?.type ?? 'unknown';
      updateSubtypes[subtype] = (updateSubtypes[subtype] ?? 0) + 1;
      snapshotBytes += bytes(event.message);
      partialBytes += bytes(event.assistantMessageEvent?.partial);
      deltaBytes += bytes(event.assistantMessageEvent?.delta);
    }
  }
  files.push({ path, bytes: raw.length, gzipBytes: compressedBytes, lines: lineCount });
}
const result = { files: files.length, totalBytes, gzipBytes, invalidLines,
  messageUpdateFields: { snapshotBytes, partialBytes, deltaBytes, updateFields, updateSubtypes },
  eventTypes: Object.entries(types).sort((a, b) => b[1].bytes - a[1].bytes),
  largestFiles: files.sort((a, b) => b.bytes - a.bytes).slice(0, 5) };
writeFileSync(join(outputDir, '日志体积分析.json'), JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result, null, 2));
