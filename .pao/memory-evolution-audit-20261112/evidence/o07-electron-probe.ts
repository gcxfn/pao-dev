import { app } from "electron";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { createMemoryBackup, restoreMemoryBackup } from "../../../PAO/packages/coding-agent/src/pao/memory/backup.ts";

// 独立 Electron 主进程运行；数据与结果均位于调用方提供的审核证据目录。
const evidenceRoot = process.argv[2]!;
const userData = join(evidenceRoot, "o07-electron-user-data");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const root = mkdtempSync(join(evidenceRoot, "o07-electron-case-"));
  let result: Record<string, unknown>;
  try {
    const home = join(root, "home"), backupDir = join(root, "backup");
    const store = openMemoryStore(home, "readwrite");
    let backup;
    try {
      store.db.exec("CREATE TABLE o07_runtime_probe (body TEXT)");
      store.db.prepare("INSERT INTO o07_runtime_probe VALUES (?)").run("Electron 备份恢复确切字节");
      backup = createMemoryBackup(store, { home, backupDir });
    } finally { store.close(); }
    if (!backup.ok) throw new Error(backup.error.message);
    const restored = restoreMemoryBackup({ backupDir, targetHome: join(root, "restored") });
    if (!restored.ok) throw new Error(restored.error.message);
    const db = new DatabaseSync(restored.database);
    let row;
    try { row = db.prepare("SELECT body FROM o07_runtime_probe").get(); } finally { db.close(); }
    if (row?.body !== "Electron 备份恢复确切字节") throw new Error("恢复字节不一致");
    result = { ok: true, electron: process.versions.electron, node: process.versions.node, body: row.body, backupOk: backup.ok, restoreOk: restored.ok };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.stack : String(error) };
  } finally { rmSync(root, { recursive: true, force: true }); }
  writeFileSync(join(evidenceRoot, "o07-electron-results.json"), JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
});
