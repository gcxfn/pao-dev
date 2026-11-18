// 复现：多个进程同时以读写模式打开同一个记忆库时，是否出现 "database is locked"。
// 用法：node wal-open-race.mjs <coding-agent 包目录> <轮数> <每轮进程数>
// 每轮所有子进程等到同一时刻再调用 openMemoryStore(home, "readwrite")，随后关闭。
// 输出每轮失败数与首条错误；退出码恒为 0（统计结果写到标准输出）。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [packageDir, roundsArg = "10", workersArg = "8"] = process.argv.slice(2);
if (!packageDir) throw new Error("缺少参数：coding-agent 包目录");
const rounds = Number(roundsArg);
const workers = Number(workersArg);
const storePath = resolve(packageDir, "src/pao/memory/store.ts").replaceAll("\\", "/");
const home = mkdtempSync(join(tmpdir(), "pao-wal-race-"));
const childScript = join(home, "open-child.mts");
writeFileSync(
	childScript,
	`const { openMemoryStore } = await import(${JSON.stringify(`file:///${storePath}`)});
const startAt = Number(process.argv[2]);
while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 2));
try {
	const store = openMemoryStore(${JSON.stringify(home)}, "readwrite");
	store.close();
	process.stdout.write("ok");
} catch (error) {
	process.stdout.write("fail:" + (error instanceof Error ? error.message : String(error)));
}
`,
);

function runChild(startAt) {
	return new Promise((done) => {
		const proc = spawn(process.execPath, ["--experimental-strip-types", childScript, String(startAt)], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		proc.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		proc.stderr.on("data", (chunk) => {
			err += String(chunk);
		});
		proc.on("close", (code) => done(out.length > 0 ? out : `fail:exit ${code} ${err.split("\n")[0]}`));
	});
}

// 先由一个进程建库并切到 WAL，之后各轮都在已有 WAL 库上并发打开（与桌面/CLI 并存的真实情形一致）。
console.log(`init: ${await runChild(Date.now())}`);
let totalFail = 0;
for (let round = 1; round <= rounds; round++) {
	const startAt = Date.now() + 1200;
	const results = await Promise.all(Array.from({ length: workers }, () => runChild(startAt)));
	const failures = results.filter((r) => r !== "ok");
	totalFail += failures.length;
	console.log(`round ${round}: ${failures.length}/${workers} failed${failures.length ? ` — ${failures[0]}` : ""}`);
}
console.log(`total: ${totalFail}/${rounds * workers} failed (home=${home})`);
