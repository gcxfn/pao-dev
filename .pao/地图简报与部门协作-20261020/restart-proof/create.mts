/**
 * 用途：重启反例第一进程，创建真实临时 Git 仓库和 dispatch 产物。
 * 输入：环境变量 RESTART_PROOF_ROOT、RESTART_PROOF_STATE。
 * 输出：状态 JSON、v1 旧引用和 v2 当前引用；进程正常退出后才由第二进程读取。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const proofRoot = process.env.RESTART_PROOF_ROOT;
const statePath = process.env.RESTART_PROOF_STATE;
if (!proofRoot || !statePath) throw new Error("缺少 RESTART_PROOF_ROOT 或 RESTART_PROOF_STATE");
const proofRootResolved = realpathSync(proofRoot);

const proofModuleRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"pao-dev",
	"PAO",
	"packages",
	"coding-agent",
	"src",
	"pao",
	"dispatch-brief",
);
const artifacts = await import(pathToFileURL(join(proofModuleRoot, "artifacts.ts")).href);
const canonical = await import(pathToFileURL(join(proofModuleRoot, "canonical.ts")).href);
const snapshotModule = await import(pathToFileURL(join(proofModuleRoot, "snapshot.ts")).href);
const briefModule = await import(pathToFileURL(join(proofModuleRoot, "brief.ts")).href);
const workspace = await import(pathToFileURL(join(proofModuleRoot, "workspace.ts")).href);

const repo = join(proofRootResolved, "repo");
mkdirSync(repo, { recursive: true });
const cardsDir = join(repo, ".pao", "任务", "卡");
mkdirSync(cardsDir, { recursive: true });
mkdirSync(join(repo, "src"), { recursive: true });
const git = (args: string[]) =>
	execFileSync("git", ["-c", "user.name=restart-proof", "-c", "user.email=restart@proof", ...args], {
		cwd: repo,
		encoding: "utf8",
	});
git(["init", "--quiet"]);
writeFileSync(join(repo, "src", "contract.md"), "export interface RestartContract { version: 1 }\n");
const cardPath = join(cardsDir, "卡0001-重启门.md");
writeFileSync(
	cardPath,
	[
		"---",
		"goal: 验证独立进程重启后旧来源仍被拒绝",
		"dept: 测试",
		'inputs: ["src/contract.md"]',
		"acceptance: 旧 ref 仍可只读加载，新派发拒绝",
		"attempt: 1",
		"created: 2026-10-20 10:00",
		"status: in_progress",
		"owner: 重启门用户",
		"---",
		"",
	].join("\n"),
);
git(["add", "."]);
git(["commit", "-qm", "restart base"]);

const mapV1 = workspace.captureDispatchMap({
	id: "restart-map-v1",
	projectRoot: repo,
	coverage: ["src"],
	scopeConfirmed: true,
	scopeBasis: ["覆盖范围内可检出新增调用方"],
	facts: ["第一进程地图"],
	capturedAt: "2026-10-20T10:00:00.000Z",
});
const mapV1Saved = await artifacts.saveDispatchMapArtifact({ cardsDir, artifact: mapV1 });
const contractV1 = await artifacts.saveDispatchContractReference({
	cardsDir,
	projectRoot: repo,
	id: "restart-contract",
	version: "v1",
	ref: join(repo, "src", "contract.md"),
	contentPath: "src/contract.md",
	digest: canonical.sha256Bytes(readFileSync(join(repo, "src", "contract.md"))),
});
const card = await import(pathToFileURL(join(proofModuleRoot, "..", "cards", "cardfile.ts")).href);
const current = card.readCard(cardPath);
current.frontmatter.inputs = [...(current.frontmatter.inputs ?? []), mapV1Saved.ref, contractV1.ref];
writeFileSync(current.path, card.serializeCard(current.frontmatter, current.body));
const draft = await briefModule.prepareDispatchBrief({
	cardsDir,
	cardPath,
	projectRoot: repo,
	executionRoot: repo,
	claim: { attempt: 1, owner: "重启门用户" },
	workspace: { commonGitDir: join(repo, ".git") },
});
const frozen = await snapshotModule.freezeDispatchBrief(
	draft,
	{ attempt: 1, owner: "重启门用户" },
	{
		projectRoot: repo,
		repositoryRoot: repo,
		executionRoot: repo,
		versionControl: "git",
		commonGitDir: join(repo, ".git"),
	},
);
writeFileSync(join(repo, "src", "contract.md"), "export interface RestartContract { version: 2 }\n");
const contractV2 = await artifacts.saveDispatchContractReference({
	cardsDir,
	projectRoot: repo,
	id: "restart-contract",
	version: "v2",
	ref: join(repo, "src", "contract.md"),
	contentPath: "src/contract.md",
	digest: canonical.sha256Bytes(readFileSync(join(repo, "src", "contract.md"))),
	previousRef: contractV1.ref,
	supersessionReason: "独立进程重启验证",
});
const mapV2 = workspace.captureDispatchMap({
	id: "restart-map-v2",
	projectRoot: repo,
	coverage: ["src"],
	scopeConfirmed: true,
	scopeBasis: ["覆盖范围内可检出新增调用方"],
	facts: ["第二版地图"],
	previousRef: mapV1Saved.ref,
	supersessionReason: "独立进程重启验证",
	capturedAt: "2026-10-20T10:01:00.000Z",
});
const mapV2Saved = await artifacts.saveDispatchMapArtifact({ cardsDir, artifact: mapV2 });

const state = {
	repo,
	cardsDir,
	cardPath,
	oldMapRef: mapV1Saved.ref,
	newMapRef: mapV2Saved.ref,
	oldContractRef: contractV1.ref,
	newContractRef: contractV2.ref,
	snapshotPath: snapshotModule.dispatchInputSnapshotPath(cardsDir, 1, 1),
	oldRefsFrozenInCard: true,
	firstProcessPid: process.pid,
};
mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(
	JSON.stringify({
		phase: "create",
		pid: process.pid,
		oldMapRef: state.oldMapRef,
		oldContractRef: state.oldContractRef,
		newMapRef: state.newMapRef,
		newContractRef: state.newContractRef,
	}),
);
