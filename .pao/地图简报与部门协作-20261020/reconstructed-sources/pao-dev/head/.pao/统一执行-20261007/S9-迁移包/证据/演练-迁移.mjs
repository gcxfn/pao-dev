// S9 迁移包·隔离副本演练脚本（2026-10-07）
// 用途：在 mktemp 临时目录构造合成语料（定名表全谱正例＋冲突/坏值反例＋真实形态取样），
//       通过子进程跑 PAO/packages/coding-agent/src/pao/migration/cli.ts，验证五面：
//       原子写（杀进程不留半成品）/ 中断恢复（重跑续上）/ 幂等（重复执行无损）/ 内容不丢 / 冲突拒绝。
// 输入：无参数（正本对照＝.pao/统一执行-20261007/S9调查/定名表-默认方案.md）。
// 输出：stdout 全程记录（重定向到 演练-迁移.log）；退出码 0＝全部面通过。
// 纪律：全部在 os.tmpdir() 临时目录，不碰正式现场 D:/AI/workspace/pao；结束清理并报告去向。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..", "..");
const cliPath = join(repoRoot, "PAO", "packages", "coding-agent", "src", "pao", "migration", "cli.ts");

// —— 独立断言表（照定名表另行誊写，与工具实现互为对照，不做共享代码） ——
const FM_MAP = { 目标: "goal", 部门: "dept", 输入: "inputs", 约束: "constraints", 验收: "acceptance", 档位: "tier", 预算: "budget", 优先级: "priority", 尝试: "attempt", 创建: "created", 完成: "completed", 状态: "status" };
const BULLET_MAP = { 留档: "archive_flag", 结果: "result", 摘要: "summary", 产物路径: "artifact_path", 证据: "evidence", 用量: "usage", 值得沉淀: "worth_distilling", 失败类型: "failure_type" };
const V = {
	状态: { 待认领: "unclaimed", 进行中: "in_progress", 已交付: "delivered", 失败: "failed", 取消: "canceled" },
	优先级: { 高: "high", 中: "medium", 低: "low" },
	档位: { 快: "fast", 主力: "primary" },
	失败类型: { 瞬时故障: "transient", 缺输入: "missing_input", 能力不足: "insufficient_capability", 结果未知: "unknown_outcome" },
	留档: { 旧尝试留档: "old_attempt", 迟到回执: "late_receipt" },
};
const FM_ORDER = ["goal", "dept", "inputs", "constraints", "acceptance", "depends_on", "parent", "tier", "budget", "priority", "owner", "attempt", "created", "completed", "status"];

const lines = [];
const log = (s = "") => { lines.push(s); console.log(s); };
let failures = 0;
const face = (name, ok, detail = "") => { log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` —— ${detail}` : ""}`); if (!ok) failures++; };

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const fileHash = (p) => sha(readFileSync(p, "utf8"));
const treeHash = (dir) => sha(readdirSync(dir).sort().map((n) => `${n}:${fileHash(join(dir, n))}`).join("|"));

function runCli(args) {
	return new Promise((res, rej) => {
		const proc = spawn(process.execPath, [cliPath, ...args], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		proc.on("error", rej);
		proc.on("close", (code) => res({ code, out, err }));
	});
}

// —— 语料构造 ——
const SPECTRUM = `---
目标: 全谱正例卡
部门: 核心机制
输入: ["a.md", "b.md"]
约束: 只读
验收: 键值全对账
depends_on: []
parent: 卡0001-旧
档位: 主力
预算: {"turns":9,"toolCalls":80,"cost":1.5,"协作配额":3}
优先级: 高
owner: 主控
尝试: 2
创建: "2026-10-02 19:31"
完成: "2026-10-02 19:35"
状态: 已交付
---

## owner记录 2026-10-02 19:31
- 事件: 状态改为 进行中
- 依据: 旧尝试留档前的依据原文

## 回执 尝试1 2026-10-02 19:33
- 留档: 旧尝试留档
- 结果: 成功
- 摘要: 摘要原文
- 产物路径: ["out/a.md"]
- 证据: ["evidence.jsonl"]
- 用量: {"input":1,"output":2,"cacheRead":3,"cacheWrite":0,"cost":0.1,"turns":4}
- 值得沉淀: 是
- 失败类型: 瞬时故障
- 任务态: completed
- verification: [{"条件": "文件存在", "结论": "pass", "证据": "x"}]
- changes: [{"路径": "src/a.ts", "类型": "modified", "说明": "改"}]

## 回执 尝试2 2026-10-02 19:34
- 失败类型: 缺输入
- 留档: 迟到回执
`;
const card = (extra = {}, status = "待认领", body = "") =>
	`---\n目标: ${extra.目标 ?? "演练卡"}\n部门: ${extra.部门 ?? "核心"}\n验收: ${extra.验收 ?? "演练"}\n${extra.优先级 !== undefined ? `优先级: ${extra.优先级}\n` : ""}${extra.档位 !== undefined ? `档位: ${extra.档位}\n` : ""}尝试: 0\n创建: "2026-10-07 10:00"\n状态: ${status}\n---\n${body}`;

const REAL_SAMPLES = [
	join(repoRoot, ".pao", "卡", "卡0001-把.pao体检现有体检评测条目逐份整理成.md"),
	join(repoRoot, ".pao", "后续执行-20261004", "桌面真实对话-路径修复复验", "workspace", ".pao", "卡", "卡0998-桌面展示样本.md"),
];

const base = mkdtempSync(join(tmpdir(), "pao-s9-drill-"));
const okDir = join(base, "corpus-ok", "卡");
const badDir = join(base, "corpus-bad", "卡");
const bigDir = join(base, "corpus-big", "卡");
const refDir = join(base, "corpus-ref", "卡");
const sessRoot = join(base, "sessions");
mkdirSync(okDir, { recursive: true });
mkdirSync(badDir, { recursive: true });
mkdirSync(bigDir, { recursive: true });
mkdirSync(refDir, { recursive: true });
log(`# S9 迁移包·隔离副本演练 ${new Date().toISOString()}`);
log(`临时根：${base}（正式现场 D:/AI/workspace/pao 全程未触碰）`);
log(`工具：${cliPath}`);
log("");

// corpus-ok：定名表每键至少一个正例
writeFileSync(join(okDir, "卡0001-全谱.md"), SPECTRUM, "utf8");
const statuses = ["待认领", "进行中", "已交付", "失败", "取消"];
statuses.forEach((s, i) => writeFileSync(join(okDir, `卡001${i}-状.md`), card({ 目标: `状态${s}` }, s), "utf8"));
["高", "中", "低"].forEach((p, i) => writeFileSync(join(okDir, `卡002${i}-优.md`), card({ 优先级: p, 目标: `优${p}` }, "待认领"), "utf8"));
["快", "主力"].forEach((t, i) => writeFileSync(join(okDir, `卡003${i}-档.md`), card({ 档位: t, 目标: `档${t}` }, "待认领"), "utf8"));
["瞬时故障", "缺输入", "能力不足", "结果未知"].forEach((f, i) =>
	writeFileSync(join(okDir, `卡004${i}-失.md`), card({ 目标: `失${f}` }, "失败", `## 回执 尝试1 2026-10-07 10:01\n- 结果: 失败\n- 失败类型: ${f}\n`), "utf8"));
for (const [i, src] of REAL_SAMPLES.entries()) copyFileSync(src, join(okDir, `卡010${i}-真实.md`));
// corpus-bad：冲突/坏值反例
writeFileSync(join(badDir, "卡9001-未知键.md"), card().replace("尝试: 0", "技能: 挖掘\n尝试: 0"), "utf8");
writeFileSync(join(badDir, "卡9002-坏状态.md"), card({}, "废弃值"), "utf8");
writeFileSync(join(badDir, "卡9003-坏档位.md"), card({ 档位: "超级" }), "utf8");
writeFileSync(join(badDir, "卡9004-未知bullet.md"), card({ 目标: "未知bullet" }, "进行中", "## 回执 尝试1 2026-10-07 10:01\n- 随便键: 1\n"), "utf8");
writeFileSync(join(badDir, "卡9005-未映射留档.md"), SPECTRUM.replace("- 留档: 旧尝试留档", "- 留档: 重复终结留档").replace("目标: 全谱正例卡", "目标: 未映射留档"), "utf8");
writeFileSync(join(badDir, "卡9006-新旧并存.md"), card().replace("目标: 演练卡", "目标: 演练卡\ngoal: 已迁"), "utf8");
writeFileSync(join(badDir, "卡9007-无信封.md"), "只是正文，没有 frontmatter\n", "utf8");
writeFileSync(join(badDir, "卡9008-坏预算.md"), card().replace("尝试: 0", '预算: {"turns":1,"吨位":2}\n尝试: 0'), "utf8");
copyFileSync(join(repoRoot, ".pao", "后续执行-20261004", "桌面真实对话-路径修复复验", "workspace", ".pao", "卡", "卡0999-损坏样本.md"), join(badDir, "卡9009-真实损坏.md"));
// corpus-big/corpus-ref：杀进程演练与参考
const bigCount = 120;
for (let i = 1; i <= bigCount; i++) {
	const no = String(i).padStart(4, "0");
	const c = card({ 目标: `批量${no}` }, i % 3 === 0 ? "已交付" : "进行中", i % 2 === 0 ? `## 回执 尝试1 2026-10-07 10:02\n- 结果: 成功\n- 摘要: 批量回执\n` : "");
	writeFileSync(join(bigDir, `卡${no}-批量.md`), c, "utf8");
	writeFileSync(join(refDir, `卡${no}-批量.md`), c, "utf8");
}
// 合成会话根（list-sessions 演练对象；不使用真实用户会话目录）
for (const d of ["--D--workspace-pao--", "--D--workspace-pao-dev--", "--C--temp--"]) {
	mkdirSync(join(sessRoot, d), { recursive: true });
	writeFileSync(join(sessRoot, d, "20261001_120000_a.jsonl"), "{}\n");
	writeFileSync(join(sessRoot, d, "20261002_130000_b.jsonl"), "{}\n{}\n");
}

// —— 覆盖率自检（每键正例数） ——
const okAll = readdirSync(okDir).map((n) => readFileSync(join(okDir, n), "utf8")).join("\n");
log("## 定名表覆盖率自检（corpus-ok 每键正例数）");
for (const [zh, en] of Object.entries(FM_MAP)) log(`  frontmatter ${zh}→${en}: ${okAll.split(`${zh}:`).length - 1}`);
log(`  预算.协作配额→collab_quota: ${okAll.split('"协作配额"').length - 1}`);
for (const [zh, en] of Object.entries(BULLET_MAP)) log(`  回执 ${zh}→${en}: ${okAll.split(`- ${zh}:`).length - 1}`);
for (const [dom, map] of Object.entries(V)) for (const [zh, en] of Object.entries(map)) log(`  值 ${dom}.${zh}→${en}: ${okAll.split(zh).length - 1}`);
log("");

// —— 独立断言：期望迁移（照断言表另写一遍，与工具输出对照） ——
const bare = (s) => /^[\w\u4e00-\u9fff.-]+$/.test(s);
const yamlSafe = (raw) => {
	if (raw.startsWith("[" ) || raw.startsWith("{")) return raw; // 数组/对象逐字
	const unquoted = raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) : raw; // 先解开原引号
	if (typeof unquoted === "number" || /^(true|false|null|\d+)$/.test(unquoted)) return String(unquoted);
	return bare(unquoted) ? unquoted : JSON.stringify(unquoted); // 与 cardfile 序列化同规则
};
function expectMigrated(content) {
	const m = /^---\n([\s\S]*?)\n---([\s\S]*)$/.exec(content);
	const fmPairs = [];
	for (const line of m[1].split("\n")) {
		const kv = /^([^:]+): ?(.*)$/.exec(line);
		if (!kv) continue;
		const k = FM_MAP[kv[1]] ?? kv[1];
		let v = kv[2];
		if (kv[1] === "预算") v = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(v)).map(([bk, bv]) => [bk === "协作配额" ? "collab_quota" : bk, bv])));
		for (const dom of ["状态", "优先级", "档位"]) if (kv[1] === dom) v = V[dom][v] ?? v;
		fmPairs.push([k, v]);
	}
	fmPairs.sort((a, b) => FM_ORDER.indexOf(a[0]) - FM_ORDER.indexOf(b[0]));
	const fmText = fmPairs.map(([k, v]) => `${k}: ${yamlSafe(v)}`).join("\n");
	const outLines = [];
	let inReceipt = false;
	for (const line of (m[2].endsWith("\n") ? m[2] : `${m[2]}\n`).split("\n")) {
		const t = line.trim();
		if (t.startsWith("## ")) { inReceipt = /^## 回执 尝试\d+ \d{4}/.test(t); outLines.push(line); continue; }
		const kv = inReceipt ? /^- ([^:]+): ?(.*)$/.exec(line) : null;
		if (!kv) { outLines.push(line); continue; }
		const k = BULLET_MAP[kv[1]] ?? kv[1];
		let v = kv[2];
		if (kv[1] === "失败类型" || kv[1] === "留档") v = V[kv[1]][v] ?? v;
		outLines.push(`- ${k}: ${v}`);
	}
	return `---\n${fmText}\n---${outLines.join("\n")}`;
}

// —— 面 1：dry-run 预览（不写盘、列将改键、列冲突） ——
log("## 面 1 dry-run 预览");
const beforeOk = treeHash(okDir);
const beforeBad = treeHash(badDir);
const dryOk = await runCli(["migrate", "--root", okDir, "--dry-run"]);
const dryBad = await runCli(["migrate", "--root", badDir, "--dry-run"]);
face("corpus-ok dry-run 退出 0 且列出 would-migrate", dryOk.code === 0 && dryOk.out.includes('"would-migrate"'));
face("corpus-ok dry-run 未写盘", treeHash(okDir) === beforeOk);
face("corpus-bad dry-run 退出 1 且逐条列冲突", dryBad.code === 1 && dryBad.out.split('"conflict"').length - 1 === 9, `冲突 ${dryBad.out.split('"conflict"').length - 1} 条`);
face("corpus-bad dry-run 未写盘", treeHash(badDir) === beforeBad);

// —— 面 2：干净迁移 ＋ 内容/引用不丢 ——
log("## 面 2 干净迁移与不丢");
const originalsOk = new Map(readdirSync(okDir).map((n) => [n, readFileSync(join(okDir, n), "utf8")]));
const run1 = await runCli(["migrate", "--root", okDir]);
face("corpus-ok 实跑退出 0", run1.code === 0);
let noLoss = true, lossDetail = "";
for (const n of readdirSync(okDir)) {
	const got = readFileSync(join(okDir, n), "utf8");
	const want = expectMigrated(originalsOk.get(n));
	if (got !== want) { noLoss = false; lossDetail = `${n} 与独立断言表产物不一致`; break; }
	if ((originalsOk.get(n).match(/^## 回执 尝试/gm) ?? []).length !== (got.match(/^## 回执 尝试/gm) ?? []).length) { noLoss = false; lossDetail = `${n} 回执段数变化`; break; }
	if ((originalsOk.get(n).match(/^- /gm) ?? []).length !== (got.match(/^- /gm) ?? []).length) { noLoss = false; lossDetail = `${n} bullet 行数变化`; break; }
}
face("前后键数与值逐对比对（独立断言表）全等", noLoss, lossDetail);
const backupDir = join(base, "corpus-ok", "卡-migration-backup");
face("转换前备份存在且等于原件", readdirSync(backupDir).length === originalsOk.size && readdirSync(backupDir).every((n) => fileHash(join(backupDir, n)) === sha(originalsOk.get(n))));

// —— 面 3：幂等（重复执行无损） ——
log("## 面 3 幂等");
const snap1 = treeHash(okDir);
const backupSnap = treeHash(backupDir);
const run2 = await runCli(["migrate", "--root", okDir]);
const unchangedLines = (run2.out.match(/"status":"unchanged"/g) ?? []).length;
face(
	"二次运行退出 0 且全部 unchanged",
	run2.code === 0 && unchangedLines === originalsOk.size && !/"status":"migrated"/.test(run2.out),
	`unchanged=${unchangedLines}/${originalsOk.size}`,
);
face("二次运行字节不变", treeHash(okDir) === snap1);
face("首份备份未被覆盖", treeHash(backupDir) === backupSnap);

// —— 面 4：原子写（中途杀进程）＋ 中断恢复 ——
log("## 面 4 原子写与中断恢复");
const killResult = await new Promise((res) => {
	const proc = spawn(process.execPath, [cliPath, "migrate", "--root", bigDir, "--sleep-ms", "10"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
	let seen = 0;
	proc.stdout.on("data", () => { seen++; if (seen >= 5) { try { proc.kill("SIGKILL"); } catch {} } });
	proc.on("close", (code) => res({ code, seen }));
});
await new Promise((r) => setTimeout(r, 200));
const bigFiles = readdirSync(bigDir);
face("杀进程成功（已见 ≥5 条逐文件结果后被杀）", killResult.seen >= 5, `seen=${killResult.seen}`);
face("无 .tmp 半成品残留", !bigFiles.some((f) => f.endsWith(".tmp")));
let atomic = true, halfDetail = "";
for (const n of bigFiles) {
	const c = readFileSync(join(bigDir, n), "utf8");
	const oldF = /\n状态: /.test(c), newF = /\nstatus: /.test(c);
	if (oldF === newF) { atomic = false; halfDetail = `${n} 状态键既非纯旧也非纯新`; break; }
	if ((oldF && /\n目标: /.test(c) === false) || (newF && /\ngoal: /.test(c) === false)) { atomic = false; halfDetail = `${n} frontmatter 半迁移`; break; }
}
face("每个文件要么整旧要么整新（无半成品）", atomic, halfDetail);
const resume = await runCli(["migrate", "--root", bigDir]);
face("中断后重跑退出 0", resume.code === 0);
const refRun = await runCli(["migrate", "--root", refDir]);
face("参考运行退出 0", refRun.code === 0);
face("恢复结果与干净参考逐字节一致", treeHash(bigDir) === treeHash(refDir));

// —— 面 5：冲突拒绝（实跑） ——
log("## 面 5 冲突拒绝");
const originalsBad = new Map(readdirSync(badDir).map((n) => [n, readFileSync(join(badDir, n), "utf8")]));
const badRun = await runCli(["migrate", "--root", badDir]);
face("corpus-bad 实跑退出 1", badRun.code === 1);
face("冲突首文件原文未动", readdirSync(badDir).every((n) => readFileSync(join(badDir, n), "utf8") === originalsBad.get(n)));
face("冲突理由含未知键名", badRun.out.includes("技能") || badRun.out.includes("随便键"));

// —— list-sessions：只列不删 ——
log("## list-sessions（合成会话根）");
const sess = await runCli(["list-sessions", "--root", sessRoot]);
face("逐目录清单（3 目录×2 会话）", sess.code === 0 && sess.out.split('"sessions":2').length - 1 === 3);
face("只列不删（现场原样）", readdirSync(sessRoot).length === 3 && readdirSync(join(sessRoot, "--D--workspace-pao--")).length === 2);
const noRoot = await runCli(["migrate"]);
const noRootSess = await runCli(["list-sessions"]);
face("缺 --root 一律拒跑（不猜默认）", noRoot.code === 2 && noRootSess.code === 2);

// —— 清理 ——
rmSync(base, { recursive: true, force: true });
log("");
log(`## 清理：已删除临时根 ${base}（存在=${existsSync(base)}），正式现场未触碰`);
log("");
log(failures === 0 ? `结果：全部面通过（0 FAIL）` : `结果：${failures} 项 FAIL`);
process.exit(failures === 0 ? 0 : 1);
