import { readFileSync, writeFileSync } from "node:fs";

const src = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/desktop/index.ts";
const dst = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/desktop/owners.ts";

const owners = `/**
 * 桌面 owner 注册表：同进程只读活性的唯一信号源。
 *
 * 主控会话注册后，桌面读投影（read-model）与本模块的 readDesktopWorkerActivity 共用同一份
 * owners；只看本进程内、cwd 等于目标项目的会话，CLI 进程与心跳都不参与。
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { MinisterHandle } from "../host/handle.ts";
import type { ProcessEntry } from "../worker/registry.ts";

/** 桌面 owner 条目：一个会话一份；活性与阈值同源于该会话内核运行器与保温配置。 */
export interface DesktopOwnerEntry {
\tpi: ExtensionAPI;
\tctx: ExtensionContext;
\tgetMinisters: () => MinisterHandle[];
\t/** 本会话运行器登记表快照（同进程活性信号源；未注入返回空表）。 */
\tgetWorkerActivity: () => readonly ProcessEntry[];
\t/** 静默阈值分钟（保温.json「worker 静默分钟」现读；0=关）。 */
\tgetSilenceMinutes: () => number;
}

const owners = new Map<string, DesktopOwnerEntry>();

/** 必须由内核主扩展注册；桌面文件扩展不能冒用另一个 ExtensionAPI 的命令闭包。 */
export function registerDesktopOwner(
\tpi: ExtensionAPI,
\toptions: {
\t\tgetMinisters?: () => MinisterHandle[];
\t\tgetWorkerActivity?: () => readonly ProcessEntry[];
\t\tgetSilenceMinutes?: () => number;
\t} = {},
): void {
\tlet id: string | undefined;
\tconst bind = (_event: unknown, ctx: ExtensionContext) => {
\t\tif (id && owners.get(id)?.pi === pi) owners.delete(id);
\t\tid = ctx.sessionManager.getSessionId();
\t\towners.set(id, {
\t\t\tpi,
\t\t\tctx,
\t\t\tgetMinisters: options.getMinisters ?? (() => []),
\t\t\tgetWorkerActivity: options.getWorkerActivity ?? (() => []),
\t\t\tgetSilenceMinutes: options.getSilenceMinutes ?? (() => 0),
\t\t});
\t};
\tpi.on("session_start", bind);
\tpi.on("session_tree", bind);
\tpi.on("session_shutdown", () => {
\t\tif (id && owners.get(id)?.pi === pi) owners.delete(id);
\t});
}

/** 读当前 owner 条目（不校验项目）；供同进程身份比对使用。 */
export function desktopOwnerEntry(sessionId: string): DesktopOwnerEntry | undefined {
\treturn owners.get(sessionId);
}

/** 已绑定项目语义的 owner 取用：会话、项目任一不符即拒绝，不能重放旧动作。 */
export function desktopOwner(sessionId: string, project: string): DesktopOwnerEntry {
\tconst current = owners.get(sessionId);
\tif (!current || current.ctx.sessionManager.getSessionId() !== sessionId || current.ctx.cwd !== project)
\t\tthrow new Error("原会话 owner 不可用或已切换；请回到对应会话重新查看，不能重放旧动作。");
\treturn current;
}

/** 一条桌面 worker 活性行（只读投影；不含 pid/命令）。 */
export interface DesktopWorkerActivityRow {
\t/** 会话（owner）标识 */
\t会话: string;
\t/** 执行标识（当前尝试的关联键；登记缺失时为空串） */
\t执行标识: string;
\t/** 卡路径（realpath；项目范围过滤依据） */
\t卡路径: string;
\t/** 登记表条目的尝试号（-1=未记） */
\t尝试: number;
\t/** 登记时间（ISO） */
\t登记时间: string;
\t/** 最近输出时间（ISO；undefined＝登记以来无任何输出） */
\t最近输出时间?: string;
\t/** 是否仍在运行 */
\t运行中: boolean;
\t/** 静默阈值（分钟；0=关） */
\t静默分钟: number;
}

/**
 * 桌面会话派出的 worker 活性只读投影（同进程）。
 * 只覆盖本进程（桌面主进程）内、且 cwd 等于给定项目的会话；CLI 进程不在内，也不造心跳。
 * 按卡路径落在项目根内过滤；尝试号原样带出，由调用方按卡面尝试判「当前尝试」。
 */
export function readDesktopWorkerActivity(project: string): DesktopWorkerActivityRow[] {
\tconst root = realpathSync(resolve(project));
\tconst rows: DesktopWorkerActivityRow[] = [];
\tfor (const [sessionId, entry] of owners) {
\t\tif (entry.ctx.sessionManager.getSessionId() !== sessionId) continue;
\t\tlet ownerRoot: string;
\t\ttry {
\t\t\townerRoot = realpathSync(entry.ctx.cwd);
\t\t} catch {
\t\t\tcontinue;
\t\t}
\t\tif (ownerRoot !== root) continue;
\t\tconst 静默分钟 = entry.getSilenceMinutes();
\t\tfor (const item of entry.getWorkerActivity()) {
\t\t\tif (!item.卡路径) continue;
\t\t\tlet cardPath: string;
\t\t\ttry {
\t\t\t\tcardPath = realpathSync(item.卡路径);
\t\t\t} catch {
\t\t\t\tcontinue;
\t\t\t}
\t\t\tconst delta = relative(root, cardPath);
\t\t\tif (isAbsolute(delta) || delta === ".." || delta.startsWith(\`..\${sep}\`)) continue;
\t\t\trows.push({
\t\t\t\t会话: sessionId,
\t\t\t\t执行标识: item.执行标识 ?? "",
\t\t\t\t卡路径: cardPath,
\t\t\t\t尝试: typeof item.尝试 === "number" ? item.尝试 : -1,
\t\t\t\t登记时间: item.登记时间,
\t\t\t\t最近输出时间: item.最近输出时间,
\t\t\t\t运行中: item.运行中,
\t\t\t\t静默分钟,
\t\t\t});
\t\t}
\t}
\treturn rows;
}
`;

let text = readFileSync(src, "utf8");
const blockStart = "/** 桌面 owner 条目：一个会话一份；活性与阈值同源于该会话内核运行器与保温配置。 */";
const start = text.indexOf(blockStart);
if (start < 0) throw new Error("找不到 owner 区块起点");
const endAnchor = "请回到对应会话重新查看，不能重放旧动作。\");\n\treturn current;\n}\n\n";
const end = text.indexOf(endAnchor, start);
if (end < 0) throw new Error("找不到 owner 区块终点");
text = text.slice(0, start) + text.slice(end + endAnchor.length);

const importOld = 'import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";';
if (!text.includes(importOld)) throw new Error("node:path 导入行不匹配");
text = text.replace(importOld, 'import { dirname, isAbsolute, join, relative, sep } from "node:path";');

const processImport = 'import type { ProcessEntry } from "../worker/registry.ts";\n';
if (!text.includes(processImport)) throw new Error("ProcessEntry 导入行不匹配");
text = text.replace(processImport, "");

const flowImport = 'import { readDesktopFlows } from "./workflow.ts";';
if (!text.includes(flowImport)) throw new Error("workflow 导入行不匹配");
text = text.replace(flowImport, 'import { desktopOwner as owner, desktopOwnerEntry } from "./owners.ts";\n' + flowImport);

const exportAnchor = 'export { resolvePaoHome } from "../routing/config.ts";';
if (!text.includes(exportAnchor)) throw new Error("导出锚点不匹配");
text = text.replace(
  exportAnchor,
  exportAnchor +
    '\nexport { registerDesktopOwner, readDesktopWorkerActivity } from "./owners.ts";' +
    '\nexport type { DesktopWorkerActivityRow } from "./owners.ts";',
);

const ownerGet = "if (owners.get(sessionId) !== originalOwner ||";
if (!text.includes(ownerGet)) throw new Error("originalOwner 比对行不匹配");
text = text.replace(ownerGet, "if (desktopOwnerEntry(sessionId) !== originalOwner ||");

writeFileSync(src, text);
writeFileSync(dst, owners);
console.log("ok: owners.ts 已写入，index.ts 已改");