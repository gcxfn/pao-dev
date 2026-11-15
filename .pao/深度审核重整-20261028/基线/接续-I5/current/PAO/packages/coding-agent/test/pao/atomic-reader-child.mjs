// 用途：并发读取原子写目标；输入workerData；输出完整性观测，不调用模型。
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const stop = new Int32Array(workerData.stop);
let reads = 0;
let invalid;
const allowed = new Set(workerData.allowed);
parentPort.postMessage('ready');
const deadline = Date.now() + 10_000;
while (!Atomics.load(stop, 0) && Date.now() < deadline) {
  try {
    const data = readFileSync(workerData.file, 'utf8');
    reads++;
    if (!allowed.has(data)) { invalid = '读取到部分或未知内容'; break; }
  } catch (error) {
    invalid = String(error);
    break;
  }
}
parentPort.postMessage({ reads, invalid });
