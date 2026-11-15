import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import type { PiDesktopApi } from "../../contracts/ipc";
import {
  type PiAppWindow,
  createNamedThread,
  launchDesktop,
  launchPackagedDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  seedAgentDir,
  waitForWorkspaceByPath,
  waitForTimelineLayout,
} from "../helpers/electron-app";
import { selectSessionByTitle as selectSessionAndWait } from "../helpers/session-event-test-helpers";

const execFileAsync = promisify(execFile);
const PROVIDER_ID = "worktree-host-electron-offline";
const MODEL_ID = "offline-scripted";
const THREAD_TITLE = "独立工作目录宿主验收";

interface OfflineProviderSourceOptions {
  readonly modelLogPath: string;
  readonly taskRoot: string;
  readonly cardsDir: string;
  readonly barrierDir: string;
}

interface ScriptResult {
  id: string;
  name: string;
  isError: boolean;
  details?: { binding?: { kind: string; worktreeId: string; executionRoot: string } };
}

// 顺序由唯一调用 ID 确定；任何工具错误都先退出，不能拿失败结果推进下一步。
async function mainStep(
  results: ScriptResult[],
  cardsDir: string,
  readonlyInventory = false,
  waitForFirstWorkerIn?: string,
  listDirectory?: (path: string) => string[],
) {
  const steps = readonlyInventory
    ? [{ id: "worktree-reopen-list", name: "pao_worktree_list", arguments: {} }]
    : [
        {
          id: "worktree-create-main",
          name: "pao_worktree_create",
          arguments: { request_id: "electron-main-a", display_name: "Electron 主目录甲" },
        },
        {
          id: "worktree-create-second",
          name: "pao_worktree_create",
          arguments: { request_id: "electron-main-b", display_name: "Electron 主目录乙" },
        },
        { id: "worktree-list-main", name: "pao_worktree_list", arguments: {} },
        ...["main", "second"].map((suffix, index) => ({
          id: `worktree-dispatch-${suffix}`,
          name: "pao_dispatch_card",
          arguments: {
            card_ref: String(index + 1),
            cards_dir: cardsDir,
            reason: "V08 两张独立预算卡在受管工作树并行写入",
          },
        })),
      ];
  const failed = results.find((result) => result.isError);
  if (failed) throw new Error(`离线脚本工具失败：${failed.id}/${failed.name}`);
  if (new Set(results.map((result) => result.id)).size !== results.length)
    throw new Error("离线脚本收到重复结果 ID");
  for (const [index, result] of results.entries()) {
    if (result.id !== steps[index]?.id || result.name !== steps[index]?.name)
      throw new Error(`离线脚本结果顺序不符：${result.id}/${result.name}`);
  }
  const step = steps[results.length];
  if (!step) return { text: readonlyInventory ? "WORKTREE_REOPEN 完成" : "WORKTREE_TOOLS 完成" };
  if (step.name === "pao_dispatch_card") {
    // 第一张卡派发是后台受理；等它真正启动后再派第二张，避免共享短锁交接窗口
    // 让测试把合法的短暂占用误判成两卡不能并行。两张卡随后仍会在 worker 屏障处重叠。
    if (step.id === "worktree-dispatch-second" && waitForFirstWorkerIn) {
      if (!listDirectory) throw new Error("等待第一张卡启动时缺少目录读取能力");
      const deadline = Date.now() + 60_000;
      let ready: string[] = [];
      while (Date.now() < deadline) {
        ready = listDirectory(waitForFirstWorkerIn).filter((name) => name.endsWith(".ready.json"));
        if (ready.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (ready.length !== 1) throw new Error(`等待第一张卡启动超时或启动数异常：${ready.length}`);
    }
    const created = results[step.id.endsWith("main") ? 0 : 1]?.details?.binding;
    if (created?.kind !== "managed" || !created.worktreeId || !created.executionRoot)
      throw new Error("创建结果缺少受管工作树身份");
    return {
      toolCall: { ...step, arguments: { ...step.arguments, worktree_id: created.worktreeId } },
    };
  }
  return { toolCall: step };
}

const offlineProviderSource = (options: OfflineProviderSourceOptions) => String.raw`
import { appendFileSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

const MODEL_LOG_PATH = ${JSON.stringify(options.modelLogPath)};
const TASK_ROOT = ${JSON.stringify(options.taskRoot)};
const CARDS_DIR = ${JSON.stringify(options.cardsDir)};
const BARRIER_DIR = ${JSON.stringify(options.barrierDir)};
const mainStep = ${mainStep.toString()};
let worker;
const key = (value) => realpathSync(value).replaceAll("\\", "/").toLowerCase();

function publish(path, value) {
  writeFileSync(path + ".pending", JSON.stringify(value), { flag: "wx" });
  renameSync(path + ".pending", path);
}

function text(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

function done(model, value, stream) {
  const message = {
    role: "assistant",
    content: value.toolCall
      ? [{ type: "toolCall", id: value.toolCall.id, name: value.toolCall.name, arguments: value.toolCall.arguments }]
      : [{ type: "text", text: value.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: worker ? worker.cardNo + 10 : 1,
      output: worker ? worker.cardNo + 20 : 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: worker ? 2 * worker.cardNo + 30 : 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: value.toolCall ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  if (!value.toolCall) {
    stream.push({ type: "text_delta", contentIndex: 0, delta: value.text, partial: message });
  }
  stream.push({ type: "done", reason: message.stopReason, message });
  return stream;
}

async function workerStep(context) {
  if (!worker) {
    const mappingDir = join(TASK_ROOT, ".pao", "执行映射");
    const mappings = readdirSync(mappingDir).filter((name) => name.endsWith(".jsonl"))
      .map((name) => JSON.parse(readFileSync(join(mappingDir, name), "utf8").split(/\r?\n/)[0]))
      .filter((entry) => key(entry.executionRoot) === key(process.cwd()));
    if (mappings.length !== 1) throw new Error("worker 必须对应唯一真实执行映射");
    const mapping = mappings[0];
    const match = /^卡(\d+)-/.exec(basename(mapping.卡路径));
    if (!match) throw new Error("执行映射卡号缺失");
    worker = {
      run_id: mapping.执行标识, pid: process.pid, parentPid: process.ppid,
      cwd: process.cwd(), execPath: process.execPath, entryPath: process.argv[1],
      executionRoot: mapping.executionRoot, worktreeId: mapping.worktreeId,
      snapshotDigest: mapping.snapshotDigest, worktreeBindingDigest: mapping.worktreeBindingDigest,
      executionBindingDigest: mapping.executionBindingDigest, taskRoot: mapping.任务根,
      cardPath: mapping.卡路径, attempt: mapping.尝试, cardNo: Number(match[1]), start: Date.now(),
    };
    if (worker.attempt !== 1 || ![1, 2].includes(worker.cardNo) || key(worker.taskRoot) !== key(TASK_ROOT))
      throw new Error("worker 任务身份不符");
    publish(join(BARRIER_DIR, worker.run_id + ".ready.json"), worker);
  }
  const id = "worker-write-" + worker.run_id;
  const results = context.messages.filter((entry) => entry.role === "toolResult");
  const failed = results.find((entry) => entry.isError);
  if (failed) throw new Error("worker 工具失败：" + failed.toolCallId + "/" + text(failed.content));
  const writes = results.filter((entry) => entry.toolCallId === id);
  if (writes.length > 1) throw new Error("worker 写结果重复");
  const marker = "v08-marker-" + worker.cardNo + ".txt";
  if (!writes.length) {
    const deadline = Date.now() + 60_000;
    let peers;
    while (Date.now() < deadline) {
      peers = readdirSync(BARRIER_DIR).filter((name) => name.endsWith(".ready.json"))
        .map((name) => JSON.parse(readFileSync(join(BARRIER_DIR, name), "utf8")));
      if (peers.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (peers?.length !== 2 || new Set(peers.map((peer) => peer.pid)).size !== 2 ||
        new Set(peers.map((peer) => key(peer.executionRoot))).size !== 2)
      throw new Error("双进程文件屏障超时或身份重复");
    worker.peers = peers.map((peer) => peer.run_id).sort();
    worker.barrierReleased = Date.now();
    return { toolCall: { id, name: "write", arguments: { path: marker, content: worker.run_id + "\n" } } };
  }
  if (readFileSync(join(process.cwd(), marker), "utf8") !== worker.run_id + "\n")
    throw new Error("真实 write 工具未写入当前执行根");
  worker.end = Date.now();
  publish(join(BARRIER_DIR, worker.run_id + ".finished.json"), worker);
  return { text: JSON.stringify({ result: "success", artifact_path: [marker], summary: "V08 离线真实写工具完成" }) };
}

export default function worktreeHostElectronOfflineProvider(pi) {
  pi.registerProvider(${JSON.stringify(PROVIDER_ID)}, {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_ZERO_COST",
    api: ${JSON.stringify(PROVIDER_ID)},
    models: [{
      id: ${JSON.stringify(MODEL_ID)},
      name: "Worktree host Electron offline scripted provider",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
      const tools = getCurrentTools(context.messages).map((tool) => tool.name);
      const lastUserIndex = context.messages.findLastIndex((entry) => entry.role === "user");
      const currentText =
        lastUserIndex === -1 ? "" : text(context.messages[lastUserIndex]?.content);
      const current = lastUserIndex === -1 ? [] : context.messages.slice(lastUserIndex + 1);
      const calls = current.flatMap((entry) =>
        entry.role === "assistant" && Array.isArray(entry.content)
          ? entry.content
              .filter((part) => part.type === "toolCall")
              .map((part) => ({
                id: part.id,
                name: part.name,
                arguments: part.arguments,
              }))
          : [],
      );
      const results = current
        .filter((entry) => entry.role === "toolResult")
        .map((entry) => ({
          id: entry.toolCallId,
          name: entry.toolName,
          isError: Boolean(entry.isError),
          text: text(entry.content),
          details: entry.details,
        }));
      const notifications = getCurrentSystemPrompt(context.messages).split("\n")
        .filter((line) => /\[派卡|回执落卡失败/.test(line));
      appendFileSync(MODEL_LOG_PATH, JSON.stringify({
        role: process.env.PAO_ROLE ?? "主控", pid: process.pid,
        currentText,
        tools,
        calls,
        results,
        notifications,
      }) + "\n");

      const failedNotification = notifications.find((body) => /\[派卡(?:失败|被拒)\]|回执落卡失败/.test(body));
      if (failedNotification) throw new Error(failedNotification);

      if (process.env.PAO_ROLE === "worker") return await workerStep(context);
      if (currentText.includes("WORKTREE_REOPEN")) return await mainStep(results, CARDS_DIR, true);
      if (currentText.includes("WORKTREE_TOOLS")) {
        if (calls.length !== results.length) throw new Error("主控工具调用尚无唯一结果");
        return await mainStep(results, CARDS_DIR, false, BARRIER_DIR, readdirSync);
      }
      // 后台通知只确认接收，不能重新建树或派卡。
      return { text: "已接收后台派卡通知。" };
      })().then((value) => done(model, value, stream), (error) => {
        appendFileSync(MODEL_LOG_PATH, JSON.stringify({ role: process.env.PAO_ROLE ?? "主控", pid: process.pid, error: String(error) }) + "\n");
        stream.push({ type: "error", reason: "error", error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error", errorMessage: String(error), timestamp: Date.now(),
        } });
      });
      return stream;
    },
  });
}
`;

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonLines<T = Record<string, unknown>>(path: string): Promise<T[]> {
  const bytes = await readFile(path);
  const content = (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

interface ModelRecord {
  role: string;
  pid: number;
  error?: string;
  tools?: string[];
  calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  results?: Array<ScriptResult & { details?: unknown }>;
}

interface WorkerObservation {
  run_id: string;
  pid: number;
  parentPid: number;
  cwd: string;
  execPath: string;
  entryPath: string;
  taskRoot: string;
  executionRoot: string;
  worktreeId: string;
  snapshotDigest: string;
  worktreeBindingDigest: string;
  executionBindingDigest: string;
  cardPath: string;
  attempt: number;
  cardNo: number;
  start: number;
  barrierReleased: number;
  end: number;
  peers: string[];
}

const V08_TMP = process.env.PI_APP_WORKTREE_TEST_TMP
  ? resolve(process.env.PI_APP_WORKTREE_TEST_TMP)
  : undefined;

function assertWithin(root: string, target: string): void {
  const formalHome = resolve("D:/AI/workspace/pao").toLowerCase();
  const absolute = resolve(target).toLowerCase();
  if (absolute === formalHome || absolute.startsWith(formalHome + sep))
    throw new Error(`测试路径触及正式 PAO_HOME：${target}`);
  const child = relative(resolve(root), resolve(target));
  if (child === ".." || child.startsWith(".." + sep) || isAbsolute(child))
    throw new Error(`测试路径不在隔离根内：${target}`);
}

async function pathKey(path: string): Promise<string> {
  return (await realpath(path)).replaceAll("\\", "/").toLowerCase();
}

async function closeWithEvidence(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  evidencePath: string,
  action: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await action();
  } catch (error) {
    failures.push(error);
    try {
      const window = await harness.firstWindow();
      const state = await window.evaluate(() =>
        (globalThis.window as PiAppWindow).piApp!.getState(),
      );
      await writeFile(
        evidencePath.replace(/\.json$/, "-app-state.json"),
        JSON.stringify(state, null, 2),
      );
      await window.screenshot({ path: evidencePath.replace(/\.json$/, ".png") });
    } catch (captureError) {
      failures.push(captureError);
    }
  }
  try {
    await harness.close();
  } catch (error) {
    failures.push(error);
  }
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        action: failures.length ? "见 errors，不能视为通过" : "通过",
        errors: failures.map((error) => (error instanceof Error ? error.stack : String(error))),
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  if (failures.length)
    throw new AggregateError(failures, "Electron 场景或关闭失败；原始错误全部保留");
}

test("V08 离线脚本顺序与错误停止自检（不启动 Electron）", async () => {
  const results: ScriptResult[] = [];
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const step = (await mainStep(results, "shared-cards")).toolCall;
    expect(step).toBeDefined();
    if (!step) throw new Error("脚本提前完成");
    ids.push(step.id);
    await expect(
      mainStep([...results, { id: step.id, name: step.name, isError: true }], "shared-cards"),
    ).rejects.toThrow("工具失败");
    if (step.name === "pao_dispatch_card")
      expect(step.arguments).toMatchObject({
        cards_dir: "shared-cards",
        worktree_id: index === 3 ? "tree-a" : "tree-b",
      });
    results.push({
      id: step.id,
      name: step.name,
      isError: false,
      ...(index < 2
        ? {
            details: {
              binding: {
                kind: "managed",
                worktreeId: index ? "tree-b" : "tree-a",
                executionRoot: index ? "root-b" : "root-a",
              },
            },
          }
        : {}),
    });
  }
  expect(new Set(ids).size).toBe(5);
  expect(await mainStep(results, "shared-cards")).toEqual({ text: "WORKTREE_TOOLS 完成" });
  await expect(mainStep([results[0]!, results[0]!], "shared-cards")).rejects.toThrow("重复结果");
  await expect(mainStep([results[1]!], "shared-cards")).rejects.toThrow("顺序不符");
  expect((await mainStep([], "shared-cards", true)).toolCall?.name).toBe("pao_worktree_list");
  expect(
    (
      await mainStep(
        [{ id: "worktree-reopen-list", name: "pao_worktree_list", isError: false }],
        "shared-cards",
        true,
      )
    ).text,
  ).toBe("WORKTREE_REOPEN 完成");
  const source = offlineProviderSource({
    modelLogPath: "log",
    taskRoot: "task",
    cardsDir: "cards",
    barrierDir: "barrier",
  });
  // 同时检查真正写给 CLI 的脚本，避免模板里的转义或序列化函数不可执行。
  const generatedStep = new Function(
    source.replace(/^import .*;$/gm, "").replace("export default function", "function") +
      ";return mainStep;",
  )() as typeof mainStep;
  expect(await generatedStep(results, "shared-cards")).toEqual({ text: "WORKTREE_TOOLS 完成" });
  await expect(
    generatedStep(
      [{ id: "worktree-create-main", name: "pao_worktree_create", isError: true }],
      "shared-cards",
    ),
  ).rejects.toThrow("工具失败");
});

test("主进程构建产物不静态 require ESM 内核入口", async () => {
  const mainBundle = await readFile(join(__dirname, "..", "..", "out", "main", "main.js"), "utf8");
  expect(mainBundle).not.toContain('require("@earendil-works/pi-coding-agent/pao")');
  expect(mainBundle).not.toContain('require("@earendil-works/pi-coding-agent/pao/desktop")');
  expect(mainBundle).toContain("loadPaoWorktreeRuntime()");
});

async function selectSessionByTitle(window: Page, title: string): Promise<void> {
  await selectSessionAndWait(window, title);
  await expect(window.locator(".chat-header__title")).toHaveText(title);
  await waitForTimelineLayout(window);
}

async function openThread(window: Page, title: string): Promise<void> {
  await createNamedThread(window, title);
}

async function send(window: Page, text: string): Promise<void> {
  const composer = window.getByTestId("composer");
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

test("真实 Electron 装配并执行工作树工具", async () => {
  test.setTimeout(300_000);
  if (!V08_TMP) throw new Error("启动 Playwright 前须设置 PI_APP_WORKTREE_TEST_TMP 为隔离临时根");
  for (const name of ["TMP", "TEMP", "TMPDIR"]) {
    if (resolve(process.env[name] ?? ".") !== V08_TMP)
      throw new Error(`启动 Playwright 前须设置 ${name}=${V08_TMP}`);
  }
  await mkdir(V08_TMP, { recursive: true });
  // 夹具读写复用开发内核；桌面与 worker 仍经各自真实装配入口加载内核。
  const { createCard, readCard } =
    await import("../../../../../PAO/packages/coding-agent/dist/pao/cards/cardfile.js");
  const { resolveExecutionContext } =
    await import("../../../../../PAO/packages/coding-agent/dist/pao/cards/execution-context.js");
  const root = await makeUserDataDir("pao-worktree-electron-");
  assertWithin(V08_TMP, root);
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  const paoHome = join(root, "pao-home");
  const workspacePath = await makeGitWorkspace("worktree-electron-workspace");
  assertWithin(V08_TMP, workspacePath);
  assertWithin(root, paoHome);
  const cardsDir = join(workspacePath, ".pao", "卡");
  const barrierDir = join(root, "barrier");
  const modelLogPath = join(root, "model-calls.jsonl");
  console.log(`V08 隔离证据根：${root}`);
  await mkdir(userDataDir, { recursive: true });
  await mkdir(join(paoHome, "pao配置"), { recursive: true });
  await mkdir(barrierDir, { recursive: true });
  await mkdir(cardsDir, { recursive: true });
  await writeFile(
    join(paoHome, "pao配置", "档位.json"),
    JSON.stringify({
      provider: "pao",
      档位: [{ 名: "primary", provider: PROVIDER_ID, model: MODEL_ID, thinkingLevel: "off" }],
    }),
  );
  // 测试现场的总额度；两卡各自预算、无 parent，不声称覆盖有限父预算并行。
  await writeFile(
    join(paoHome, "总预算账.json"),
    JSON.stringify({
      version: 1,
      grants: [
        {
          version: 1,
          总预算: 2,
          授权时间: new Date().toISOString(),
          余额依据: { 已花: 0, 授权前总预算: 0 },
          授权人: "V08 离线测试夹具",
        },
      ],
      reservations: [],
    }),
  );
  const cards: Awaited<ReturnType<typeof createCard>>[] = [];
  for (const cardNo of [1, 2]) {
    cards.push(
      await createCard(cardsDir, {
        目标: `写入 v08-marker-${cardNo}.txt`,
        部门: cardNo === 1 ? "测试甲" : "测试乙",
        约束: `只写 v08-marker-${cardNo}.txt；卡与任务状态仍归共享 cardsDir。`,
        验收: `当前执行根的 v08-marker-${cardNo}.txt 含本次真实 run_id。`,
        创建: "2026-10-21 00:00",
        档位: "primary",
        预算: { turns: 4, toolCalls: 2, cost: 1 },
      }),
    );
  }
  await writeFile(join(root, "cards-before.json"), JSON.stringify(cards, null, 2));
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
    "utf8",
  );
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");
  // agentDir 扩展同时由桌面和默认 CLI 子进程加载；不依赖项目目录中的副本。
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "worktree-host-electron-offline.ts"),
    offlineProviderSource({ modelLogPath, taskRoot: workspacePath, cardsDir, barrierDir }),
  );

  const launchImpl = process.env.PI_APP_TEST_RELEASE_DIR ? launchPackagedDesktop : launchDesktop;
  const launch = () =>
    launchImpl(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
      envOverrides: {
        TMP: V08_TMP,
        TEMP: V08_TMP,
        TMPDIR: V08_TMP,
        PAO_HOME: paoHome,
        PAO_ROLE: "主控",
        PAO_DEPT: undefined,
        PAO_DISABLE_BUILTIN_EXTENSION: "0",
        PAO_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_NO_LOCAL_LLM: "1",
      },
    });

  const firstRun = await launch();
  let createdBindings: NonNullable<ScriptResult["details"]>["binding"][] = [];
  await closeWithEvidence(firstRun, join(root, "first-run-and-close.json"), async () => {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await openThread(window, THREAD_TITLE);
    await send(window, "WORKTREE_TOOLS：请创建甲乙两个独立工作目录，盘点后分别派发两张卡。");
    await expect(
      window
        .locator(".timeline-item--assistant")
        .filter({ hasText: "WORKTREE_TOOLS 完成" })
        .first(),
    ).toBeVisible({ timeout: 90_000 });

    const calls = (await readJsonLines<ModelRecord>(modelLogPath)).filter(
      (entry) => entry.role === "主控",
    );
    expect(calls.filter((entry) => entry.error)).toEqual([]);

    // 遍历全部结果并按唯一调用 ID 去重，不能每轮 find 第一个 create。
    // 每次模型请求都携带累计历史，同一次调用会在后续请求中再次被观察到。
    // 按唯一 ID 核对一致性和顺序，单次历史中的重复 ID 仍视为错误。
    const uniqueCalls = new Map<string, NonNullable<ModelRecord["calls"]>[number]>();
    for (const entry of calls) {
      expect(new Set(entry.calls?.map((call) => call.id)).size).toBe(entry.calls?.length ?? 0);
      for (const call of entry.calls ?? []) {
        const previous = uniqueCalls.get(call.id);
        if (previous) expect(call).toEqual(previous);
        else uniqueCalls.set(call.id, call);
      }
    }
    expect([...uniqueCalls.values()].map((call) => call.name)).toEqual([
      "pao_worktree_create",
      "pao_worktree_create",
      "pao_worktree_list",
      "pao_dispatch_card",
      "pao_dispatch_card",
    ]);
    const results = new Map(
      calls.flatMap((entry) => entry.results ?? []).map((row) => [row.id, row]),
    );
    expect([...results.values()].every((row) => !row.isError)).toBe(true);
    expect([...results.keys()]).toEqual([
      "worktree-create-main",
      "worktree-create-second",
      "worktree-list-main",
      "worktree-dispatch-main",
      "worktree-dispatch-second",
    ]);
    createdBindings = ["worktree-create-main", "worktree-create-second"].map(
      (id) => results.get(id)?.details?.binding,
    );
    expect(new Set(createdBindings.map((binding) => binding?.worktreeId)).size).toBe(2);
    const commonDir = await pathKey(
      await git(workspacePath, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    for (const binding of createdBindings) {
      expect(binding?.kind).toBe("managed");
      if (!binding) throw new Error("建树结果缺失");
      assertWithin(userDataDir, binding.executionRoot);
      expect(await pathKey(await git(binding.executionRoot, "rev-parse", "--show-toplevel"))).toBe(
        await pathKey(binding.executionRoot),
      );
      expect(await pathKey(binding.executionRoot)).not.toBe(await pathKey(workspacePath));
      expect(
        await pathKey(
          await git(
            binding.executionRoot,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ),
        ),
      ).toBe(commonDir);
    }
    expect(new Set(createdBindings.map((binding) => binding?.executionRoot)).size).toBe(2);

    await expect
      .poll(
        async () => {
          const records = await readJsonLines<ModelRecord>(modelLogPath);
          const errors = records.filter((entry) => entry.error);
          if (errors.length) throw new Error(JSON.stringify(errors));
          return cards.map((card) => readCard(card.path).receipts.length);
        },
        { timeout: 90_000, message: "等待两个默认 WorkerRunner 子进程真实结算" },
      )
      .toEqual([1, 1]);

    const observations = await Promise.all(
      (await readdir(barrierDir))
        .filter((name) => name.endsWith(".finished.json"))
        .map(
          async (name) =>
            JSON.parse(await readFile(join(barrierDir, name), "utf8")) as WorkerObservation,
        ),
    );
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((row) => row.pid)).size).toBe(2);
    expect(new Set(observations.map((row) => row.run_id)).size).toBe(2);
    const runtimePaths = await firstRun.electronApp.evaluate(({ app }) => ({
      pid: process.pid,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    }));
    await writeFile(join(root, "runtime-paths.json"), JSON.stringify(runtimePaths, null, 2), {
      flag: "wx",
    });
    if (process.env.PI_APP_TEST_RELEASE_DIR) {
      assertWithin(resolve(process.env.PI_APP_TEST_RELEASE_DIR), runtimePaths.appPath);
      assertWithin(resolve(process.env.PI_APP_TEST_RELEASE_DIR), runtimePaths.execPath);
      expect(runtimePaths.appPath).toContain("app.asar");
    }
    const mainPid = runtimePaths.pid;
    expect(calls.every((entry) => entry.pid === mainPid)).toBe(true);
    const runIds = observations.map((row) => row.run_id).sort();
    expect(Math.max(...observations.map((row) => row.start))).toBeLessThan(
      Math.min(...observations.map((row) => row.end)),
    );
    const processAudit = await readJsonLines(join(workspacePath, ".pao", "派发日志.jsonl"));
    const mappings = await readdir(join(workspacePath, ".pao", "执行映射"));
    expect(mappings.filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
    const ledger = (await readJsonLines(join(paoHome, "用量账.jsonl"))).filter(
      (row) => row.角色 === "worker",
    );
    expect(ledger).toHaveLength(2);
    const modelRecords = await readJsonLines<ModelRecord>(modelLogPath);
    expect(modelRecords.filter((row) => row.error)).toEqual([]);
    for (const observation of observations) {
      const card = cards.find((entry) => entry.card_no === observation.cardNo);
      if (!card) throw new Error("子进程对应卡缺失");
      const actual = readCard(card.path);
      expect(actual.frontmatter).toMatchObject({
        status: "in_progress",
        attempt: 1,
        owner: "主控",
        budget: { turns: 4, toolCalls: 2, cost: 1 },
      });
      expect(actual.frontmatter.parent).toBeUndefined();
      expect(actual.receipts).toHaveLength(1);
      const receipt = actual.receipts[0]!;
      expect(receipt).toMatchObject({
        attempt: 1,
        result: "success",
        artifact_path: [`v08-marker-${observation.cardNo}.txt`],
      });
      expect(receipt.archive_flag).toBeUndefined();
      expect(receipt.usage).toMatchObject({
        run_id: observation.run_id,
        input: 2 * (observation.cardNo + 10),
        output: 2 * (observation.cardNo + 20),
        turns: 2,
        toolCalls: 1,
        cost: 0,
        missing_usage_rounds: 0,
      });
      const execution = await resolveExecutionContext({
        cardsDir,
        cardNo: card.card_no,
        attempt: 1,
      });
      expect(execution.worktree.kind).toBe("managed");
      if (execution.worktree.kind !== "managed") throw new Error("执行关联未指向受管工作树");
      expect(observation).toMatchObject({
        parentPid: mainPid,
        execPath: runtimePaths.execPath,
        taskRoot: workspacePath,
        cardPath: card.path,
        attempt: 1,
        executionRoot: execution.executionRoot,
        worktreeId: execution.worktree.worktreeId,
        snapshotDigest: execution.snapshotDigest,
        worktreeBindingDigest: execution.worktree.bindingDigest,
        executionBindingDigest: execution.bindingDigest,
      });
      if (process.env.PI_APP_TEST_RELEASE_DIR) {
        assertWithin(resolve(process.env.PI_APP_TEST_RELEASE_DIR), observation.entryPath);
        expect(observation.entryPath).toContain("app.asar");
      }
      expect(createdBindings[observation.cardNo - 1]?.worktreeId).toBe(observation.worktreeId);
      expect(await pathKey(observation.cwd)).toBe(await pathKey(execution.executionRoot));
      expect(observation.peers).toEqual(runIds);
      expect(observation.barrierReleased).toBeGreaterThanOrEqual(
        Math.max(...observations.map((row) => row.start)),
      );
      expect(observation.end).toBeGreaterThanOrEqual(observation.barrierReleased);
      const marker = `v08-marker-${observation.cardNo}.txt`;
      expect(await readFile(join(execution.executionRoot, marker), "utf8")).toBe(
        observation.run_id + "\n",
      );
      expect(await pathExists(join(workspacePath, marker))).toBe(false);
      expect(
        await pathExists(
          join(execution.executionRoot, `v08-marker-${observation.cardNo === 1 ? 2 : 1}.txt`),
        ),
      ).toBe(false);
      const mapping = await readJsonLines(
        join(workspacePath, ".pao", "执行映射", observation.run_id + ".jsonl"),
      );
      expect(mapping.at(-1)).toMatchObject({
        状态: "success",
        pid: observation.pid,
        exitCode: 0,
        ownerPid: mainPid,
      });
      expect(
        processAudit.filter((row) => row.event === "spawn" && row.执行标识 === observation.run_id),
      ).toHaveLength(1);
      expect(
        processAudit.filter((row) => row.event === "exit" && row.执行标识 === observation.run_id),
      ).toEqual([expect.objectContaining({ pid: observation.pid, 父进程: mainPid, exitCode: 0 })]);
      const evidence = await readJsonLines(receipt.evidence?.[0] ?? "");
      expect(evidence.filter((row) => row.type === "pao_worker_evidence")).toEqual([
        expect.objectContaining({ 执行标识: observation.run_id, exitCode: 0 }),
      ]);
      expect(evidence.filter((row) => row.type === "tool_execution_start")).toEqual([
        expect.objectContaining({ toolName: "write" }),
      ]);
      const nativeMessages = evidence
        .filter((row) => row.type === "message_end")
        .map((row) => row.message as { role: string; usage?: { input: number; output: number } })
        .filter((message) => message.role === "assistant");
      expect(nativeMessages).toHaveLength(2);
      expect(nativeMessages.every((message) => message.usage !== undefined)).toBe(true);
      expect(nativeMessages.reduce((total, message) => total + message.usage!.input, 0)).toBe(
        receipt.usage?.input,
      );
      expect(nativeMessages.reduce((total, message) => total + message.usage!.output, 0)).toBe(
        receipt.usage?.output,
      );
      const workerCalls = modelRecords.filter(
        (row) => row.role === "worker" && row.pid === observation.pid,
      );
      expect(workerCalls).toHaveLength(2);
      expect(workerCalls[0]?.tools).toContain("write");
      expect(workerCalls[0]?.tools).not.toContain("pao_dispatch_card");
      const ownLedger = ledger.filter((row) => row.input === receipt.usage?.input);
      expect(ownLedger).toHaveLength(1);
      expect(ownLedger[0]).toMatchObject({
        input: receipt.usage?.input,
        output: receipt.usage?.output,
        turns: 2,
        cost: 0,
        缺用量轮次: 0,
      });
    }
    await expect
      .poll(
        async () => JSON.parse(await readFile(join(paoHome, "总预算账.json"), "utf8")).reservations,
        { timeout: 10_000 },
      )
      .toEqual(
        expect.arrayContaining(
          [1, 2].map((number) =>
            expect.objectContaining({
              idempotencyKey: `派发:卡000${number}:尝试1`,
              status: "settled",
              预留额: 1,
              已结算费用: 0,
            }),
          ),
        ),
      );
    expect(
      JSON.parse(await readFile(join(paoHome, "总预算账.json"), "utf8")).reservations,
    ).toHaveLength(2);
    await expect
      .poll(
        async () =>
          (await readdir(join(paoHome, "派发状态", "派发名额"))).filter((name) =>
            name.endsWith(".json"),
          ),
        { timeout: 10_000, message: "两个真实 worker 结算后共享名额全部释放" },
      )
      .toEqual([]);
    await writeFile(
      join(root, "v08-observations.json"),
      JSON.stringify(
        { observations, cards: cards.map((card) => readCard(card.path)), ledger },
        null,
        2,
      ),
      { flag: "wx" },
    );

    const state = await window.evaluate(async () => {
      const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
      if (!app) throw new Error("piApp IPC bridge is unavailable");
      return app.getState();
    });
    expect(state.selectedWorkspaceId).toBeTruthy();
  });

  const beforeReopen = await Promise.all(cards.map((card) => readFile(card.path, "utf8")));
  const logBeforeReopen = (await readJsonLines<ModelRecord>(modelLogPath)).length;
  const secondRun = await launch();
  await closeWithEvidence(secondRun, join(root, "reopen-and-close.json"), async () => {
    const window = await secondRun.firstWindow();
    await selectSessionByTitle(window, THREAD_TITLE);
    await send(window, "WORKTREE_REOPEN：重开后只读盘点，不重跑、不清理。");
    await expect(
      window
        .locator(".timeline-item--assistant")
        .filter({ hasText: "WORKTREE_REOPEN 完成" })
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    const records = (await readJsonLines<ModelRecord>(modelLogPath)).slice(logBeforeReopen);
    expect(records.filter((row) => row.error)).toEqual([]);
    const readonlyCalls = new Map(
      records.flatMap((row) => row.calls ?? []).map((row) => [row.id, row]),
    );
    expect([...readonlyCalls.values()]).toEqual([
      { id: "worktree-reopen-list", name: "pao_worktree_list", arguments: {} },
    ]);
    const listed = records
      .flatMap((row) => row.results ?? [])
      .find((row) => row.id === "worktree-reopen-list");
    expect(listed?.isError).toBe(false);
    const inspection = listed?.details as unknown as Array<{
      worktreeId: string;
      executionRoot: string;
      active: boolean | "unknown";
    }>;
    for (const binding of createdBindings) {
      expect(inspection).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            worktreeId: binding?.worktreeId,
            executionRoot: binding?.executionRoot,
            active: false,
          }),
        ]),
      );
    }
    expect(await Promise.all(cards.map((card) => readFile(card.path, "utf8")))).toEqual(
      beforeReopen,
    );
    expect(
      (await readdir(barrierDir)).filter((name) => name.endsWith(".finished.json")),
    ).toHaveLength(2);
  });
});
