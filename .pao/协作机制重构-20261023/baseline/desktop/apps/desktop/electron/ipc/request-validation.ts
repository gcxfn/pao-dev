import {
  parseExtensionAction,
  type ExtensionFlagValues,
  type HostUiResponse,
} from "@pi-gui/session-driver";
import type { ExtensionActionRequest } from "../../contracts/extension-actions";
import type { SessionRef } from "@pi-gui/session-driver";
import type { NavigateSessionTreeOptions } from "@pi-gui/session-driver/types";
import type { RuntimeSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  isThemeMode,
  isThemePresetId,
  isAppLanguage,
  isCloseWindowBehavior,
  type AppLanguage,
  type CloseWindowBehavior,
  type AppView,
  type ComposerAttachment,
  type CreateSessionInput,
  type CreateWorkflowControllerInput,
  type CreateWorktreeInput,
  type ForkThreadInput,
  type ModelSettingsScopeMode,
  type NotificationPreferences,
  type RemoveWorktreeInput,
  type SendChildThreadFollowUpInput,
  type SetChildSupervisionLoopInput,
  type StartThreadInput,
  type ThemeMode,
  type ThemePresetId,
  type ThreadGrouping,
  type WorkspaceSessionTarget,
  type WorkflowTabMode,
  type WorkflowTabRecord,
  type SetWorkflowTabsInput,
  isThreadGrouping,
} from "../../contracts/desktop-state";
import type { WorkboardSessionInput } from "../../contracts/kanban";
import type {
  CustomProviderConfig,
  CustomProviderProbeInput,
  McpServerScope,
  NewMcpServerInput,
  SessionControlAction,
  SessionControlRequest,
  TerminalSize,
} from "../../contracts/ipc";
import type {
  WizardRecipe,
  WorkflowPreflightInput,
  WorkflowRecipeDeleteInput,
  WorkflowRecipeSaveInput,
  WorkflowStartInput,
  WorkflowTemplateInstallInput,
  WorkflowTierSaveInput,
} from "../../contracts/workflow-wizard";
import type { CanvasNodeDetailInput } from "../../contracts/canvas";
import type { KanbanCardAction, KanbanCardOpInput } from "../../contracts/kanban";
import type {
  WorkflowControlAction,
  WorkflowControlCommandInput,
  WorkflowControlQueryInput,
} from "../../contracts/workflow-control";
import type { TemporaryPlansQueryInput } from "../../contracts/temporary-plans";
import type { SendSideChatMessageInput } from "../../contracts/side-chat";
import {
  assertScheduledTaskSchedule,
  assertScheduledTaskTarget,
  type CreateScheduledTaskInput,
  type UpdateScheduledTaskInput,
} from "../../contracts/scheduled-tasks";
import { assertComposerAttachmentsAccepted } from "../../contracts/composer-attachments";
import {
  decodeTaskWorkbenchTemplate,
  type SaveTaskWorkbenchTemplateInput,
} from "../../contracts/workbench";

export function expectSaveTaskWorkbenchTemplateInput(
  value: unknown,
): SaveTaskWorkbenchTemplateInput {
  const input = expectRecord(value, "workbench save");
  if (Object.keys(input).some((key) => !["target", "template", "sequence"].includes(key))) {
    throw new TypeError("workbench save contains an unsupported field");
  }
  if (
    typeof input.sequence !== "number" ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1
  ) {
    throw new TypeError("workbench sequence must be a positive safe integer");
  }
  return {
    target: expectSessionTarget(input.target),
    template: decodeTaskWorkbenchTemplate(input.template),
    sequence: input.sequence,
  };
}

export function expectString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

export function expectNonEmptyString(value: unknown, name: string): string {
  const parsed = expectString(value, name).trim();
  if (!parsed) {
    throw new TypeError(`${name} must not be empty`);
  }
  return parsed;
}

export function expectOptionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : expectString(value, name);
}

/** 可选实例路径字段：空白视为未提供；有值时同画布实例路径口径（限长＋拒 NUL），只做形状校验。 */
function expectOptionalPath(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const path = expectString(value, name).trim();
  if (!path) return undefined;
  if (path.length > 4096 || path.includes("\0")) {
    throw new TypeError(`${name} must be a filesystem path of at most 4096 characters`);
  }
  return path;
}

export function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function expectOptionalBoolean(value: unknown, name: string): boolean | undefined {
  return value === undefined ? undefined : expectBoolean(value, name);
}

function expectOptionalNonEmptyString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : expectNonEmptyString(value, name);
}

function expectOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

export function expectStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value;
}

export function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** 字符串值字典（向导参数表等）；非字符串值拒绝，不静默强转。 */
export function expectStringRecord(value: unknown, name: string): Record<string, string> {
  const record = expectRecord(value, name);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new TypeError(`${name}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

export function expectSessionTarget(value: unknown, name = "target"): WorkspaceSessionTarget {
  const record = expectRecord(value, name);
  return {
    workspaceId: expectNonEmptyString(record.workspaceId, `${name}.workspaceId`),
    sessionId: expectNonEmptyString(record.sessionId, `${name}.sessionId`),
  };
}

const SIDE_CHAT_ID_MAX_LENGTH = 256;
const SIDE_CHAT_TEXT_MAX_LENGTH = 100_000;

function expectSideChatId(value: unknown, name: string): string {
  const id = expectNonEmptyString(value, name);
  if (id.length > SIDE_CHAT_ID_MAX_LENGTH) {
    throw new TypeError(`${name} must be at most ${SIDE_CHAT_ID_MAX_LENGTH} characters`);
  }
  return id;
}

function expectSideChatSourceFields(record: Record<string, unknown>, name: string): SessionRef {
  return {
    workspaceId: expectSideChatId(record.workspaceId, `${name}.workspaceId`),
    sessionId: expectSideChatId(record.sessionId, `${name}.sessionId`),
  };
}

/** 辅助对话来源只收已登记会话标识；未知字段在进入宿主前拒绝。 */
export function expectSideChatRequest(value: unknown): SessionRef {
  const record = expectRecord(value, "side chat request");
  rejectUnexpectedFields(record, ["workspaceId", "sessionId"], "side chat request");
  return expectSideChatSourceFields(record, "side chat request");
}

/** 辅助对话消息没有附件或控制参数；空白和超长文本都明确拒绝。 */
export function expectSendSideChatMessageRequest(value: unknown): SendSideChatMessageInput {
  const record = expectRecord(value, "side chat message");
  rejectUnexpectedFields(record, ["workspaceId", "sessionId", "text"], "side chat message");
  const text = expectString(record.text, "side chat message.text");
  if (!text.trim()) {
    throw new TypeError("side chat message.text must not be empty");
  }
  if (text.length > SIDE_CHAT_TEXT_MAX_LENGTH) {
    throw new TypeError(
      `side chat message.text must be at most ${SIDE_CHAT_TEXT_MAX_LENGTH} characters`,
    );
  }
  return {
    source: expectSideChatSourceFields(record, "side chat message"),
    text,
  };
}

export function expectAppView(value: unknown, name = "view"): AppView {
  if (
    value !== "threads" &&
    value !== "new-thread" &&
    value !== "scheduled" &&
    value !== "workboard" &&
    value !== "plans" &&
    value !== "canvas" &&
    value !== "skills" &&
    value !== "extensions" &&
    value !== "settings"
  ) {
    throw new TypeError(`${name} must be a supported app view`);
  }
  return value;
}

/** Zero-input request channels still go through a decoder; only `undefined` passes. */
export function expectNoInput(value: unknown): void {
  if (value !== undefined) {
    throw new TypeError("This request takes no input");
  }
}

/** D8d 节点详情选择子（P4-4）：实例路径＋节点名；主进程按它自行重解析，不信渲染层传路径。 */
export function expectWorkboardSessionInput(value: unknown): WorkboardSessionInput {
  const input = expectRecord(value, "workboard session");
  const workspaceId = expectNonEmptyString(input.workspaceId, "input.workspaceId");
  const offset = expectOptionalNonNegativeInteger(input.offset, "input.offset");
  if (input.kind === "worker")
    return {
      workspaceId,
      offset,
      kind: "worker",
      executionId: expectNonEmptyString(input.executionId, "input.executionId"),
    };
  if (input.kind !== "minister") throw new TypeError("input.kind must be worker or minister");
  const round = expectOptionalNonNegativeInteger(input.round, "input.round");
  if (!round) throw new TypeError("input.round must be a positive integer");
  return {
    workspaceId,
    offset,
    kind: "minister",
    round,
    instanceId: expectNonEmptyString(input.instanceId, "input.instanceId"),
    nodeName: expectNonEmptyString(input.nodeName, "input.nodeName"),
  };
}

export function expectCanvasNodeDetailInput(value: unknown): CanvasNodeDetailInput {
  const input = expectRecord(value, "canvas node detail input");
  const instancePath = expectNonEmptyString(input.instancePath, "instancePath");
  if (instancePath.length > 4096 || instancePath.includes("\0")) {
    throw new TypeError("instancePath must be a filesystem path of at most 4096 characters");
  }
  const nodeName = expectNonEmptyString(input.nodeName, "nodeName");
  if (nodeName.length > 200) {
    throw new TypeError("nodeName must contain 1 to 200 characters");
  }
  const cardRef =
    input.cardRef === undefined ? undefined : expectNonEmptyString(input.cardRef, "cardRef");
  if (cardRef !== undefined && !/^(?:卡#?)?\d{1,16}$/.test(cardRef))
    throw new TypeError("cardRef must be a card number");
  return { instancePath, nodeName, ...(cardRef !== undefined ? { cardRef } : {}) };
}

export function expectThreadGrouping(value: unknown, name = "grouping"): ThreadGrouping {
  if (!isThreadGrouping(value)) {
    throw new TypeError(`${name} must be time or workspace`);
  }
  return value;
}

export function expectThemeMode(value: unknown, name = "mode"): ThemeMode {
  if (!isThemeMode(value)) {
    throw new TypeError(`${name} must be system, light, or dark`);
  }
  return value;
}

export function expectThemePresetId(value: unknown, name = "presetId"): ThemePresetId {
  if (!isThemePresetId(value)) {
    throw new TypeError(`${name} must be a supported theme preset`);
  }
  return value;
}

export function expectAppLanguage(value: unknown, name = "language"): AppLanguage {
  if (!isAppLanguage(value)) {
    throw new TypeError(`${name} must be en or zh`);
  }
  return value;
}

export function expectCloseWindowBehavior(
  value: unknown,
  name = "closeWindowBehavior",
): CloseWindowBehavior {
  if (!isCloseWindowBehavior(value)) {
    throw new TypeError(`${name} must be quit or tray`);
  }
  return value;
}

export function expectModelSettingsScopeMode(
  value: unknown,
  name = "mode",
): ModelSettingsScopeMode {
  if (value !== "app-global" && value !== "per-repo") {
    throw new TypeError(`${name} must be app-global or per-repo`);
  }
  return value;
}

export function expectThinkingLevel(
  value: unknown,
  name = "thinkingLevel",
): NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]> {
  if (
    value !== "off" &&
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max"
  ) {
    throw new TypeError(`${name} must be a supported thinking level`);
  }
  return value;
}

export function expectOptionalThinkingLevel(
  value: unknown,
  name = "thinkingLevel",
): RuntimeSettingsSnapshot["defaultThinkingLevel"] {
  return value === undefined ? undefined : expectThinkingLevel(value, name);
}

export function expectCreateWorktreeInput(value: unknown): CreateWorktreeInput {
  const record = expectRecord(value, "input");
  return {
    workspaceId: expectNonEmptyString(record.workspaceId, "input.workspaceId"),
    fromSessionWorkspaceId: expectOptionalNonEmptyString(
      record.fromSessionWorkspaceId,
      "input.fromSessionWorkspaceId",
    ),
    fromSessionId: expectOptionalNonEmptyString(record.fromSessionId, "input.fromSessionId"),
  };
}

export function expectRemoveWorktreeInput(value: unknown): RemoveWorktreeInput {
  const record = expectRecord(value, "input");
  return {
    workspaceId: expectNonEmptyString(record.workspaceId, "input.workspaceId"),
    worktreeId: expectNonEmptyString(record.worktreeId, "input.worktreeId"),
  };
}

export function expectCreateSessionInput(value: unknown): CreateSessionInput {
  const record = expectRecord(value, "input");
  return {
    workspaceId: expectNonEmptyString(record.workspaceId, "input.workspaceId"),
    title: expectOptionalString(record.title, "input.title"),
  };
}

/** 新建工作流 controller：普通建会话的可选 tabId，用来把新会话绑到对应画布页签。 */
export function expectCreateWorkflowControllerInput(value: unknown): CreateWorkflowControllerInput {
  const record = expectRecord(value, "input");
  return {
    ...expectCreateSessionInput(record),
    tabId: expectOptionalNonEmptyString(record.tabId, "input.tabId"),
  };
}

function expectWorkflowTabMode(value: unknown, name: string): WorkflowTabMode {
  if (value !== "edit" && value !== "runtime") {
    throw new TypeError(`${name} must be edit or runtime`);
  }
  return value;
}

function expectWorkflowTabRecord(value: unknown, name: string): WorkflowTabRecord {
  const record = expectRecord(value, name);
  return {
    id: expectNonEmptyString(record.id, `${name}.id`),
    workspaceId: expectNonEmptyString(record.workspaceId, `${name}.workspaceId`),
    title: expectString(record.title, `${name}.title`),
    recipeName: expectOptionalString(record.recipeName, `${name}.recipeName`),
    instanceName: expectOptionalString(record.instanceName, `${name}.instanceName`),
    instancePath: expectOptionalPath(record.instancePath, `${name}.instancePath`),
    selectedElementId: expectOptionalString(record.selectedElementId, `${name}.selectedElementId`),
    controller:
      record.controller === undefined
        ? undefined
        : expectSessionTarget(record.controller, `${name}.controller`),
    mode: expectWorkflowTabMode(record.mode, `${name}.mode`),
  };
}

/** 画布页签元数据整表覆写：顶层字段白名单，页签逐条校验，重复 id 拒绝。 */
export function expectSetWorkflowTabsInput(value: unknown): SetWorkflowTabsInput {
  const record = expectRecord(value, "input");
  rejectUnexpectedFields(record, ["workflowTabs", "activeWorkflowTabId"], "input");
  if (!Array.isArray(record.workflowTabs)) {
    throw new TypeError("input.workflowTabs must be an array");
  }
  const seenIds = new Set<string>();
  const workflowTabs = record.workflowTabs.map((entry, index) => {
    const tab = expectWorkflowTabRecord(entry, `input.workflowTabs[${index}]`);
    if (seenIds.has(tab.id)) {
      throw new TypeError(`input.workflowTabs[${index}].id is duplicated`);
    }
    seenIds.add(tab.id);
    return tab;
  });
  const activeWorkflowTabId = expectString(record.activeWorkflowTabId, "input.activeWorkflowTabId");
  if (activeWorkflowTabId && !seenIds.has(activeWorkflowTabId)) {
    throw new TypeError("input.activeWorkflowTabId must match one of input.workflowTabs");
  }
  return { workflowTabs, activeWorkflowTabId };
}

export function expectStartThreadInput(value: unknown): StartThreadInput {
  const record = expectRecord(value, "input");
  const environment = record.environment;
  if (environment !== "local" && environment !== "worktree") {
    throw new TypeError("input.environment must be local or worktree");
  }
  return {
    rootWorkspaceId: expectNonEmptyString(record.rootWorkspaceId, "input.rootWorkspaceId"),
    environment,
    prompt: expectOptionalString(record.prompt, "input.prompt"),
    attachments:
      record.attachments === undefined
        ? undefined
        : expectComposerAttachments(record.attachments, "input.attachments"),
    provider: expectOptionalNonEmptyString(record.provider, "input.provider"),
    modelId: expectOptionalNonEmptyString(record.modelId, "input.modelId"),
    thinkingLevel: expectOptionalString(record.thinkingLevel, "input.thinkingLevel"),
    extensionFlags:
      record.extensionFlags === undefined
        ? undefined
        : expectExtensionFlags(record.extensionFlags, "input.extensionFlags"),
  };
}

/** Flag values keyed by flag name; which names and types are valid is checked against the runtime in main. */
function expectExtensionFlags(value: unknown, label: string): ExtensionFlagValues {
  return Object.fromEntries(
    Object.entries(expectRecord(value, label)).map(([name, flagValue]) => {
      if (!name.trim()) throw new TypeError(`${label} flag names must be non-empty`);
      if (typeof flagValue !== "boolean" && typeof flagValue !== "string") {
        throw new TypeError(`${label}.${name} must be a boolean or string`);
      }
      return [name, flagValue] as const;
    }),
  );
}

export function expectForkThreadInput(value: unknown): ForkThreadInput {
  const record = expectRecord(value, "input");
  const environment = record.environment;
  if (environment !== "local" && environment !== "worktree") {
    throw new TypeError("input.environment must be local or worktree");
  }
  const position = record.position;
  if (
    position !== undefined &&
    position !== "before" &&
    position !== "at" &&
    position !== "after"
  ) {
    throw new TypeError("input.position must be before, at, or after");
  }
  return {
    sourceWorkspaceId: expectNonEmptyString(record.sourceWorkspaceId, "input.sourceWorkspaceId"),
    sourceSessionId: expectNonEmptyString(record.sourceSessionId, "input.sourceSessionId"),
    rootWorkspaceId: expectNonEmptyString(record.rootWorkspaceId, "input.rootWorkspaceId"),
    environment,
    sourceMessageId: expectOptionalNonEmptyString(record.sourceMessageId, "input.sourceMessageId"),
    sourceMessageIndex: expectOptionalNonNegativeInteger(
      record.sourceMessageIndex,
      "input.sourceMessageIndex",
    ),
    userMessageIndex: expectOptionalNonNegativeInteger(
      record.userMessageIndex,
      "input.userMessageIndex",
    ),
    position,
  };
}

export function expectSendChildThreadFollowUpInput(value: unknown): SendChildThreadFollowUpInput {
  const record = expectRecord(value, "input");
  return {
    childThreadId: expectNonEmptyString(record.childThreadId, "input.childThreadId"),
    text: expectString(record.text, "input.text"),
  };
}

export function expectSetChildSupervisionLoopInput(value: unknown): SetChildSupervisionLoopInput {
  const record = expectRecord(value, "input");
  if (record.gate !== "continue" && record.gate !== "stop") {
    throw new TypeError("input.gate must be continue or stop");
  }
  return {
    childThreadId: expectNonEmptyString(record.childThreadId, "input.childThreadId"),
    gate: record.gate,
  };
}

export function expectNotificationPreferences(value: unknown): Partial<NotificationPreferences> {
  const record = expectRecord(value, "preferences");
  let preferences: Partial<NotificationPreferences> = {};
  for (const key of ["backgroundCompletion", "backgroundFailure", "attentionNeeded"] as const) {
    if (Object.hasOwn(record, key)) {
      preferences = { ...preferences, [key]: expectBoolean(record[key], `preferences.${key}`) };
    }
  }
  return preferences;
}

export function expectCustomProviderConfig(value: unknown): CustomProviderConfig {
  const record = expectRecord(value, "config");
  if (!Array.isArray(record.models)) {
    throw new TypeError("config.models must be an array");
  }
  return {
    providerId: expectNonEmptyString(record.providerId, "config.providerId"),
    baseUrl: expectNonEmptyString(record.baseUrl, "config.baseUrl"),
    apiKey: expectOptionalString(record.apiKey, "config.apiKey"),
    models: record.models.map((model, index) => {
      const entry = expectRecord(model, `config.models[${index}]`);
      const contextWindow = entry.contextWindow;
      if (
        contextWindow !== undefined &&
        (typeof contextWindow !== "number" ||
          !Number.isSafeInteger(contextWindow) ||
          contextWindow <= 0)
      ) {
        throw new TypeError(`config.models[${index}].contextWindow must be a positive integer`);
      }
      return {
        id: expectNonEmptyString(entry.id, `config.models[${index}].id`),
        contextWindow,
      };
    }),
  };
}

export function expectMcpServerScope(value: unknown): McpServerScope {
  if (value !== "global" && value !== "project") {
    throw new TypeError("scope must be global or project");
  }
  return value;
}

/** pi's rule for MCP server names (`validateMcpServerConfig` in pi's `core/mcp-servers.js`). */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Main re-validates in the driver (URL scheme, empty command); this checks the IPC shape. */
export function expectNewMcpServerInput(value: unknown): NewMcpServerInput {
  const record = expectRecord(value, "server");
  const name = expectNonEmptyString(record.name, "server.name");
  if (!MCP_SERVER_NAME.test(name)) {
    throw new TypeError('server.name may only use letters, digits, "_" and "-"');
  }
  const description = expectOptionalString(record.description, "server.description");
  const named = description === undefined ? { name } : { name, description };
  if (record.url !== undefined) {
    if (record.command !== undefined || record.args !== undefined) {
      throw new TypeError("server needs either a url or a command, not both");
    }
    return { ...named, url: expectNonEmptyString(record.url, "server.url") };
  }
  return {
    ...named,
    command: expectNonEmptyString(record.command, "server.command"),
    args: record.args === undefined ? [] : [...expectStringArray(record.args, "server.args")],
  };
}

export function expectCustomProviderProbeInput(value: unknown): CustomProviderProbeInput {
  const record = expectRecord(value, "input");
  return {
    baseUrl: expectNonEmptyString(record.baseUrl, "input.baseUrl"),
    apiKey: expectOptionalString(record.apiKey, "input.apiKey"),
  };
}

export function expectHostUiResponse(value: unknown): HostUiResponse {
  const record = expectRecord(value, "response");
  const requestId = expectNonEmptyString(record.requestId, "response.requestId");
  const variants = [
    typeof record.value === "string",
    typeof record.confirmed === "boolean",
    record.cancelled === true,
  ].filter(Boolean).length;
  if (variants !== 1) {
    throw new TypeError("response must contain exactly one of value, confirmed, or cancelled");
  }
  if (typeof record.value === "string") {
    return { requestId, value: record.value };
  }
  if (typeof record.confirmed === "boolean") {
    return { requestId, confirmed: record.confirmed };
  }
  return { requestId, cancelled: true };
}

export function expectNavigateSessionTreeOptions(value: unknown): NavigateSessionTreeOptions {
  const record = expectRecord(value, "options");
  return {
    summarize: expectOptionalBoolean(record.summarize, "options.summarize"),
    customInstructions: expectOptionalString(
      record.customInstructions,
      "options.customInstructions",
    ),
  };
}

export function expectTerminalSize(value: unknown, name = "size"): TerminalSize {
  const record = expectRecord(value, name);
  const cols = record.cols;
  const rows = record.rows;
  if (typeof cols !== "number" || !Number.isSafeInteger(cols) || cols <= 0) {
    throw new TypeError(`${name}.cols must be a positive integer`);
  }
  if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows <= 0) {
    throw new TypeError(`${name}.rows must be a positive integer`);
  }
  return { cols, rows };
}

export function expectWorkspaceFileListOptions(
  value: unknown,
): { readonly force?: boolean } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = expectRecord(value, "options");
  return { force: expectOptionalBoolean(record.force, "options.force") };
}

export function expectComposerAttachments(
  value: unknown,
  name = "attachments",
): readonly ComposerAttachment[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  const attachments = value.map((attachment, index) => {
    const itemName = `${name}[${index}]`;
    const record = expectRecord(attachment, itemName);
    const common = {
      id: expectNonEmptyString(record.id, `${itemName}.id`),
      name: expectNonEmptyString(record.name, `${itemName}.name`),
      mimeType: expectNonEmptyString(record.mimeType, `${itemName}.mimeType`),
    };
    if (record.kind === "image") {
      return {
        ...common,
        kind: "image" as const,
        data: expectNonEmptyString(record.data, `${itemName}.data`),
      };
    }
    if (record.kind === "file") {
      const sizeBytes = expectOptionalNonNegativeInteger(record.sizeBytes, `${itemName}.sizeBytes`);
      return {
        ...common,
        kind: "file" as const,
        fsPath: expectNonEmptyString(record.fsPath, `${itemName}.fsPath`),
        sizeBytes,
      };
    }
    throw new TypeError(`${itemName}.kind must be image or file`);
  });
  return assertComposerAttachmentsAccepted([], attachments);
}

export function expectOptionalDeliverOptions(
  value: unknown,
): { readonly deliverAs?: "steer" | "followUp" } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = expectRecord(value, "options");
  if (record.deliverAs === undefined) {
    return {};
  }
  if (record.deliverAs !== "steer" && record.deliverAs !== "followUp") {
    throw new TypeError("options.deliverAs must be steer or followUp");
  }
  return { deliverAs: record.deliverAs };
}

export function expectCreateScheduledTaskInput(value: unknown): CreateScheduledTaskInput {
  const record = expectRecord(value, "input");
  return {
    title: expectNonEmptyString(record.title, "input.title"),
    instruction: expectNonEmptyString(record.instruction, "input.instruction"),
    schedule: assertScheduledTaskSchedule(record.schedule, "input.schedule"),
    target: assertScheduledTaskTarget(record.target, "input.target"),
    originSessionId: expectOptionalNonEmptyString(record.originSessionId, "input.originSessionId"),
  };
}

export function expectUpdateScheduledTaskInput(value: unknown): UpdateScheduledTaskInput {
  const record = expectRecord(value, "patch");
  const status = record.status;
  if (
    status !== undefined &&
    status !== "active" &&
    status !== "paused" &&
    status !== "completed"
  ) {
    throw new TypeError("patch.status must be active, paused, or completed");
  }
  return {
    title: expectOptionalNonEmptyString(record.title, "patch.title"),
    instruction: expectOptionalNonEmptyString(record.instruction, "patch.instruction"),
    ...(record.schedule === undefined
      ? {}
      : { schedule: assertScheduledTaskSchedule(record.schedule, "patch.schedule") }),
    ...(record.target === undefined
      ? {}
      : { target: assertScheduledTaskTarget(record.target, "patch.target") }),
    ...(status ? { status } : {}),
  };
}

/** A card button's click. The action is extension-authored data, parsed by its one parser. */
export function expectExtensionActionRequest(raw: unknown): ExtensionActionRequest {
  const input = expectRecord(raw, "extension action request");
  const action = parseExtensionAction(input.action);
  if (!action) throw new Error("pi-gui does not support this button's action");
  return { target: expectSessionTarget(input.target), action };
}

/** 渲染层生成的幂等键：非空、不超过 128 字符（设计包 §3）。 */
const SESSION_CONTROL_REQUEST_ID_MAX_LENGTH = 128;

function expectSessionControlRequestId(value: unknown, name: string): string {
  const requestId = expectString(value, name);
  if (!requestId.trim()) {
    throw new TypeError(`${name} must not be empty`);
  }
  if (requestId.length > SESSION_CONTROL_REQUEST_ID_MAX_LENGTH) {
    throw new TypeError(
      `${name} must be at most ${SESSION_CONTROL_REQUEST_ID_MAX_LENGTH} characters`,
    );
  }
  return requestId;
}

function rejectUnexpectedFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${name} contains an unsupported field: ${key}`);
    }
  }
}

/** 单一控制入口的动作联合：逐支白名单校验，未知字段拒绝（设计包 §3）。 */
export function expectSessionControlRequest(value: unknown): SessionControlRequest {
  const record = expectRecord(value, "session control request");
  rejectUnexpectedFields(record, ["target", "requestId", "action"], "session control request");
  const action = expectSessionControlAction(record.action);
  return {
    target: expectSessionTarget(record.target),
    requestId: expectSessionControlRequestId(record.requestId, "requestId"),
    action,
  };
}

function expectSessionControlAction(value: unknown): SessionControlAction {
  const action = expectRecord(value, "action");
  switch (action.kind) {
    case "send": {
      rejectUnexpectedFields(action, ["kind", "text", "attachments", "deliverAs"], "action");
      const deliver =
        action.deliverAs === undefined
          ? undefined
          : expectOptionalDeliverOptions({ deliverAs: action.deliverAs });
      return {
        kind: "send",
        text: expectString(action.text, "action.text"),
        ...(action.attachments === undefined
          ? {}
          : { attachments: expectComposerAttachments(action.attachments, "action.attachments") }),
        ...(deliver?.deliverAs ? { deliverAs: deliver.deliverAs } : {}),
      };
    }
    case "cancel": {
      rejectUnexpectedFields(action, ["kind"], "action");
      return { kind: "cancel" };
    }
    case "dispatch": {
      rejectUnexpectedFields(action, ["kind", "cardGoal", "dispatchReason"], "action");
      return {
        kind: "dispatch",
        cardGoal: expectNonEmptyString(action.cardGoal, "action.cardGoal"),
        ...(action.dispatchReason === undefined
          ? {}
          : { dispatchReason: expectString(action.dispatchReason, "action.dispatchReason") }),
      };
    }
    case "confirm": {
      rejectUnexpectedFields(action, ["kind", "cardRef", "basis"], "action");
      return {
        kind: "confirm",
        cardRef: expectNonEmptyString(action.cardRef, "action.cardRef"),
        ...(action.basis === undefined
          ? {}
          : { basis: expectString(action.basis, "action.basis") }),
      };
    }
    case "query": {
      rejectUnexpectedFields(action, ["kind", "requestId"], "action");
      return {
        kind: "query",
        ...(action.requestId === undefined
          ? {}
          : { requestId: expectString(action.requestId, "action.requestId") }),
      };
    }
    default:
      throw new TypeError("action.kind must be send, cancel, dispatch, confirm, or query");
  }
}

// ── 工作流向导（P4-3）输入校验 ──
// 透传口径（S2 定案，选项一）：本层只做骨架预检快速失败（对象形状守卫），配方深度契约
// 单源＝内核 parseRecipe（PAO workflow/recipe.ts），本层不重造字段校验、不建第二份配方契约。
// 三个入口的内核终判点：
//   preflight（expectWorkflowPreflightInput）→ previewDesktopWorkflow 渲染前全量 parseRecipe；
//   save（expectWorkflowRecipeSaveInput）→ saveDesktopRecipe 的 checkDesktopRecipeEdit，
//     ui.confirm 前后各跑一次（渲染→emitRecipeMarkdown→parseRecipe 回验）；
//   start（expectWorkflowStartInput）→ startDesktopWorkflow 的 check()：磁盘重读 revision 比对
//     ＋提交配方与磁盘渲染比对＋preview 内全量 parseRecipe，confirm 后 recheck 再派发。

/** 配方行最小形状：非对象行（含数组/null）在 IPC 层即拒绝，不进内核。 */
function isRecipeRowObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectWizardRecipe(value: unknown, name: string): WizardRecipe {
  const record = expectRecord(value, name);
  const nodes = record["节点"];
  if (!Array.isArray(nodes) || !nodes.every(isRecipeRowObject)) {
    throw new TypeError(`${name}.节点 must be an array of node objects`);
  }
  return {
    ...record,
    名字: expectNonEmptyString(record["名字"], `${name}.名字`),
    参数: expectStringArray(record["参数"] ?? [], `${name}.参数`),
    节点: nodes,
  } as WizardRecipe;
}

export function expectWorkflowPreflightInput(value: unknown): WorkflowPreflightInput {
  const record = expectRecord(value, "input");
  return {
    project: expectNonEmptyString(record.project, "input.project"),
    recipe: expectWizardRecipe(record.recipe, "input.recipe"),
    parameters: expectStringRecord(record.parameters ?? {}, "input.parameters"),
  };
}

export function expectWorkflowTemplateInstallInput(value: unknown): WorkflowTemplateInstallInput {
  const record = expectRecord(value, "input");
  return {
    sessionId: expectNonEmptyString(record.sessionId, "input.sessionId"),
    project: expectNonEmptyString(record.project, "input.project"),
    templateId: expectNonEmptyString(record.templateId, "input.templateId"),
    ...(record.name === undefined ? {} : { name: expectNonEmptyString(record.name, "input.name") }),
  };
}

export function expectWorkflowRecipeSaveInput(value: unknown): WorkflowRecipeSaveInput {
  const record = expectRecord(value, "input");
  return {
    sessionId: expectNonEmptyString(record.sessionId, "input.sessionId"),
    project: expectNonEmptyString(record.project, "input.project"),
    recipe: expectWizardRecipe(record.recipe, "input.recipe"),
    revision:
      record.revision === null ? null : expectNonEmptyString(record.revision, "input.revision"),
  };
}

/** 删除配方入参：名字非空字符串＋revision 照保存口径（null 或非空）；版本漂移/运行中实例由内核终判。 */
export function expectWorkflowRecipeDeleteInput(value: unknown): WorkflowRecipeDeleteInput {
  const record = expectRecord(value, "input");
  return {
    sessionId: expectNonEmptyString(record.sessionId, "input.sessionId"),
    project: expectNonEmptyString(record.project, "input.project"),
    name: expectNonEmptyString(record.name, "input.name"),
    revision:
      record.revision === null ? null : expectNonEmptyString(record.revision, "input.revision"),
  };
}

export function expectWorkflowStartInput(value: unknown): WorkflowStartInput {
  const record = expectRecord(value, "input");
  return {
    sessionId: expectNonEmptyString(record.sessionId, "input.sessionId"),
    project: expectNonEmptyString(record.project, "input.project"),
    recipe: expectWizardRecipe(record.recipe, "input.recipe"),
    revision: expectNonEmptyString(record.revision, "input.revision"),
    parameters: expectStringRecord(record.parameters ?? {}, "input.parameters"),
    masterTier: expectNonEmptyString(record.masterTier, "input.masterTier"),
    thinking: expectNonEmptyString(record.thinking, "input.thinking"),
  };
}

/** 档位保存入参（S9-2）：四必填非空；editing 可选、出现即非空（空串＝伪造「无编辑对象」）。深度校验（重名/思考档合法）由内核写前校验终判。 */
export function expectWorkflowTierSaveInput(value: unknown): WorkflowTierSaveInput {
  const record = expectRecord(value, "input");
  const tier = expectRecord(record.tier, "input.tier");
  return {
    tier: {
      name: expectNonEmptyString(tier.name, "input.tier.name"),
      provider: expectNonEmptyString(tier.provider, "input.tier.provider"),
      model: expectNonEmptyString(tier.model, "input.tier.model"),
      thinkingLevel: expectNonEmptyString(tier.thinkingLevel, "input.tier.thinkingLevel"),
    },
    ...(record.editing === undefined
      ? {}
      : { editing: expectNonEmptyString(record.editing, "input.editing") }),
  };
}

/**
 * 看板卡操作入参（S7-B）：桌面只代用户执行取消；其他动作（含完成——须走验收链）
 * 在入口即拒，不透传内核。多余字段一律丢弃（重建新对象），卡路径同实例路径口径限长＋拒 NUL，
 * 项目归属与卡号一致性由主进程桥复核。
 */
export function expectKanbanCardOpInput(value: unknown): KanbanCardOpInput {
  const input = expectRecord(value, "kanban card op");
  const action = input.action;
  if (action !== "取消") {
    throw new TypeError("input.action must be 取消");
  }
  const cardNumber = input.cardNumber;
  if (typeof cardNumber !== "number" || !Number.isSafeInteger(cardNumber) || cardNumber < 0) {
    throw new TypeError("input.cardNumber must be a non-negative integer");
  }
  const cardPath = expectNonEmptyString(input.cardPath, "input.cardPath");
  if (cardPath.length > 4096 || cardPath.includes("\0")) {
    throw new TypeError("input.cardPath must be a filesystem path of at most 4096 characters");
  }
  return {
    workspaceId: expectNonEmptyString(input.workspaceId, "input.workspaceId"),
    cardPath,
    cardNumber,
    action: action as KanbanCardAction,
    ...(input.reason === undefined ? {} : { reason: expectString(input.reason, "input.reason") }),
  };
}

/** 运行控制只读查询入参：workspaceId＋实例名（＝配方名）＋可选实例路径；项目路径由主进程解析。 */
export function expectWorkflowControlQueryInput(value: unknown): WorkflowControlQueryInput {
  const input = expectRecord(value, "workflow control query");
  const instanceName = expectNonEmptyString(input.instanceName, "input.instanceName");
  if (instanceName.length > 200) {
    throw new TypeError("input.instanceName must contain 1 to 200 characters");
  }
  return {
    workspaceId: expectNonEmptyString(input.workspaceId, "input.workspaceId"),
    instanceName,
    instancePath: expectOptionalPath(input.instancePath, "input.instancePath"),
  };
}

/** 临时计划只读查询入参：workspaceId＋可选稳定计划 ID；项目路径由主进程按登记表解析。 */
export function expectTemporaryPlansQueryInput(value: unknown): TemporaryPlansQueryInput {
  const input = expectRecord(value, "temporary plans query");
  const planId =
    input.planId === undefined ? undefined : expectNonEmptyString(input.planId, "input.planId");
  if (planId !== undefined && planId.length > 64) {
    throw new TypeError("input.planId must contain 1 to 64 characters");
  }
  return {
    workspaceId: expectNonEmptyString(input.workspaceId, "input.workspaceId"),
    ...(planId === undefined ? {} : { planId }),
  };
}

function expectWorkflowControlAction(value: unknown, name: string): WorkflowControlAction {
  if (value !== "confirm" && value !== "pause" && value !== "resume") {
    throw new TypeError(`${name} must be confirm, pause or resume`);
  }
  return value;
}

/**
 * 运行控制动作入参：只收身份与意图；配方名/卡目录/原 owner 由主进程从磁盘真值填充，
 * 这里重建新对象，多余字段一律丢掉，不能借渲染层随手加参数。
 */
export function expectWorkflowControlCommandInput(value: unknown): WorkflowControlCommandInput {
  const input = expectRecord(value, "workflow control command");
  const round = input.round;
  if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) {
    throw new TypeError("input.round must be a positive integer");
  }
  const nodeName = expectNonEmptyString(input.nodeName, "input.nodeName");
  if (nodeName.length > 200) {
    throw new TypeError("input.nodeName must contain 1 to 200 characters");
  }
  return {
    workspaceId: expectNonEmptyString(input.workspaceId, "input.workspaceId"),
    sessionId: expectNonEmptyString(input.sessionId, "input.sessionId"),
    instanceId: expectNonEmptyString(input.instanceId, "input.instanceId"),
    nodeName,
    round,
    action: expectWorkflowControlAction(input.action, "input.action"),
    ...(input.reason === undefined ? {} : { reason: expectString(input.reason, "input.reason") }),
  };
}
