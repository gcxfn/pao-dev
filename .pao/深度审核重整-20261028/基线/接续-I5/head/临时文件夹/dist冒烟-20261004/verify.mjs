const { 创建静默提醒器 } = await import("file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/pao/worker/index.js");
const fired = [];
const r = 创建静默提醒器({
  runner: { registry: { list: () => [] }, listActive: () => [] },
  取静默分钟: () => { throw new Error("缺少环境变量 PAO_HOME"); },
  提醒: (b) => fired.push(b),
  间隔毫秒: 3_600_000,
});
try { r.扫描(); console.log("SCAN_OK_NO_THROW"); } catch (e) { console.log("STILL_THROWS:", e.message); }
r.停止();
