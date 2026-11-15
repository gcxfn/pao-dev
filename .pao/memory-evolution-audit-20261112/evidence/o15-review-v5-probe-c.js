// 复核探针：另起一个进程 C 用同一打包 dist 读 o15-v5 home 的绑定
const PACKAGED_DIST = "D:/AI/workspace/pao-dev/desktop/apps/desktop/release/win-unpacked/resources/app.asar.unpacked/node_modules/@pao/coding-agent/dist";
const home = "D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/o15-v5/home";
const { openMemoryStore } = require(`${PACKAGED_DIST}/pao/memory/store.js`);
const { listTaskBindings } = require(`${PACKAGED_DIST}/pao/evolution/binding.js`);
const { recoverEvolutionState } = require(`${PACKAGED_DIST}/pao/evolution/recovery.js`);
console.log("module file:", require.resolve(`${PACKAGED_DIST}/pao/memory/store.js`));
const store = openMemoryStore(home, "readonly");
const report = recoverEvolutionState(store, { paoHome: home });
console.log("recover resources:", report.resources.length, JSON.stringify(report.resources.map(r=>r.resourceId)));
const bindings = listTaskBindings(store, { taskId: "task-v5", activeOnly: true });
console.log("bindings:", JSON.stringify(bindings.items));
store.close();
