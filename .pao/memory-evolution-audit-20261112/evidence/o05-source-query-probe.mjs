import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const [mode, path, queryName] = process.argv.slice(2);
const queries = {
  match: "SELECT f.source_id,f.rank FROM source_fts f JOIN sources s ON s.source_id=f.source_id WHERE source_fts MATCH 'SQLite' ORDER BY f.rank,f.source_id LIMIT 10",
  bm25: "SELECT f.source_id,bm25(source_fts) AS score FROM source_fts f JOIN sources s ON s.source_id=f.source_id WHERE source_fts MATCH 'SQLite' ORDER BY score,f.source_id LIMIT 10",
  like: "SELECT f.source_id FROM source_fts f JOIN sources s ON s.source_id=f.source_id WHERE f.content LIKE '%数据%' ORDER BY f.source_id LIMIT 10",
};
if (mode === "child") {
  const db = new DatabaseSync(path, { readOnly: true });
  console.log(JSON.stringify(db.prepare(queries[queryName]).all()));
  db.close();
} else {
  const db = new DatabaseSync(path, { readOnly: true });
  console.log(JSON.stringify({ sources: db.prepare("SELECT COUNT(*) AS n FROM sources").get(), exclusions: db.prepare("SELECT COUNT(*) AS n FROM source_exclusions").get() }));
  db.close();
  for (const name of Object.keys(queries)) {
    try { console.log(JSON.stringify({ query: name, rows: JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "child", path, name], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) })); }
    catch (e) { console.log(JSON.stringify({ query: name, error: e.code, signal: e.signal })); }
  }
}
