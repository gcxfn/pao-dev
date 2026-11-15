import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createCard } from "../../src/pao/cards/cardfile.ts";
import paoExtension from "../../src/pao/index.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";

const roots: string[] = [];
const runners: WorkerRunner[] = [];

afterEach(async () => {
 for (const runner of runners.splice(0)) await runner.stopAll();
 for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setupRoot(prefix: string): { root: string; cardsDir: string; home: string } {
 const root = mkdtempSync(join(tmpdir(), `pao-index-wiring-${prefix}-`));
 roots.push(root);
 const cardsDir = join(root, ".pao", "卡");
 const home = join(root, "home");
 mkdirSync(cardsDir, { recursive: true });
 mkdirSync(join(home, "pao配置"), { recursive: true });
 writeFileSync(
  join(home, "pao配置", "档位.json"),
  JSON.stringify({
		档位: [
			{ 名: "fast", provider: "fixture", model: "fast", thinkingLevel: "low" },
			{ 名: "primary", provider: "fixture", model: "primary", thinkingLevel: "medium" },
		],
  }),
  "utf8",
 );
 writeFileSync(join(root, "fixture.txt"), "primary wiring fixture\n");
 const git = (args: string[]) =>
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
   cwd: root,
   stdio: "pipe",
  });
 git(["init", "--quiet"]);
 git(["add", "."]);
 git(["commit", "--quiet", "--no-gpg-sign", "-m", "fixture baseline"]);
 return { root, cardsDir, home };
}

function ctx(root: string): ExtensionToolContext {
 return {
  cwd: root,
  hasUI: false,
  sessionManager: {
   getSessionId: () => "index-wiring-session",
   getBranch: () => [],
   getEntries: () => [],
  },
  ui: {
   setStatus: vi.fn(),
   notify: vi.fn(),
   confirm: vi.fn(async () => true),
   setWorkingIndicator: vi.fn(),
   setWidget: vi.fn(),
   custom: vi.fn(),
  },
  tools: [],
  executeTool: vi.fn(),
 } as unknown as ExtensionToolContext;
}

function mockPi() {
 const tools = new Map<string, any>();
 const handlers = new Map<string, ((...args: any[]) => any)[]>();
 const messages: Array<{ customType: string; text: string }> = [];
 const messageWaiters: Array<{
  customType: string;
  occurrence: number;
  resolve: () => void;
 }> = [];
 const notifyMessageWaiters = (): void => {
  for (let index = messageWaiters.length - 1; index >= 0; index--) {
   const waiter = messageWaiters[index];
   const count = messages.filter((message) => message.customType === waiter.customType).length;
   if (count < waiter.occurrence) continue;
   messageWaiters.splice(index, 1);
   waiter.resolve();
  }
 };
 const waitForMessage = (customType: string, occurrence = 1): Promise<void> => {
  const count = messages.filter((message) => message.customType === customType).length;
  if (count >= occurrence) return Promise.resolve();
  return new Promise((resolve) => messageWaiters.push({ customType, occurrence, resolve }));
 };
 const api = {
  registerTool(tool: any) { tools.set(tool.name, tool); },
  registerCommand() {},
  registerVirtualModel() {},
  registerMessageRenderer() {},
  registerEntryRenderer() {},
  registerToolRenderer() {},
  registerShortcut() {},
  registerFlag() {},
  getFlag() { return undefined; },
  on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  sendMessage(message: any) {
   messages.push({ customType: message.customType, text: message.content?.[0]?.text ?? "" });
   notifyMessageWaiters();
  },
  sendUserMessage: vi.fn(),
  appendEntry() {},
  setStatus() {},
  setSessionName() {},
  getSessionName() { return undefined; },
  exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  getActiveTools() { return [...tools.keys()]; },
  getAllTools() { return [...tools.values()]; },
  setActiveTools: vi.fn(),
  refreshTools: vi.fn(),
  registerProvider() {},
  unregisterProvider() {},
  registerMcpServer() {},
  mcpServers: {},
  unregisterVirtualModel() {},
 } as unknown as ExtensionAPI;
 return { pi: api, tools, handlers, messages, waitForMessage };
}

function receipt(options: WorkerRunOptions): WorkerReceipt {
 return {
  card_no: options.卡号,
  card_path: options.卡路径,
  attempt: options.尝试号 ?? 1,
  status: "success",
  artifact_path: [],
  summary: "本地 wiring 假回执",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  工具调用次数: 0,
  evidence_path: "",
  exitCode: 0,
  command: "fake",
  pid: -1,
  duration_ms: 1,
 };
}

class WiringRunner extends WorkerRunner {
 runs: WorkerRunOptions[] = [];
 private readonly runWaiters: Array<{
  count: number;
  resolve: (options: WorkerRunOptions) => void;
 }> = [];

 waitForRun(count: number): Promise<WorkerRunOptions> {
  const started = this.runs[count - 1];
  if (started) return Promise.resolve(started);
  return new Promise((resolve) => this.runWaiters.push({ count, resolve }));
 }

 override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
  this.runs.push(options);
  for (let index = this.runWaiters.length - 1; index >= 0; index--) {
   const waiter = this.runWaiters[index];
   if (this.runs.length < waiter.count) continue;
   this.runWaiters.splice(index, 1);
   waiter.resolve(options);
  }
  return receipt(options);
 }
}

async function invoke(handlers: Map<string, ((...args: any[]) => any)[]>, root: string): Promise<void> {
 for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx(root));
}

async function register(
 prefix: string,
 options: { role?: string } = {},
): Promise<
 ReturnType<typeof setupRoot> &
  ReturnType<typeof mockPi> & {
   runner: WiringRunner;
  }
> {
 const setup = setupRoot(prefix);
 const mock = mockPi();
 const runner = new WiringRunner({ 证据目录: join(setup.root, "证据") });
 runners.push(runner);
 const previousRole = process.env.PAO_ROLE;
 const previousHome = process.env.PAO_HOME;
 if (options.role === undefined) delete process.env.PAO_ROLE;
 else process.env.PAO_ROLE = options.role;
 process.env.PAO_HOME = setup.home;
 try {
  paoExtension(mock.pi, {
   resolveProjectRoot: () => setup.root,
   resolveCardsDir: () => setup.cardsDir,
   resolvePaoHome: () => setup.home,
   runner,
  });
  await invoke(mock.handlers, setup.root);
 } finally {
  if (previousRole === undefined) delete process.env.PAO_ROLE;
  else process.env.PAO_ROLE = previousRole;
  if (previousHome === undefined) delete process.env.PAO_HOME;
  else process.env.PAO_HOME = previousHome;
 }
 return { ...setup, ...mock, runner };
}

async function addCard(cardsDir: string, goal: string) {
 mkdirSync(cardsDir, { recursive: true });
 return createCard(
  cardsDir,
  { 目标: goal, 部门: "测试", 验收: "本地回执成功", 档位: "primary", 创建: "2026-10-21 01:00" },
  { counterPath: join(cardsDir, "..", "卡号.txt") },
 );
}

async function fireBeforeAgentStart(
 handlers: Map<string, ((...args: any[]) => any)[]>,
 root: string,
 prompt: string,
): Promise<{
 sections: Record<string, string>;
 messages: unknown[];
 systemPrompt?: string;
}> {
 const sections: Record<string, string> = {};
 const messages: unknown[] = [];
 let systemPrompt: string | undefined;
 const event = {
  type: "before_agent_start",
  prompt,
  get systemPrompt() {
   return systemPrompt ?? Object.values(sections).join("\n\n");
  },
  systemPromptOptions: { sections },
 };
 for (const handler of handlers.get("before_agent_start") ?? []) {
  const result = (await handler(event, ctx(root))) as
   | { message?: unknown; systemPrompt?: string }
   | undefined;
  if (result?.message) messages.push(result.message);
  if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
 }
 return { sections: { ...sections }, messages, ...(systemPrompt !== undefined ? { systemPrompt } : {}) };
}

describe("paoExtension primary 默认接线", () => {
 test("无 worktreeHost：单卡与扇出均经真实工具 execute 使用 primary，managed 工具明确不注册", async () => {
  const wired = await register("single-root");
  expect(wired.tools.has("pao_dispatch_card"), [...wired.tools.keys()].join(",")).toBe(true);
  expect(wired.tools.has("pao_fanout"), [...wired.tools.keys()].join(",")).toBe(true);
  expect(wired.tools.has("pao_integrate_delivery"), [...wired.tools.keys()].join(",")).toBe(true);
  expect(wired.tools.has("pao_worktree_create"), [...wired.tools.keys()].join(",")).toBe(false);

  const firstCard = await addCard(wired.cardsDir, "单卡单根");
  const singleStarted = wired.runner.waitForRun(1);
  const singleNotified = wired.waitForMessage("pao-dispatch-notify", 1);
  const single = await wired.tools.get("pao_dispatch_card")!.execute(
   "single",
   { card_ref: "1", reason: "默认 CLI 单根回归" },
   undefined,
   undefined,
   ctx(wired.root),
  );
  expect(single.isError, JSON.stringify(single)).not.toBe(true);
  const firstSignal = await Promise.race([
   singleStarted.then((options) => ({ kind: "started" as const, options })),
   singleNotified.then(() => ({ kind: "notified" as const })),
  ]);
  if (firstSignal.kind === "notified") {
   const turn = await fireBeforeAgentStart(wired.handlers, wired.root, "单卡启动诊断");
   throw new Error(
    JSON.stringify({
     problem: "单卡在进入 WiringRunner.run 前已产生派发通知",
     tool: single,
     turn,
     messages: wired.messages,
     runs: wired.runner.runs,
    }),
   );
  }
  await singleNotified;
  const turn = await fireBeforeAgentStart(wired.handlers, wired.root, "单卡完成");
  const card = (await import("../../src/pao/cards/cardfile.ts")).readCard(
   firstCard.path,
  );
  const diagnostic = JSON.stringify({
   tool: single,
   turn,
   messages: wired.messages,
   runs: wired.runner.runs,
   card: {
    status: card.frontmatter.status,
    attempt: card.frontmatter.attempt,
    owner: card.frontmatter.owner,
   },
  });
  expect(wired.runner.runs.length, diagnostic).toBeGreaterThanOrEqual(1);
  expect(firstSignal.options).toMatchObject({
   taskRoot: wired.root,
   executionRoot: wired.root,
   cwd: wired.root,
  });
  expect(firstSignal.options).not.toHaveProperty("worktreeId");
  expect(turn.sections["pao-dispatch-notify"], diagnostic).toContain("[派卡完成]");

  await addCard(wired.cardsDir, "扇出单根");
  const fanoutStarted = wired.runner.waitForRun(2);
  const fanout = await wired.tools.get("pao_fanout")!.execute(
   "fanout",
   { card_refs: ["卡#2"], reason: "默认 CLI 扇出回归", background: false },
   undefined,
   undefined,
   ctx(wired.root),
  );
  expect(fanout.isError, JSON.stringify(fanout)).not.toBe(true);
  const fanoutRun = await fanoutStarted;
  expect(wired.runner.runs.length).toBeGreaterThanOrEqual(2);
  expect(fanoutRun).toMatchObject({
   taskRoot: wired.root,
   executionRoot: wired.root,
   cwd: wired.root,
  });
 }, 20_000);

 test("worker 角色无递归/建树/整合/普通改卡，保留侦察保存且可实际执行", async () => {
  const wired = await register("worker", { role: "worker" });
  expect(wired.tools.has("pao_save_dispatch_recon")).toBe(true);
  expect(wired.tools.has("pao_dispatch_card")).toBe(false);
  expect(wired.tools.has("pao_fanout")).toBe(false);
  expect(wired.tools.has("pao_worktree_create")).toBe(false);
  expect(wired.tools.has("pao_integrate_delivery")).toBe(false);
  expect(wired.tools.has("pao_create_card")).toBe(false);
  expect(wired.tools.has("pao_change_status")).toBe(false);
  expect(wired.tools.has("pao_submit_receipt")).toBe(false);

  const card = await addCard(wired.cardsDir, "worker 侦察保存");
  const { readCard, serializeCard } = await import("../../src/pao/cards/cardfile.ts");
  const current = readCard(card.path);
  current.frontmatter.status = "in_progress";
  current.frontmatter.attempt = 1;
  current.frontmatter.owner = "worker-owner";
  writeFileSync(current.path, serializeCard(current.frontmatter, current.body));
  const { bindExecutionContext } = await import("../../src/pao/cards/execution-context.ts");
  await bindExecutionContext(
   {
    key: { cardsDir: wired.cardsDir, cardNo: 1, attempt: 1 },
    projectRoot: wired.root,
    repositoryRoot: wired.root,
    executionRoot: wired.root,
    worktree: {
     kind: "primary",
     taskRoot: wired.root,
     executionRoot: wired.root,
     commonGitDir: "",
     inputVersion: "single-root",
    bindingDigest: `sha256:${"1".repeat(64)}`,
    },
    snapshotRef: join(wired.cardsDir, "..", "输入快照", "worker.json"),
    snapshotDigest: `sha256:${"2".repeat(64)}`,
   },
   { expectedCurrentAttempt: 1 },
  );
  const previous = {
   cards: process.env.PAO_CARDS_DIR,
   card: process.env.PAO_WORKER_CARD,
   attempt: process.env.PAO_WORKER_ATTEMPT,
   owner: process.env.PAO_WORKER_OWNER,
  };
  process.env.PAO_CARDS_DIR = wired.cardsDir;
  process.env.PAO_WORKER_CARD = "卡0001";
  process.env.PAO_WORKER_ATTEMPT = "1";
  process.env.PAO_WORKER_OWNER = "worker-owner";
  try {
   const result = await wired.tools.get("pao_save_dispatch_recon")!.execute(
    "recon",
    {
     id: "worker-recon",
     markdown: "侦察结论正文",
     sections: [{ category: "facts", title: "事实", markdown: "已核实" }],
    },
    undefined,
    undefined,
    ctx(wired.root),
   );
   expect(result.isError, JSON.stringify(result)).not.toBe(true);
   expect(result.content[0].text).toContain("pao-brief");
  } finally {
   if (previous.cards === undefined) delete process.env.PAO_CARDS_DIR; else process.env.PAO_CARDS_DIR = previous.cards;
   if (previous.card === undefined) delete process.env.PAO_WORKER_CARD; else process.env.PAO_WORKER_CARD = previous.card;
   if (previous.attempt === undefined) delete process.env.PAO_WORKER_ATTEMPT; else process.env.PAO_WORKER_ATTEMPT = previous.attempt;
   if (previous.owner === undefined) delete process.env.PAO_WORKER_OWNER; else process.env.PAO_WORKER_OWNER = previous.owner;
  }
 }, 20_000);
});
