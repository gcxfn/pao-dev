import { readFileSync, writeFileSync } from "node:fs";

const src = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/desktop/read-model.ts";
let text = readFileSync(src, "utf8");

const flowImport = 'import { type DesktopFlow, readDesktopFlows } from "./workflow.ts";';
if (!text.includes(flowImport)) throw new Error("workflow 导入不匹配");
text = text.replace(
  flowImport,
  flowImport + '\nimport { readDesktopWorkerActivity, type DesktopWorkerActivityRow } from "./owners.ts";',
);

const execInterface = `export interface DesktopExecution {
\t执行标识: string;
\t卡路径: string;
\t尝试: number;
\t状态: string;
\t时间: string;
\t映射路径: string;
\t会话路径?: string;
\t当前尝试: boolean;
}`;
if (!text.includes(execInterface)) throw new Error("DesktopExecution 接口不匹配");
const cardActivity = `/** 一张卡当前登记表活性（同进程只读；缺省＝无信号，不用卡时间兜底）。 */
export interface DesktopCardActivity {
\t/** 关联卡的 路径 原值（与卡列表同源，便于按路径合并） */
\t卡路径: string;
\t/** 派出 worker 的桌面会话（owner）标识 */
\t会话: string;
\t/** 执行标识（登记缺失时为空串） */
\t执行标识: string;
\t/** 登记条目的尝试号（-1=未记） */
\t尝试: number;
\t/** 登记时间（ISO） */
\t登记时间: string;
\t/** 最近输出时间（ISO；没有则为空） */
\t最近输出时间?: string;
\t/** 是否仍在运行 */
\t运行中: boolean;
\t/** 静默阈值（分钟；0=关） */
\t静默分钟: number;
\t/** 登记条目尝试号是否等于卡面当前尝试 */
\t当前尝试: boolean;
}`;
text = text.replace(execInterface, execInterface + "\n" + cardActivity);

const snapshot = `\t卡: ParsedCard[];
\t执行: DesktopExecution[];
\t问题: DesktopReadIssue[];`;
if (!text.includes(snapshot)) throw new Error("DesktopProjectSnapshot 字段不匹配");
text = text.replace(
  snapshot,
  `\t卡: ParsedCard[];
\t执行: DesktopExecution[];
\t/** 同进程桌面会话派出的 worker 活性；按卡路径对齐，历史尝试也带出但标 当前尝试=false。 */
\t活性: DesktopCardActivity[];
\t问题: DesktopReadIssue[];`,
);

const initLiteral = `\t\t卡: [],
\t\t执行: [],
\t\t问题: [],`;
if (!text.includes(initLiteral)) throw new Error("初始化字面量不匹配");
text = text.replace(initLiteral, `\t\t卡: [],
\t\t执行: [],
\t\t活性: [],
\t\t问题: [],`);

const sortAnchor = "\tresult.卡.sort((a, b) => a.卡号 - b.卡号);\n";
if (!text.includes(sortAnchor)) throw new Error("卡排序锚点不匹配");
const activityBlock = `${sortAnchor}\tconst activityCards = new Map<string, ParsedCard>();
\tfor (const card of result.卡) {
\t\ttry {
\t\t\tactivityCards.set(realpathSync(card.路径), card);
\t\t} catch {
\t\t\t// 卡文件在读取后消失：本轮不并入活性，交给下一次刷新重读
\t\t}
\t}
\tfor (const row of readDesktopWorkerActivity(root)) {
\t\tconst card = activityCards.get(row.卡路径);
\t\tif (!card) continue;
\t\tresult.活性.push({
\t\t\t卡路径: card.路径,
\t\t\t会话: row.会话,
\t\t\t执行标识: row.执行标识,
\t\t\t尝试: row.尝试,
\t\t\t登记时间: row.登记时间,
\t\t\t最近输出时间: row.最近输出时间,
\t\t\t运行中: row.运行中,
\t\t\t静默分钟: row.静默分钟,
\t\t\t当前尝试: card.frontmatter.尝试 === row.尝试,
\t\t});
\t}
`;
text = text.replace(sortAnchor, activityBlock);

const unused = "type DesktopWorkerActivityRow";
if (!text.includes(unused)) throw new Error("活性行类型导入缺失");
writeFileSync(src, text);
console.log("ok: read-model.ts 已并入活性");