// O14 独立复核探针（跑完即删）：验证 node:sqlite 嵌套 BEGIN IMMEDIATE 是否抛错。
// 若内层 BEGIN 抛错，则 #5「不能折进 service 事务」成立。
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "o14-nestedtx-"));
const db = new DatabaseSync(join(dir, "t.sqlite"));
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
let innerError;
try {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("BEGIN IMMEDIATE"); // 嵌套
    db.exec("COMMIT");
  } catch (e) {
    innerError = e;
    try { db.exec("ROLLBACK"); } catch {}
  }
  try { db.exec("ROLLBACK"); } catch {}
} catch (e) {
  console.log("outer error:", e.message);
}
console.log("inner nested BEGIN IMMEDIATE error:", innerError ? `${innerError.constructor.name}: ${innerError.message}` : "(none)");
// 对照：内层 BEGIN（非 IMMEDIATE）同样试
let inner2Error;
try {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("BEGIN");
    db.exec("COMMIT");
  } catch (e) {
    inner2Error = e;
    try { db.exec("ROLLBACK"); } catch {}
  }
  try { db.exec("ROLLBACK"); } catch {}
} catch (e) {}
console.log("inner nested BEGIN error:", inner2Error ? `${inner2Error.constructor.name}: ${inner2Error.message}` : "(none)");
db.close();
rmSync(dir, { recursive: true, force: true });
