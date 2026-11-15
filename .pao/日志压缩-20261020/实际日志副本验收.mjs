// 用途：对历史日志的隔离副本验证实际压缩和字节还原；输入：历史 .pao；输出：数字报告，原日志只读。
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveWorkerEvidence, readWorkerEvidenceFile } from '../../PAO/packages/coding-agent/src/pao/shared/evidence.ts';
const outputDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(outputDir, '..');
const fixtureRoot = 'D:/AI/workspace/临时文件夹/日志压缩验收-20261020';
await mkdir(fixtureRoot, { recursive: true });
const fixture = await mkdtemp(join(fixtureRoot, 'actual-log-copies-'));
async function findLogs(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await findLogs(path));
    else if (entry.isFile() && entry.name.endsWith('.live.jsonl')) result.push(path);
  }
  return result;
}
const results = [];
for (const [index, source] of (await findLogs(sourceRoot)).entries()) {
  const copy = join(fixture, `sample-${index}.live.jsonl`);
  const original = await readFile(source);
  await copyFile(source, copy);
  const archived = await archiveWorkerEvidence(copy);
  if (archived.warning) throw new Error(archived.warning);
  const restored = await readWorkerEvidenceFile(archived.path);
  if (!restored.equals(original)) throw new Error(`解压后字节不一致：${source}`);
  const viaPreviousPath = await readWorkerEvidenceFile(copy);
  if (!viaPreviousPath.equals(original)) throw new Error(`旧路径读取不一致：${source}`);
  results.push({ source, originalBytes: original.length, storedBytes: (await stat(archived.path)).size,
    compressed: archived.path.endsWith('.gz'), exactRoundTrip: true, previousPathReadable: true });
}
const result = { files: results.length, originalBytes: results.reduce((n, r) => n + r.originalBytes, 0),
  storedBytes: results.reduce((n, r) => n + r.storedBytes, 0), sourceLogsChanged: false, results };
await writeFile(join(outputDir, '实际日志副本验收.json'), JSON.stringify(result, null, 2));
if (!resolve(fixture).startsWith(resolve(fixtureRoot) + '\\')) throw new Error('夹具路径越界，拒绝清理');
await rm(fixture, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ ...result, results: undefined }, null, 2));
