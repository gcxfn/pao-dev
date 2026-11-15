import { readFileSync, writeFileSync } from "node:fs";

const T = "\t";
const desktop = "PAO/packages/coding-agent/src/pao/desktop/index.ts";
const entry = "PAO/packages/coding-agent/src/pao/index.ts";

function patch(file, pairs) {
  let text = readFileSync(file, "utf8");
  for (const [oldText, newText, label] of pairs) {
    if (!text.includes(oldText)) throw new Error(`未找到锚点（${label}）: ${file}`);
    const next = text.replace(oldText, newText);
    if (next === text) throw new Error(`替换未生效（${label}）: ${file}`);
    text = next;
  }
  writeFileSync(file, text);
  console.log("patched", file);
}

// ---- desktop/index.ts ----
patch(desktop, [
  [
    'import { dirname, isAbsolute, join, relative, sep } from "node:path";',
    'import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";',
    "path import",
  ],
  [
    'import { collectInstanceResults } from "../status/results.ts";\n',
    'import { collectInstanceResults } from "../status/results.ts";\nimport type { ProcessEntry } from "../worker/registry.ts";\n',
    "ProcessEntry import",
  ],
  [
    "const owners = new Map<string, { pi: ExtensionAPI; ctx: ExtensionContext; getMinisters: () => MinisterHandle[] }>();",
    [
      "/** 桌面 owner 条目：一个会话一份；活性与阈值同源于该会话内核运行器与保温配置。 */",
      "interface DesktopOwnerEntry {",
      T + "pi: ExtensionAPI;",
      T + "ctx: ExtensionContext;",
      T + "getMinisters: () => MinisterHandle[];",
      T + "/** 本会话运行器登记表快照（同进程活性信号源；未注入返回空表）。 */",
      T + "getWorkerActivity: () => readonly ProcessEntry[];",
      T + "/** 静默阈值分钟（保温.json「worker 静默分钟」现读；0=关）。 */",
      T + "getSilenceMinutes: () => number;",
      "}",
      "",
      "const owners = new Map<string, DesktopOwnerEntry>();",
    ].join("\n"),
    "owners map",
  ],
  [
    "export function registerDesktopOwner(pi: ExtensionAPI, options: { getMinisters?: () => MinisterHandle[] } = {}): void {",
    [
      "export function registerDesktopOwner(",
      T + "pi: ExtensionAPI,",
      T + "options: {",
      T + T + "getMinisters?: () => MinisterHandle[];",
      T + T + "getWorkerActivity?: () => readonly ProcessEntry[];",
      T + T + "getSilenceMinutes?: () => number;",
      T + "} = {},",
      "): void {",
    ].join("\n"),
    "registerDesktopOwner signature",
  ],
  [
    T + T + "owners.set(id, { pi, ctx, getMinisters: options.getMinisters ?? (() => []) });",
    [
      T + T + "owners.set(id, {",
      T + T + T + "pi,",
      T + T + T + "ctx,",
      T + T + T + "getMinisters: options.getMinisters ?? (() => []),",
      T + T + T + "getWorkerActivity: options.getWorkerActivity ?? (() => []),",
      T + T + T + "getSilenceMinutes: options.getSilenceMinutes ?? (() => 0),",
      T + T + "});",
    ].join("\n"),
    "owners.set payload",
  ],
  [
    [
      T + T + "if (id && owners.get(id)?.pi === pi) owners.delete(id);",
      T + "});",
      "}",
      "",
    ].join("\n"),
    [
      T + T + "if (id && owners.get(id)?.pi === pi) owners.delete(id);",
      T + "});",
      "}",
      "",
      "/** 一条桌面 worker 活性行（只读投影；不含 pid/命令）。 */",
      "export interface DesktopWorkerActivityRow {",
      T + "/** 会话（owner）标识 */",
      T + "会话: string;",
      T + "/** 执行标识（当前尝试的关联键；登记缺失时为空串） */",
      T + "执行标识: string;",
      T + "/** 卡路径（realpath；项目范围过滤依据） */",
      T + "卡路径: string;",
      T + "/** 登记表条目的尝试号（-1=未记） */",
      T + "尝试: number;",
      T + "/** 登记时间（ISO） */",
      T + "登记时间: string;",
      T + "/** 最近输出时间（ISO；undefined＝登记以来无任何输出） */",
      T + "最近输出时间?: string;",
      T + "/** 是否仍在运行 */",
      T + "运行中: boolean;",
      T + "/** 静默阈值（分钟；0=关） */",
      T + "静默分钟: number;",
      "}",
      "",
      "/**",
      " * 桌面会话派出的 worker 活性只读投影（同进程）。",
      " * 只覆盖本进程（桌面主进程）内、且 cwd 等于给定项目的会话；CLI 进程不在内，也不造心跳。",
      " * 按卡路径落在项目根内过滤；尝试号原样带出，由调用方按卡面尝试判「当前尝试」。",
      " */",
      "export function readDesktopWorkerActivity(project: string): DesktopWorkerActivityRow[] {",
      T + "const root = realpathSync(resolve(project));",
      T + "const rows: DesktopWorkerActivityRow[] = [];",
      T + "for (const [sessionId, entry] of owners) {",
      T + T + "if (entry.ctx.sessionManager.getSessionId() !== sessionId) continue;",
      T + T + "let ownerRoot: string;",
      T + T + "try {",
      T + T + T + "ownerRoot = realpathSync(entry.ctx.cwd);",
      T + T + "} catch {",
      T + T + T + "continue;",
      T + T + "}",
      T + T + "if (ownerRoot !== root) continue;",
      T + T + "const 静默分钟 = entry.getSilenceMinutes();",
      T + T + "for (const item of entry.getWorkerActivity()) {",
      T + T + T + "if (!item.卡路径) continue;",
      T + T + T + "let cardPath: string;",
      T + T + T + "try {",
      T + T + T + T + "cardPath = realpathSync(item.卡路径);",
      T + T + T + "} catch {",
      T + T + T + T + "continue;",
      T + T + T + "}",
      T + T + T + "const delta = relative(root, cardPath);",
      T + T + T + "if (isAbsolute(delta) || delta === \"..\" || delta.startsWith(`..${sep}`)) continue;",
      T + T + T + "rows.push({",
      T + T + T + T + "会话: sessionId,",
      T + T + T + T + "执行标识: item.执行标识 ?? \"\",",
      T + T + T + T + "卡路径: cardPath,",
      T + T + T + T + "尝试: typeof item.尝试 === \"number\" ? item.尝试 : -1,",
      T + T + T + T + "登记时间: item.登记时间,",
      T + T + T + T + "最近输出时间: item.最近输出时间,",
      T + T + T + T + "运行中: item.运行中,",
      T + T + T + T + "静默分钟,",
      T + T + T + "});",
      T + T + "}",
      T + "}",
      T + "return rows;",
      "}",
      "",
    ].join("\n"),
    "append reader",
  ],
]);

// ---- pao/index.ts ----
patch(entry, [
  [
    'import { MinisterHost } from "./host/host.ts";',
    'import { readWorkerSilenceMinutes } from "./host/config.ts";\nimport { MinisterHost } from "./host/host.ts";',
    "config import",
  ],
  [
    T + 'if (role === "主控") registerDesktopOwner(pi, { getMinisters: () => host.list() });',
    [
      T + 'if (role === "主控")',
      T + T + "registerDesktopOwner(pi, {",
      T + T + T + "getMinisters: () => host.list(),",
      T + T + T + "getWorkerActivity: () => runner.registry.list(),",
      T + T + T + "getSilenceMinutes: () => readWorkerSilenceMinutes(paoHome()),",
      T + T + "});",
    ].join("\n"),
    "registerDesktopOwner call",
  ],
]);