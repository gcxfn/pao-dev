#!/usr/bin/env node
// 用途：检查文档里的相对链接是否指向存在的文件（plans/、.agents/notes/、README/AGENTS）。
// 输入：无（扫描固定目录）；输出：缺失链接清单，有缺失退出码 1。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_FILES = ["README.md", "AGENTS.md", "摩擦日志.md"];
const SCAN_DIRS = ["plans", ".agents/notes"];

const LINK_RE = /\[[^\]]+\]\(([^)\s]+)[^)]*\)/g;

function* files() {
	for (const name of SCAN_FILES) {
		const p = join(ROOT, name);
		if (existsSync(p)) yield p;
	}
	for (const dir of SCAN_DIRS) {
		const base = join(ROOT, dir);
		if (!existsSync(base)) continue;
		const stack = [base];
		while (stack.length) {
			const cur = stack.pop();
			for (const entry of readdirSync(cur)) {
				const p = join(cur, entry);
				if (statSync(p).isDirectory()) stack.push(p);
				else if (entry.endsWith(".md")) yield p;
			}
		}
	}
}

const missing = [];
for (const file of files()) {
	const text = readFileSync(file, "utf8");
	for (const m of text.matchAll(LINK_RE)) {
		const target = m[1];
		if (/^(https?:|mailto:|#)/.test(target)) continue;
		const clean = target.split("#")[0];
		if (!clean) continue;
		if (!existsSync(resolve(dirname(file), decodeURIComponent(clean)))) {
			missing.push(`${file.slice(ROOT.length + 1)} -> ${target}`);
		}
	}
}
if (missing.length) {
	console.error(`缺失 ${missing.length} 条相对链接：`);
	for (const item of missing) console.error(`  ${item}`);
	process.exitCode = 1;
} else {
	console.log(`链接检查通过（${[...files()].length} 个 Markdown 文件）。`);
}
