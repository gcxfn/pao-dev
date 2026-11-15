/**
 * 用途：重启反例第二进程，从磁盘重新加载第一进程保存的卡、快照、地图和契约。
 * 输入：环境变量 RESTART_PROOF_STATE 指向第一进程状态 JSON。
 * 输出：旧版本只读、precheck、verify、影响计算的真实结果 JSON。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const statePath = process.env.RESTART_PROOF_STATE;
if (!statePath) throw new Error("缺少 RESTART_PROOF_STATE");
const state = JSON.parse(readFileSync(statePath, "utf8")) as {
	repo: string;
	cardsDir: string;
	cardPath: string;
	oldMapRef: string;
	newMapRef: string;
	oldContractRef: string;
	newContractRef: string;
	snapshotPath: string;
};

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
const precheckModule = await import(pathToFileURL(join(proofModuleRoot, "precheck.ts")).href);
const snapshotModule = await import(pathToFileURL(join(proofModuleRoot, "snapshot.ts")).href);
const impactModule = await import(pathToFileURL(join(proofModuleRoot, "impact.ts")).href);

const oldMap = artifacts.loadDispatchMapArtifact(state.oldMapRef, { cardsDir: state.cardsDir });
const oldContract = artifacts.loadDispatchContractReference(state.oldContractRef, {
	cardsDir: state.cardsDir,
});
const snapshot = snapshotModule.loadDispatchInputSnapshot(state.snapshotPath);
const precheck = await precheckModule.precheckDispatchReferences({
	cardsDir: state.cardsDir,
	cardPath: state.cardPath,
	projectRoot: state.repo,
	executionRoot: state.repo,
	refs: [],
	workspace: { commonGitDir: join(state.repo, ".git") },
});
const verify = await snapshotModule.verifyDispatchSnapshot(snapshot, {
	cardsDir: state.cardsDir,
	cardPath: state.cardPath,
	projectRoot: state.repo,
	executionRoot: state.repo,
	claim: { attempt: 1, owner: "重启门用户" },
	workspace: { commonGitDir: join(state.repo, ".git") },
});
const mapImpact = impactModule.findDispatchReferenceImpact({
	cardsDir: state.cardsDir,
	ref: state.newMapRef,
	previousRef: state.oldMapRef,
	reason: "独立进程重启验证",
});
const contractImpact = impactModule.findDispatchReferenceImpact({
	cardsDir: state.cardsDir,
	ref: state.newContractRef,
	previousRef: state.oldContractRef,
	reason: "独立进程重启验证",
});

const result = {
	phase: "read",
	pid: process.pid,
	firstProcessPid: JSON.parse(readFileSync(statePath, "utf8")).firstProcessPid,
	oldVersionReadable: {
		mapId: oldMap.id,
		mapStatus: oldMap.status,
		contractVersion: oldContract.version,
	},
	precheck,
	verify,
	impact: {
		mapAffected: mapImpact.affected.map((item) => item.cardNo),
		contractAffected: contractImpact.affected.map((item) => item.cardNo),
	},
	snapshotExists: existsSync(state.snapshotPath),
	checks: {
		oldVersionsReadable: oldMap.id === "restart-map-v1" && oldContract.version === "v1",
		precheckRejectsOldMap: precheck.issues.some((item) => item.code === "stale_map" && item.ref === state.oldMapRef),
		precheckRejectsOldContract: precheck.issues.some(
			(item) => item.code === "contract_changed" && item.ref === state.oldContractRef,
		),
		verifyRejectsOldMap: verify.issues.some((item) => item.code === "stale_map" && item.ref === state.oldMapRef),
		verifyRejectsOldContract: verify.issues.some(
			(item) => item.code === "contract_changed" && item.ref === state.oldContractRef,
		),
	},
};
writeFileSync(join(dirname(statePath), "second-process-result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
if (Object.values(result.checks).some((value) => value !== true)) process.exitCode = 1;
