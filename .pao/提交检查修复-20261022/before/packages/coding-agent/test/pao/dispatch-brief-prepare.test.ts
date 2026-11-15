import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { bindExecutionContext, executionContextPath } from "../../src/pao/cards/execution-context.ts";
import { appendReceipt, changeCardStatus } from "../../src/pao/cards/index.ts";
import {
	appendCardInputReference,
	saveDispatchBriefArtifact,
	saveDispatchContractReference,
	saveDispatchMapArtifact,
} from "../../src/pao/dispatch-brief/artifacts.ts";
import { prepareDispatchBrief } from "../../src/pao/dispatch-brief/brief.ts";
import { sha256Bytes } from "../../src/pao/dispatch-brief/canonical.ts";
import {
	dispatchInputSnapshotPath,
	freezeDispatchBrief,
	loadDispatchInputSnapshot,
	verifyDispatchSnapshot,
} from "../../src/pao/dispatch-brief/snapshot.ts";
import { captureDispatchMap } from "../../src/pao/dispatch-brief/workspace.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "pao-dispatch-prepare-"));
	roots.push(root);
	mkdirSync(join(root, ".pao", "任务", "卡"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	const cardsDir = join(root, ".pao", "任务", "卡");
	const cardPath = join(cardsDir, "卡0002-简报.md");
	writeFileSync(join(root, "src", "code.ts"), "export const code = true;\n");
	writeFileSync(
		cardPath,
		`---\ngoal: 装配真实简报\ndept: 测试\ninputs: ["src/code.ts", "旧卡说明"]\nconstraints: 仅修改 src\nacceptance: 简报应含目标和验收\nattempt: 0\ncreated: 2026-10-20 10:00\nstatus: unclaimed\n---\n`,
	);
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
		cwd: root,
	});
	const contractPath = join(root, "src", "contract.md");
	writeFileSync(contractPath, "export interface Api { version: 1 }\n");
	const map = captureDispatchMap({
		id: "prep-map",
		projectRoot: root,
		coverage: ["src"],
		scopeConfirmed: true,
		scopeBasis: ["覆盖范围内可检出新增调用方"],
		facts: ["caller.ts 是入口"],
		unknowns: ["运行时边界未测"],
		integrationOwner: "主控",
	});
	const mapRef = await saveDispatchMapArtifact({ cardsDir, artifact: map });
	await appendCardInputReference({ cardPath, ref: mapRef.ref });
	const contract = await saveDispatchContractReference({
		cardsDir,
		projectRoot: root,
		id: "api",
		version: "1.0.0",
		ref: contractPath,
		contentPath: "src/contract.md",
		digest: sha256Bytes(Buffer.from("export interface Api { version: 1 }\n")),
	});
	await appendCardInputReference({ cardPath, ref: contract.ref });
	return { root, cardsDir, cardPath, mapRef, contract };
}

describe("prepare/freeze/verify dispatch brief", () => {
	it("prepare/freeze 拒绝缺失或错配的认领 owner 与 attempt", async () => {
		const { root, cardsDir, cardPath } = await setup();
		await expect(
			prepareDispatchBrief({
				cardsDir,
				cardPath,
				projectRoot: root,
				executionRoot: root,
				claim: { attempt: 1, owner: "" },
			}),
		).rejects.toMatchObject({ code: "card_changed" });
		const card = readCard(cardPath);
		card.frontmatter.attempt = 1;
		card.frontmatter.status = "in_progress";
		card.frontmatter.owner = "真实 owner";
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		await expect(
			prepareDispatchBrief({
				cardsDir,
				cardPath,
				projectRoot: root,
				executionRoot: root,
				claim: { attempt: 1, owner: "伪造 owner" },
			}),
		).rejects.toMatchObject({ code: "card_changed" });
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "真实 owner" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		const tampered = { ...draft, briefMarkdown: `${draft.briefMarkdown}\n伪造改写` };
		await expect(
			freezeDispatchBrief(
				tampered,
				{ attempt: 1, owner: "真实 owner" },
				{
					projectRoot: root,
					repositoryRoot: root,
					executionRoot: root,
				},
			),
		).rejects.toMatchObject({ code: "bad_reference" });
	});

	it("从真实卡与 Git 地图装配正文，冻结后正文可直接注入", async () => {
		const { root, cardsDir, cardPath } = await setup();
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
		});
		expect(draft.briefMarkdown).toContain("装配真实简报");
		expect(draft.briefMarkdown).toContain("验收");
		expect(draft.briefMarkdown).toContain("caller.ts 是入口");
		expect(draft.briefMarkdown).toContain("运行时边界未测");
		expect(draft.briefMarkdown).not.toContain("先读卡文件");
		expect(draft.map?.status).toBe("valid");
		expect(draft.contracts[0]).toMatchObject({ id: "api", version: "1.0.0" });
		expect(draft.briefMarkdown).toContain("pao-map://prep-map");
		expect(draft.briefMarkdown).toContain("api@1.0.0");

		const card = readCard(cardPath);
		card.frontmatter.attempt = 1;
		card.frontmatter.status = "in_progress";
		card.frontmatter.owner = "测试主控";
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const claimedDraft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: {
				commonGitDir: join(root, ".git"),
			},
		});
		const snapshot = await freezeDispatchBrief(
			claimedDraft,
			{ attempt: 1, owner: "测试主控" },
			{
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				versionControl: "git",
				commonGitDir: join(root, ".git"),
				baseHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
				baseTreeId: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(),
			},
		);
		expect(snapshot.brief.ref).toMatch(/^pao-brief:\/\//);
		expect(snapshot.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(snapshot.briefMarkdown).toContain("装配真实简报");
		const snapshotPath = dispatchInputSnapshotPath(cardsDir, 2, 1);
		expect(loadDispatchInputSnapshot(snapshotPath).snapshotDigest).toBe(snapshot.snapshotDigest);
		const binding = await bindExecutionContext(
			{
				key: { cardsDir, cardNo: 2, attempt: 1 },
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				worktree: {
					kind: "primary",
					taskRoot: root,
					executionRoot: root,
					commonGitDir: join(root, ".git"),
					inputVersion: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
					bindingDigest: "host:primary:1",
				},
				snapshotRef: snapshotPath,
				snapshotDigest: snapshot.snapshotDigest,
				briefRef: snapshot.brief.ref,
			},
			{ expectedCurrentAttempt: 1 },
		);
		const verified = await verifyDispatchSnapshot(snapshot, {
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: {
				...(binding.worktree.kind === "managed" ? { worktreeId: binding.worktree.worktreeId } : {}),
				bindingRef: executionContextPath({ cardsDir, cardNo: 2, attempt: 1 }),
				bindingDigest: binding.bindingDigest,
				commonGitDir: binding.worktree.commonGitDir,
				baseHead: snapshot.execution.baseHead,
				baseTreeId: snapshot.execution.baseTreeId,
				inputVersion: binding.worktree.inputVersion,
			},
		});
		expect(verified.ok, JSON.stringify(verified.issues, null, 2)).toBe(true);
	});

	it("地图或契约变化、快照被改时 fail-closed", async () => {
		const { root, cardsDir, cardPath } = await setup();
		const card = readCard(cardPath);
		card.frontmatter.attempt = 1;
		card.frontmatter.status = "in_progress";
		card.frontmatter.owner = "测试主控";
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: {
				commonGitDir: join(root, ".git"),
			},
		});
		const snapshot = await freezeDispatchBrief(
			draft,
			{ attempt: 1, owner: "测试主控" },
			{
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				versionControl: "git",
				commonGitDir: join(root, ".git"),
			},
		);
		writeFileSync(join(root, "src", "code.ts"), "export const code = 'changed';\n");
		const stale = await verifyDispatchSnapshot(snapshot, {
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: {
				commonGitDir: join(root, ".git"),
			},
		});
		expect(stale.ok).toBe(false);
		expect(stale.code).toBe("stale_map");

		const tampered = { ...snapshot, briefMarkdown: "伪造正文" };
		const digestFailure = await verifyDispatchSnapshot(tampered, {
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: {
				commonGitDir: join(root, ".git"),
			},
		});
		expect(digestFailure.code).toBe("snapshot_digest_mismatch");
	});

	it("linked worktree 中修改契约会拒绝旧简报，即使主目录契约未变", async () => {
		const { root, cardsDir, cardPath } = await setup();
		const worktree = join(root, "..", `${root.split(/[\\/]/).pop()}-contract-linked`);
		roots.push(worktree);
		execFileSync("git", ["worktree", "add", "--quiet", "-b", "contract-linked-test", worktree, "HEAD"], {
			cwd: root,
		});
		writeFileSync(join(worktree, "src", "contract.md"), "export interface Api { version: 1 }\n");
		const commonGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: worktree,
			encoding: "utf8",
		}).trim();
		const card = readCard(cardPath);
		card.frontmatter.inputs = (card.frontmatter.inputs ?? []).filter((value) => !value.startsWith("pao-map://"));
		card.frontmatter.attempt = 1;
		card.frontmatter.status = "in_progress";
		card.frontmatter.owner = "测试主控";
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: worktree,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: {
				worktreeKind: "managed",
				worktreeId: "contract-linked",
				commonGitDir,
				bindingDigest: `sha256:${"d".repeat(64)}`,
			},
		});
		const snapshot = await freezeDispatchBrief(
			draft,
			{ attempt: 1, owner: "测试主控" },
			{
				projectRoot: root,
				repositoryRoot: worktree,
				executionRoot: worktree,
				versionControl: "git",
				commonGitDir,
				worktreeId: "contract-linked",
				bindingDigest: `sha256:${"d".repeat(64)}`,
			},
		);
		const mainContractBefore = readFileSync(join(root, "src", "contract.md"), "utf8");
		const worktreeContract = join(worktree, "src", "contract.md");
		writeFileSync(worktreeContract, "export interface Api { version: 2 }\n");
		expect(readFileSync(worktreeContract, "utf8")).not.toBe(mainContractBefore);
		expect(readFileSync(join(root, "src", "contract.md"), "utf8")).toBe(mainContractBefore);

		const verified = await verifyDispatchSnapshot(snapshot, {
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: worktree,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: {
				worktreeKind: "managed",
				worktreeId: "contract-linked",
				commonGitDir,
				bindingDigest: `sha256:${"d".repeat(64)}`,
			},
		});
		expect(verified.ok).toBe(false);
		expect(verified.code).toBe("contract_changed");
		expect(verified.issues).toContainEqual(
			expect.objectContaining({
				code: "contract_changed",
				path: worktreeContract,
			}),
		);
	});

	it("契约升版在简报中保留旧版与原因，旧 attempt 的冻结输入不改", async () => {
		const { root, cardsDir, cardPath, contract } = await setup();
		const card = readCard(cardPath);
		card.frontmatter.attempt = 1;
		card.frontmatter.status = "in_progress";
		card.frontmatter.owner = "测试主控";
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		const oldSnapshot = await freezeDispatchBrief(
			draft,
			{ attempt: 1, owner: "测试主控" },
			{
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				versionControl: "git",
				commonGitDir: join(root, ".git"),
			},
		);
		const oldSnapshotPath = dispatchInputSnapshotPath(cardsDir, 2, 1);
		const oldSnapshotBytes = readFileSync(oldSnapshotPath);
		const contractPath = join(root, "src", "contract.md");
		writeFileSync(contractPath, "export interface Api { version: 2 }\n");
		const next = await saveDispatchContractReference({
			cardsDir,
			projectRoot: root,
			id: "api",
			version: "2.0.0",
			ref: contractPath,
			contentPath: "src/contract.md",
			digest: sha256Bytes(readFileSync(contractPath)),
			previousRef: contract.ref,
			supersessionReason: "接口新增必填字段",
		});
		const changed = readCard(cardPath);
		changed.frontmatter.inputs = [
			...(changed.frontmatter.inputs ?? []).filter((value) => !value.startsWith("pao-contract://")),
			next.ref,
		];
		changed.frontmatter.attempt = 2;
		changed.frontmatter.status = "unclaimed";
		changed.frontmatter.owner = undefined;
		writeFileSync(changed.path, serializeCard(changed.frontmatter, changed.body));
		const nextDraft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
		});
		expect(nextDraft.briefMarkdown).toContain(`替代旧版：\`${contract.ref}\``);
		expect(nextDraft.briefMarkdown).toContain("更新原因：接口新增必填字段");
		expect(loadDispatchInputSnapshot(oldSnapshotPath)).toEqual(oldSnapshot);
		expect(readFileSync(oldSnapshotPath)).toEqual(oldSnapshotBytes);
		expect(oldSnapshot.contracts[0]?.ref).toBe(contract.ref);
	});

	it("冻结后改写卡 inputs 明确报告 card_changed，旧快照保留冻结定义", async () => {
		const { root, cardsDir, cardPath } = await setup();
		const card = readCard(cardPath);
		card.frontmatter.attempt = 1;
		card.frontmatter.status = "in_progress";
		card.frontmatter.owner = "测试主控";
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		const snapshot = await freezeDispatchBrief(
			draft,
			{ attempt: 1, owner: "测试主控" },
			{
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				versionControl: "git",
				commonGitDir: join(root, ".git"),
			},
		);
		const frozenInputs = snapshot.cardDefinition?.inputs;
		expect(frozenInputs?.slice(0, 2)).toEqual(["src/code.ts", "旧卡说明"]);
		expect(frozenInputs?.some((item) => item.startsWith("pao-map://"))).toBe(true);
		expect(frozenInputs?.some((item) => item.startsWith("pao-contract://"))).toBe(true);
		const changed = readCard(cardPath);
		changed.frontmatter.inputs = [...(changed.frontmatter.inputs ?? []), "新增任务定义"];
		writeFileSync(changed.path, serializeCard(changed.frontmatter, changed.body));
		const result = await verifyDispatchSnapshot(snapshot, {
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "测试主控" },
			workspace: { commonGitDir: join(root, ".git") },
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("card_changed");
		const issue = result.issues.find((candidate) => candidate.field === "cardDefinition");
		expect(issue).toMatchObject({
			code: "card_changed",
			path: cardPath,
			field: "cardDefinition",
			expectedDigest: snapshot.cardDefinition?.definitionDigest,
		});
		expect(issue?.actualDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		const persisted = loadDispatchInputSnapshot(dispatchInputSnapshotPath(cardsDir, 2, 1));
		expect(persisted.cardDefinition?.inputs).toEqual(frozenInputs);
		expect(persisted.snapshotDigest).toBe(snapshot.snapshotDigest);
	});

	it("旧卡无地图可直接组装；普通说明不会被当作 URI", async () => {
		const { root } = await setup();
		const cardsDir = join(root, ".pao", "旧卡", "卡");
		mkdirSync(cardsDir, { recursive: true });
		const cardPath = join(cardsDir, "卡0003-旧卡.md");
		writeFileSync(
			cardPath,
			`---\ngoal: 旧卡直接执行\ndept: 测试\ninputs: ["src/code.ts §2", "背景说明"]\nacceptance: 旧卡仍可派发\nattempt: 0\ncreated: 2026-10-20 10:00\nstatus: unclaimed\n---\n`,
		);
		const draft = await prepareDispatchBrief({ cardsDir, cardPath, projectRoot: root, executionRoot: root });
		expect(draft.map).toBeUndefined();
		expect(draft.briefMarkdown).toContain("本卡没有声明结构化地图");
		expect(draft.briefMarkdown).toContain("旧卡直接执行");
		expect(draft.briefMarkdown).toContain("src/code.ts §2");
	});

	it("A→B→C 只装配分类结论和当前回执，不递归内联上游简报，本卡目标只出现一次", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-dispatch-chain-"));
		roots.push(root);
		const cardsDir = join(root, ".pao", "任务", "卡");
		mkdirSync(cardsDir, { recursive: true });
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "chain.ts"), "export const chain = true;\n");
		const cardPath = (no: number, title: string) => join(cardsDir, `卡${String(no).padStart(4, "0")}-${title}.md`);
		const aPath = cardPath(1, "A");
		const bPath = cardPath(2, "B");
		const cPath = cardPath(3, "C");
		writeFileSync(
			aPath,
			`---\ngoal: A唯一目标\ndept: 测试\ninputs: ["src/chain.ts"]\nconstraints: 约束A\nacceptance: 验收A\nattempt: 0\ncreated: 2026-10-21 10:00\nstatus: unclaimed\n---\n`,
		);
		writeFileSync(
			bPath,
			`---\ngoal: B唯一目标\ndept: 测试\ninputs: ["src/chain.ts"]\nconstraints: 约束B\nacceptance: 验收B\ndepends_on: ["卡0001"]\nattempt: 0\ncreated: 2026-10-21 10:00\nstatus: unclaimed\n---\n`,
		);
		writeFileSync(
			cPath,
			`---\ngoal: C唯一目标\ndept: 测试\ninputs: ["src/chain.ts"]\nconstraints: 约束C\nacceptance: 验收C\ndepends_on: ["卡0002"]\nattempt: 0\ncreated: 2026-10-21 10:00\nstatus: unclaimed\n---\n`,
		);
		execFileSync("git", ["init", "--quiet"], { cwd: root });
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
			cwd: root,
		});

		const a = changeCardStatus(readCard(aPath), {
			操作者: "执行者A",
			to: "in_progress",
			时间: "2026-10-21 10:01",
		});
		const aResult = await saveDispatchBriefArtifact({
			cardsDir,
			id: "a-output",
			cardPath: a.path,
			cardNo: 1,
			attempt: 1,
			owner: "执行者A",
			purpose: "A 执行简报",
			markdown: "# 卡0001 执行简报\n\nA的旧全文不应递归进入B或C。",
			requirements: {
				kind: "scout",
				sections: [
					{ category: "facts", title: "接口事实", markdown: "A确认接口v1。" },
					{ category: "unknowns", title: "未测项", markdown: "A未测并发。" },
					{ category: "acceptance", title: "验收证据", markdown: "A验收src/chain.ts。" },
				],
			},
		});
		await appendCardInputReference({ cardPath: a.path, ref: aResult.ref });
		const bindA = await bindExecutionContext(
			{
				key: { cardsDir, cardNo: 1, attempt: 1 },
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				worktree: {
					kind: "primary",
					taskRoot: root,
					executionRoot: root,
					commonGitDir: join(root, ".git"),
					inputVersion: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
					bindingDigest: `sha256:${"1".repeat(64)}`,
				},
				snapshotRef: "pao://snapshots/card-1-attempt-1.json",
				snapshotDigest: `sha256:${"2".repeat(64)}`,
				briefRef: aResult.ref,
			},
			{ expectedCurrentAttempt: 1 },
		);
		appendReceipt(readCard(a.path), {
			尝试号: 1,
			时间: "2026-10-21 10:02",
			摘要: "A当前回执摘要",
			任务态: "completed",
			changes: [{ 路径: "src/chain.ts", 类型: "modified", 说明: "A改动" }],
			verification: [{ 条件: "验收A", 结论: "pass", 证据: "src/chain.ts" }],
			证据: ["src/chain.ts"],
		});
		changeCardStatus(readCard(a.path), {
			操作者: "执行者A",
			to: "delivered",
			时间: "2026-10-21 10:03",
		});

		const b = changeCardStatus(readCard(bPath), {
			操作者: "执行者B",
			to: "in_progress",
			时间: "2026-10-21 10:04",
		});
		const bDraft = await prepareDispatchBrief({
			cardsDir,
			cardPath: b.path,
			projectRoot: root,
			executionRoot: root,
			claim: { attempt: 1, owner: "执行者B" },
			purpose: "implementation",
			dependencyReconMode: "handoff-only",
			upstreamRefs: [{ ref: aResult.ref, purpose: "A当前执行结果" }],
			dependencyExecutionBinding: () => ({
				ref: executionContextPath({ cardsDir, cardNo: 1, attempt: 1 }),
				digest: bindA.bindingDigest,
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				commonGitDir: join(root, ".git"),
			}),
		});
		expect(bDraft.briefMarkdown).toContain("A确认接口v1");
		expect(bDraft.briefMarkdown).toContain("A未测并发");
		expect(bDraft.briefMarkdown).toContain("A验收src/chain.ts");
		expect(bDraft.briefMarkdown).toContain("A当前回执摘要");
		expect(bDraft.briefMarkdown).not.toContain("A的旧全文不应递归进入B或C");
		expect(bDraft.briefMarkdown.match(/B唯一目标/g)).toHaveLength(1);

		const bResult = await saveDispatchBriefArtifact({
			cardsDir,
			id: "b-output",
			cardPath: b.path,
			cardNo: 2,
			attempt: 1,
			owner: "执行者B",
			purpose: "B 执行简报",
			markdown: "# 卡0002 执行简报\n\nB的旧全文不应递归进入C。\n\n# 卡0001 执行简报\n\nA全文已被B带进来。",
			requirements: {
				kind: "scout",
				sections: [{ category: "scope", title: "B范围", markdown: "B确认仅改src/chain.ts。" }],
			},
		});
		await appendCardInputReference({ cardPath: b.path, ref: bResult.ref });
		const bindB = await bindExecutionContext(
			{
				key: { cardsDir, cardNo: 2, attempt: 1 },
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				worktree: {
					kind: "primary",
					taskRoot: root,
					executionRoot: root,
					commonGitDir: join(root, ".git"),
					inputVersion: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
					bindingDigest: `sha256:${"3".repeat(64)}`,
				},
				snapshotRef: "pao://snapshots/card-2-attempt-1.json",
				snapshotDigest: `sha256:${"4".repeat(64)}`,
				briefRef: bResult.ref,
			},
			{ expectedCurrentAttempt: 1 },
		);
		appendReceipt(readCard(b.path), {
			尝试号: 1,
			时间: "2026-10-21 10:05",
			摘要: "B当前回执摘要",
			任务态: "completed",
			changes: [{ 路径: "src/chain.ts", 类型: "modified", 说明: "B改动" }],
			verification: [{ 条件: "验收B", 结论: "pass", 证据: "src/chain.ts" }],
			证据: ["src/chain.ts"],
		});
		changeCardStatus(readCard(b.path), {
			操作者: "执行者B",
			to: "delivered",
			时间: "2026-10-21 10:06",
		});

		const cDraft = await prepareDispatchBrief({
			cardsDir,
			cardPath: cPath,
			projectRoot: root,
			executionRoot: root,
			purpose: "implementation",
			dependencyReconMode: "handoff-only",
			upstreamRefs: [{ ref: bResult.ref, purpose: "B当前执行结果" }],
			dependencyExecutionBinding: () => ({
				ref: executionContextPath({ cardsDir, cardNo: 2, attempt: 1 }),
				digest: bindB.bindingDigest,
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				commonGitDir: join(root, ".git"),
			}),
		});
		expect(cDraft.briefMarkdown).toContain("B确认仅改src/chain.ts");
		expect(cDraft.briefMarkdown).toContain("B当前回执摘要");
		expect(cDraft.briefMarkdown).not.toContain("B的旧全文不应递归进入C");
		expect(cDraft.briefMarkdown).not.toContain("A全文已被B带进来");
		expect(cDraft.briefMarkdown).not.toContain("# 卡0002 执行简报");
		expect(cDraft.briefMarkdown).not.toContain("# 卡0001 执行简报");
		expect(cDraft.briefMarkdown.match(/C唯一目标/g)).toHaveLength(1);
		expect(cDraft.briefMarkdown).toContain(`来源：\`${bResult.ref}\``);
	});

	it("旧格式简报无分类时只保留精确引用与当前回执，不内联历史全文", async () => {
		const { root, cardsDir, cardPath } = await setup();
		const dependencyPath = join(cardsDir, "卡0001-旧简报.md");
		writeFileSync(
			dependencyPath,
			`---\ngoal: 旧上游目标\ndept: 测试\ninputs: ["src/code.ts"]\nacceptance: 旧上游验收\nattempt: 0\ncreated: 2026-10-20 10:00\nstatus: unclaimed\n---\n`,
		);
		const dependency = changeCardStatus(readCard(dependencyPath), {
			操作者: "旧执行者",
			to: "in_progress",
			时间: "2026-10-21 09:01",
		});
		const legacy = await saveDispatchBriefArtifact({
			cardsDir,
			id: "legacy-unclassified",
			cardPath: dependency.path,
			cardNo: 1,
			attempt: 1,
			purpose: "旧格式执行简报",
			markdown: "# 卡0001 执行简报\n\n旧历史全文不能递归。",
		});
		appendReceipt(readCard(dependency.path), {
			尝试号: 1,
			时间: "2026-10-21 09:02",
			摘要: "旧卡当前回执仍保留",
			任务态: "completed",
		});
		changeCardStatus(readCard(dependency.path), {
			操作者: "旧执行者",
			to: "delivered",
			时间: "2026-10-21 09:03",
		});
		const next = readCard(cardPath);
		next.frontmatter.depends_on = ["卡0001"];
		writeFileSync(next.path, serializeCard(next.frontmatter, next.body));

		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath,
			projectRoot: root,
			executionRoot: root,
			dependencyReconMode: "handoff-only",
			upstreamRefs: [{ ref: legacy.ref, purpose: "旧格式上游" }],
		});
		expect(draft.briefMarkdown).toContain("保存时未提供结构化分类");
		expect(draft.briefMarkdown).toContain(`来源：\`${legacy.ref}\``);
		expect(draft.briefMarkdown).toContain("旧卡当前回执仍保留");
		expect(draft.briefMarkdown).not.toContain("旧历史全文不能递归");
	});
	it("双上游汇合允许多份上游必要结论，同时保留本卡唯一主简报约束", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-dispatch-dual-upstream-"));
		roots.push(root);
		const cardsDir = join(root, ".pao", "任务", "卡");
		mkdirSync(cardsDir, { recursive: true });
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "merge.ts"), "export const merged = false;\n");
		const cardPath = (no: number, title: string) => join(cardsDir, `卡${String(no).padStart(4, "0")}-${title}.md`);
		const writeCard = (path: string, goal: string, dependsOn?: number[]) => {
			writeFileSync(
				path,
				[
					"---",
					`goal: ${goal}`,
					"dept: 测试",
					'inputs: ["src/merge.ts"]',
					"acceptance: 双上游结论完整可核对",
					...(dependsOn
						? [`depends_on: ${JSON.stringify(dependsOn.map((no) => `卡${String(no).padStart(4, "0")}`))}`]
						: []),
					"attempt: 0",
					"created: 2026-10-22 10:00",
					"status: unclaimed",
					"---",
					"",
				].join("\n"),
			);
		};
		const aPath = cardPath(1, "A");
		const bPath = cardPath(2, "B");
		const cPath = cardPath(3, "C");
		writeCard(aPath, "A唯一目标");
		writeCard(bPath, "B唯一目标");
		writeCard(cPath, "C汇合目标", [1, 2]);
		execFileSync("git", ["init", "--quiet"], { cwd: root });
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
			cwd: root,
		});

		const commonGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		const inputVersion = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		const finishUpstream = async (
			no: number,
			path: string,
			owner: string,
			id: string,
			fact: string,
			rawMarkdown: string,
		) => {
			const running = changeCardStatus(readCard(path), {
				操作者: owner,
				to: "in_progress",
				时间: `2026-10-22 10:0${no}`,
			});
			const saved = await saveDispatchBriefArtifact({
				cardsDir,
				id,
				cardPath: running.path,
				cardNo: no,
				attempt: 1,
				owner,
				purpose: `${id} 执行简报`,
				markdown: rawMarkdown,
				requirements: {
					kind: "scout",
					sections: [{ category: "facts", title: `${id} 事实`, markdown: fact }],
				},
			});
			await appendCardInputReference({ cardPath: running.path, ref: saved.ref });
			const binding = await bindExecutionContext(
				{
					key: { cardsDir, cardNo: no, attempt: 1 },
					projectRoot: root,
					repositoryRoot: root,
					executionRoot: root,
					worktree: {
						kind: "primary",
						taskRoot: root,
						executionRoot: root,
						commonGitDir,
						inputVersion,
						bindingDigest: `sha256:${String(no).repeat(64)}`,
					},
					snapshotRef: `pao://snapshots/card-${no}-attempt-1.json`,
					snapshotDigest: `sha256:${String(no + 2).repeat(64)}`,
					briefRef: saved.ref,
				},
				{ expectedCurrentAttempt: 1 },
			);
			appendReceipt(readCard(running.path), {
				尝试号: 1,
				时间: `2026-10-22 10:1${no}`,
				摘要: `${id} 当前回执`,
				任务态: "completed",
			});
			changeCardStatus(readCard(running.path), {
				操作者: owner,
				to: "delivered",
				时间: `2026-10-22 10:2${no}`,
			});
			return { ref: saved.ref, binding };
		};
		const a = await finishUpstream(
			1,
			aPath,
			"执行者A",
			"a-dual-upstream",
			"A只改动合并入口。",
			"# A全文\nA全文不应递归。",
		);
		const b = await finishUpstream(
			2,
			bPath,
			"执行者B",
			"b-dual-upstream",
			"B只改动回退分支。",
			"# B全文\nB全文不应递归。",
		);
		const bindings = new Map([
			[1, a.binding],
			[2, b.binding],
		]);
		const draft = await prepareDispatchBrief({
			cardsDir,
			cardPath: cPath,
			projectRoot: root,
			executionRoot: root,
			purpose: "implementation",
			dependencyReconMode: "handoff-only",
			upstreamRefs: [
				{ ref: a.ref, purpose: "A当前执行结果" },
				{ ref: b.ref, purpose: "B当前执行结果" },
			],
			dependencyExecutionBinding: (key) => ({
				ref: executionContextPath(key),
				digest: bindings.get(key.cardNo)!.bindingDigest,
				projectRoot: root,
				repositoryRoot: root,
				executionRoot: root,
				commonGitDir,
			}),
		});
		expect(draft.brief).toBeUndefined();
		expect(draft.briefMarkdown).toContain("A只改动合并入口");
		expect(draft.briefMarkdown).toContain("B只改动回退分支");
		expect(draft.briefMarkdown).toContain("a-dual-upstream 当前回执");
		expect(draft.briefMarkdown).toContain("b-dual-upstream 当前回执");
		expect(draft.briefMarkdown).toContain(`来源：\`${a.ref}\``);
		expect(draft.briefMarkdown).toContain(`来源：\`${b.ref}\``);
		expect(draft.briefMarkdown).not.toContain("A全文不应递归");
		expect(draft.briefMarkdown).not.toContain("B全文不应递归");
		expect(draft.briefMarkdown.match(/C汇合目标/g)).toHaveLength(1);
	});

	it("当前卡自身仍只能有一个主简报，且上游伪造摘要继续拒绝", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-dispatch-own-brief-guard-"));
		roots.push(root);
		const cardsDir = join(root, ".pao", "任务", "卡");
		mkdirSync(cardsDir, { recursive: true });
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "guard.ts"), "export const guard = true;\n");
		const cardPath = (no: number, title: string) => join(cardsDir, `卡${String(no).padStart(4, "0")}-${title}.md`);
		const upstreamPath = cardPath(1, "A");
		const currentPath = cardPath(2, "C");
		writeFileSync(
			upstreamPath,
			'---\ngoal: A上游\ndept: 测试\ninputs: ["src/guard.ts"]\nacceptance: 上游完成\nattempt: 0\ncreated: 2026-10-22 11:00\nstatus: unclaimed\n---\n',
		);
		writeFileSync(
			currentPath,
			'---\ngoal: C当前\ndept: 测试\ninputs: ["src/guard.ts"]\nacceptance: 当前完成\nattempt: 0\ncreated: 2026-10-22 11:00\nstatus: unclaimed\n---\n',
		);
		execFileSync("git", ["init", "--quiet"], { cwd: root });
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
			cwd: root,
		});
		const running = changeCardStatus(readCard(upstreamPath), {
			操作者: "上游执行者",
			to: "in_progress",
			时间: "2026-10-22 11:01",
		});
		const first = await saveDispatchBriefArtifact({
			cardsDir,
			id: "own-first",
			cardPath: running.path,
			cardNo: 1,
			attempt: 1,
			purpose: "第一份主简报",
			markdown: "第一份正文",
		});
		const second = await saveDispatchBriefArtifact({
			cardsDir,
			id: "own-second",
			cardPath: running.path,
			cardNo: 1,
			attempt: 1,
			purpose: "第二份主简报",
			markdown: "第二份正文",
		});
		const current = changeCardStatus(readCard(currentPath), {
			操作者: "当前执行者",
			to: "in_progress",
			时间: "2026-10-22 11:02",
		});
		for (const ref of [first.ref, second.ref]) {
			current.frontmatter.inputs = [...(current.frontmatter.inputs ?? []), ref];
		}
		writeFileSync(current.path, serializeCard(current.frontmatter, current.body));
		await expect(
			prepareDispatchBrief({
				cardsDir,
				cardPath: current.path,
				projectRoot: root,
				executionRoot: root,
				claim: { attempt: 1, owner: "当前执行者" },
			}),
		).rejects.toThrow("多个自包含简报引用");

		const upstreamCard = readCard(running.path);
		upstreamCard.frontmatter.inputs = [...(upstreamCard.frontmatter.inputs ?? []), first.ref];
		writeFileSync(upstreamCard.path, serializeCard(upstreamCard.frontmatter, upstreamCard.body));
		appendReceipt(readCard(upstreamCard.path), {
			尝试号: 1,
			时间: "2026-10-22 11:03",
			摘要: "上游完成",
			任务态: "completed",
		});
		changeCardStatus(readCard(upstreamCard.path), {
			操作者: "上游执行者",
			to: "delivered",
			时间: "2026-10-22 11:04",
		});
		const forgedRef = first.ref.replace(/\?digest=sha256:[0-9a-f]+$/, `?digest=sha256:${"f".repeat(64)}`);
		await expect(
			prepareDispatchBrief({
				cardsDir,
				cardPath: currentPath,
				projectRoot: root,
				executionRoot: root,
				dependencyReconMode: "handoff-only",
				upstreamRefs: [{ ref: forgedRef }],
			}),
		).rejects.toMatchObject({ code: "bad_reference" });
	});
});
