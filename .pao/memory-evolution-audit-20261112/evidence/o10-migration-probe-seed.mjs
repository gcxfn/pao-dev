import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "o10-mig2-"));
mkdirSync(join(home, "memory"), { recursive: true });
const dbPath = join(home, "memory", "memory.sqlite");

// 旧库（S7）：extraction_jobs CHECK 不含 evolve、无 consecutive_failures、无 evolution 表
const HEAD_SCHEMA = `
CREATE TABLE IF NOT EXISTS extraction_jobs (
	job_id TEXT PRIMARY KEY,
	job_kind TEXT NOT NULL DEFAULT 'extract' CHECK (job_kind IN ('extract','embed','organize','archive')),
	source_scope TEXT NOT NULL,
	scope_key TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
	cursor TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	last_usage TEXT,
	owner_process TEXT,
	owner_token TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`;
{
  const db = new DatabaseSync(dbPath);
  db.exec(HEAD_SCHEMA);
  db.exec(`INSERT INTO extraction_jobs (job_id, job_kind, source_scope, scope_key, status, cursor, created_at, updated_at)
    VALUES ('job-extract-old','extract','{"kind":"extract"}','session:s-old','done','src-9','2026-01-01','2026-01-01'),
           ('job-embed-old','embed','{"kind":"embed"}','embed:p1','pending',NULL,'2026-01-01','2026-01-01')`);
  db.close();
}
console.log(home);
