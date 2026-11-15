import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { snapshotClaimBaseline } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/cards/baseline.ts";
import { createCard, loadCard } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/cards/cardfile.ts";
import { bindExecutionContext } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/cards/execution-context.ts";
import {
	integrateDelivery,
	integrationResultPath,
	type IntegrationRecord,
} from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/cards/integration.ts";
import { changeCardStatus } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/cards/statemachine.ts";

function scalar(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.name=review", "-c", "user.email=review@local", ...args], {
		cwd,
		encoding: "utf8",
	}).trim();
}

function raw(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8" });
}

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "pao-integration-review-"));
	writeFileSync(join(root, "base.txt"), "base\n");
	scalar(root, ["init"]);
	scalar(root, ["add", "-A"]);
	scalar(root, ["commit", "--no-gpg-sign", "-m", "base"]);
	return root;
}

async function bind(input: {
	source: string;
	managed: string;
	cardNo: number;
	attempt: number;
	cardsDir: string;
	kind: "primary" | "managed";
	branch?: string;
}): Promise<Awaited<ReturnType<typeof bindExecutionContext>>> {
	const head = scalar(input.source, ["rev-parse", "HEAD"]);
	const tree = scalar(input.source, ["rev-parse", "HEAD^{tree}"]);
	const common = scalar(input.managed, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	mkdirSync(input.cardsDir, { recursive: true });
	const worktree =
		input.kind === "primary"
			? ({
					kind: "primary" as const,
					taskRoot: input.source,
					executionRoot: input.managed,
					commonGitDir: common,
					inputVersion: head,
					bindingDigest: `host:${head}`,
				})
			: ({
					kind: "managed" as const,
					worktreeId: `worktree-${input.cardNo}`,
					taskRoot: input.source,
					executionRoot: input.managed,
					commonGitDir: common,
					branchName: input.branch!,
					inputVersion: head,
					bindingDigest: `host:${input.branch}:${head}`,
					baseline: {
						sourceRoot: input.source,
						sourceHead: head,
						treeId: tree,
						snapshotRepositoryPath: join(mkdtempSync(join(tmpdir(), "pao-review-snapshot-")), "repo.git"),
						inputVersion: head,
						capturedAt: "2026-10-20T12:00:00.000Z",
						fileCount: 1,
						byteCount: 5,
						coverage: "complete" as const,
						includedPaths: ["base.txt"],
						excludedPaths: [],
						notes: [],
					},
				});
	return bindExecutionContext(
		{
			key: { cardsDir: input.cardsDir, cardNo: input.cardNo, attempt: input.attempt },
			projectRoot: input.source,
			repositoryRoot: input.managed,
			executionRoot: input.managed,
			worktree,
			snapshotRef: join(mkdtempSync(join(tmpdir(), "pao-review-input-")), "snapshot.json"),
			snapshotDigest: `sha256:${String(input.cardNo).padStart(64, "a").slice(-64)}`,
		},
		{ expectedCurrentAttempt: input.attempt },
	);
}

async function card(cardsDir: string, goal: string): Promise<number> {
	mkdirSync(cardsDir, { recursive: true });
	const created = await createCard(cardsDir, {
		目标: goal,
		部门: "审查",
		验收: "包含: base.txt :: marker",
		创建: "2026-10-20 20:00",
	});
	return created.card_no;
}

async function claimedCard(cardsDir: string, goal: string): Promise<number> {
	const cardNo = await card(cardsDir, goal);
	const created = loadCard(cardsDir, cardNo);
	changeCardStatus(created, { 操作者: "review", to: "in_progress", 时间: "2026-10-20 20:01" });
	return cardNo;
}

async function sourceDelivery(input: {
	source: string;
	managed: string;
	cardNo: number;
	content: string;
}): Promise<{ execution: Awaited<ReturnType<typeof bindExecutionContext>>; baseline: string; delivery: string }> {
	const sourceRoot = mkdtempSync(join(tmpdir(), "pao-review-source-repo-"));
	writeFileSync(join(sourceRoot, "base.txt"), "base\n");
	scalar(sourceRoot, ["init"]);
	scalar(sourceRoot, ["add", "-A"]);
	scalar(sourceRoot, ["commit", "--no-gpg-sign", "-m", "base"]);
	const cardsDir = join(sourceRoot, `.pao/card-${input.cardNo}`);
	const branch = `source-review-${input.cardNo}`;
	scalar(sourceRoot, ["worktree", "add", "-b", branch, input.managed, "HEAD"]);
	const createdNo = await card(cardsDir, `source ${input.cardNo}`);
	const created = loadCard(cardsDir, createdNo);
	changeCardStatus(created, {
		时间: "2026-10-20 20:01",
	});
	const claimed = loadCard(cardsDir, createdNo);
	const execution = await bind({
		source: sourceRoot,
		cardNo: claimed.card_no,
		attempt: 1,
		cardsDir,
		kind: "managed",
		branch,
	});
	const snapshot = await snapshotClaimBaseline(cardsDir, claimed.card_no, {
		owner: "review",
		attempt: 1,
		execution,
		验收: claimed.frontmatter.acceptance,
	});
	expect(snapshot.可用).toBe(true);
	writeFileSync(join(input.managed, "base.txt"), input.content);
	scalar(input.managed, ["add", "-A"]);
	const tree = scalar(input.managed, ["write-tree"]);
	expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
	const boundary = scalar(sourceRoot, ["commit-tree", snapshot.内容Tree!, "-p", "HEAD", "-m", "boundary"]);
	const delivery = scalar(sourceRoot, ["commit-tree", tree.trim(), "-p", boundary, "-m", "delivery"]);
	scalar(input.managed, ["update-ref", ref, delivery]);
		execution: execution as Awaited<ReturnType<typeof bindExecutionContext>>,
		baseline: snapshot.内容Tree!,
		delivery: tree.trim(),
	};
}

function record(key: {
	sourceExec: Awaited<ReturnType<typeof bindExecutionContext>>;
}, requestId: string): IntegrationRecord | undefined {
	const path = integrationResultPath(key.sourceExec.key.cardsDir, requestId);
	try {
		return JSON.parse(readFileSync(path, "utf8")) as IntegrationRecord;
	} catch {
		return undefined;
	}
}

it("merge-tree 使用两个源 tree，丢失目标已有进展", async () => {
	const source = repo();
	const sourceManaged = mkdtempSync(join(tmpdir(), "pao-review-source-wt-"));
	const delivered = await sourceDelivery({
		source,
		managed: sourceManaged,
		cardNo: 1,
		content: "base\ndelivery\n",
	});
	const managed = mkdtempSync(join(tmpdir(), "pao-review-target-"));
	scalar(source, ["worktree", "add", "-b", "target-review", managed, "HEAD"]);
	writeFileSync(join(managed, "prior.txt"), "prior integration\n");
	scalar(managed, ["add", "-A"]);
	scalar(managed, ["commit", "--no-gpg-sign", "-m", "prior"]);
	const cardsDir = join(source, ".pao/target-cards");
	const createdNo = await claimedCard(cardsDir, "target");
	const target = await bind({
		source,
		managed,
		cardNo: createdNo,
		attempt: 1,
		cardsDir,
		kind: "managed",
		branch: "target-review",
	});
	const before = scalar(managed, ["rev-parse", "HEAD"]);
	const result = await integrateDelivery({
		requestId: "prior-progress",
		sourceExecutionKey: delivered.execution.key,
		targetExecution: {
			...target,
			canonicalExecutionRoot: managed,
		},
		expectedTargetHead: before,
	});
	const shown = [...scalar(managed, ["ls-tree", "-r", "--name-only", "HEAD"])].join("\n");
	console.log(JSON.stringify({ scenario: "prior-progress", result, files: shown }));
	expect(shown).toContain("prior.txt");
});

it("目标 dirty 不应被覆盖", async () => {
	const source = repo();
	const delivered = await sourceDelivery({
		source,
		managed: mkdtempSync(join(tmpdir(), "pao-review-source-wt-")),
		cardNo: 2,
		content: "base\ndelivery\n",
	});
	const managed = mkdtempSync(join(tmpdir(), "pao-review-target-"));
	scalar(source, ["worktree", "add", "-b", "target-dirty", managed, "HEAD"]);
	const cardsDir = join(source, ".pao/target-cards");
	const createdNo = await claimedCard(cardsDir, "target");
	const target = await bind({
		source,
		managed,
		cardNo: createdNo,
		attempt: 1,
		cardsDir,
		kind: "managed",
		branch: "target-dirty",
	});
	writeFileSync(join(managed, "base.txt"), "user dirty\n");
	const before = scalar(managed, ["rev-parse", "HEAD"]);
	await integrateDelivery({
		requestId: "dirty-target",
		sourceExecutionKey: delivered.execution.key,
		targetExecution: {
			...target,
			canonicalExecutionRoot: managed,
		},
		expectedTargetHead: before,
	});
	const content = readFileSync(join(managed, "base.txt"), "utf8");
	console.log(JSON.stringify({ scenario: "dirty-target", before, after: scalar(managed, ["rev-parse", "HEAD"]), content }));
	expect(content).toBe("user dirty\n");
});

it("无检查时必须保持未验", async () => {
	const source = repo();
	const delivered = await sourceDelivery({
		source,
		managed: mkdtempSync(join(tmpdir(), "pao-review-source-wt-")),
		cardNo: 3,
		content: "base\ndelivery\n",
	});
	const managed = mkdtempSync(join(tmpdir(), "pao-review-target-"));
	scalar(source, ["worktree", "add", "-b", "target-unverified", managed, "HEAD"]);
	const cardsDir = join(source, ".pao/target-cards");
	const createdNo = await claimedCard(cardsDir, "target");
	const target = await bind({
		source,
		managed,
		cardNo: createdNo,
		attempt: 1,
		cardsDir,
		kind: "managed",
		branch: "target-unverified",
	});
	const result = await integrateDelivery({
		requestId: "unverified",
		sourceExecutionKey: delivered.execution.key,
		targetExecution: {
			...target,
			canonicalExecutionRoot: managed,
		},
		expectedTargetHead: scalar(managed, ["rev-parse", "HEAD"]),
	});
	console.log(JSON.stringify({ scenario: "unverified", result }));
	expect(result.integrationPassed).toBe(false);
});

it("检查后改代码必须拒绝证据", async () => {
	const source = repo();
	const delivered = await sourceDelivery({
		source,
		managed: mkdtempSync(join(tmpdir(), "pao-review-source-wt-")),
		cardNo: 4,
		content: "base\ndelivery\n",
	});
	const managed = mkdtempSync(join(tmpdir(), "pao-review-target-"));
	scalar(source, ["worktree", "add", "-b", "target-check", managed, "HEAD"]);
	const cardsDir = join(source, ".pao/target-cards");
	const createdNo = await claimedCard(cardsDir, "target");
	const target = await bind({
		source,
		managed,
		cardNo: createdNo,
		attempt: 1,
		cardsDir,
		kind: "managed",
		branch: "target-check",
	});
	const command = `"${process.execPath}" -e "require('fs').writeFileSync('after.txt','after check')"`;
	await integrateDelivery({
		requestId: "after-check",
		sourceExecutionKey: delivered.execution.key,
		targetExecution: {
			...target,
			canonicalExecutionRoot: managed,
		},
		expectedTargetHead: scalar(managed, ["rev-parse", "HEAD"]),
		checks: [command],
	});
	const recordPath = integrationResultPath(delivered.execution.key.cardsDir, "after-check");
	const recordJson = JSON.parse(readFileSync(recordPath, "utf8")) as IntegrationRecord;
	console.log(JSON.stringify({ scenario: "after-check", result: recordJson, dirty: scalar(managed, ["status", "--porcelain"]) }));
	expect(recordJson.integrationPassed).toBe(false);
});

it("错的 cards_dir 不能跨归属写入", async () => {
	const source = repo();
	const delivered = await sourceDelivery({
		source,
		managed: mkdtempSync(join(tmpdir(), "pao-review-source-wt-")),
		cardNo: 5,
		content: "base\ndelivery\n",
	});
	const foreignRoot = mkdtempSync(join(tmpdir(), "pao-review-foreign-"));
	const foreignCards = join(foreignRoot, "cards");
	mkdirSync(foreignCards, { recursive: true });
	const foreignCardNo = await claimedCard(foreignCards, "foreign");
	const target = await bind({
		source,
		managed: source,
		cardNo: foreignCardNo,
		attempt: 1,
		cardsDir: foreignCards,
		kind: "primary",
	});
	const before = scalar(source, ["rev-parse", "HEAD"]);
	let accepted = false;
	try {
		await integrateDelivery({
			requestId: "foreign",
			sourceExecutionKey: delivered.execution.key,
			targetExecution: {
				...target,
				canonicalExecutionRoot: source,
			},
			expectedTargetHead: before,
		});
		accepted = true;
	} catch (error) {
		console.log(JSON.stringify({ scenario: "foreign", accepted, error: String(error) }));
	}
	expect(accepted).toBe(false);
});
