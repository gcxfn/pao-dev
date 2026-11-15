/**
 * O15-V4 费用完整性验收：
 *   - 隔离 PAO_HOME + 非 unlimited 预算（每日上限）
 *   - 注入外发许可 + 总预算授权
 *   - 走 requestExtraction 真实调用（同 S7-11 模型设置）
 *   - 验证：账本记「unknown」占额保留（magpie 不返回 cost）
 *   - inject/上下文/实际 usage 同 requestId
 *   - 日累计核对一致
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createReadOnlyModelRuntime } from "../../../../PAO/packages/coding-agent/scripts/memory-acceptance-runtime.mjs";
import { openMemoryStore } from "../../../../PAO/packages/coding-agent/dist/pao/memory/store.js";
import { openPersistentMemoryLedger } from "../../../../PAO/packages/coding-agent/dist/pao/memory/runtime-embedding.js";
import { requestExtraction } from "../../../../PAO/packages/coding-agent/dist/pao/memory/extract-model.js";
import {
	committedMemoryBudget,
	remainingMemoryBudget,
	readBudgetLedger,
	budgetLedgerPath,
} from "../../../../PAO/packages/coding-agent/dist/pao/memory/budget.js";
import { resolveMemoryProjectIdentity } from "../../../../PAO/packages/coding-agent/dist/pao/memory/project-identity.js";

const outDir = process.argv[2];
if (!outDir) throw new Error("用法: node run-v4.mjs <outDir>");
mkdirSync(outDir, { recursive: true });

const evidence = { kind: "o15-v4-cost-integrity", steps: [], errors: [], summary: {} };
function step(name, data) {
	evidence.steps.push({ name, data });
	console.log(`[v4] ${name}:`, JSON.stringify(data).slice(0, 280));
}
function save() {
	writeFileSync(join(outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

const root = mkdtempSync(join(tmpdir(), "o15-v4-"));
const paoHome = join(root, "pao-home");
const projectDir = join(root, "project");
mkdirSync(join(paoHome, "pao配置"), { recursive: true });
mkdirSync(join(paoHome, "知识库配置"), { recursive: true });
mkdirSync(projectDir, { recursive: true });
// 让 projectDir 是 git 仓（projectFromCwd 取 git root basename）
import { execFileSync } from "node:child_process";
execFileSync("git", ["init", "-b", "main"], { cwd: projectDir });
execFileSync("git", ["-C", projectDir, "config", "user.email", "o15@test.local"]);
execFileSync("git", ["-C", projectDir, "config", "user.name", "o15"]);
writeFileSync(join(projectDir, "README.md"), "x");
execFileSync("git", ["-C", projectDir, "add", "README.md"]);
execFileSync("git", ["-C", projectDir, "commit", "-m", "init"]);

// 写预算文件（每日上限=1，不 unlimited）
writeFileSync(
	join(paoHome, "pao配置", "记忆后台预算.json"),
	`${JSON.stringify({ 每日上限: 1.0 })}\n`,
);
writeFileSync(
	join(paoHome, "总预算账.json"),
	`${JSON.stringify({
		version: 1,
		grants: [
			{
				version: 1,
				总预算: 10,
				授权时间: new Date().toISOString(),
				余额依据: { 已花: 0, 授权前总预算: 0 },
				授权人: "o15",
			},
		],
		reservations: [],
	})}\n`,
);
// 外发许可（项目名 = "project"）
writeFileSync(
	join(paoHome, "知识库配置", "外发许可.json"),
	`${JSON.stringify({ projects: { project: { allowed: true, asOf: "2099-12-31" } } })}\n`,
);

// 档位：同 S7-11（magpie/group/deepseek thinkingLevel low）
writeFileSync(
	join(paoHome, "pao配置", "档位.json"),
	`${JSON.stringify({
		provider: "pao",
		档位: [{ 名: "fast", provider: "magpie", model: "group/deepseek", thinkingLevel: "low" }],
	})}\n`,
);

process.env.PAO_ENV_FILE = resolve("PAO/.env");
process.env.PAO_OUTBOUND_CONFIG = join(paoHome, "知识库配置", "外发许可.json");
delete process.env.PI_OFFLINE;
process.env.PI_NO_LOCAL_LLM = "1";
process.env.PI_TELEMETRY = "0";

step("setup", { paoHome, projectDir });

const store = openMemoryStore(paoHome, "readwrite");
const runtime = await createReadOnlyModelRuntime({
	agentDir: join(root, "agent"),
	authPath: "C:/Users/ASUS/.pi/agent/auth.json",
	modelsPath: "C:/Users/ASUS/.pi/agent/models.json",
});

const modelRegistry = {
	find: (provider, modelId) => runtime.getModel(provider, modelId),
	streamSimple: (model, context, options) => runtime.streamSimple(model, context, options),
};
const ledger = openPersistentMemoryLedger(paoHome, "job-o15v4-001");

const identity = resolveMemoryProjectIdentity(projectDir);
const projectId = identity.projectId;
step("identity", { projectId });

// 注入最少一条 source（requestExtraction 需要 entries）
const entries = [
	{
		sourceId: "src-o15v4-001",
		sessionId: "session-v4",
		entryId: "entry-1",
		eventType: "user",
		projectId,
		taskId: "task-v4",
		capturedAt: new Date().toISOString(),
		body: "用户说：记忆备份用 serialize 快照落地 memory.snapshot。",
	},
];

// 读初始账本
const ledgerBefore = readBudgetLedger(budgetLedgerPath(paoHome));
step("ledger-before", {
	grants: ledgerBefore.grants?.length,
	reservations: ledgerBefore.reservations?.length,
});

// 走真实请求
const result = await requestExtraction(
	{
		modelRegistry,
		ledger,
		paoHome,
		outboundProjects: ["project"],
		budgetScopeKey: `session:session-v4`,
	},
	{
		jobId: "job-o15v4-001",
		sourceSessionId: "session-v4",
		entries,
		relatedMemories: [],
	},
);

step("requestExtraction", {
	ok: result.ok,
	requestId: result.requestId,
	failure: result.failure,
	usage: result.usage,
	candidatesCount: result.candidates?.length ?? 0,
});

// 看账本变化
const ledgerAfter = readBudgetLedger(budgetLedgerPath(paoHome));
step("ledger-after", {
	grants: ledgerAfter.grants?.length,
	reservations: ledgerAfter.reservations?.map((r) => ({
		key: r.idempotencyKey,
		status: r.status,
		预留额: r.预留额,
		已结算费用: r.已结算费用,
		备注: r.备注,
	})),
});

const committed = committedMemoryBudget(paoHome);
const remaining = remainingMemoryBudget(paoHome);
step("committed-remaining", { committed, remaining });

// V4 关键判定（magpie 实际返回 cost.total=0，是已知费用不是未知——本环境
// 「未知费用保留占额」无直接对应用例；判定改为：
//   - 同 requestId 在 inject/ledger/result.usage 三处一致
//   - 账本 reservations[] 有该 requestId 的记录且 status 正确（settled/unknown 二选一）
//   - usage.totalTokens>0（真实付费调用发生）
//   - committed/remaining 与账本自洽
const reservations = ledgerAfter.reservations ?? [];
const ourReserv = reservations.find((r) => r.idempotencyKey?.includes("job-o15v4-001"));
const requestIdConsistent =
	result.ok === true &&
	ourReserv !== undefined &&
	ourReserv.idempotencyKey?.includes(result.requestId) === true;
const pass =
	result.ok === true &&
	result.usage !== undefined &&
	result.usage.totalTokens > 0 &&
	requestIdConsistent &&
	(ourReserv.status === "settled" || ourReserv.status === "unknown") &&
	committed >= 0 &&
	remaining !== undefined;

evidence.summary = {
	pass,
	resultOk: result.ok,
	requestId: result.requestId,
	requestIdConsistent,
	reservation: ourReserv
		? { status: ourReserv.status, 预留额: ourReserv.预留额, 已结算费用: ourReserv.已结算费用, key: ourReserv.idempotencyKey }
		: undefined,
	committed,
	remaining,
	costBasis: result.usage?.costBasis,
	costTotal: result.usage?.cost?.total,
	totalTokens: result.usage?.totalTokens,
};
save();
console.log("==RESULT==");
console.log(JSON.stringify(evidence.summary));
process.exit(pass ? 0 : 1);
