// 真实Node加载反例，不用源码文字匹配证明检查有效。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const gate = fileURLToPath(new URL('./gate-kernel-import.mjs', import.meta.url));
for (const [name, source, expected] of [
  ['纯导出', 'export const value = 1;', 0],
  ['disconnect监听', "process.on('disconnect', () => {});", 1],
  ['exit监听', "process.on('exit', () => {});", 1],
  ['stdout输出', "console.log('副作用');", 1],
  ['stdin数据监听', "process.stdin.on('data', () => {});", 1],
  ['raw属性改变', 'process.stdin.isRaw = true;', 1],
  ['导入提前退出', 'process.exit(0);', 1],
  ['导入异常', "throw new Error('明确失败');", 1],
  ['导入后仍有活动句柄', 'setInterval(() => {}, 1000);', 1],
]) {
  test(name, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pao-import-gate-'));
    try {
      const file = path.join(dir, 'fixture.mjs');
      writeFileSync(file, source);
      const result = spawnSync(process.execPath, [gate, '--entry', file], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, result.stdout + result.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
