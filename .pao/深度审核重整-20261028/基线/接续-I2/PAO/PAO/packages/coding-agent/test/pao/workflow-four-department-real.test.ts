/**
 * 四部门离线真实闭环。
 *
 * 输入：临时 Git 项目、隔离 PAO_HOME、真实主控 AgentSession、真实部长 RPC 子进程、
 * 真实 WorkerRunner 子进程。模型全是仓内 fauxProvider；网络关闭，无付费调用。
 * 输出：只写临时目录；断言真实控制正本、卡、回执、机械验收、地图、业务文件和判定。
 * 边界：本测试不修改产品源码，不替换 host.executeTask、runAutoChain 或任何控制函数。
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { appWorktreeRootMatcher } from "../../../../../desktop/apps/desktop/electron/platform/worktrees/app-worktree-roots.ts";
import { PaoDesktopWorktreeHost } from "../../../../../desktop/apps/desktop/electron/platform/worktrees/pao-worktree-host.ts";
import { GitWorktreeManager } from "../../../../../desktop/apps/desktop/electron/platform/worktrees/worktree-manager.ts";
import { TurnCheckpointStore } from "../../../../../desktop/apps/desktop/electron/workbench/checkpoint-store.ts";
import { JsonCatalogStore } from "../../../../../desktop/packages/catalogs/src/node/json-catalog-store.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { listCards } from "../../src/pao/cards/index.ts";
import {
	loadDispatchInputSnapshot,
	loadDispatchMapArtifact,
	parseDispatchUri,
} from "../../src/pao/dispatch-brief/index.ts";
import { MinisterHost, type SpawnOptions } from "../../src/pao/host/host.ts";
import paoExtension from "../../src/pao/index.ts";
import {
	acquireExecutionRootGuard,
	detectExecutionOccupancy,
	listReleasedExecutionArtifacts,
	prepareExecutionRootForRemoval,
} from "../../src/pao/worker/lock.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { type FlowControl, readControl } from "../../src/pao/workflow/control.ts";
import { loadRecipe } from "../../src/pao/workflow/recipe.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

const TEST_NODE = "C:/Program Files/nodejs/node.exe";
const SOURCE_RESOLVER = pathToFileURL(resolve(__dirname, "../../src/experimental/source-resolver.ts")).href;
const MINISTER_FIXTURE = resolve(__dirname, "fixtures/workflow-four-department-minister.ts");
const WORKER_FIXTURE = resolve(__dirname, "fixtures/workflow-four-department-worker.ts");
const WORKFLOW = "四部门闭环";
const DEPARTMENTS = ["侦察部", "规划部", "实施部", "审核部"] as const;

const roots: string[] = [];
const sessions: AgentSession[] = [];
const hosts: MinisterHost[] = [];
const runners: WorkerRunner[] = [];
const worktreeHosts: PaoDesktopWorktreeHost[] = [];
const failedRoots = new Set<string>();
const EVIDENCE_ROOT = resolve(__dirname, "../../../../../.pao/具体故障修复-20261022/G-四部门离线闭环-evidence");

type Scenario = "success" | "illegal-acceptance" | "lost-minister" | "map-refresh";

afterEach(async ({ task }) => {
	// Vitest 的整例超时不会进入用例内部的 catch，也必须保留现场。
	if (task.result?.state === "fail") for (const root of roots) failedRoots.add(root);
	const cleanupErrors: string[] = [];
	for (const runner of runners.splice(0)) {
		try {
			await runner.stopAll();
		} catch (error) {
			cleanupErrors.push(`WorkerRunner.stopAll 失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const host of hosts.splice(0)) {
		try {
			await host.stopAll("测试清理");
		} catch (error) {
			cleanupErrors.push(`MinisterHost.stopAll 失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const session of sessions.splice(0)) {
		try {
			session.dispose();
		} catch (error) {
			cleanupErrors.push(`AgentSession.dispose 失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	worktreeHosts.splice(0);
	if (cleanupErrors.length > 0) {
		for (const root of roots) failedRoots.add(root);
	}
	const pendingRoots = roots.splice(0);
	const failureDestination = join(EVIDENCE_ROOT, new Date().toISOString().replaceAll(":", "-"));
	for (const root of pendingRoots) {
		if (failedRoots.has(root) && existsSync(root)) {
			try {
				mkdirSync(failureDestination, { recursive: true });
				cpSync(root, join(failureDestination, join(root).split(/[\\/]/).at(-1)!), {
					recursive: true,
				});
			} catch (error) {
				cleanupErrors.push(`失败现场复制失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (cleanupErrors.length === 0) {
		for (const root of pendingRoots) {
			try {
				rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
			} catch (error) {
				cleanupErrors.push(`临时目录清理失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (cleanupErrors.length > 0) throw new Error(`测试清理未完成：\n${cleanupErrors.join("\n")}`);
}, 60_000);

class FourDepartmentMinisterHost extends MinisterHost {
	private readonly fixtureRoot: string;
	private readonly scenario: Scenario;
	private readonly fixturePath: string;

	constructor(
		fixtureRoot: string,
		fixturePath: string,
		scenario: Scenario,
		options: ConstructorParameters<typeof MinisterHost>[0] = {},
	) {
		super(options);
		this.fixtureRoot = fixtureRoot;
		this.fixturePath = fixturePath;
		this.scenario = scenario;
	}

	override async spawn(options: SpawnOptions) {
		const sessionIdIndex = options.参数?.indexOf("--session-id") ?? -1;
		const sessionDirIndex = options.参数?.indexOf("--session-dir") ?? -1;
		const sessionId = sessionIdIndex >= 0 ? options.参数?.[sessionIdIndex + 1] : undefined;
		const sessionDir = sessionDirIndex >= 0 ? options.参数?.[sessionDirIndex + 1] : undefined;
		if (!sessionId || !sessionDir) return { ok: false as const, 原因: "测试部长夹具缺少真实 RPC 会话参数" };
		return super.spawn({
			...options,
			命令: TEST_NODE,
			环境变量: {
				...options.环境变量,
				PAO_G_SCENARIO: this.scenario,
			},
			参数: [
				"--import",
				SOURCE_RESOLVER,
				this.fixturePath,
				this.fixtureRoot,
				"--session-id",
				sessionId,
				"--session-dir",
				sessionDir,
			],
		});
	}
}

class FourDepartmentWorkerRunner extends WorkerRunner {
	private readonly fixtureRoot: string;
	private readonly fixturePath: string;

	constructor(fixtureRoot: string, fixturePath: string, options: ConstructorParameters<typeof WorkerRunner>[0] = {}) {
		super(options);
		this.fixtureRoot = fixtureRoot;
		this.fixturePath = fixturePath;
	}

	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		return super.run({
			...options,
			命令: TEST_NODE,
			参数: ["--import", SOURCE_RESOLVER, this.fixturePath, this.fixtureRoot],
		});
	}
}

function createDesktopWorktreeHost(
	fixture: ReturnType<typeof setupProject>,
	runner: FourDepartmentWorkerRunner,
): PaoDesktopWorktreeHost {
	const userDataDir = join(fixture.controlRoot, "desktop-user-data");
	const catalog = new JsonCatalogStore({
		catalogFilePath: join(userDataDir, "catalogs.json"),
	});
	const checkpoints = new TurnCheckpointStore(userDataDir, {
		timeoutMs: 20_000,
		maxFiles: 10_000,
		maxBytes: 64 * 1024 * 1024,
		maxFileBytes: 16 * 1024 * 1024,
	});
	const worktreeRoot = join(userDataDir, "worktrees");
	const worktreeManager = new GitWorktreeManager({
		catalogStorage: catalog,
		isAppWorktreePath: appWorktreeRootMatcher(worktreeRoot),
	});
	const worktreeHost = new PaoDesktopWorktreeHost({
		userDataDir,
		catalogStorage: catalog,
		checkpoints,
		worktreeManager,
		activeExecution: (_taskRoot, executionRoot) => runner.isExecutionActive(executionRoot),
		executionOccupancy: detectExecutionOccupancy,
		acquireCleanupGuard: acquireExecutionRootGuard,
		listReleasedExecutionArtifacts,
		prepareRunMetadataForRemoval: prepareExecutionRootForRemoval,
	});
	worktreeHosts.push(worktreeHost);
	return worktreeHost;
}

function expectIndependentReviewExecution(
	_flow: FlowControl,
	fixture: ReturnType<typeof setupProject>,
	worktreeHost: PaoDesktopWorktreeHost,
): Promise<void> {
	const implementationStart = readTrace(join(fixture.controlRoot, "worker-starts.jsonl")).find(
		(entry) => entry.node === "实施",
	);
	const reviewStart = readTrace(join(fixture.controlRoot, "worker-starts.jsonl")).find(
		(entry) => entry.node === "审核",
	);
	expect(implementationStart?.cwd).toBe(fixture.root);
	expect(reviewStart?.cwd).toBeTypeOf("string");
	expect(reviewStart?.cwd).not.toBe(fixture.root);
	const reviewCard = listCards(fixture.cardsDir).find((card) => card.body.includes("节点=审核"));
	const reviewReceipt = reviewCard?.receipts.at(-1);
	expect(reviewReceipt?.result).toBe("success");
	expect(reviewReceipt?.artifact_path ?? []).toEqual([]);
	expect(reviewReceipt?.changes ?? []).toEqual([]);
	return worktreeHost.inspect({ projectRoot: fixture.root }).then((entries) => {
		const managed = entries.find(
			(entry) =>
				entry.kind === "managed" && realpathSync(entry.executionRoot) === realpathSync(String(reviewStart!.cwd)),
		);
		expect(managed).toBeDefined();
		expect(managed?.active).toBe(false);
	});
}

function setupProject() {
	const root = mkdtempSync(join(tmpdir(), "pao-four-department-project-"));
	const homeRoot = mkdtempSync(join(tmpdir(), "pao-four-department-home-"));
	const controlRoot = mkdtempSync(join(tmpdir(), "pao-four-department-control-"));
	roots.push(root, homeRoot, controlRoot);
	const home = join(homeRoot, "PAO_HOME");
	const cardsDir = join(root, ".pao", "卡");
	const evidenceDir = join(root, ".pao", "worker-evidence");
	for (const dir of [
		cardsDir,
		evidenceDir,
		join(root, "业务"),
		join(home, "pao配置"),
		join(home, "部门"),
		join(home, "工作流"),
	]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(root, "业务", "输入.txt"), "四部门真实闭环输入\n", "utf8");
	writeFileSync(
		join(home, "pao配置", "档位.json"),
		`${JSON.stringify(
			{
				provider: "pao",
				档位: [
					{
						名: "primary",
						provider: "fixture",
						model: "fixture-primary",
						thinkingLevel: "low",
					},
				],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	writeFileSync(
		join(home, "pao配置", "保温.json"),
		`${JSON.stringify({
			空闲分钟: 30,
			工人检查分钟: 0,
			部门检查分钟: 0,
			toast通知: false,
		})}\n`,
		"utf8",
	);
	writeFileSync(
		join(home, "部门", "注册表.md"),
		[
			"# 部门注册表",
			"",
			"| 名字 | 能力标签 | 库路径 | 建部日期 |",
			"| --- | --- | --- | --- |",
			...DEPARTMENTS.map(
				(name, index) => `| ${name} | 四部门闭环 | 部门/${name}/知识库 | 2026-10-${String(22 + index)} |`,
			),
			"",
		].join("\n"),
		"utf8",
	);
	for (const department of DEPARTMENTS) {
		const deptDir = join(home, "部门", department);
		mkdirSync(join(deptDir, "知识库"), { recursive: true });
		writeFileSync(
			join(deptDir, "配方.md"),
			[
				`# ${department}配方`,
				`名字:${department}`,
				`人设:${department}负责四部门离线闭环中的职责。`,
				`工具:${department === "审核部" ? "read" : "read、write"}`,
				"默认档位:primary",
				`记忆目录:部门/${department}/知识库`,
				"",
				"## 标准:有证据",
				"结论必须有真实运行证据和可定位引用。",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(join(deptDir, "知识库", "索引.md"), `# ${department}知识库\n`, "utf8");
	}
	writeFileSync(
		join(home, "工作流", `${WORKFLOW}.md`),
		[
			"---",
			"版本: 2",
			`名字: ${WORKFLOW}`,
			"自动执行: true",
			"参数: []",
			"节点:",
			"  - 名字: 侦察",
			"    部门: 侦察部",
			"    目标: 读取业务/输入.txt并保存侦察交接地图",
			"    验收: 保存有效节点地图并说明零卡理由",
			"    输入:",
			"      - 业务/输入.txt",
			"    只读: true",
			"    工人数量: 1",
			"    档位: primary",
			"    预算:",
			"      turns: 4",
			"      toolCalls: 8",
			"    depends_on: []",
			"    人工确认: false",
			"  - 名字: 规划",
			"    部门: 规划部",
			"    目标: 消费侦察地图并保存规划交接地图",
			"    验收: 保存有效节点地图并说明零卡理由",
			"    只读: true",
			"    工人数量: 1",
			"    档位: primary",
			"    预算:",
			"      turns: 4",
			"      toolCalls: 8",
			"    depends_on: [侦察]",
			"    人工确认: false",
			"  - 名字: 实施",
			"    部门: 实施部",
			"    目标: 根据规划地图写入业务闭环结果和业务审查记录",
			"    验收: 两份业务证据存在且业务审查记录不冒充独立审核并由负责部长确认内容",
			"    输入:",
			"      - 业务/输入.txt",
			"    工人数量: 1",
			"    档位: primary",
			"    预算:",
			"      turns: 8",
			"      toolCalls: 6",
			"    depends_on: [规划]",
			"    人工确认: false",
			"  - 名字: 审核",
			"    部门: 审核部",
			"    目标: 在独立受管副本中只读复核实施部写下的业务结果和业务审查记录",
			"    验收: 仅凭两份现有业务证据完成独立复核并由负责部长提交 pass",
			"    输入:",
			"      - 业务/闭环结果.txt",
			"      - 业务/审核结论.txt",
			"    工人数量: 1",
			"    档位: primary",
			"    预算:",
			"      turns: 6",
			"      toolCalls: 4",
			"    depends_on: [实施]",
			"    人工确认: false",
			"    只读: true",
			"    审核: true",
			"    部门标准: 审核部:有证据",
			"    允许请求主控裁定: true",
			"---",
			"",
			"从真实输入开始，依次完成侦察、规划、实施、审核。",
			"",
		].join("\n"),
		"utf8",
	);

	const git = (args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=four-department-fixture", "-c", "user.email=fixture@example.invalid", ...args],
			{ cwd: root, stdio: "pipe" },
		);
	git(["init", "--quiet"]);
	git(["config", "core.longpaths", "true"]);
	git(["add", "业务/输入.txt"]);
	git(["commit", "--quiet", "--no-gpg-sign", "-m", "four department fixture"]);
	return {
		root,
		home,
		controlRoot,
		roots: [root, homeRoot, controlRoot],
		cardsDir,
		evidenceDir,
	};
}

function readFlow(root: string, cardsDir: string, home: string, owner: string): FlowControl {
	const recipe = loadRecipe(home, WORKFLOW);
	return readControl(recipe, {
		cardsDir,
		workspaceDir: join(root, ".pao"),
		ownerSessionId: owner,
	});
}

async function waitFor(check: () => boolean | string | undefined, label: string, timeoutMs = 90_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = "尚未执行";
	while (Date.now() < deadline) {
		const result = check();
		if (result === true) return;
		if (typeof result === "string") last = result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`等待${label}超时：${last}`);
}

function diagnosticSnapshot(fixture: { root: string; home: string; controlRoot: string; cardsDir: string }): string {
	const files: string[] = [];
	for (const path of [
		join(fixture.controlRoot, "部长轨迹.jsonl"),
		join(fixture.root, ".pao", "派发日志.jsonl"),
		join(fixture.root, ".pao", `工作流实例-${WORKFLOW}.md`),
	]) {
		if (!existsSync(path)) continue;
		files.push(`--- ${path} ---\n${readFileSync(path, "utf8").slice(-12000)}`);
	}
	const evidenceRoot = join(fixture.root, ".pao", "部长留证");
	if (existsSync(evidenceRoot)) {
		for (const name of readdirSync(evidenceRoot, { withFileTypes: true })) {
			if (!name.isFile()) continue;
			const path = join(evidenceRoot, name.name);
			files.push(`--- ${path} ---\n${readFileSync(path, "utf8").slice(-8000)}`);
		}
	}
	return files.join("\n\n");
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
		)
		.map((part) => part.text)
		.join("\n");
}

function latestUserText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string; content?: unknown } | undefined;
		if (message?.role === "user") return contentText(message.content);
	}
	return "";
}

function taskMessages(messages: readonly unknown[]): readonly unknown[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string } | undefined;
		if (message?.role === "user") return messages.slice(index + 1);
	}
	return messages;
}

function hasToolCallSinceLatestUser(messages: readonly unknown[], toolName: string): boolean {
	return taskMessages(messages).some((item) => {
		const message = item as { role?: string; content?: Array<{ type?: string; name?: string }> } | undefined;
		return (
			message?.role === "assistant" &&
			(message.content?.some((part) => part.type === "toolCall" && part.name === toolName) ?? false)
		);
	});
}

function readTrace(path: string): Array<Record<string, unknown>> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForMinisterIdle(
	host: MinisterHost,
	fixture: ReturnType<typeof setupProject>,
	department: string,
	context: string,
	sessionId: string,
	label: string,
): Promise<void> {
	await waitFor(() => {
		const count = host.backgroundCountFor({
			department,
			projectRoot: fixture.root,
			context,
			sessionId,
		}).inFlight;
		return count === 0 ? true : `仍有 ${count} 个任务在途`;
	}, label);
}

async function promptWhenMainIdle(session: AgentSession, prompt: string): Promise<void> {
	await waitFor(() => !session.isStreaming, "主控自动链通知轮结束，可提交恢复推流");
	await session.prompt(prompt);
}

function preservePassedEvidence(
	scenario: Scenario,
	fixture: ReturnType<typeof setupProject>,
	session: AgentSession,
): string {
	const stamp = new Date().toISOString().replaceAll(":", "-");
	const destination = join(EVIDENCE_ROOT, `passed-${scenario}-${stamp}`);
	mkdirSync(destination, { recursive: true });
	cpSync(fixture.root, join(destination, "project"), { recursive: true });
	cpSync(fixture.roots[1], join(destination, "home"), { recursive: true });
	cpSync(fixture.controlRoot, join(destination, "control"), { recursive: true });
	writeFileSync(
		join(destination, "场景结论.json"),
		`${JSON.stringify(
			{
				场景: scenario,
				结果: "passed",
				时间: new Date().toISOString(),
				模型: "仓内 fauxProvider；allowModelNetwork=false",
				主控会话: session.sessionId,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return destination;
}

async function runRecoveryScenario(scenario: "illegal-acceptance" | "lost-minister" | "map-refresh") {
	const fixture = setupProject();
	const previousHome = process.env.PAO_HOME;
	const previousRole = process.env.PAO_ROLE;
	process.env.PAO_HOME = fixture.home;
	process.env.PAO_ROLE = "主控";
	let session: AgentSession | undefined;

	try {
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		const mainRespond = (ctx: Context) => {
			faux.appendResponses([mainRespond]);
			const prompt = latestUserText(ctx.messages);
			const injected = `${ctx.systemPrompt ?? ""}\n${JSON.stringify(ctx.messages)}`;
			if (prompt.includes("启动工作流") && !hasToolCallSinceLatestUser(ctx.messages, "pao_start_flow")) {
				return fauxAssistantMessage(fauxToolCall("pao_start_flow", { name: WORKFLOW }), {
					stopReason: "toolUse",
				});
			}
			if (prompt.includes("重推工作流") && !hasToolCallSinceLatestUser(ctx.messages, "pao_push_flow")) {
				return fauxAssistantMessage(fauxToolCall("pao_push_flow", { name: WORKFLOW }), {
					stopReason: "toolUse",
				});
			}
			if (injected.includes("[自动链完成]")) return fauxAssistantMessage("四部门流程已完成并投递主控");
			return fauxAssistantMessage("四部门流程已受理或恢复场景已记录");
		};
		faux.setResponses([mainRespond]);

		const runner = new FourDepartmentWorkerRunner(fixture.controlRoot, WORKER_FIXTURE, {
			证据目录: fixture.evidenceDir,
			dispatchStateRoot: join(fixture.home, "派发状态"),
		});
		runners.push(runner);
		const worktreeHost = createDesktopWorktreeHost(fixture, runner);
		const host = new FourDepartmentMinisterHost(fixture.controlRoot, MINISTER_FIXTURE, scenario, {
			paoHome: fixture.home,
			监督分钟: () => ({ 工人: 0, 部门: 0 }),
		});
		hosts.push(host);
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) =>
					paoExtension(pi, {
						host,
						runner,
						resolveProjectRoot: () => fixture.root,
						resolveCardsDir: () => fixture.cardsDir,
						resolvePaoHome: () => fixture.home,
						worktreeHost,
					}),
			],
			fixture.root,
		);
		const created = await createAgentSession({
			cwd: fixture.root,
			agentDir: fixture.controlRoot,
			modelRuntime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(fixture.root),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			tools: ["pao_start_flow", "pao_push_flow", "pao_query_flow", "pao_inventory"],
		});
		session = created.session;
		sessions.push(session);
		await session.bindExtensions({});
		const owner = session.sessionId;

		await session.prompt(`启动工作流 ${WORKFLOW}`);
		const accepted = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
		expect(accepted.owner).toBe(owner);
		expect(accepted.状态).toBe("运行中");

		if (scenario === "illegal-acceptance") {
			await waitFor(
				() => existsSync(join(fixture.controlRoot, "worker.illegal-acceptance-ready")),
				"实施部长收到非法验收预检错误",
			);
			const rejected = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
			const implementation = rejected.节点.find((node) => node.名字 === "实施")!;
			expect(implementation.卡).toHaveLength(0);
			expect(implementation.拆解结束).toBe(false);
			expect(listCards(fixture.cardsDir)).toHaveLength(0);
			const rejectedTrace = readTrace(join(fixture.controlRoot, "部长轨迹.jsonl"));
			expect(rejectedTrace).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						event: "illegal-acceptance-rejected",
						node: "实施",
						text: expect.stringContaining("禁绝对路径"),
					}),
				]),
			);
			await waitForMinisterIdle(
				host,
				fixture,
				"实施部",
				rejected.脉络,
				implementation.部长会话!,
				"非法验收部长轮结束",
			);
			writeFileSync(join(fixture.controlRoot, "worker.illegal-acceptance.release"), "release\n", "utf8");
			await promptWhenMainIdle(session, "非法验收已当场纠正，重推工作流");
			await waitFor(() => {
				const flow = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
				const node = flow.节点.find((candidate) => candidate.名字 === "实施")!;
				return node.卡.length === 1 && node.拆解结束 ? true : "修正卡尚未真实落盘或拆解未结束";
			}, "非法验收纠正后真实交卡");
		}

		if (scenario === "map-refresh") {
			await waitFor(() => existsSync(join(fixture.controlRoot, "map.refresh-ready")), "侦察首版地图保存并可刷新");
			const beforeRefresh = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
			const scout = beforeRefresh.节点.find((node) => node.名字 === "侦察")!;
			const firstMaps = beforeRefresh.记录.filter(
				(record) => record.事件 === "节点交接地图" && record.节点 === "侦察",
			);
			expect(firstMaps).toHaveLength(1);
			expect(scout.拆解结束).toBe(false);
			writeFileSync(join(fixture.root, "业务", "输入.txt"), "四部门真实闭环输入（已刷新）\n", "utf8");
			await waitForMinisterIdle(
				host,
				fixture,
				"侦察部",
				beforeRefresh.脉络,
				scout.部长会话!,
				"地图刷新前侦察部长轮结束",
			);
			writeFileSync(join(fixture.controlRoot, "map.refresh.release"), "release\n", "utf8");
			await promptWhenMainIdle(session, "业务输入已变更并刷新地图，重推工作流");
			await waitFor(() => {
				const flow = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
				const maps = flow.记录.filter((record) => record.事件 === "节点交接地图" && record.节点 === "侦察");
				const node = flow.节点.find((candidate) => candidate.名字 === "侦察")!;
				return maps.length === 2 && node.拆解结束
					? true
					: `侦察地图 ${maps.length} 份，拆解结束 ${String(node.拆解结束)}`;
			}, "业务地图替代刷新完成");
		}

		if (scenario === "lost-minister") {
			await waitFor(
				() => existsSync(join(fixture.controlRoot, "minister.lost-ready")),
				"侦察部长首版地图完成后可失联",
			);
			const beforeLoss = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
			const scout = beforeLoss.节点.find((node) => node.名字 === "侦察")!;
			const oldSession = scout.部长会话!;
			const oldRound = scout.轮次;
			const oldHandle = host.hotSession("侦察部", fixture.root, beforeLoss.脉络);
			expect(oldHandle?.会话标识).toBe(oldSession);
			expect(oldHandle?.pid).toBeTypeOf("number");
			await waitForMinisterIdle(host, fixture, "侦察部", beforeLoss.脉络, oldSession, "失联前侦察部长轮结束");
			const stopped = await host.teardown("侦察部", fixture.root, "故障注入：真实终止失联侦察部长", beforeLoss.脉络);
			expect(stopped).toBeDefined();
			await waitFor(() => !processIsAlive(oldHandle!.pid), "失联侦察部长真实进程退出");
			expect(host.hotSession("侦察部", fixture.root, beforeLoss.脉络)).toBeUndefined();
			writeFileSync(join(fixture.controlRoot, "minister.recovery.release"), "release\n", "utf8");
			await promptWhenMainIdle(session, "恢复失联部长并重推工作流");
			await waitFor(() => {
				const handle = host.hotSession("侦察部", fixture.root, beforeLoss.脉络);
				if (!handle) return "部长尚未重建";
				if (handle.会话标识 !== oldSession) return `会话标识变成 ${handle.会话标识}`;
				if (handle.pid === oldHandle!.pid) return "部长仍是旧进程";
				return true;
			}, "原会话标识由新进程重建");
			const recovered = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
			const recoveredScout = recovered.节点.find((node) => node.名字 === "侦察")!;
			expect(recoveredScout.部长会话).toBe(oldSession);
			expect(recoveredScout.轮次).toBe(oldRound);
			await waitFor(
				() =>
					readFlow(fixture.root, fixture.cardsDir, fixture.home, owner).节点.find((node) => node.名字 === "侦察")
						?.拆解结束 === true,
				"恢复后的原实例完成侦察拆解",
			);
		}

		await waitFor(() => existsSync(join(fixture.controlRoot, "worker.started-实施")), "实施 worker 在释放前真实启动");
		const waiting = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
		expect(waiting.状态).toBe("运行中");
		expect(waiting.节点.find((node) => node.名字 === "侦察")?.拆解结束).toBe(true);
		expect(waiting.节点.find((node) => node.名字 === "规划")?.拆解结束).toBe(true);
		expect(waiting.节点.find((node) => node.名字 === "实施")?.拆解结束).toBe(true);
		expect(existsSync(join(fixture.root, "业务", "闭环结果.txt"))).toBe(false);

		if (scenario === "map-refresh") {
			const scoutMaps = waiting.记录.filter((record) => record.事件 === "节点交接地图" && record.节点 === "侦察");
			expect(scoutMaps).toHaveLength(2);
			const currentMap = loadDispatchMapArtifact(scoutMaps[1].理由, { cardsDir: fixture.cardsDir });
			const planRecord = waiting.记录.findLast(
				(record) => record.事件 === "节点交接地图" && record.节点 === "规划",
			)!;
			const planMap = loadDispatchMapArtifact(planRecord.理由, { cardsDir: fixture.cardsDir });
			expect(currentMap.previousRef).toBe(scoutMaps[0].理由);
			expect(currentMap.supersessionReason).toContain("业务输入已变更");
			expect(currentMap.facts.join("\n")).toContain("四部门真实闭环输入（已刷新）");
			expect(planMap.facts.join("\n")).toContain("四部门真实闭环输入（已刷新）");
			const implementationCard = listCards(fixture.cardsDir).find((card) => card.body.includes(`节点=实施`))!;
			const implementationSnapshot = loadDispatchInputSnapshot(
				join(fixture.cardsDir, "..", "输入快照", "attempts", "card-0001-attempt-1.json"),
			);
			expect(implementationSnapshot.briefMarkdown).toContain(planRecord.理由);
			expect(implementationSnapshot.briefMarkdown).toContain("四部门真实闭环输入（已刷新）");
			const canonicalPlanMapRef = parseDispatchUri(planRecord.理由).canonical;
			expect(implementationSnapshot.evidence).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "upstream",
						ref: canonicalPlanMapRef,
						purpose: "地图覆盖、事实、未知和影响范围",
					}),
				]),
			);
			const implementationDefinition = waiting.冻结配方.节点.find((node) => node.名字 === "实施")!;
			expect(implementationDefinition.depends_on).toEqual(["规划"]);
			expect(waiting.节点.find((node) => node.名字 === "规划")?.卡).toEqual([]);
			expect(implementationCard.frontmatter.depends_on).toEqual([]);
		}

		writeFileSync(join(fixture.controlRoot, "worker.release-实施"), "release\n", "utf8");
		await waitFor(
			() => existsSync(join(fixture.controlRoot, "worker.started-审核")),
			"实施完成后审核 worker 真实启动",
		);
		const implementationResultBeforeReview = readFileSync(join(fixture.root, "业务", "闭环结果.txt"), "utf8");
		const businessReviewRecordBeforeReview = readFileSync(join(fixture.root, "业务", "审核结论.txt"), "utf8");
		expect(implementationResultBeforeReview).toBe("四部门闭环通过\n");
		expect(businessReviewRecordBeforeReview).toBe("实施侧审查记录：业务结果已提交独立复核\n");
		writeFileSync(join(fixture.controlRoot, "worker.release-审核"), "release\n", "utf8");

		await waitFor(() => {
			const flow = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
			return flow.状态 === "已完成" ? true : `当前状态 ${flow.状态}`;
		}, `${scenario} 四部门控制正本完成`);
		await waitFor(
			() =>
				session!.messages.some(
					(message) =>
						(message as { role?: string }).role === "assistant" &&
						contentText((message as { content?: unknown }).content).includes("四部门流程已完成"),
				),
			`${scenario} 完成后只唤醒主控的完成通知`,
		);

		const flow = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
		expect(flow.状态).toBe("已完成");
		expect(flow.节点.map((node) => node.名字)).toEqual(["侦察", "规划", "实施", "审核"]);
		expect(flow.节点.every((node) => node.拆解结束)).toBe(true);
		expect(flow.节点.find((node) => node.名字 === "审核")?.判定).toMatchObject({
			结果: "pass",
			引用: ["业务/审核结论.txt:1", "业务/闭环结果.txt:1"],
		});
		expect(flow.记录.filter((record) => record.事件 === "节点交接地图")).toHaveLength(
			scenario === "map-refresh" ? 3 : 2,
		);
		expect(flow.记录.filter((record) => record.事件 === "工人审核请求")).toHaveLength(2);
		expect(readFileSync(join(fixture.root, "业务", "闭环结果.txt"), "utf8")).toBe(implementationResultBeforeReview);
		expect(readFileSync(join(fixture.root, "业务", "审核结论.txt"), "utf8")).toBe(businessReviewRecordBeforeReview);
		expect(businessReviewRecordBeforeReview).not.toContain("审核通过");
		await expectIndependentReviewExecution(flow, fixture, worktreeHost);
		const cards = listCards(fixture.cardsDir);
		expect(cards).toHaveLength(2);
		expect(cards.every((card) => card.frontmatter.status === "delivered")).toBe(true);
		expect(
			cards.every(
				(card) =>
					card.receipts.some((receipt) => receipt.attempt === card.frontmatter.attempt) &&
					card.body.includes("## 机械验收"),
			),
		).toBe(true);
		expect(runner.registry.list().every((entry) => entry.running === false)).toBe(true);

		if (scenario === "lost-minister") {
			const starts = readTrace(join(fixture.controlRoot, "部长轨迹.jsonl")).filter(
				(entry) => entry.event === "fixture-start" && entry.node === "侦察",
			);
			expect(starts.length).toBeGreaterThanOrEqual(2);
			expect(new Set(starts.map((entry) => entry.session)).size).toBe(1);
			expect(JSON.parse(String(starts[0].session))).toMatchObject({
				节点: "侦察",
				轮次: 1,
			});
		}

		writeFileSync(
			join(fixture.controlRoot, "主控消息.json"),
			`${JSON.stringify(session.messages, null, 2)}\n`,
			"utf8",
		);
		preservePassedEvidence(scenario, fixture, session);
	} catch (error) {
		for (const root of fixture.roots) failedRoots.add(root);
		if (session) {
			writeFileSync(
				join(fixture.controlRoot, "主控消息.json"),
				`${JSON.stringify(session.messages, null, 2)}\n`,
				"utf8",
			);
		}
		throw error;
	} finally {
		if (previousHome === undefined) delete process.env.PAO_HOME;
		else process.env.PAO_HOME = previousHome;
		if (previousRole === undefined) delete process.env.PAO_ROLE;
		else process.env.PAO_ROLE = previousRole;
	}
}

describe("四部门离线真实闭环", () => {
	// Windows 单独实跑完整断言需 135.90 秒；与下方恢复场景统一为 180 秒，不放宽各阶段判定。
	it("真实工具入口启动后后台完成侦察→规划→实施→审核，部长 review 与 decision 均落控制正本", async () => {
		const fixture = setupProject();
		const previousHome = process.env.PAO_HOME;
		const previousRole = process.env.PAO_ROLE;
		process.env.PAO_HOME = fixture.home;
		process.env.PAO_ROLE = "主控";

		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("pao_start_flow", { name: WORKFLOW }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("四部门流程已受理"),
			fauxAssistantMessage("四部门流程已完成并投递主控"),
		]);

		const runner = new FourDepartmentWorkerRunner(fixture.controlRoot, WORKER_FIXTURE, {
			证据目录: fixture.evidenceDir,
			dispatchStateRoot: join(fixture.home, "派发状态"),
		});
		runners.push(runner);
		const worktreeHost = createDesktopWorktreeHost(fixture, runner);
		const host = new FourDepartmentMinisterHost(fixture.controlRoot, MINISTER_FIXTURE, "success", {
			paoHome: fixture.home,
			监督分钟: () => ({ 工人: 0, 部门: 0 }),
		});
		hosts.push(host);
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) =>
					paoExtension(pi, {
						host,
						runner,
						resolveProjectRoot: () => fixture.root,
						resolveCardsDir: () => fixture.cardsDir,
						resolvePaoHome: () => fixture.home,
						worktreeHost,
					}),
			],
			fixture.root,
		);
		const { session } = await createAgentSession({
			cwd: fixture.root,
			agentDir: fixture.controlRoot,
			modelRuntime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(fixture.root),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			tools: ["pao_start_flow", "pao_query_flow", "pao_inventory"],
		});
		sessions.push(session);
		await session.bindExtensions({});
		const owner = session.sessionId;

		try {
			await session.prompt(`启动工作流 ${WORKFLOW}`);
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
			});
			const accepted = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
			expect(accepted.owner).toBe(owner);
			expect(accepted.状态).toBe("运行中");

			try {
				await waitFor(
					() => existsSync(join(fixture.controlRoot, "worker.started-实施")),
					"实施 worker 在释放前真实启动",
				);
			} catch (error) {
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\n${diagnosticSnapshot(fixture)}`,
				);
			}
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "四部门流程已受理" }],
			});
			const waiting = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
			expect(waiting.状态).toBe("运行中");
			expect(waiting.节点.find((node) => node.名字 === "侦察")?.拆解结束).toBe(true);
			expect(waiting.节点.find((node) => node.名字 === "规划")?.拆解结束).toBe(true);
			expect(waiting.节点.find((node) => node.名字 === "实施")?.拆解结束).toBe(true);
			expect(existsSync(join(fixture.root, "业务", "闭环结果.txt"))).toBe(false);

			writeFileSync(join(fixture.controlRoot, "worker.release-实施"), "release\n", "utf8");
			await waitFor(
				() => existsSync(join(fixture.controlRoot, "worker.started-审核")),
				"实施完成后审核 worker 真实启动",
			);
			const implementationResultBeforeReview = readFileSync(join(fixture.root, "业务", "闭环结果.txt"), "utf8");
			const businessReviewRecordBeforeReview = readFileSync(join(fixture.root, "业务", "审核结论.txt"), "utf8");
			expect(implementationResultBeforeReview).toBe("四部门闭环通过\n");
			expect(businessReviewRecordBeforeReview).toBe("实施侧审查记录：业务结果已提交独立复核\n");
			writeFileSync(join(fixture.controlRoot, "worker.release-审核"), "release\n", "utf8");

			await waitFor(() => {
				const flow = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
				return flow.状态 === "已完成" ? true : `当前状态 ${flow.状态}`;
			}, "四部门控制正本完成");
			await waitFor(
				() =>
					session.messages.some(
						(message) =>
							(message as { role?: string }).role === "assistant" &&
							contentText((message as { content?: unknown }).content).includes("四部门流程已完成"),
					),
				"完成后只唤醒主控的完成通知",
			);

			const flow = readFlow(fixture.root, fixture.cardsDir, fixture.home, owner);
			expect(flow.节点.map((node) => node.名字)).toEqual(["侦察", "规划", "实施", "审核"]);
			expect(flow.节点.every((node) => node.拆解结束)).toBe(true);
			expect(flow.节点.find((node) => node.名字 === "审核")?.判定).toMatchObject({
				结果: "pass",
				引用: ["业务/审核结论.txt:1", "业务/闭环结果.txt:1"],
			});
			expect(flow.记录.filter((record) => record.事件 === "节点交接地图")).toHaveLength(2);
			expect(flow.记录.filter((record) => record.事件 === "工人审核请求")).toHaveLength(2);
			expect(flow.记录.filter((record) => record.事件 === "工人审核结论")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						节点: "实施",
						理由: expect.stringContaining('"result":"pass"'),
					}),
					expect.objectContaining({
						节点: "审核",
						理由: expect.stringContaining('"result":"pass"'),
					}),
				]),
			);

			expect(readFileSync(join(fixture.root, "业务", "闭环结果.txt"), "utf8")).toBe(
				implementationResultBeforeReview,
			);
			expect(readFileSync(join(fixture.root, "业务", "审核结论.txt"), "utf8")).toBe(
				businessReviewRecordBeforeReview,
			);
			expect(businessReviewRecordBeforeReview).not.toContain("审核通过");
			await expectIndependentReviewExecution(flow, fixture, worktreeHost);
			const cards = listCards(fixture.cardsDir);
			expect(cards).toHaveLength(2);
			expect(cards.every((card) => card.frontmatter.status === "delivered")).toBe(true);
			expect(
				cards.every(
					(card) =>
						card.receipts.some((receipt) => receipt.attempt === card.frontmatter.attempt) &&
						card.body.includes("## 机械验收"),
				),
			).toBe(true);
			expect(runner.registry.list().every((entry) => entry.running === false)).toBe(true);
			writeFileSync(
				join(fixture.controlRoot, "主控消息.json"),
				`${JSON.stringify(session.messages, null, 2)}\n`,
				"utf8",
			);
			preservePassedEvidence("success", fixture, session);
		} catch (error) {
			for (const root of fixture.roots) failedRoots.add(root);
			writeFileSync(
				join(fixture.controlRoot, "主控消息.json"),
				`${JSON.stringify(session.messages, null, 2)}\n`,
				"utf8",
			);
			throw error;
		} finally {
			if (previousHome === undefined) delete process.env.PAO_HOME;
			else process.env.PAO_HOME = previousHome;
			if (previousRole === undefined) delete process.env.PAO_ROLE;
			else process.env.PAO_ROLE = previousRole;
		}
	}, 180_000);
});

describe("四部门离线受控恢复", () => {
	for (const [scenario, label] of [
		["illegal-acceptance", "非法验收"],
		["lost-minister", "部长失联"],
		["map-refresh", "业务地图刷新"],
	] as const) {
		it(`${scenario}：${label}后仍由真实内核完成四部门闭环`, async () => {
			await runRecoveryScenario(scenario);
		}, 180_000);
	}
});
