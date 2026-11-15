// 运行：electron.exe packaged-electron-probe.cjs <证据目录> <打包内核 dist 目录>。
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const evidenceRoot = process.argv[2];
const distRoot = process.argv[3];
const profile = path.join(evidenceRoot, "packaged-electron-profile");
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const root = fs.mkdtempSync(path.join(evidenceRoot, "packaged-backup-case-"));
  let result;
  let store;
  try {
    const memory = await import(pathToFileURL(path.join(distRoot, "pao/memory/store.js")).href);
    const backup = await import(pathToFileURL(path.join(distRoot, "pao/memory/backup.js")).href);
    const home = path.join(root, "home");
    store = memory.openMemoryStore(home, "readwrite");
    const created = backup.createMemoryBackup(store, { home, backupDir: path.join(root, "backup") });
    result = { ok: created.ok, electron: process.versions.electron, node: process.versions.node, distRoot, result: created };
  } catch (error) {
    result = { ok: false, electron: process.versions.electron, node: process.versions.node, distRoot, error: String(error), stack: error.stack };
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(evidenceRoot, "packaged-electron-results.json"), JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
});
