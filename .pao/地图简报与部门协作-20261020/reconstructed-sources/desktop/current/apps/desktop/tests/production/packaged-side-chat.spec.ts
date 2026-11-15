import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import type { SideChatSnapshot } from "@pi-gui/session-driver";
import { desktopIpc, type PiDesktopApi, type SideChatRequest } from "../../contracts/ipc";
import {
  type DesktopHarness,
  type PiAppWindow,
  createNamedThread,
  getDesktopState,
  installIpcInvokeControl,
  launchPackagedDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  resolvePackagedAppExecutable,
  seedAgentDir,
  selectSession,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);
const PROVIDER_ID = "packaged-side-chat-offline";
const MODEL_ID = "offline-scripted";
const WORKSPACE_A_TITLE = "发行辅助对话来源甲";
const WORKSPACE_B_TITLE = "发行辅助对话来源乙";
const DEPARTMENT_OWNER_A = "部门切换来源甲";
const DEPARTMENT_OWNER_B = "部门切换来源乙";
const DEPARTMENT_LONG_GOAL =
  "审查一个包含很长的交付路径、执行标识与验收说明的部门任务，用于确认只读详情不会在窄侧栏中产生横向溢出";
const DEPARTMENT_LONG_ACCEPTANCE =
  "执行记录路径 C:\\workspace\\验收\\包含很长目录名称\\用于检查只读部门详情在窄侧栏中完整折行\\交付回执.jsonl 可以读取，且必须在窄侧栏内折行；随后滚动到执行会话并打开工人真实记录。";
const DEPARTMENT_LONG_PATH =
  "C:\\workspace\\验收\\包含很长目录名称\\用于检查只读部门详情在窄侧栏中完整折行\\交付回执.jsonl";
const MAIN_GATE_PROMPT = "PACKAGED_MAIN_GATE";
const SIDE_A_FIRST_QUESTION = "PACKAGED_SIDE_A_FIRST";
const SIDE_A_FOLLOW_UP = "PACKAGED_SIDE_A_FOLLOW_UP";
const SIDE_B_QUESTION = "PACKAGED_SIDE_B_ONLY";
const SIDE_A_FIRST_ANSWER = "离线验收夹具：甲来源第一轮辅助结论。";
const SIDE_A_FOLLOW_UP_ANSWER = "离线验收夹具：甲来源已看到第一轮问答和最新主控完成记录。";
const SIDE_B_ANSWER = "离线验收夹具：乙来源独立回答。";
const OFFLINE_RELEASE_FALLBACK_ANSWER = "离线发行替身没有匹配到当前问题。";
const MAIN_DONE_TEXT = "主控门控已经放开，回答完成。";
const EXISTING_DRAFT = "主对话已有草稿，不能被辅助结论覆盖";

interface OfflineModelCall {
  readonly currentText: string;
  readonly sourceRunning: boolean;
  readonly aFirstSeen: boolean;
  readonly aFirstCount: number;
  readonly bQuestionSeen: boolean;
  readonly mainDoneSeen: boolean;
  readonly toolsQuestionSeen: boolean;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: unknown;
  }[];
  readonly toolResults: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly isError: boolean;
    readonly text: string;
  }[];
}

interface SideChatFixture {
  readonly releaseDir: string;
  readonly expectedExecutablePath: string;
  readonly userDataDir: string;
  readonly agentDir: string;
  readonly paoHome: string;
  readonly gatePath: string;
  readonly modelLogPath: string;
  readonly outsideEvidencePath: string;
  readonly protectedPath: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
  readonly launchOptions: {
    readonly agentDir: string;
    readonly initialWorkspaces: readonly string[];
    readonly scrubProviderEnv: true;
    readonly testMode: "background";
    readonly envOverrides: {
      readonly PAO_HOME: string;
      readonly PAO_DISABLE_BUILTIN_EXTENSION?: string;
    };
  };
}

type SideChatSource = Pick<SideChatRequest, "workspaceId" | "sessionId">;

/**
 * 本地离线供应商。
 *
 * 它不访问网络：baseUrl 指向不可用回环端口，streamSimple 直接返回本地事件流。
 * 真实部分是发行物 Electron、preload/IPC、pi 会话循环、辅助 runtime 和界面交互。
 */
const offlineProviderSource = (options: {
  readonly gatePath: string;
  readonly modelLogPath: string;
  readonly outsideEvidencePath: string;
  readonly protectedPath: string;
}) => String.raw`
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const GATE_PATH = ${JSON.stringify(options.gatePath)};
const MODEL_LOG_PATH = ${JSON.stringify(options.modelLogPath)};
const OUTSIDE_EVIDENCE_PATH = ${JSON.stringify(options.outsideEvidencePath)};
const PROTECTED_PATH = ${JSON.stringify(options.protectedPath)};
const SIDE_A_FIRST_QUESTION = ${JSON.stringify(SIDE_A_FIRST_QUESTION)};
const SIDE_A_FOLLOW_UP = ${JSON.stringify(SIDE_A_FOLLOW_UP)};
const SIDE_B_QUESTION = ${JSON.stringify(SIDE_B_QUESTION)};
const SIDE_A_TOOLS_QUESTION = ${JSON.stringify(SIDE_A_TOOLS_QUESTION)};
const SIDE_A_FIRST_ANSWER = ${JSON.stringify(SIDE_A_FIRST_ANSWER)};
const SIDE_A_FOLLOW_UP_ANSWER = ${JSON.stringify(SIDE_A_FOLLOW_UP_ANSWER)};
const SIDE_B_ANSWER = ${JSON.stringify(SIDE_B_ANSWER)};
const SIDE_A_TOOLS_ANSWER = ${JSON.stringify(SIDE_A_TOOLS_ANSWER)};
const MAIN_GATE_PROMPT = ${JSON.stringify(MAIN_GATE_PROMPT)};
const MAIN_DONE_TEXT = ${JSON.stringify(MAIN_DONE_TEXT)};
const OUTSIDE_READ_TOKEN = ${JSON.stringify(OUTSIDE_READ_TOKEN)};
const WRITE_CONTENT = ${JSON.stringify(WRITE_CONTENT)};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function message(request) {
  return {
    role: "assistant",
    content: request.content,
    api: request.model.api,
    provider: request.model.provider,
    model: request.model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: request.stopReason,
    timestamp: Date.now(),
  };
}

function assistantMessage(model, text) {
  return message({ model, content: [{ type: "text", text }], stopReason: "stop" });
}

function finishedStream(model, text) {
  const message = assistantMessage(model, text);
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

function callTools(model, content) {
  const result = message({ model, content, stopReason: "toolUse" });
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...result, content: [] } });
  stream.push({ type: "done", reason: "toolUse", message: result });
  return stream;
}

export default function packagedSideChatOfflineProvider(pi) {
  pi.registerProvider(${JSON.stringify(PROVIDER_ID)}, {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_ZERO_COST",
    api: ${JSON.stringify(PROVIDER_ID)},
    models: [{
      id: ${JSON.stringify(MODEL_ID)},
      name: "Packaged side chat offline scripted provider",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const lastUser = context.messages.findLastIndex((entry) => entry.role === "user");
      const serialized = JSON.stringify(context.messages);
      const currentText =
        lastUser === -1 ? "" : contentText(context.messages[lastUser]?.content);
      const currentMessages =
        lastUser === -1 ? context.messages : context.messages.slice(lastUser + 1);
      const toolCalls = currentMessages.flatMap((entry) =>
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
      const toolResults = currentMessages
        .filter((entry) => entry.role === "toolResult")
        .map((entry) => ({
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          isError: Boolean(entry.isError),
          text: contentText(entry.content),
        }));

      appendFileSync(
        MODEL_LOG_PATH,
        JSON.stringify({
          currentText,
          sourceRunning: serialized.includes("source_status=running"),
          aFirstSeen: serialized.includes(SIDE_A_FIRST_QUESTION),
          aFirstCount: countOccurrences(serialized, SIDE_A_FIRST_QUESTION),
          bQuestionSeen: serialized.includes(SIDE_B_QUESTION),
          mainDoneSeen: serialized.includes(MAIN_DONE_TEXT),
          toolsQuestionSeen: currentText.includes(SIDE_A_TOOLS_QUESTION),
          toolCalls,
          toolResults,
        }) + "\n",
      );

      // 辅助问题排在前面：来源上下文本身可能包含主控 gate 标记，不能让它劫持当前问题。
      if (currentText.includes(SIDE_A_FOLLOW_UP)) {
        return finishedStream(model, SIDE_A_FOLLOW_UP_ANSWER);
      }
      if (currentText.includes(SIDE_A_FIRST_QUESTION)) {
        return finishedStream(model, SIDE_A_FIRST_ANSWER);
      }
      if (currentText.includes(SIDE_A_TOOLS_QUESTION)) {
        if (toolCalls.length === 0) {
          return callTools(model, [
            {
              type: "toolCall",
              id: "release-side-read",
              name: "read",
              arguments: { path: OUTSIDE_EVIDENCE_PATH },
            },
            {
              type: "toolCall",
              id: "release-side-write",
              name: "write",
              arguments: { path: PROTECTED_PATH, content: WRITE_CONTENT + "\n" },
            },
          ]);
        }
        const readResult = toolResults.find((result) => result.toolCallId === "release-side-read");
        const writeResult = toolResults.find(
          (result) => result.toolCallId === "release-side-write",
        );
        if (
          !readResult?.isError &&
          readResult.text.includes(OUTSIDE_READ_TOKEN) &&
          writeResult?.isError
        ) {
          return finishedStream(model, SIDE_A_TOOLS_ANSWER);
        }
        return finishedStream(model, "发行辅助工具证据不符合预期。");
      }
      if (currentText.includes(SIDE_B_QUESTION)) {
        return finishedStream(model, SIDE_B_ANSWER);
      }
      if (currentText.trim() === MAIN_GATE_PROMPT) {
        const message = assistantMessage(model, MAIN_DONE_TEXT);
        const stream = createAssistantMessageEventStream();
        void (async () => {
          while (!existsSync(GATE_PATH)) await wait(25);
          stream.push({ type: "start", partial: { ...message, content: [] } });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: MAIN_DONE_TEXT,
            partial: message,
          });
          stream.push({ type: "done", reason: "stop", message });
        })();
        return stream;
      }
      return finishedStream(model, "离线发行替身没有匹配到当前问题。");
    },
  });
}
`;

const SIDE_A_TOOLS_QUESTION = "PACKAGED_SIDE_A_TOOLS：读取外部证据并尝试写入受保护文件";
const SIDE_A_TOOLS_ANSWER = "离线验收夹具：发行辅助读取成功，写入已拒绝。";
const OUTSIDE_READ_TOKEN = "PACKAGED_OUTSIDE_READ_EVIDENCE";
const WRITE_CONTENT = "PACKAGED_SIDE_CHAT_MUST_NOT_WRITE";

/**
 * 真实 PAO 内核生成部门计划、卡、控制与执行记录；会话记录本身是模拟 fixture，
 * 不派发工人，也不启动模型。界面选择、getKanban 和 workboard 会话读取都走正式 API。
 */
const departmentFixtureSource = String.raw`
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dist, project, ownerA, ownerB] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(join(dist, name)).href);
const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");

const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "部门切换验收",
  来源会话: ownerA,
  请求ID: "department-switch-a",
  已注册部门: ["审查部", "研发部"],
  步骤: [
    {
      标题: ${JSON.stringify(DEPARTMENT_LONG_GOAL)},
      部门: "审查部",
      要求: "读取甲工人记录",
      验收: ${JSON.stringify(DEPARTMENT_LONG_ACCEPTANCE)},
      人工门: true,
    },
    { 标题: "甲另一部门", 部门: "研发部", 要求: "核对部门切换" },
  ],
  当刻: "2026-10-19 16:00",
});
const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "department-run-a",
  定义版本: 1,
  来源会话: ownerA,
});
await driver.startWorkflow(
  execution.配方,
  {},
  {
    cardsDir: execution.卡目录,
    workspaceDir: execution.工作区,
    ownerSessionId: ownerA,
  },
);
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID,
  定义版本: 1,
  启动请求ID: "department-run-a",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: ownerA,
  受理时刻: "2026-10-19 16:01",
});

const options = {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: ownerA,
};
for (const [step, department] of [["s1", "审查部"], ["s2", "研发部"]]) {
  const minister = "minister-" + step;
  await control.bindMinister(execution.配方, options, step, minister);
  const [ref] = await control.addNodeCards(
    execution.配方,
    options,
    {
      实例: identity.实例,
      节点: step,
      轮次: 1,
      部长会话: minister,
    },
    [{ goal: department + "工人任务", acceptance: "核对记录切换" }],
  );
  const cardNumber = cards.parseCardRef(ref);
  let card = cards.loadCard(execution.卡目录, cardNumber);
  const operator = card.frontmatter.owner ?? minister;
  card = cards.changeCardStatus(card, {
    操作者: operator,
    to: "in_progress",
    时间: "2026-10-19 16:02",
  });
  if (step === "s1") {
    card = cards.changeCardStatus(card, {
      操作者: operator,
      to: "delivered",
      时间: "2026-10-19 16:03",
    });
  }
  await control.endDecomposition(execution.配方, options, {
    实例: identity.实例,
    节点: step,
    轮次: 1,
    部长会话: minister,
  });

  const ministersDir = join(execution.工作区, "部长会话", identity.实例);
  mkdirSync(ministersDir, { recursive: true });
  writeFileSync(
    join(ministersDir, "20261019_" + minister + ".jsonl"),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "模拟部长记录：" + step }],
      },
    }) + "\n",
  );

  const executionId = "department-worker-" + step;
  const mappingDir = join(project, ".pao", "执行映射");
  const sessionDir = join(project, ".pao", "worker会话");
  mkdirSync(mappingDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(mappingDir, executionId + ".jsonl"),
    JSON.stringify({
      执行标识: executionId,
      项目根: project,
      卡路径: card.path,
      尝试: card.frontmatter.attempt,
      状态: step === "s1" ? "成功" : "运行中",
      交付路径: step === "s1" ? ${JSON.stringify(DEPARTMENT_LONG_PATH)} : undefined,
      时间: "2026-10-19T08:04:00Z",
    }) + "\n",
  );
  writeFileSync(
    join(sessionDir, "20261019_" + executionId + ".jsonl"),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "工人记录-" + step + "-唯一标识" }],
      },
    }) + "\n",
  );
}

await plan.createTemporaryPlan({
  项目根: project,
  显示名: "乙主控部门隔离",
  来源会话: ownerB,
  请求ID: "department-switch-b",
  已注册部门: ["研发部"],
  步骤: [{ 标题: "乙主控独立任务", 部门: "研发部", 要求: "不能看见甲记录" }],
});
console.log(JSON.stringify({ planId: created.计划ID, instance: identity.实例 }));
`;

async function requiredReleaseDir(): Promise<string> {
  const configured = process.env.PI_APP_TEST_RELEASE_DIR?.trim();
  if (!configured) {
    throw new Error(
      "PI_APP_TEST_RELEASE_DIR 未设置；发行辅助对话测试不会退回开发目录或旧 release。",
    );
  }
  const releaseDir = isAbsolute(configured) ? resolve(configured) : resolve(configured);
  try {
    await access(releaseDir);
  } catch (error) {
    throw new Error(`指定的最终发行目录不可访问：${releaseDir}`, { cause: error });
  }
  return releaseDir;
}

async function prepareSideChatFixture(options: {
  readonly prefix: string;
  readonly workspaceName: string;
  readonly builtinPaoTools?: boolean;
}): Promise<SideChatFixture> {
  const releaseDir = await requiredReleaseDir();
  const expectedExecutablePath = await resolvePackagedAppExecutable(releaseDir);
  const userDataDir = await makeUserDataDir(options.prefix);
  const agentDir = join(userDataDir, "agent");
  const paoHome = join(userDataDir, "pao-home");
  const gatePath = join(userDataDir, "release-main-gate");
  const modelLogPath = join(userDataDir, "offline-model-calls.jsonl");
  const workspaceA = await makeGitWorkspace(options.workspaceName);
  const workspaceB = await makeGitWorkspace(`${options.workspaceName}-b`);
  const outsideEvidencePath = join(userDataDir, "packaged-source-attachment.txt");
  const protectedPath = join(workspaceA, "must-not-change.txt");

  await mkdir(paoHome, { recursive: true });
  await writeFile(outsideEvidencePath, OUTSIDE_READ_TOKEN, "utf8");
  await writeFile(protectedPath, "PACKAGED_ORIGINAL_PROTECTED_CONTENT\n", "utf8");
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
  const providerSource = offlineProviderSource({
    gatePath,
    modelLogPath,
    outsideEvidencePath,
    protectedPath,
  });
  await writeProjectExtension(workspaceA, "packaged-side-chat-offline.ts", providerSource);
  await writeProjectExtension(workspaceB, "packaged-side-chat-offline.ts", providerSource);
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  const envOverrides = {
    PAO_HOME: paoHome,
    ...(options.builtinPaoTools ? { PAO_DISABLE_BUILTIN_EXTENSION: "0" } : {}),
  };
  return {
    releaseDir,
    expectedExecutablePath,
    userDataDir,
    agentDir,
    paoHome,
    gatePath,
    modelLogPath,
    outsideEvidencePath,
    protectedPath,
    workspaceA,
    workspaceB,
    launchOptions: {
      agentDir,
      initialWorkspaces: [workspaceA, workspaceB],
      scrubProviderEnv: true,
      testMode: "background",
      envOverrides,
    },
  };
}

async function selectedSource(window: Page): Promise<SideChatSource> {
  return window.evaluate(async () => {
    const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
    if (!app) throw new Error("piApp IPC bridge is unavailable");
    const state = await app.getState();
    if (!state.selectedWorkspaceId || !state.selectedSessionId) {
      throw new Error("没有选中的来源主会话");
    }
    return {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    };
  });
}

async function openSideChat(window: Page, options: { readonly waitUntilLoaded?: boolean } = {}) {
  const panel = window.getByTestId("side-chat-panel");
  if (await panel.isVisible().catch(() => false)) {
    if (options.waitUntilLoaded !== false) {
      await expect(panel).toHaveAttribute("aria-busy", "false");
    }
    return panel;
  }

  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible().catch(() => false))) {
    await window.getByRole("button", { name: /显示\/隐藏侧面板|Toggle side panel/ }).click();
  }
  await expect(workbench).toBeVisible();

  const tab = workbench.getByRole("tab", { name: "辅助对话", exact: true });
  if (await tab.count()) {
    await tab.click();
  } else {
    await window.getByTestId("workbench-add-tab").click();
    const chooser = window.getByTestId("workbench-chooser");
    await expect(chooser).toBeVisible();
    await chooser.getByRole("button", { name: "辅助对话", exact: true }).click();
  }

  await expect(panel).toBeVisible();
  if (options.waitUntilLoaded !== false) {
    await expect(panel).toHaveAttribute("aria-busy", "false");
  }
  return panel;
}

async function expectPackagedRelease(
  harness: DesktopHarness,
  releaseDir: string,
  expectedExecutablePath: string,
) {
  const artifact = await harness.electronApp.evaluate(({ app }) => ({
    appPath: app.getAppPath(),
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    defaultApp: Boolean(process.defaultApp),
    resourcesPath: process.resourcesPath,
  }));
  expect(artifact.execPath).toBe(expectedExecutablePath);
  expect(artifact.isPackaged).toBe(true);
  expect(artifact.defaultApp).toBe(false);
  expect(artifact.appPath).toMatch(/[/\\]app\.asar$/);
  expect(artifact.appPath.startsWith(`${releaseDir}${sep}`)).toBe(true);
  expect(artifact.resourcesPath.startsWith(`${releaseDir}${sep}`)).toBe(true);
}

async function askSideChat(
  panel: ReturnType<Page["getByTestId"]>,
  question: string,
  expectedAnswer: string,
) {
  const input = await waitForSideChatComposer(panel);
  await input.fill(question);
  await panel.getByRole("button", { name: "发送", exact: true }).click();
  await expect(panel.locator('.side-chat__message[data-role="user"]').last()).toContainText(
    question,
  );
  const answer = panel.locator('.side-chat__message[data-role="assistant"]').last();
  await expect(answer).toContainText(expectedAnswer);
  await expect(answer).toHaveAttribute("data-status", "complete");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  return answer;
}

async function waitForSideChatComposer(
  panel: ReturnType<Page["getByTestId"]>,
): Promise<ReturnType<Page["getByLabel"]>> {
  const input = panel.getByLabel("继续这个只读问答");
  await expect(input).toBeEnabled({ timeout: 30_000 });
  return input;
}

async function chooseAnswerText(
  panel: ReturnType<Page["getByTestId"]>,
  answer: ReturnType<Page["locator"]>,
) {
  await answer.evaluate((element) => {
    const content = element.querySelector(".message__content") ?? element;
    const selection = globalThis.window.getSelection();
    if (!selection) throw new Error("浏览器 Selection 不可用");
    const range = document.createRange();
    range.selectNodeContents(content);
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        view: globalThis.window,
      }),
    );
  });
  const draftButton = panel.getByRole("button", {
    name: "带入主对话草稿",
    exact: true,
  });
  await expect(draftButton).toBeEnabled();
  return draftButton;
}

async function modelCalls(logPath: string): Promise<readonly OfflineModelCall[]> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OfflineModelCall);
}

async function expectSessionStatus(
  window: Page,
  source: SideChatSource,
  status: "idle" | "running" | "failed" | "stopping",
) {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      return state.workspaces
        .find((workspace) => workspace.id === source.workspaceId)
        ?.sessions.find((session) => session.id === source.sessionId)?.status;
    })
    .toBe(status);
}

async function gitSnapshot(workspacePath: string): Promise<string> {
  const run = async (...args: string[]) =>
    (await execFileAsync("git", ["-C", workspacePath, ...args])).stdout;
  return [
    await run("rev-parse", "HEAD"),
    await run("status", "--porcelain=v1"),
    await run("diff", "--no-ext-diff", "--binary"),
  ].join("\n");
}

async function installSlowSideChatRead(harness: DesktopHarness, snapshot: SideChatSnapshot) {
  await installIpcInvokeControl(harness, desktopIpc.getSideChat, {
    mode: "replace",
  });
  await harness.electronApp.evaluate(
    async ({}, payload) => {
      type Control = {
        invokeCount: number;
        replacement?: unknown;
      };
      const store = globalThis as typeof globalThis & {
        __PI_TEST_IPC_INVOKE_CONTROL__?: Record<string, Control>;
      };
      const control = store.__PI_TEST_IPC_INVOKE_CONTROL__?.[payload.channel];
      if (!control) throw new Error("slow side-chat IPC control was not installed");

      let resolveFirst!: () => void;
      const first = new Promise<unknown>((resolve) => {
        resolveFirst = () => resolve(payload.snapshot);
      });
      control.replacement = first.then((value) => {
        control.replacement = Promise.resolve(payload.snapshot);
        return value;
      });
      (
        globalThis as typeof globalThis & { __P5_RELEASE_FIRST_READ__?: () => void }
      ).__P5_RELEASE_FIRST_READ__ = resolveFirst;
    },
    { channel: desktopIpc.getSideChat, snapshot },
  );

  // 仅“首个显式读取延迟 + 虚拟时间”是 UI 模拟。Electron 页面、正式 preload/IPC、
  // 第二个真实 handler 调用和辅助面板请求管理均未替换。
  return snapshot;
}

async function sideChatControlSnapshot(
  harness: DesktopHarness,
): Promise<{ readonly mode: string; readonly invokeCount: number }> {
  return harness.electronApp.evaluate(({}, channel) => {
    type Control = {
      mode: string;
      invokeCount: number;
      rejectCount: number;
      sentinel: string;
    };
    const store = globalThis as typeof globalThis & {
      __PI_TEST_IPC_INVOKE_CONTROL__?: Record<string, Control>;
    };
    const control = store.__PI_TEST_IPC_INVOKE_CONTROL__?.[channel];
    if (!control) throw new Error("side-chat IPC control was not installed");
    return {
      mode: control.mode,
      invokeCount: control.invokeCount,
    };
  }, desktopIpc.getSideChat);
}

async function releaseSlowSideChatRead(harness: DesktopHarness) {
  await harness.electronApp.evaluate(() => {
    const global = globalThis as typeof globalThis & {
      __P5_RELEASE_FIRST_READ__?: () => void;
    };
    if (!global.__P5_RELEASE_FIRST_READ__) {
      throw new Error("slow side-chat read has no pending first request");
    }
    global.__P5_RELEASE_FIRST_READ__();
    delete global.__P5_RELEASE_FIRST_READ__;
  });
}

/**
 * 在真实 UI 内先读甲部门工人记录，再切到同主控另一部门、另一主控。
 * 部门数据由内核 fixture 生成，会话正文是模拟记录；点击和 API 读取是真实入口。
 */
async function openDepartmentWorker(window: Page, panel: ReturnType<Page["getByTestId"]>) {
  const worker = panel.getByRole("button", { name: /工人 1.*查看会话/ }).first();
  await expect(worker).toBeEnabled();
  await worker.click();
  const session = window.getByTestId("workboard-session");
  await expect(session).toBeVisible();
  await expect(session.getByText("工人记录-s1-唯一标识", { exact: true })).toBeVisible();
  return session;
}

test("最终发行物 V08/V13：辅助问答与主控并行、连续记录和来源隔离", async ({}, testInfo) => {
  test.skip(process.platform !== "win32", "最终发行验收目标是 Windows 发行物");
  test.setTimeout(180_000);

  const fixture = await prepareSideChatFixture({
    prefix: "pao-packaged-side-chat-v08-",
    workspaceName: "packaged-side-chat-a",
  });
  const {
    releaseDir,
    expectedExecutablePath,
    userDataDir,
    gatePath,
    modelLogPath,
    protectedPath,
    workspaceA,
  } = fixture;
  const workspaceB = fixture.workspaceB;
  let harness: DesktopHarness | undefined;

  try {
    harness = await launchPackagedDesktop(userDataDir, fixture.launchOptions);
    let window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspaceA);
    await waitForWorkspaceByPath(window, workspaceB);

    await expectPackagedRelease(harness, releaseDir, expectedExecutablePath);

    await createNamedThread(window, WORKSPACE_A_TITLE, {
      workspaceName: basename(workspaceA),
    });
    const sourceA = await selectedSource(window);
    let composer = window.getByTestId("composer");
    await composer.fill(MAIN_GATE_PROMPT);
    await composer.press("Enter");
    await expectSessionStatus(window, sourceA, "running");

    // 主控停在真实 stream 中时，辅助 runtime 由同一正式 UI 和 IPC 发问并独立完成。
    let panel = await openSideChat(window);
    await expect(panel).toHaveAttribute("data-source-session", sourceA.sessionId);
    await expect(panel).toContainText("运行中（可以继续提问）");
    await askSideChat(panel, SIDE_A_FIRST_QUESTION, SIDE_A_FIRST_ANSWER);
    await expect(panel).toContainText("主对话仍在运行；");
    await expect(panel).toContainText("不包含尚未结束的模型输出或工具结果");
    await window.screenshot({
      path: testInfo.outputPath("V08-V13-离线夹具-运行中回答与同步限制.png"),
      animations: "disabled",
    });

    // 真实窗口缩到任务要求的矮窗边界；问答仍走当前包的正式 preload/IPC 与离线供应商。
    const originalContentBounds = await harness.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("发行物窗口不存在");
      return window.getContentBounds();
    });
    await window.setViewportSize({ width: 900, height: 520 });
    await expect(panel).toBeVisible();
    await expect
      .poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true);

    const compactInput = window.getByLabel("继续这个只读问答");
    await compactInput.scrollIntoViewIfNeeded();
    await expect(compactInput).toBeVisible();
    await expect(compactInput).toBeInViewport();
    await compactInput.focus();
    await expect(compactInput).toBeFocused();
    await compactInput.fill("PACKAGED_SIDE_900X520");
    const compactSend = panel.getByRole("button", { name: "发送", exact: true });
    await compactSend.scrollIntoViewIfNeeded();
    await expect(compactSend).toBeVisible();
    await expect(compactSend).toBeInViewport();
    await expect(compactSend).toBeEnabled();

    // 离线替身立即返回固定文本，不连接真实供应商；这里同时证明矮窗发送按钮可实际点击。
    await compactSend.click();
    await expect(panel.locator('.side-chat__message[data-role="user"]').last()).toContainText(
      "PACKAGED_SIDE_900X520",
    );
    await expect(panel.locator('.side-chat__message[data-role="assistant"]').last()).toContainText(
      OFFLINE_RELEASE_FALLBACK_ANSWER,
    );
    await expect(panel).toHaveAttribute("aria-busy", "false");

    const compactHeader = panel.getByRole("heading", { name: "辅助对话", exact: true });
    await compactHeader.scrollIntoViewIfNeeded();
    await expect(compactHeader).toBeInViewport();
    await compactInput.scrollIntoViewIfNeeded();
    await expect(compactInput).toBeInViewport();
    await window.screenshot({
      path: testInfo.outputPath("V08-V13-900x520-离线夹具-输入发送与头部可达.png"),
    });
    await harness.electronApp.evaluate(({ BrowserWindow }, bounds) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("发行物窗口不存在");
      window.setContentSize(bounds.width, bounds.height);
    }, originalContentBounds);
    await window.setViewportSize({
      width: originalContentBounds.width,
      height: originalContentBounds.height,
    });
    await expect
      .poll(() => window.evaluate(() => globalThis.innerWidth))
      .toBeGreaterThanOrEqual(originalContentBounds.width - 1);
    await expect(panel).toBeVisible();

    const stateWhileMainRunning = await getDesktopState(window);
    const runningSession = stateWhileMainRunning.workspaces
      .find((workspace) => workspace.id === sourceA.workspaceId)
      ?.sessions.find((session) => session.id === sourceA.sessionId);
    expect(runningSession?.status).toBe("running");
    expect(runningSession?.cancellationRequested).not.toBe(true);

    await writeFile(gatePath, "release main gate\n", "utf8");
    await expect(window.getByTestId("transcript")).toContainText(MAIN_DONE_TEXT);
    await expectSessionStatus(window, sourceA, "idle");

    await createNamedThread(window, WORKSPACE_B_TITLE, {
      workspaceName: basename(workspaceB),
    });
    const sourceB = await selectedSource(window);
    expect(sourceB.workspaceId).not.toBe(sourceA.workspaceId);
    panel = await openSideChat(window);
    await expect(panel).toHaveAttribute("data-source-session", sourceB.sessionId);
    await expect(panel.locator(".side-chat__message")).toHaveCount(0);
    await askSideChat(panel, SIDE_B_QUESTION, SIDE_B_ANSWER);
    await expect(panel).not.toContainText(SIDE_A_FIRST_QUESTION);
    await expect(panel).not.toContainText(SIDE_A_FIRST_ANSWER);

    await selectSession(window, WORKSPACE_A_TITLE);
    await expect
      .poll(async () => (await getDesktopState(window)).selectedSessionId)
      .toBe(sourceA.sessionId);
    panel = await openSideChat(window);
    await expect(panel).toHaveAttribute("data-source-session", sourceA.sessionId);
    await expect(panel).toContainText(SIDE_A_FIRST_QUESTION);
    await expect(panel).toContainText(SIDE_A_FIRST_ANSWER);
    await expect(panel).not.toContainText(SIDE_B_QUESTION);
    await expect(panel).not.toContainText(SIDE_B_ANSWER);
    const gitBeforeTools = await gitSnapshot(workspaceA);
    await askSideChat(panel, SIDE_A_TOOLS_QUESTION, SIDE_A_TOOLS_ANSWER);
    expect(await readFile(protectedPath, "utf8")).toBe("PACKAGED_ORIGINAL_PROTECTED_CONTENT\n");
    expect(await gitSnapshot(workspaceA)).toBe(gitBeforeTools);
    const followUpAnswer = await askSideChat(panel, SIDE_A_FOLLOW_UP, SIDE_A_FOLLOW_UP_ANSWER);

    const calls = await modelCalls(modelLogPath);
    const firstAuxCall = calls.find((call) => call.currentText.includes(SIDE_A_FIRST_QUESTION));
    expect(firstAuxCall, "辅助问答必须真实进入来源模型 runtime").toMatchObject({
      sourceRunning: true,
      aFirstCount: 1,
      bQuestionSeen: false,
    });
    const followUpCall = calls.find((call) => call.currentText.includes(SIDE_A_FOLLOW_UP));
    expect(followUpCall, "后续辅助问答应继承自身历史和最新主控材料").toMatchObject({
      aFirstSeen: true,
      aFirstCount: 1,
      bQuestionSeen: false,
      mainDoneSeen: true,
    });
    const sourceBCall = calls.find((call) => call.currentText.includes(SIDE_B_QUESTION));
    expect(sourceBCall, "乙来源辅助问答必须真实执行").toMatchObject({
      aFirstSeen: false,
      bQuestionSeen: true,
    });
    const toolsCall = calls.find(
      (call) =>
        call.toolsQuestionSeen &&
        call.toolResults.some((result) => result.toolCallId === "release-side-read"),
    );
    expect(toolsCall, "发行物辅助 runtime 必须真实执行工具调用").toBeDefined();
    expect(
      toolsCall?.toolResults.find((result) => result.toolCallId === "release-side-read"),
    ).toMatchObject({
      toolName: "read",
      isError: false,
    });
    expect(
      toolsCall?.toolResults
        .find((result) => result.toolCallId === "release-side-read")
        ?.text.includes(OUTSIDE_READ_TOKEN),
    ).toBe(true);
    expect(
      toolsCall?.toolResults.find((result) => result.toolCallId === "release-side-write"),
    ).toMatchObject({
      toolName: "write",
      isError: true,
    });

    expect(await composer.inputValue()).toBe("");
    const draftButton = await chooseAnswerText(panel, followUpAnswer);
    await draftButton.click();
    await expect(
      panel.getByText("已填入来源主对话草稿，尚未发送。", { exact: true }),
    ).toBeVisible();
    await expect(composer).toHaveValue(SIDE_A_FOLLOW_UP_ANSWER);
    await window.screenshot({
      path: testInfo.outputPath("V10-V13-离线夹具-选中文本带回草稿.png"),
      animations: "disabled",
    });
    await expect(window.getByTestId("transcript").getByText(SIDE_A_FOLLOW_UP_ANSWER)).toHaveCount(
      0,
    );
    await expectSessionStatus(window, sourceA, "idle");

    await composer.fill(EXISTING_DRAFT);
    await chooseAnswerText(panel, followUpAnswer);
    await draftButton.click();
    await expect(
      panel.getByText("来源主对话已有草稿，未覆盖；请先手动处理现有内容。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(composer).toHaveValue(EXISTING_DRAFT);
  } finally {
    // 测试中途失败时也放开离线流，避免让主控永久停在 running 后拖住退出。
    await writeFile(gatePath, "cleanup main gate\n", "utf8").catch(() => undefined);
    await harness?.close();
  }
});

test.describe("发行物辅助对话 UI 模拟与真实 API fixture", () => {
  test.skip(process.platform !== "win32", "最终发行验收目标是 Windows 发行物");
  test.setTimeout(120_000);

  test("V04 慢显式 get 跨越 30 秒后可结束 loading 并显示恢复记录", async ({}, testInfo) => {
    const fixture = await prepareSideChatFixture({
      prefix: "pao-packaged-side-chat-slow-read-",
      workspaceName: "packaged-side-chat-slow-read",
    });
    const {
      releaseDir,
      expectedExecutablePath,
      userDataDir,
      workspaceA: workspacePath,
      workspaceB: workspacePathB,
    } = fixture;
    const promptA = "PACKAGED_SLOW_READ_RECOVERY_SOURCE_A";
    const promptB = "PACKAGED_SLOW_READ_RECOVERY_SOURCE_B";
    const harness = await launchPackagedDesktop(userDataDir, fixture.launchOptions);
    try {
      const window = await harness.firstWindow();
      await waitForWorkspaceByPath(window, workspacePath);
      await waitForWorkspaceByPath(window, workspacePathB);
      await expectPackagedRelease(harness, releaseDir, expectedExecutablePath);
      await createNamedThread(window, "慢读取记录来源甲", {
        workspaceName: basename(workspacePath),
      });
      const sourceA = await selectedSource(window);

      // 两个来源各通过正式 IPC 建立一条记录。
      await window.evaluate(
        async ({ target, text }) => {
          const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
          if (!app) throw new Error("piApp IPC bridge is unavailable");
          return app.sendSideChatMessage({ ...target, text });
        },
        { target: sourceA, text: promptA },
      );
      await createNamedThread(window, "慢读取记录来源乙", {
        workspaceName: basename(workspacePathB),
      });
      const sourceB = await selectedSource(window);
      await window.evaluate(
        async ({ target, text }) => {
          const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
          if (!app) throw new Error("piApp IPC bridge is unavailable");
          return app.sendSideChatMessage({ ...target, text });
        },
        { target: sourceB, text: promptB },
      );

      // 正式 IPC 只允许读取当前选中来源；读取前再从宿主取得此刻真实选中的来源。
      const selected = await selectedSource(window);
      const snapshot = await window.evaluate(async (target) => {
        const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
        if (!app) throw new Error("piApp IPC bridge is unavailable");
        return app.getSideChat(target);
      }, selected);
      expect(snapshot.source).toMatchObject(selected);
      expect(snapshot.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", text: promptB, status: "complete" }),
          expect.objectContaining({
            role: "assistant",
            text: OFFLINE_RELEASE_FALLBACK_ANSWER,
            status: "complete",
          }),
        ]),
      );

      // 回到甲的已加载面板后安装慢读，再通过正常 sidebar click 切到乙。
      await selectSession(window, "慢读取记录来源甲");
      let panel = await openSideChat(window);
      await expect(panel).toContainText(promptA);
      await expect(panel).not.toContainText(promptB);

      await installSlowSideChatRead(harness, snapshot);
      await selectSession(window, "慢读取记录来源乙");
      panel = await openSideChat(window, { waitUntilLoaded: false });
      await expect(panel).toHaveAttribute("data-source-session", sourceB.sessionId);
      await expect.poll(async () => (await sideChatControlSnapshot(harness)).invokeCount).toBe(1);
      const loadingText = panel.getByText("正在读取独立问答记录…", { exact: true });
      const syncingButton = panel.getByRole("button", { name: "正在同步…", exact: true });
      await expect(loadingText).toBeVisible();
      await expect(syncingButton).toBeDisabled();
      // 延迟由真实 IPC control 提供；真实等待跨过 30 秒，验证后台轮询不能结束显式 loading。
      await new Promise((resolve) => setTimeout(resolve, 30_100));
      await expect(loadingText).toBeVisible();
      await expect(syncingButton).toBeDisabled();
      expect(await sideChatControlSnapshot(harness)).toEqual({
        mode: "replace",
        invokeCount: 1,
      });

      await releaseSlowSideChatRead(harness);
      await expect(loadingText).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "同步进展", exact: true })).toBeEnabled();
      await waitForSideChatComposer(panel);
      await expect(panel).toContainText(promptB);
      await expect(panel).toContainText(OFFLINE_RELEASE_FALLBACK_ANSWER);
      await expect(panel).not.toContainText(promptA);
      await expect(panel.getByText("还没有辅助问答。", { exact: false })).toHaveCount(0);
      await window.screenshot({
        path: testInfo.outputPath("V04-慢读取恢复.png"),
        animations: "disabled",
      });
    } finally {
      await harness.close();
    }
  });

  test("V04 发行物关闭重开恢复各来源辅助记录", async ({}, testInfo) => {
    const fixture = await prepareSideChatFixture({
      prefix: "pao-packaged-fresh-recovery-",
      workspaceName: "packaged-fresh-recovery-a",
    });
    const { releaseDir, expectedExecutablePath, userDataDir, gatePath, protectedPath, workspaceA } =
      fixture;
    const workspaceB = fixture.workspaceB;
    let harness: DesktopHarness | undefined;
    try {
      harness = await launchPackagedDesktop(userDataDir, fixture.launchOptions);
      let window = await harness.firstWindow();
      await waitForWorkspaceByPath(window, workspaceA);
      await waitForWorkspaceByPath(window, workspaceB);
      await expectPackagedRelease(harness, releaseDir, expectedExecutablePath);

      await createNamedThread(window, WORKSPACE_A_TITLE, {
        workspaceName: basename(workspaceA),
      });
      const sourceA = await selectedSource(window);
      let panel = await openSideChat(window);
      await askSideChat(panel, SIDE_A_FIRST_QUESTION, SIDE_A_FIRST_ANSWER);

      await createNamedThread(window, WORKSPACE_B_TITLE, {
        workspaceName: basename(workspaceB),
      });
      const sourceB = await selectedSource(window);
      panel = await openSideChat(window);
      await askSideChat(panel, SIDE_B_QUESTION, SIDE_B_ANSWER);

      await panel.getByLabel("继续这个只读问答").fill("待恢复的辅助草稿");
      await window.screenshot({
        path: testInfo.outputPath("关闭前-乙来源离线记录.png"),
        animations: "disabled",
      });
      const gitBefore = await gitSnapshot(workspaceA);
      expect(await readFile(protectedPath, "utf8")).toBe("PACKAGED_ORIGINAL_PROTECTED_CONTENT\n");

      await harness.close();
      harness = await launchPackagedDesktop(userDataDir, fixture.launchOptions);
      window = await harness.firstWindow();
      await waitForWorkspaceByPath(window, workspaceA);
      await waitForWorkspaceByPath(window, workspaceB);
      await expectPackagedRelease(harness, releaseDir, expectedExecutablePath);

      await selectSession(window, WORKSPACE_A_TITLE);
      panel = await openSideChat(window);
      await expect(panel).toHaveAttribute("data-source-session", sourceA.sessionId);
      await expect(panel).toContainText(SIDE_A_FIRST_QUESTION);
      await expect(panel).toContainText(SIDE_A_FIRST_ANSWER);
      await expect(panel).not.toContainText(SIDE_B_QUESTION);
      await expect(panel).not.toContainText(SIDE_B_ANSWER);

      await selectSession(window, WORKSPACE_B_TITLE);
      panel = await openSideChat(window);
      await expect(panel).toHaveAttribute("data-source-session", sourceB.sessionId);
      await expect(panel).toContainText(SIDE_B_QUESTION);
      await expect(panel).toContainText(SIDE_B_ANSWER);
      await expect(panel).not.toContainText(SIDE_A_FIRST_QUESTION);
      await expect(panel).not.toContainText(SIDE_A_FOLLOW_UP_ANSWER);

      expect(await gitSnapshot(workspaceA)).toBe(gitBefore);
      expect(await readFile(protectedPath, "utf8")).toBe("PACKAGED_ORIGINAL_PROTECTED_CONTENT\n");
      await window.screenshot({
        path: testInfo.outputPath("重开后-乙来源恢复.png"),
        animations: "disabled",
      });
    } finally {
      await harness?.close();
      await writeFile(gatePath, "cleanup main gate\n", "utf8").catch(() => undefined);
    }
  });

  /**
   * 部门计划、卡、控制与执行映射由真实内核生成；工人/部长会话正文是确定性 fixture。
   * 刷新、部门卡、工人会话、返回和主控切换全部通过发行物页面正常入口点击。
   */
  test("V04 已读甲部门工人切乙部门或乙主控后不残留甲记录", async ({}, testInfo) => {
    const fixture = await prepareSideChatFixture({
      prefix: "pao-packaged-department-switch-",
      workspaceName: "packaged-department-switch",
    });
    const {
      releaseDir,
      expectedExecutablePath,
      userDataDir,
      paoHome,
      workspaceA: workspacePath,
    } = fixture;
    const harness = await launchPackagedDesktop(userDataDir, fixture.launchOptions);
    try {
      const window = await harness.firstWindow();
      await waitForWorkspaceByPath(window, workspacePath);
      await expectPackagedRelease(harness, releaseDir, expectedExecutablePath);

      await createNamedThread(window, DEPARTMENT_OWNER_A, {
        workspaceName: basename(workspacePath),
      });
      const ownerA = await selectedSource(window);
      const expectedProject = (await getDesktopState(window)).workspaces.find(
        (workspace) => workspace.path === workspacePath,
      );
      if (!expectedProject) throw new Error("隔离 fixture 的甲项目不在宿主状态中");
      expect(ownerA.workspaceId).toBe(expectedProject.id);

      await createNamedThread(window, DEPARTMENT_OWNER_B, {
        workspaceName: basename(workspacePath),
      });
      const ownerB = await selectedSource(window);
      expect(ownerB.sessionId).not.toBe(ownerA.sessionId);
      expect(ownerB.workspaceId).toBe(expectedProject.id);
      await mkdir(join(paoHome, "部门"), { recursive: true });
      const fixtureScript = join(userDataDir, "package-department-fixture.mjs");
      await writeFile(fixtureScript, departmentFixtureSource, "utf8");
      const fixtureRun = await execFileAsync(
        process.execPath,
        [
          fixtureScript,
          join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao"),
          workspacePath,
          ownerA.sessionId,
          ownerB.sessionId,
        ],
        {
          windowsHide: true,
          env: { ...process.env, PAO_HOME: paoHome },
        },
      );
      const fixtureIdentity = JSON.parse(fixtureRun.stdout.trim()) as {
        readonly planId: string;
      };
      const planDefinition = await readFile(
        join(workspacePath, ".pao", "临时工作流", fixtureIdentity.planId, "计划.md"),
        "utf8",
      );
      expect(planDefinition).toContain(ownerA.sessionId);

      await selectSession(window, DEPARTMENT_OWNER_A);
      await window
        .getByTestId("task-status")
        .getByRole("button", { name: "刷新", exact: true })
        .click();
      await expect(window.getByTestId("task-status-todos")).toContainText(DEPARTMENT_LONG_GOAL);
      const reviewDepartment = window
        .getByTestId("task-status-departments")
        .getByTestId("task-status-department")
        .filter({ hasText: "审查部" });
      await expect(reviewDepartment).toBeVisible();
      await reviewDepartment.click();
      const panel = window.getByTestId("department-execution-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: "审查部", exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: /工人 1.*查看会话/ }).first()).toBeVisible();
      await expect(panel.getByText(DEPARTMENT_LONG_GOAL, { exact: true })).toBeVisible();
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      const executionSession = panel.getByRole("heading", {
        name: "执行会话",
        exact: true,
      });
      await executionSession.scrollIntoViewIfNeeded();
      await expect(executionSession).toBeInViewport();
      await window.screenshot({
        path: testInfo.outputPath("部门A长内容滚到执行会话.png"),
        animations: "disabled",
      });
      await openDepartmentWorker(window, panel);
      await window.screenshot({
        path: testInfo.outputPath("部门A已读工人.png"),
        animations: "disabled",
      });

      await window.getByRole("button", { name: "返回部门卡", exact: true }).click();
      await expect(window.getByTestId("workboard-session")).toHaveCount(0);
      await expect(window.getByText("工人记录-s1-唯一标识", { exact: true })).toHaveCount(0);
      const researchDepartment = window
        .getByTestId("task-status-departments")
        .getByTestId("task-status-department")
        .filter({ hasText: "研发部" });
      await expect(researchDepartment).toBeVisible();
      await researchDepartment.click();
      await expect(
        window
          .getByTestId("department-execution-panel")
          .getByRole("heading", { name: "研发部", exact: true }),
      ).toBeVisible();
      await expect(window.getByText("工人记录-s1-唯一标识", { exact: true })).toHaveCount(0);
      await expect(window.getByTestId("workboard-session")).toHaveCount(0);

      await selectSession(window, DEPARTMENT_OWNER_B);
      await expect(window.getByTestId("task-status-todos")).toContainText("乙主控独立任务");
      await expect(window.getByText("工人记录-s1-唯一标识", { exact: true })).toHaveCount(0);
      await expect(window.getByTestId("workboard-session")).toHaveCount(0);
      await window.screenshot({
        path: testInfo.outputPath("切乙主控后无甲记录.png"),
        animations: "disabled",
      });
    } finally {
      await harness.close();
    }
  });
});
