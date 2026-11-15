import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import {
	bindExecutionContext,
	executionContextPath,
	resolveExecutionContext,
} from "../../src/pao/cards/execution-context.ts";
import { appendReceipt, changeCardStatus } from "../../src/pao/cards/index.ts";
import {
	appendCardInputReference,
	assertDispatchReferenceNotSuperseded,
	loadDispatchBriefArtifact,
	loadDispatchContractReference,
	loadDispatchMapArtifact,
	saveDispatchBriefArtifact,
	saveDispatchContractReference,
	saveDispatchMapArtifact,
} from "../../src/pao/dispatch-brief/artifacts.ts";
import { prepareDispatchBrief } from "../../src/pao/dispatch-brief/brief.ts";
import { sha256Bytes } from "../../src/pao/dispatch-brief/canonical.ts";
import { findDispatchReferenceImpact, formatDispatchReferenceImpact } from "../../src/pao/dispatch-brief/impact.ts";
import { dispatchReconWorkerEnvironment } from "../../src/pao/dispatch-brief/index.ts";
import { precheckDispatchReferences } from "../../src/pao/dispatch-brief/precheck.ts";
import {
	resolveCurrentAttemptReconRefs,
	saveDispatchReconHandoff,
} from "../../src/pao/dispatch-brief/recon-handoff.ts";
import { freezeDispatchBrief, verifyDispatchSnapshot } from "../../src/pao/dispatch-brief/snapshot.ts";
import { registerDispatchBriefTools, registerDispatchReconTool } from "../../src/pao/dispatch-brief/tool.ts";
import { captureDispatchMap, mapRefFor, sameDispatchMapCoverage } from "../../src/pao/dispatch-brief/workspace.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRepo(): { root: string; cardsDir: string; cardPath: string } {
	const root = mkdtempSync(join(tmpdir(), "pao-dispatch-brief-"));
	roots.push(root);
	const cardsDir = join(root, ".pao", "任务", "卡");
	mkdirSync(cardsDir, { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	const git = (args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
			cwd: root,
			stdio: "pipe",
		});
	git(["init", "--quiet"]);
	writeFileSync(join(root, "src", "caller.ts"), "export const caller = true;\n");
	writeFileSync(
		join(cardsDir, "卡0001-真实地图.md"),
		`---\ngoal: 验证简报\ndept: 测试\ninputs: ["src/caller.ts", "这是旧卡说明"]\nconstraints: 只改 src\nacceptance: 真实文件内容可核对\nattempt: 0\ncreated: 2026-10-20 10:00\nstatus: unclaimed\n---\n`,
	);
	git(["add", "."]);
	git(["commit", "-qm", "base"]);
	return { root, cardsDir, cardPath: join(cardsDir, "卡0001-真实地图.md") };
}

async function dispatchReconTool(input: {
	cardsDir: string;
	cardNo: number;
	attempt: number;
	owner: string;
	id: string;
	markdown: string;
	sections: Array<{
		category: "facts" | "unknowns" | "scope" | "acceptance" | "risks" | "evidence" | "integration";
		title: string;
		markdown: string;
	}>;
}): Promise<{ ref: string; digest: string }> {
	let definition: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	const pi = {
		registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
			definition = value;
		},
	} as unknown as ExtensionAPI;
	registerDispatchReconTool(pi);
	const previous = {
		PAO_CARDS_DIR: process.env.PAO_CARDS_DIR,
		PAO_WORKER_CARD: process.env.PAO_WORKER_CARD,
		PAO_WORKER_ATTEMPT: process.env.PAO_WORKER_ATTEMPT,
		PAO_WORKER_OWNER: process.env.PAO_WORKER_OWNER,
	};
	Object.assign(process.env, {
		PAO_CARDS_DIR: input.cardsDir,
		PAO_WORKER_CARD: `卡${String(input.cardNo).padStart(4, "0")}`,
		PAO_WORKER_ATTEMPT: String(input.attempt),
		PAO_WORKER_OWNER: input.owner,
	});
	try {
		const result = await definition!.execute(
			"recon",
			{
				id: input.id,
				markdown: input.markdown,
				purpose: "侦察结论",
				sections: input.sections,
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError, (result.content[0] as { text: string }).text).not.toBe(true);
		const payload = JSON.parse((result.content[0] as { text: string }).text) as {
			recon: { ref: string; digest: string };
		};
		return payload.recon;
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function setupReconFixture(): Promise<{
	root: string;
	cardsDir: string;
	cards: Map<number, string>;
}> {
	const root = mkdtempSync(join(tmpdir(), "pao-dispatch-recon-"));
	roots.push(root);
	const cardsDir = join(root, ".pao", "任务", "卡");
	mkdirSync(cardsDir, { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "caller.ts"), "export const caller = true;\n");
	const cards = new Map<number, string>();
	const write = (
		cardNo: number,
		filename: string,
		frontmatter: {
			goal: string;
			status: "unclaimed" | "delivered";
			attempt: number;
			owner?: string;
			inputs?: string[];
			dependsOn?: number[];
		},
		receipt?: string,
	) => {
		const cardPath = join(cardsDir, `卡${String(cardNo).padStart(4, "0")}-${filename}.md`);
		cards.set(cardNo, cardPath);
		writeFileSync(
			cardPath,
			[
				"---",
				`goal: ${frontmatter.goal}`,
				"dept: 测试",
				`inputs: ${JSON.stringify(frontmatter.inputs ?? ["src/caller.ts"])}`,
				"constraints: 只改目标文件",
				`acceptance: 卡${String(cardNo).padStart(4, "0")} 验收`,
				...(frontmatter.dependsOn
					? [
							`depends_on: ${JSON.stringify(frontmatter.dependsOn.map((no) => `卡${String(no).padStart(4, "0")}`))}`,
						]
					: []),
				...(frontmatter.owner ? [`owner: ${frontmatter.owner}`] : []),
				`attempt: ${frontmatter.attempt}`,
				"created: 2026-10-20 10:00",
				`status: ${frontmatter.status}`,
				"---",
				"",
				receipt ?? "",
			].join("\n"),
		);
	};
	write(10, "侦察", { goal: "侦察调用边界", status: "unclaimed", attempt: 0 });
	write(11, "实现", {
		goal: "实现调用改动",
		status: "unclaimed",
		attempt: 0,
		dependsOn: [10],
	});
	write(12, "规划", {
		goal: "根据侦察制定计划",
		status: "unclaimed",
		attempt: 0,
		dependsOn: [10],
	});
	write(13, "审核", { goal: "审核实现", status: "unclaimed", attempt: 0, dependsOn: [10, 11] });
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: root });
	return { root, cardsDir, cards };
}

describe("dispatch-brief persistence and map", () => {
	it("覆盖 HEAD、暂存、未暂存、未跟踪内容，且范围外变化不影响地图", () => {
		const { root } = tempRepo();
		const untouched = join(root, "src", "caller.ts");
		writeFileSync(untouched, "export const caller = 'head';\n");
		writeFileSync(join(root, "src", "readme.md"), "head file\n");
		writeFileSync(join(root, "src", "new.ts"), "export const added = true;\n");
		const baseline = captureDispatchMap({
			id: "map-real",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
			capturedAt: "2026-10-20T10:00:00.000Z",
		});
		expect(baseline.status).toBe("valid");
		expect(baseline.coverage.paths).toEqual(["src"]);
		expect(baseline.files.map((file) => file.path)).toContain("src/new.ts");
		expect(baseline.files.every((file) => !file.path.startsWith(root))).toBe(true);
		writeFileSync(join(untouched), "export const caller = 'working';\n");
		execFileSync("git", ["add", "src/caller.ts"], { cwd: root });
		writeFileSync(join(untouched), "export const caller = 'staged?'; \n");
		execFileSync("git", ["add", "src/caller.ts"], { cwd: root });
		writeFileSync(join(untouched), "export const caller = 'unstaged';\n");
		writeFileSync(join(root, "src", "untracked.ts"), "export const u = 1;\n");
		const changed = captureDispatchMap({
			id: "map-real",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
			capturedAt: "2026-10-20T10:00:00.000Z",
		});
		const changedCalling = changed.files.find((file) => file.path === "src/caller.ts");
		expect(changedCalling?.headDigest).not.toBe(changedCalling?.indexDigest);
		expect(changedCalling?.indexDigest).not.toBe(changedCalling?.workingDigest);
		expect(changed.files.some((file) => file.path === "src/untracked.ts")).toBe(true);
		writeFileSync(join(root, "outside.txt"), "unrelated\n");
		const afterOutside = captureDispatchMap({
			id: "map-real",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
			capturedAt: "2026-10-20T10:00:00.000Z",
		});
		expect(afterOutside.mapDigest).toBe(changed.mapDigest);
	});

	it("项目根覆盖统一排除 Git 元数据和编排状态，控制文件持续写入不使业务地图失效", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const controlPath = join(root, ".pao", "工作流实例-定向回归.md");
		writeFileSync(controlPath, "状态: 初始\n");
		const map = captureDispatchMap({
			id: "implicit-project-boundary",
			projectRoot: root,
			coverage: ["."],
			scopeConfirmed: true,
			scopeBasis: ["项目根覆盖能检出 src 业务文件的新增调用方"],
		});
		expect(map.coverage.paths).toEqual(["."]);
		expect(map.coverage.excludes).toEqual([".git", ".pao"]);
		expect(map.files.map((file) => file.path)).toContain("src/caller.ts");
		expect(map.files.every((file) => !file.path.startsWith(".git/") && !file.path.startsWith(".pao/"))).toBe(true);
		const explicitControlCoverage = captureDispatchMap({
			id: "explicit-control-boundary",
			projectRoot: root,
			coverage: ["src/caller.ts", ".git/HEAD", ".pao"],
			scopeConfirmed: true,
			scopeBasis: ["业务文件覆盖能检出新增调用方"],
		});
		expect(explicitControlCoverage.coverage.excludes).toEqual([".git", ".pao"]);
		expect(explicitControlCoverage.files.map((file) => file.path)).toEqual(["src/caller.ts"]);
		const saved = await saveDispatchMapArtifact({ cardsDir, artifact: map });
		await appendCardInputReference({ cardPath, ref: saved.ref });
		const precheck = () =>
			precheckDispatchReferences({
				cardsDir,
				cardPath,
				projectRoot: root,
				executionRoot: root,
				refs: [],
				workspace: { commonGitDir: join(root, ".git") },
			});

		writeFileSync(controlPath, "状态: 派发中\n");
		mkdirSync(join(root, ".pao", "卡"), { recursive: true });
		writeFileSync(join(root, ".pao", "卡", "卡0002-流程写入.md"), "---\nstatus: in_progress\n---\n");
		execFileSync("git", ["add", ".pao"], { cwd: root });
		const controlWrites = await precheck();
		expect(controlWrites.ok, JSON.stringify(controlWrites.issues, null, 2)).toBe(true);

		writeFileSync(join(root, "src", "caller.ts"), "export const caller = 'business-change';\n");
		const businessChange = await precheck();
		expect(businessChange.ok).toBe(false);
		expect(businessChange.code).toBe("stale_map");
	});

	it("单纯给出目录覆盖也不算调用边界已确认；必须显式 scopeConfirmed", () => {
		const { root } = tempRepo();
		const map = captureDispatchMap({
			id: "scope-review",
			projectRoot: root,
			coverage: ["src"],
		});
		expect(map.scopeConfirmed).toBe(false);
		expect(map.scopeReviewRequired).toBe(true);
		expect(map.status).toBe("unknown");
	});

	it("Git仓库内子项目的编排状态也排除，真实业务改动仍使地图失效", () => {
		const { root } = tempRepo();
		const projectRoot = join(root, "apps", "project");
		mkdirSync(join(projectRoot, ".pao", "任务", "卡"), { recursive: true });
		const business = join(projectRoot, "business.ts"),
			state = join(projectRoot, ".pao", "任务", "工作流实例.md");
		writeFileSync(business, "export const value = 1;\n");
		writeFileSync(state, "状态: 初始化\n");
		const capture = () =>
			captureDispatchMap({
				id: "nested-project",
				projectRoot,
				coverage: ["apps/project"],
				scopeConfirmed: true,
				scopeBasis: ["子项目整体业务范围"],
			});
		const saved = capture();
		expect(saved.coverage.excludes).toContain("apps/project/.pao");
		expect(saved.files.map((file) => file.path)).toEqual(["apps/project/business.ts"]);
		writeFileSync(state, "状态: 已写卡和回执\n");
		expect(sameDispatchMapCoverage(saved, capture())).toBe(true);
		writeFileSync(business, "export const value = 2;\n");
		expect(sameDispatchMapCoverage(saved, capture())).toBe(false);
	});

	it("覆盖路径与契约内容必须留在项目根内", async () => {
		const { root, cardsDir } = tempRepo();
		expect(() =>
			captureDispatchMap({
				id: "escape",
				projectRoot: root,
				coverage: ["../outside"],
			}),
		).toThrow(expect.objectContaining({ code: "unsafe_path" }));
		const contractPath = join(root, "..", "outside-contract.md");
		writeFileSync(contractPath, "outside\n");
		try {
			await expect(
				saveDispatchContractReference({
					cardsDir,
					projectRoot: root,
					id: "escape-contract",
					version: "1",
					ref: contractPath,
					contentPath: "../outside-contract.md",
					digest: sha256Bytes(readFileSync(contractPath)),
				}),
			).rejects.toMatchObject({ code: "unsafe_path" });
		} finally {
			rmSync(contractPath, { force: true });
		}
	});

	it("多目录里的局部目录不能替其他覆盖目录确认调用边界", () => {
		const { root } = tempRepo();
		mkdirSync(join(root, "src", "a"), { recursive: true });
		mkdirSync(join(root, "src", "b"), { recursive: true });
		writeFileSync(join(root, "src", "a", "one.ts"), "export const one = true;\n");
		writeFileSync(join(root, "src", "b", "two.ts"), "export const two = true;\n");
		const map = captureDispatchMap({
			id: "multi-scope",
			projectRoot: root,
			coverage: ["src/a", "src/b"],
			facts: ["src/a 已查"],
		});
		expect(map.coverage.paths).toEqual(["src/a", "src/b"]);
		expect(map.scopeConfirmed).toBe(false);
		expect(map.scopeReviewRequired).toBe(true);
		expect(map.status).toBe("unknown");
	});

	it("覆盖外提交不使地图过期，覆盖内文件内容变化仍拒绝", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const map = captureDispatchMap({
			id: "outside-commit",
			projectRoot: root,
			coverage: ["src/caller.ts"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
		});
		const saved = await saveDispatchMapArtifact({ cardsDir, artifact: map });
		await appendCardInputReference({ cardPath, ref: saved.ref });
		writeFileSync(join(root, "outside.txt"), "outside\n");
		execFileSync("git", ["add", "outside.txt"], { cwd: root });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "outside"], { cwd: root });
		const clean = await precheckDispatchReferences({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			refs: [],
			workspace: {
				commonGitDir: join(root, ".git"),
			},
		});
		expect(clean.ok, JSON.stringify(clean.issues, null, 2)).toBe(true);
		writeFileSync(join(root, "src", "caller.ts"), "export const caller = 'changed';\n");
		const changed = await precheckDispatchReferences({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			refs: [],
			workspace: {
				commonGitDir: join(root, ".git"),
			},
		});
		expect(changed.ok).toBe(false);
		expect(changed.code).toBe("stale_map");
	});

	it("真实 linked worktree 通过共同 Git 目录核验，异仓或伪造共同目录被拒绝", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const worktree = join(root, "..", `${root.split(/[\\/]/).pop()}-linked`);
		roots.push(worktree);
		execFileSync("git", ["worktree", "add", "--quiet", "-b", "linked-test", worktree, "HEAD"], {
			cwd: root,
		});
		const commonGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: worktree,
			encoding: "utf8",
		}).trim();
		const map = captureDispatchMap({
			id: "linked-map",
			projectRoot: root,
			executionRoot: worktree,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
		});
		const saved = await saveDispatchMapArtifact({ cardsDir, artifact: map });
		await appendCardInputReference({ cardPath, ref: saved.ref });
		const result = await precheckDispatchReferences({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: worktree,
			refs: [],
			workspace: {
				repositoryRoot: worktree,
				commonGitDir,
				bindingDigest: "host:managed:1",
			},
		});
		expect(result.ok, JSON.stringify(result.issues, null, 2)).toBe(true);

		const fake = await precheckDispatchReferences({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: worktree,
			refs: [],
			workspace: {
				commonGitDir: join(root, "different.git"),
			},
		});
		expect(fake.ok).toBe(false);
		expect(fake.code).toBe("execution_binding_invalid");

		const otherRepo = mkdtempSync(join(tmpdir(), "pao-dispatch-other-"));
		roots.push(otherRepo);
		execFileSync("git", ["init", "--quiet"], { cwd: otherRepo });
		writeFileSync(join(otherRepo, "other.txt"), "other\n");
		execFileSync("git", ["add", "other.txt"], { cwd: otherRepo });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "other"], { cwd: otherRepo });
		const otherCommon = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: otherRepo,
			encoding: "utf8",
		}).trim();
		const mixed = await precheckDispatchReferences({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: worktree,
			refs: [saved.ref],
			workspace: {
				commonGitDir: otherCommon,
			},
		});
		expect(mixed.ok).toBe(false);
		expect(mixed.code).toBe("execution_binding_invalid");
	});

	it("已知 dirty 基线在内容一致的 linked worktree 中复用，覆盖外变化仍复用而覆盖内变化失效", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const worktree = join(root, "..", `${root.split(/[\\/]/).pop()}-dirty-linked`);
		roots.push(worktree);
		execFileSync("git", ["worktree", "add", "--quiet", "-b", "dirty-linked-test", worktree, "HEAD"], {
			cwd: root,
		});
		const dirtyContent = "export const caller = 'dirty baseline';\n";
		writeFileSync(join(root, "src", "caller.ts"), dirtyContent);
		writeFileSync(join(worktree, "src", "caller.ts"), dirtyContent);
		const untrackedContent = "export const untrackedBaseline = true;\n";
		writeFileSync(join(root, "src", "untracked.ts"), untrackedContent);
		writeFileSync(join(worktree, "src", "untracked.ts"), untrackedContent);
		const map = captureDispatchMap({
			id: "dirty-map",
			projectRoot: root,
			executionRoot: worktree,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
		});
		const saved = await saveDispatchMapArtifact({ cardsDir, artifact: map });
		await appendCardInputReference({ cardPath, ref: saved.ref });
		const commonGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: worktree,
			encoding: "utf8",
		}).trim();
		const precheck = () =>
			precheckDispatchReferences({
				cardsDir,
				cardPath,
				projectRoot: root,
				executionRoot: worktree,
				refs: [],
				workspace: { commonGitDir },
			});

		const baseline = await precheck();
		expect(baseline.ok, JSON.stringify(baseline.issues, null, 2)).toBe(true);
		writeFileSync(join(worktree, "outside.txt"), "outside only\n");
		const outside = await precheck();
		expect(outside.ok, JSON.stringify(outside.issues, null, 2)).toBe(true);
		writeFileSync(join(worktree, "src", "caller.ts"), "export const caller = 'changed';\n");
		const changed = await precheck();
		expect(changed.ok).toBe(false);
		expect(changed.code).toBe("stale_map");
	});

	it("保存、读取、卡 inputs URI 去重，旧卡普通说明不冒充结构化引用", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const map = captureDispatchMap({
			id: "map-artifact",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
		});
		const savedMap = await saveDispatchMapArtifact({ cardsDir, artifact: map });
		expect(loadDispatchMapArtifact(savedMap.ref, { cardsDir }).id).toBe("map-artifact");
		const brief = await saveDispatchBriefArtifact({
			cardsDir,
			id: "brief-artifact",
			cardPath,
			cardNo: 1,
			attempt: 1,
			markdown: "# 任务\n目标可直接执行",
		});
		expect(loadDispatchBriefArtifact(brief.ref, { cardsDir }).markdown).toContain("目标可直接执行");
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface A { x: string }\n");
		const contract = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "contract-a",
			version: "1",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
		});
		expect(loadDispatchContractReference(contract.ref, { cardsDir }).version).toBe("1");
		writeFileSync(contractPath, "export interface A { x: number }\n");
		const nextContract = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "contract-a",
			version: "2",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
			previousRef: contract.ref,
			supersessionReason: "接口类型改为 number",
		});
		expect(loadDispatchContractReference(contract.ref, { cardsDir }).version).toBe("1");
		expect(loadDispatchContractReference(nextContract.ref, { cardsDir }).version).toBe("2");

		await expect(appendCardInputReference({ cardPath, ref: savedMap.ref })).resolves.toEqual({ changed: true });
		await expect(appendCardInputReference({ cardPath, ref: savedMap.ref })).resolves.toEqual({ changed: false });
		const card = readCard(cardPath);
		expect(card.frontmatter.inputs).toContain(savedMap.ref);
		expect(card.frontmatter.inputs).toContain("src/caller.ts");
		expect(card.frontmatter.inputs).toContain("这是旧卡说明");
		expect(card.frontmatter.inputs).not.toContain(brief.ref);
		expect(card.frontmatter.inputs).not.toContain(contract.ref);
	});

	it("工具路径可从卡现有 inputs 引用保存的简报/地图/契约", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const map = captureDispatchMap({
			id: "from-tool",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
		});
		const mapRef = mapRefFor(map);
		const saved = await saveDispatchMapArtifact({ cardsDir, artifact: map });
		expect(saved.ref).toBe(mapRef);
		await appendCardInputReference({ cardPath, ref: saved.ref });
		expect(readCard(cardPath).frontmatter.inputs).toContain(saved.ref);
	});

	it("契约首次版本可无替代，完全重放幂等；同 ID 新版本必须从当前版本显式替代", async () => {
		const { root, cardsDir } = tempRepo();
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface Api { version: 1 }\n");
		const firstInput = {
			cardsDir,
			projectRoot: root,
			id: "version-gate",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
		};
		const first = await saveDispatchContractReference({ ...firstInput, version: "v1" });
		await expect(saveDispatchContractReference({ ...firstInput, version: "v1" })).resolves.toEqual(first);
		await expect(
			saveDispatchContractReference({
				...firstInput,
				version: "v1-b",
			}),
		).rejects.toMatchObject({ code: "missing_input" });
		await expect(
			saveDispatchContractReference({
				...firstInput,
				version: "v2",
				previousRef: first.ref,
			}),
		).rejects.toMatchObject({ code: "missing_input" });
		const v2 = await saveDispatchContractReference({
			...firstInput,
			version: "v2",
			previousRef: first.ref,
			supersessionReason: "接口新增字段",
		});
		await expect(
			saveDispatchContractReference({
				...firstInput,
				version: "v2",
				previousRef: first.ref,
				supersessionReason: "接口新增字段",
			}),
		).resolves.toEqual(v2);
		await expect(
			saveDispatchContractReference({
				...firstInput,
				version: "v3",
				previousRef: first.ref,
				supersessionReason: "从历史版本分叉",
			}),
		).rejects.toMatchObject({ code: "bad_reference" });
		expect(loadDispatchContractReference(first.ref, { cardsDir }).version).toBe("v1");
		expect(loadDispatchContractReference(v2.ref, { cardsDir })).toMatchObject({
			version: "v2",
			previousRef: first.ref,
			supersessionReason: "接口新增字段",
		});
		await expect(
			saveDispatchContractReference({
				...firstInput,
				version: "v2",
				previousRef: first.ref,
				supersessionReason: "同版本的不同替代内容",
				purpose: "同版本内容已变化",
			}),
		).rejects.toMatchObject({ code: "artifact_conflict" });
	});

	it("工具保存契约时拒绝经真实 junction 越出项目根的正本", async () => {
		const { root, cardsDir } = tempRepo();
		const outside = mkdtempSync(join(tmpdir(), "pao-dispatch-contract-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "contract.md"), "export interface Outside { escaped: true }\n");
		const junction = join(root, "linked-outside");
		symlinkSync(outside, junction, "junction");
		let definition: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
		const pi = {
			registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
				definition = value;
			},
		} as unknown as ExtensionAPI;
		registerDispatchBriefTools(pi, { resolveCardsDir: () => cardsDir });
		const result = await definition!.execute(
			"junction-save",
			{
				action: "contract",
				cards_dir: cardsDir,
				id: "junction-contract",
				version: "1",
				ref: join(junction, "contract.md"),
				project_root: root,
				content_path: "linked-outside/contract.md",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("项目根内的真实路径");
		expect(() => readFileSync(join(cardsDir, "..", "输入快照", "contract", "junction-contract.json"))).toThrow();
	});

	it("契约冻结后把 src 换成真实 junction，precheck 与 verify 都拒绝实际越界读取", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const claimed = readCard(cardPath);
		claimed.frontmatter.attempt = 1;
		claimed.frontmatter.status = "in_progress";
		claimed.frontmatter.owner = "路径门用户";
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface Guard { value: string }\n");
		const contract = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "junction-guard",
			version: "1",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
		});
		claimed.frontmatter.inputs = [...(claimed.frontmatter.inputs ?? []), contract.ref];
		writeFileSync(claimed.path, serializeCard(claimed.frontmatter, claimed.body));
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "路径门用户" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		const snapshot = await freezeDispatchBrief(
			draft,
			{ attempt: 1, owner: "路径门用户" },
			{
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				versionControl: "git",
				commonGitDir: join(root, ".git"),
			},
		);
		const outside = mkdtempSync(join(tmpdir(), "pao-dispatch-read-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "contract.md"), "export interface Guard { escaped: true }\n");
		rmSync(join(root, "src"), { recursive: true, force: true });
		symlinkSync(outside, join(root, "src"), "junction");
		const precheck = await precheckDispatchReferences({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			refs: [],
			workspace: { commonGitDir: join(root, ".git") },
		});
		expect(precheck.ok).toBe(false);
		expect(precheck.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "bad_reference",
					message: expect.stringContaining("项目根内的真实路径"),
				}),
			]),
		);
		const verify = await verifyDispatchSnapshot(snapshot, {
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "路径门用户" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		expect(verify.ok).toBe(false);
		expect(verify.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "bad_reference",
					message: expect.stringContaining("项目根内的真实路径"),
				}),
			]),
		);
	});

	it("已交付前置卡冻结的旧来源通过 depends_on 命中未终态下游，并排除无关与终态卡", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const oldMap = captureDispatchMap({
			id: "dependency-map-v1",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
		});
		const oldMapSaved = await saveDispatchMapArtifact({ cardsDir, artifact: oldMap });
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface Dependency { version: 1 }\n");
		const oldContract = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "dependency-contract",
			version: "1",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
		});
		const source = readCard(cardPath);
		source.frontmatter.attempt = 1;
		source.frontmatter.status = "in_progress";
		source.frontmatter.owner = "前置侦察";
		source.frontmatter.inputs = [...(source.frontmatter.inputs ?? []), oldMapSaved.ref, oldContract.ref];
		writeFileSync(source.path, serializeCard(source.frontmatter, source.body));
		const sourceDraft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "前置侦察" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		const sourceSnapshot = await freezeDispatchBrief(
			sourceDraft,
			{ attempt: 1, owner: "前置侦察" },
			{
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				versionControl: "git",
				commonGitDir: join(root, ".git"),
			},
		);
		expect(sourceSnapshot.map?.ref).toBe(oldMapSaved.ref);
		expect(sourceSnapshot.contracts.map((item) => item.ref)).toContain(oldContract.ref);
		changeCardStatus(readCard(cardPath), {
			操作者: "前置侦察",
			to: "delivered",
			时间: "2026-10-20 11:00",
		});
		const writeDependent = (
			cardNo: number,
			name: string,
			status: "unclaimed" | "delivered" | "canceled",
			dependsOn: number[],
		) =>
			writeFileSync(
				join(cardsDir, `卡${String(cardNo).padStart(4, "0")}-${name}.md`),
				[
					"---",
					`goal: ${name}`,
					"dept: 测试",
					'inputs: ["src/caller.ts"]',
					`depends_on: ${JSON.stringify(dependsOn.map((no) => `卡${String(no).padStart(4, "0")}`))}`,
					"acceptance: 影响只命中真实使用来源",
					"attempt: 0",
					"created: 2026-10-20 10:00",
					`status: ${status}`,
					"---",
					"",
				].join("\n"),
			);
		writeDependent(2, "依赖前置", "unclaimed", [1]);
		writeDependent(3, "无关", "unclaimed", []);
		writeDependent(4, "终态下游", "canceled", [1]);
		writeFileSync(contractPath, "export interface Dependency { version: 2 }\n");
		const nextContract = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "dependency-contract",
			version: "2",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
			previousRef: oldContract.ref,
			supersessionReason: "前置卡来源升级",
		});
		const nextMap = captureDispatchMap({
			id: "dependency-map-v2",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
			previousRef: oldMapSaved.ref,
			supersessionReason: "前置卡地图升级",
		});
		const nextMapSaved = await saveDispatchMapArtifact({ cardsDir, artifact: nextMap });
		const contractImpact = findDispatchReferenceImpact({
			cardsDir,
			ref: nextContract.ref,
			previousRef: oldContract.ref,
			reason: "前置卡来源升级",
		});
		expect(contractImpact.affected.map((item) => item.cardNo)).toEqual([2]);
		expect(contractImpact.affected[0]).toMatchObject({
			matchedRef: oldContract.ref,
			message: expect.stringContaining("前置卡当前尝试快照"),
		});
		expect(contractImpact.ignored).toEqual(expect.arrayContaining([1, 3, 4]));
		const mapImpact = findDispatchReferenceImpact({
			cardsDir,
			ref: nextMapSaved.ref,
			previousRef: oldMapSaved.ref,
			reason: "前置卡地图升级",
		});
		expect(mapImpact.affected.map((item) => item.cardNo)).toEqual([2]);
		expect(mapImpact.affected[0]?.matchedRef).toBe(oldMapSaved.ref);
		expect(mapImpact.ignored).toEqual(expect.arrayContaining([1, 3, 4]));
	});

	it("显式旧 attempt 简报的来源卡升到新 attempt 后仍按简报身份命中原快照契约", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface Historical { version: 1 }\n");
		const oldContract = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "historical-contract",
			version: "1",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
		});
		const source = readCard(cardPath);
		source.frontmatter.attempt = 1;
		source.frontmatter.status = "in_progress";
		source.frontmatter.owner = "旧尝试来源";
		source.frontmatter.inputs = [...(source.frontmatter.inputs ?? []), oldContract.ref];
		writeFileSync(source.path, serializeCard(source.frontmatter, source.body));
		const oldDraft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "旧尝试来源" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		const oldSnapshot = await freezeDispatchBrief(
			oldDraft,
			{ attempt: 1, owner: "旧尝试来源" },
			{
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				versionControl: "git",
				commonGitDir: join(root, ".git"),
			},
		);
		expect(oldSnapshot.card.attempt).toBe(1);
		const sourceAfterAttempt = readCard(cardPath);
		sourceAfterAttempt.frontmatter.status = "unclaimed";
		sourceAfterAttempt.frontmatter.attempt = 2;
		delete sourceAfterAttempt.frontmatter.owner;
		writeFileSync(sourceAfterAttempt.path, serializeCard(sourceAfterAttempt.frontmatter, sourceAfterAttempt.body));
		const downstreamPath = join(cardsDir, "卡0002-显式旧简报.md");
		writeFileSync(
			downstreamPath,
			[
				"---",
				"goal: 消费旧尝试简报",
				"dept: 测试",
				'inputs: ["src/caller.ts", "' + oldSnapshot.brief.ref + '"]',
				"acceptance: 旧简报所绑定的旧契约升级仍能命中",
				"attempt: 0",
				"created: 2026-10-20 10:00",
				"status: unclaimed",
				"---",
				"",
			].join("\n"),
		);
		writeFileSync(contractPath, "export interface Historical { version: 2 }\n");
		const nextContract = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "historical-contract",
			version: "2",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
			previousRef: oldContract.ref,
			supersessionReason: "历史简报所绑定的契约升版",
		});
		const impact = findDispatchReferenceImpact({
			cardsDir,
			ref: nextContract.ref,
			previousRef: oldContract.ref,
			reason: "历史简报所绑定的契约升版",
		});
		expect(impact.affected.map((item) => item.cardNo)).toEqual([1, 2]);
		expect(impact.affected[0]).toMatchObject({
			matchedRef: oldContract.ref,
			message: expect.stringContaining("卡 inputs"),
		});
		expect(impact.affected[1]).toMatchObject({
			cardNo: 2,
			matchedRef: oldContract.ref,
			message: expect.stringContaining("上游简报身份"),
		});
		expect(readCard(cardPath).frontmatter.attempt).toBe(2);
		expect(readCard(downstreamPath).frontmatter.inputs).toContain(oldSnapshot.brief.ref);
	});

	it("正常工具入口可创建地图并写回卡现有 inputs", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const claimed = readCard(cardPath);
		claimed.frontmatter.attempt = 1;
		claimed.frontmatter.status = "in_progress";
		claimed.frontmatter.owner = "工具主控";
		writeFileSync(claimed.path, serializeCard(claimed.frontmatter, claimed.body));
		let definition: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
		const pi = {
			registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
				definition = value;
			},
		} as unknown as ExtensionAPI;
		registerDispatchBriefTools(pi, { resolveCardsDir: () => cardsDir });
		expect(definition?.name).toBe("pao_dispatch_brief");
		const result = await definition!.execute(
			"map",
			{
				action: "map",
				id: "tool-map",
				project_root: root,
				coverage: ["src"],
				scope_confirmed: true,
				scope_basis: ["覆盖范围内可检出新增调用方"],
				card_path: cardPath,
				card_no: 1,
				attempt: 1,
				owner: "工具主控",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError, (result.content[0] as { text: string }).text).not.toBe(true);
		const payload = JSON.parse((result.content[0] as { text: string }).text) as {
			ref: string;
			changed: boolean;
		};
		expect(payload.ref).toMatch(/^pao-map:\/\//);
		expect(payload.changed).toBe(true);
		expect(readCard(cardPath).frontmatter.inputs).toContain(payload.ref);
	});

	it("契约升版保留旧版本与旧快照，影响事件命中 pending/active 并排除无关和已终态卡", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface Api { version: 1 }\n");
		const v1 = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "api-contract",
			version: "1",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
		});
		const pending = readCard(cardPath);
		pending.frontmatter.inputs = [...(pending.frontmatter.inputs ?? []), v1.ref];
		writeFileSync(pending.path, serializeCard(pending.frontmatter, pending.body));
		const activePath = join(cardsDir, "卡0002-运行中.md");
		writeFileSync(
			activePath,
			`---\ngoal: 运行中的契约使用方\ndept: 测试\ninputs: ["${v1.ref}"]\nacceptance: 复核新契约\nattempt: 1\ncreated: 2026-10-20 10:00\nstatus: in_progress\nowner: 运行中 owner\n---\n旧 attempt 回执与证据必须保留。\n`,
		);
		const unrelatedPath = join(cardsDir, "卡0003-无关.md");
		writeFileSync(
			unrelatedPath,
			`---\ngoal: 无关任务\ndept: 测试\ninputs: ["src/other.ts"]\nacceptance: 不打扰\nattempt: 0\ncreated: 2026-10-20 10:00\nstatus: unclaimed\n---\n`,
		);
		const deliveredPath = join(cardsDir, "卡0004-已交付.md");
		writeFileSync(
			deliveredPath,
			`---\ngoal: 已交付任务\ndept: 测试\ninputs: ["${v1.ref}"]\nacceptance: 已完成\nattempt: 1\ncreated: 2026-10-20 10:00\ncompleted: 2026-10-20 11:00\nstatus: delivered\nowner: 已完成 owner\n---\n旧交付回执。\n`,
		);
		const before = new Map(
			[cardPath, activePath, unrelatedPath, deliveredPath].map((path) => [path, readFileSync(path)]),
		);
		const pendingSnapshot = await saveDispatchBriefArtifact({
			cardsDir,
			id: "pending-attempt-1",
			cardPath,
			cardNo: pending.card_no,
			attempt: 1,
			owner: "pending-owner",
			markdown: "旧简报",
		});
		const pendingSnapshotBytes = readFileSync(join(cardsDir, "..", "输入快照", "brief", "pending-attempt-1.json"));

		writeFileSync(contractPath, "export interface Api { version: 2 }\n");
		const v2 = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "api-contract",
			version: "2",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
			previousRef: v1.ref,
			supersessionReason: "新增必填字段，调用方需要同步复核",
			affectedCards: [1, 2, 3],
		});
		const v1Record = loadDispatchContractReference(v1.ref, { cardsDir });
		const v2Record = loadDispatchContractReference(v2.ref, { cardsDir });
		expect(v1Record).toMatchObject({ id: "api-contract", version: "1" });
		expect(v2Record).toMatchObject({
			id: "api-contract",
			version: "2",
			previousRef: v1.ref,
			supersessionReason: "新增必填字段，调用方需要同步复核",
		});
		expect(loadDispatchBriefArtifact(pendingSnapshot.ref, { cardsDir }).markdown).toBe("旧简报");
		for (const [path, bytes] of before) expect(readFileSync(path)).toEqual(bytes);
		expect(readFileSync(join(cardsDir, "..", "输入快照", "brief", "pending-attempt-1.json"))).toEqual(
			pendingSnapshotBytes,
		);

		const impact = findDispatchReferenceImpact({
			cardsDir,
			ref: v2.ref,
			previousRef: v1.ref,
			reason: v2Record.supersessionReason,
		});
		expect(
			impact.affected.map(({ cardNo, status, attempt, action }) => ({ cardNo, status, attempt, action })),
		).toEqual([
			{ cardNo: 1, status: "unclaimed", attempt: 0, action: "checkpoint" },
			{ cardNo: 2, status: "in_progress", attempt: 1, action: "checkpoint" },
		]);
		expect(impact.ignored).toEqual([3, 4]);
		const text = formatDispatchReferenceImpact(impact);
		expect(text).toContain("新增必填字段");
		expect(text).toContain("卡0001");
		expect(text).toContain("卡0002");
		expect(text).toContain("旧输入、旧快照和旧证据均保留");
	});

	it("间接来源与重启式重读都阻止旧来源；旧版本仍只读可加载", async () => {
		const { root, cardsDir } = tempRepo();
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface Api { version: 1 }\n");
		const v1 = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "indirect-api",
			version: "1",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
		});
		const oldMap = captureDispatchMap({
			id: "indirect-map-v1",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
			facts: ["旧地图"],
		});
		await saveDispatchMapArtifact({ cardsDir, artifact: oldMap });
		const dependentPath = join(cardsDir, "卡0002-间接使用.md");
		writeFileSync(
			dependentPath,
			`---\ngoal: 快照里的旧地图\ndept: 测试\ninputs: ["src/caller.ts"]\nacceptance: 新派发拒绝旧来源\nattempt: 1\ncreated: 2026-10-20 10:00\nstatus: in_progress\nowner: 快照用户\n---\n`,
		);
		const dependent = readCard(dependentPath);
		dependent.frontmatter.inputs = [...(dependent.frontmatter.inputs ?? []), mapRefFor(oldMap)];
		writeFileSync(dependent.path, serializeCard(dependent.frontmatter, dependent.body));
		const dependencyDraft = await prepareDispatchBrief({
			cardsDir,
			cardPath: dependentPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "快照用户" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		const dependencySnapshot = await freezeDispatchBrief(
			dependencyDraft,
			{ attempt: 1, owner: "快照用户" },
			{
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				versionControl: "git",
				commonGitDir: join(root, ".git"),
			},
		);
		expect(dependencySnapshot.map?.ref).toBe(mapRefFor(oldMap));
		const unrelatedPath = join(cardsDir, "卡0003-无关.md");
		writeFileSync(
			unrelatedPath,
			`---\ngoal: 无关\ndept: 测试\ninputs: ["src/caller.ts"]\nacceptance: 不受影响\nattempt: 0\ncreated: 2026-10-20 10:00\nstatus: unclaimed\n---\n`,
		);
		const deliveredPath = join(cardsDir, "卡0004-已交付.md");
		writeFileSync(
			deliveredPath,
			`---\ngoal: 已交付\ndept: 测试\ninputs: ["${v1.ref}"]\nacceptance: 已完成\nattempt: 1\ncreated: 2026-10-20 10:00\ncompleted: 2026-10-20 11:00\nstatus: delivered\n---\n`,
		);
		writeFileSync(contractPath, "export interface Api { version: 2 }\n");
		await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "indirect-api",
			version: "2",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
			previousRef: v1.ref,
			supersessionReason: "间接来源升级",
		});
		const nextMap = captureDispatchMap({
			id: "indirect-map-v2",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
			facts: ["新地图"],
			previousRef: mapRefFor(oldMap),
			supersessionReason: "旧地图事实变化",
		});
		const nextMapSaved = await saveDispatchMapArtifact({ cardsDir, artifact: nextMap });
		// 这里的快照故意只验证身份/路径逻辑，真实冻结快照由下一个独立进程反例覆盖。
		expect(loadDispatchContractReference(v1.ref, { cardsDir }).version).toBe("1");
		expect(loadDispatchMapArtifact(mapRefFor(oldMap), { cardsDir }).id).toBe(oldMap.id);
		expect(() => assertDispatchReferenceNotSuperseded(v1.ref, { cardsDir })).toThrow(
			expect.objectContaining({ code: "contract_changed" }),
		);
		expect(() => assertDispatchReferenceNotSuperseded(mapRefFor(oldMap), { cardsDir })).toThrow(
			expect.objectContaining({ code: "stale_map" }),
		);
		const impact = findDispatchReferenceImpact({
			cardsDir,
			ref: nextMapSaved.ref,
			previousRef: mapRefFor(oldMap),
			reason: "间接来源升级",
		});
		expect(impact.affected.map((item) => item.cardNo)).toContain(2);
		expect(impact.ignored).toContain(3);
		expect(impact.ignored).toContain(4);
	});

	it("precheck 与 verify 对显式替代后的旧地图和旧契约都停发，旧版本仍可加载", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const claimed = readCard(cardPath);
		claimed.frontmatter.attempt = 1;
		claimed.frontmatter.status = "in_progress";
		claimed.frontmatter.owner = "门禁用户";
		writeFileSync(claimed.path, serializeCard(claimed.frontmatter, claimed.body));
		const oldMap = captureDispatchMap({
			id: "gate-map-v1",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
		});
		const oldMapSaved = await saveDispatchMapArtifact({ cardsDir, artifact: oldMap });
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface Gate { version: 1 }\n");
		const oldContract = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "gate-contract",
			version: "1",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
		});
		const card = readCard(cardPath);
		card.frontmatter.inputs = [...(card.frontmatter.inputs ?? []), oldMapSaved.ref, oldContract.ref];
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "门禁用户" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		const snapshot = await freezeDispatchBrief(
			draft,
			{ attempt: 1, owner: "门禁用户" },
			{
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				versionControl: "git",
				commonGitDir: join(root, ".git"),
			},
		);
		const nextMap = captureDispatchMap({
			id: "gate-map-v2",
			projectRoot: root,
			coverage: ["src"],
			scopeConfirmed: true,
			scopeBasis: ["覆盖范围内可检出新增调用方"],
			previousRef: oldMapSaved.ref,
			supersessionReason: "地图更新",
		});
		await saveDispatchMapArtifact({ cardsDir, artifact: nextMap });
		writeFileSync(contractPath, "export interface Gate { version: 2 }\n");
		await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "gate-contract",
			version: "2",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
			previousRef: oldContract.ref,
			supersessionReason: "契约更新",
		});
		expect(loadDispatchMapArtifact(oldMapSaved.ref, { cardsDir }).id).toBe(oldMap.id);
		expect(loadDispatchContractReference(oldContract.ref, { cardsDir }).version).toBe("1");
		const precheck = await precheckDispatchReferences({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			refs: [],
			workspace: { commonGitDir: join(root, ".git") },
		});
		expect(precheck.ok).toBe(false);
		expect(precheck.issues[0]?.code).toBe("stale_map");
		expect(precheck.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "stale_map", ref: oldMapSaved.ref }),
				expect.objectContaining({ code: "contract_changed", ref: oldContract.ref }),
			]),
		);
		const verify = await verifyDispatchSnapshot(snapshot, {
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 2, owner: "门禁用户" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		expect(verify.ok).toBe(false);
		expect(verify.issues[0]?.code).toBe("card_changed");
		expect(verify.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "stale_map", ref: oldMapSaved.ref }),
				expect.objectContaining({ code: "contract_changed", ref: oldContract.ref }),
			]),
		);
	});

	it("真实工具保存替代版本时把影响事件交给宿主现有通知回调，旧卡与旧版本不改", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface Api { version: 1 }\n");
		const v1 = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "tool-api",
			version: "1",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
		});
		const card = readCard(cardPath);
		card.frontmatter.inputs = [...(card.frontmatter.inputs ?? []), v1.ref];
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const cardBefore = readFileSync(cardPath);
		writeFileSync(contractPath, "export interface ToolApi { version: 2 }\n");
		let definition: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
		const delivered: unknown[] = [];
		const pi = {
			registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
				definition = value;
			},
		} as unknown as ExtensionAPI;
		registerDispatchBriefTools(pi, {
			resolveCardsDir: () => cardsDir,
			onReferenceImpact: (impact) => {
				delivered.push(impact);
			},
		});
		const result = await definition!.execute(
			"contract-v2",
			{
				action: "contract",
				cards_dir: cardsDir,
				id: "tool-api",
				version: "2",
				ref: contractPath,
				project_root: root,
				content_path: "src/contract.md",
				previous_ref: v1.ref,
				supersession_reason: "工具入口升级契约",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError, (result.content[0] as { text: string }).text).not.toBe(true);
		const payload = JSON.parse((result.content[0] as { text: string }).text) as {
			impact: { affected: Array<{ cardNo: number; action: string }>; previousRef: string };
		};
		expect(payload.impact.previousRef).toBe(v1.ref);
		expect(payload.impact.affected).toEqual([expect.objectContaining({ cardNo: 1, action: "checkpoint" })]);
		expect(delivered).toEqual([payload.impact]);
		expect(readFileSync(cardPath)).toEqual(cardBefore);
	});

	it("真实工具入口完整保存地图事实、未知、风险与整合责任，并能在正文消费", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const claimed = readCard(cardPath);
		claimed.frontmatter.attempt = 1;
		claimed.frontmatter.status = "in_progress";
		claimed.frontmatter.owner = "工具主控";
		writeFileSync(claimed.path, serializeCard(claimed.frontmatter, claimed.body));
		let definition: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
		const pi = {
			registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
				definition = value;
			},
		} as unknown as ExtensionAPI;
		registerDispatchBriefTools(pi, { resolveCardsDir: () => cardsDir });
		const result = await definition!.execute(
			"map-full",
			{
				action: "map",
				id: "tool-map-full",
				project_root: root,
				coverage: ["src"],
				scope_confirmed: true,
				scope_basis: ["覆盖范围内可检出新增调用方"],
				card_path: cardPath,
				card_no: 1,
				attempt: 1,
				owner: "工具主控",
				facts: ["工具事实"],
				unknowns: ["工具未知"],
				risks: ["工具风险"],
				integration_owner: "工具主控",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError, (result.content[0] as { text: string }).text).not.toBe(true);
		const payload = JSON.parse((result.content[0] as { text: string }).text) as { ref: string };
		const saved = loadDispatchMapArtifact(payload.ref, { cardsDir });
		expect(saved.facts).toEqual(["工具事实"]);
		expect(saved.unknowns).toEqual(["工具未知"]);
		expect(saved.risks).toEqual(["工具风险"]);
		expect(saved.integrationOwner).toBe("工具主控");
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
		});
		expect(draft.briefMarkdown).toContain("工具事实");
		expect(draft.briefMarkdown).toContain("工具风险");
		expect(draft.briefMarkdown).toContain("工具主控");
	});

	it("真实工具保存的无分类上游简报只注入精确 URI，不递归复制全文", async () => {
		const { root, cardsDir, cardPath } = tempRepo();
		const card = readCard(cardPath);
		card.frontmatter.attempt = 1;
		card.frontmatter.status = "in_progress";
		card.frontmatter.owner = "侦察员";
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		let definition: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
		const pi = {
			registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
				definition = value;
			},
		} as unknown as ExtensionAPI;
		registerDispatchBriefTools(pi, { resolveCardsDir: () => cardsDir });
		const upstream = await definition!.execute(
			"upstream",
			{
				action: "brief",
				id: "scout-result",
				project_root: root,
				card_path: cardPath,
				card_no: 1,
				attempt: 1,
				owner: "侦察员",
				purpose: "调用关系侦察结论",
				markdown: "## 必要结论\n所有调用方经过 callers.ts。",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(upstream.isError, (upstream.content[0] as { text: string }).text).not.toBe(true);
		const upstreamResult = JSON.parse((upstream.content[0] as { text: string }).text) as {
			ref: string;
		};
		expect(readCard(cardPath).frontmatter.inputs).toContain(upstreamResult.ref);
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
		});
		expect(draft.briefMarkdown).toContain("调用关系侦察结论");
		expect(draft.briefMarkdown).toContain("保存时未提供结构化分类");
		expect(draft.briefMarkdown).not.toContain("所有调用方经过 callers.ts。");
		expect(draft.briefMarkdown).toContain(upstreamResult.ref);
	});

	it("侦察角色结果可通过保存原语生成受控摘要，并由卡依赖自动进入实现/规划/审核正文", async () => {
		const { root, cardsDir, cards } = await setupReconFixture();
		const recon = changeCardStatus(readCard(cards.get(10)!), {
			操作者: "侦察员",
			to: "in_progress",
			时间: "2026-10-20 10:01",
		});
		const cardDefinitionBefore = readFileSync(recon.path, "utf8");
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		const commonGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		await bindExecutionContext(
			{
				key: { cardsDir, cardNo: 10, attempt: 1 },
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				worktree: {
					kind: "primary",
					taskRoot: root,
					executionRoot: root,
					commonGitDir,
					inputVersion: head,
					bindingDigest: "host:recon:1",
				},
				snapshotRef: "pao://snapshots/recon-10-1.json",
				snapshotDigest: `sha256:${"a".repeat(64)}`,
			},
			{ expectedCurrentAttempt: 1 },
		);
		for (const [key, value] of Object.entries(dispatchReconWorkerEnvironment(cardsDir, 10, 1, "侦察员"))) {
			process.env[key] = value;
		}
		let reconResult: { ref: string; digest: string };
		try {
			reconResult = await dispatchReconTool({
				cardsDir,
				cardNo: 10,
				attempt: 1,
				owner: "侦察员",
				id: "callers",
				markdown: "调用入口唯一在 caller.ts；api.ts 契约待审核。",
				sections: [
					{
						category: "facts",
						title: "调用入口",
						markdown: "调用入口唯一在 caller.ts。",
					},
					{
						category: "unknowns",
						title: "契约",
						markdown: "api.ts 契约待审核。",
					},
					{
						category: "evidence",
						title: "真实文件",
						markdown: "src/caller.ts",
					},
				],
			});
		} finally {
			for (const key of ["PAO_CARDS_DIR", "PAO_WORKER_CARD", "PAO_WORKER_ATTEMPT", "PAO_WORKER_OWNER"]) {
				delete process.env[key];
			}
		}
		expect(readFileSync(recon.path, "utf8")).toBe(cardDefinitionBefore);
		const reconBinding = await resolveExecutionContext(
			{ cardsDir, cardNo: 10, attempt: 1 },
			{ expectedCurrentAttempt: 1 },
		);
		expect(
			resolveCurrentAttemptReconRefs({
				cardsDir,
				cardNo: 10,
				attempt: 1,
				executionBindingDigest: reconBinding.bindingDigest,
			}),
		).toEqual([reconResult]);
		expect(() =>
			resolveCurrentAttemptReconRefs({
				cardsDir,
				cardNo: 10,
				attempt: 1,
				executionBindingDigest: `sha256:${"f".repeat(64)}`,
			}),
		).toThrow(expect.objectContaining({ code: "execution_binding_invalid" }));
		appendReceipt(readCard(recon.path), {
			尝试号: 1,
			时间: "2026-10-20 10:02",
			摘要: "侦察完成",
			任务态: "completed",
		});
		changeCardStatus(readCard(recon.path), {
			操作者: "侦察员",
			to: "delivered",
			时间: "2026-10-20 10:03",
		});
		expect(readCard(recon.path).frontmatter.inputs).not.toContain(reconResult.ref);
		const implementation = await prepareDispatchBrief({
			cardsDir,
			cardPath: cards.get(11)!,
			projectRoot: root,
			executionRoot: root,
			purpose: "implementation",
			dependencyReconMode: "handoff-only",
		});
		const planning = await prepareDispatchBrief({
			cardsDir,
			cardPath: cards.get(12)!,
			projectRoot: root,
			executionRoot: root,
			purpose: "planning",
			dependencyReconMode: "handoff-only",
		});
		for (const draft of [implementation, planning]) {
			expect(draft.briefMarkdown).toContain("调用入口唯一在 caller.ts");
			expect(draft.briefMarkdown).toContain("api.ts 契约待审核");
			expect(draft.briefMarkdown).toContain("src/caller.ts");
		}
		expect(implementation.briefMarkdown).toContain("实现所需结论");
		expect(planning.briefMarkdown).toContain("规划所需结论");
		expect(planning.briefMarkdown).toContain("规划所需接口与依赖");
	});

	it("同一上游侦察产物按实现、规划、审核用途装配；审核保留当前回执的 changes、verification、风险与证据", async () => {
		const { root, cardsDir, cards } = await setupReconFixture();
		const recon = changeCardStatus(readCard(cards.get(10)!), {
			操作者: "侦察员",
			to: "in_progress",
			时间: "2026-10-20 10:21",
		});
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		const commonGitDir = join(root, ".git");
		const binding = await bindExecutionContext(
			{
				key: { cardsDir, cardNo: 10, attempt: 1 },
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				worktree: {
					kind: "primary",
					taskRoot: root,
					executionRoot: root,
					commonGitDir,
					inputVersion: head,
					bindingDigest: `sha256:${"e".repeat(64)}`,
				},
				snapshotRef: "pao://snapshots/recon-10-purpose.json",
				snapshotDigest: `sha256:${"f".repeat(64)}`,
			},
			{ expectedCurrentAttempt: 1 },
		);
		const reconResult = await dispatchReconTool({
			cardsDir,
			cardNo: 10,
			attempt: 1,
			owner: "侦察员",
			id: "shared-purpose",
			markdown: "共享侦察结论。",
			sections: [
				{ category: "facts", title: "必要事实", markdown: "唯一入口是 caller.ts。" },
				{ category: "unknowns", title: "未知边界", markdown: "异步调用未运行。" },
				{ category: "scope", title: "接口与依赖", markdown: "依赖 Api 契约。" },
				{ category: "risks", title: "升级风险", markdown: "旧调用方需要复核。" },
				{ category: "evidence", title: "证据入口", markdown: "src/caller.ts" },
			],
		});
		expect(readCard(recon.path).frontmatter.inputs).not.toContain(reconResult.ref);
		appendReceipt(readCard(recon.path), {
			尝试号: 1,
			时间: "2026-10-20 10:22",
			摘要: "侦察完成",
			任务态: "completed",
			changes: [{ 路径: "src/caller.ts", 类型: "modified", 说明: "核对入口" }],
			verification: [{ 条件: "调用入口唯一", 结论: "pass", 证据: "src/caller.ts" }],
			证据: ["src/caller.ts"],
		});
		changeCardStatus(readCard(recon.path), {
			操作者: "侦察员",
			to: "delivered",
			时间: "2026-10-20 10:23",
		});
		const implementationCard = changeCardStatus(readCard(cards.get(11)!), {
			操作者: "实现者",
			to: "in_progress",
			时间: "2026-10-20 10:24",
		});
		appendReceipt(readCard(implementationCard.path), {
			尝试号: 1,
			时间: "2026-10-20 10:25",
			摘要: "实现完成",
			任务态: "completed",
			changes: [{ 路径: "src/caller.ts", 类型: "modified", 说明: "接入新契约" }],
			verification: [{ 条件: "调用方已接入", 结论: "pass", 证据: "src/caller.ts" }],
			证据: ["src/caller.ts"],
		});
		changeCardStatus(readCard(implementationCard.path), {
			操作者: "实现者",
			to: "delivered",
			时间: "2026-10-20 10:26",
		});
		const dependencyExecutionBinding = () => ({
			ref: executionContextPath({ cardsDir, cardNo: 10, attempt: 1 }),
			digest: binding.bindingDigest,
			projectRoot: root,
			repositoryRoot: root,
			executionRoot: root,
			commonGitDir,
		});
		const implementation = await prepareDispatchBrief({
			cardsDir,
			cardPath: cards.get(11)!,
			projectRoot: root,
			executionRoot: root,
			purpose: "implementation",
			dependencyReconMode: "handoff-only",
			dependencyExecutionBinding,
		});
		const planning = await prepareDispatchBrief({
			cardsDir,
			cardPath: cards.get(12)!,
			projectRoot: root,
			executionRoot: root,
			purpose: "planning",
			dependencyReconMode: "handoff-only",
			dependencyExecutionBinding,
		});
		const review = await prepareDispatchBrief({
			cardsDir,
			cardPath: cards.get(13)!,
			projectRoot: root,
			executionRoot: root,
			purpose: "review",
			dependencyReconMode: "handoff-only",
			dependencyExecutionBinding: (key) =>
				key.cardNo === 10
					? dependencyExecutionBinding()
					: {
							ref: executionContextPath(key),
							digest: `sha256:${"a".repeat(64)}`,
							projectRoot: root,
							repositoryRoot: root,
							executionRoot: root,
							commonGitDir,
						},
		});
		for (const draft of [implementation, planning, review]) {
			expect(draft.briefMarkdown).toContain("唯一入口是 caller.ts");
			expect(draft.briefMarkdown).toContain("异步调用未运行");
			expect(draft.briefMarkdown).toContain("依赖 Api 契约");
			expect(draft.briefMarkdown).toContain(reconResult.ref);
		}
		expect(implementation.briefMarkdown).toContain("实现所需结论");
		expect(planning.briefMarkdown).toContain("规划所需接口与依赖");
		expect(review.briefMarkdown).toContain("审核所需实际变更与证据");
		expect(review.briefMarkdown).toContain("modified src/caller.ts（核对入口）");
		expect(review.briefMarkdown).toContain("调用入口唯一=pass（src/caller.ts）");
		expect(review.briefMarkdown).toContain("证据入口：src/caller.ts");
		expect(review.briefMarkdown).toContain("旧调用方需要复核");
	});

	it("handoff-only 不扫描旧卡 inputs，且交接绑定摘要必须匹配当前 ExecutionBinding", async () => {
		const { root, cardsDir, cards } = await setupReconFixture();
		const recon = changeCardStatus(readCard(cards.get(10)!), {
			操作者: "侦察员",
			to: "in_progress",
			时间: "2026-10-20 10:11",
		});
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		const commonGitDir = join(root, ".git");
		const binding = await bindExecutionContext(
			{
				key: { cardsDir, cardNo: 10, attempt: 1 },
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				worktree: {
					kind: "primary",
					taskRoot: root,
					executionRoot: root,
					commonGitDir,
					inputVersion: head,
					bindingDigest: "host:recon:2",
				},
				snapshotRef: "pao://snapshots/recon-10-1.json",
				snapshotDigest: `sha256:${"b".repeat(64)}`,
			},
			{ expectedCurrentAttempt: 1 },
		);
		const legacy = await saveDispatchBriefArtifact({
			cardsDir,
			id: "scout-legacy-only",
			cardPath: recon.path,
			cardNo: 10,
			attempt: 1,
			owner: "侦察员",
			markdown: "旧摘要",
			requirements: {
				kind: "scout",
				sections: [
					{
						category: "facts",
						title: "旧结论",
						markdown: "旧 inputs 里的结论不能进入 handoff-only 正文。",
					},
				],
			},
		});
		const legacyCard = readCard(recon.path);
		legacyCard.frontmatter.inputs = [...(legacyCard.frontmatter.inputs ?? []), legacy.ref];
		writeFileSync(legacyCard.path, serializeCard(legacyCard.frontmatter, legacyCard.body));
		appendReceipt(readCard(recon.path), {
			尝试号: 1,
			时间: "2026-10-20 10:12",
			摘要: "侦察完成",
			任务态: "completed",
		});
		changeCardStatus(readCard(recon.path), {
			操作者: "侦察员",
			to: "delivered",
			时间: "2026-10-20 10:13",
		});
		const noHandoff = await prepareDispatchBrief({
			cardsDir,
			cardPath: cards.get(11)!,
			projectRoot: root,
			executionRoot: root,
			purpose: "implementation",
			dependencyReconMode: "handoff-only",
			dependencyExecutionBinding: () => ({
				ref: executionContextPath({ cardsDir, cardNo: 10, attempt: 1 }),
				digest: binding.bindingDigest,
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				commonGitDir,
			}),
		});
		expect(noHandoff.briefMarkdown).not.toContain("旧 inputs 里的结论");
		const stillNoLegacy = await prepareDispatchBrief({
			cardsDir,
			cardPath: cards.get(11)!,
			projectRoot: root,
			executionRoot: root,
			dependencyReconMode: "handoff-only",
			dependencyExecutionBinding: () => ({
				ref: executionContextPath({
					cardsDir,
					cardNo: 10,
					attempt: 1,
				}),
				digest: `sha256:${"c".repeat(64)}`,
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				commonGitDir,
			}),
		});
		expect(stillNoLegacy.briefMarkdown).not.toContain("旧 inputs 里的结论");

		const handoffInput = {
			cardsDir,
			cardPath: recon.path,
			cardNo: legacyCard.card_no,
			attempt: 1,
			owner: "侦察员",
			bindingRef: executionContextPath({ cardsDir, cardNo: 10, attempt: 1 }),
			bindingDigest: binding.bindingDigest,
			recon: legacy,
		};
		await saveDispatchReconHandoff(handoffInput);
		await expect(
			prepareDispatchBrief({
				cardsDir,
				cardPath: cards.get(11)!,
				projectRoot: root,
				executionRoot: root,
				dependencyReconMode: "handoff-only",
				dependencyExecutionBinding: () => ({
					ref: executionContextPath({
						cardsDir,
						cardNo: 10,
						attempt: 1,
					}),
					digest: `sha256:${"c".repeat(64)}`,
					projectRoot: root,
					repositoryRoot: root,
					executionRoot: root,
					commonGitDir,
				}),
			}),
		).rejects.toMatchObject({ code: "execution_binding_invalid" });
	});
});
