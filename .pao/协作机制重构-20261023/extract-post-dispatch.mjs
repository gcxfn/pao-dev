// 用途：迁移已有完成链至共享执行模块；输入自动链源码，输出公共模块及原入口适配。
// 仅做有边界的机械迁移，语义由主控差异审查与真实集成测试验证。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../../PAO/packages/coding-agent/src/pao/', import.meta.url);
const autoPath = new URL('workflow/auto.ts', root);
const commonPath = new URL('worker/post-dispatch.ts', root);
if (existsSync(commonPath)) throw new Error('公共模块已有实现，须先审读，禁止覆盖');
let source = readFileSync(autoPath, 'utf8');
const start = source.indexOf('\toptions.signal?.throwIfAborted();\n\tconst { receipt, receiptWriteError } = chainReceipt;');
const end = source.indexOf('\n/** 自动链结果 →', start);
const helpers = source.indexOf('\n/**\n * 审核回调可能', start);
if ([start,end,helpers].some(value => value < 0)) throw new Error('未定位完成链边界');
let body = source.slice(start, helpers);
let utility = source.slice(helpers, end);
body = body.replace('\tconst { receipt, receiptWriteError } = chainReceipt;', '\tconst { cardsDir, cardRef, operator, receipt, receiptWriteError, reviewSourceTree, independentReview } = options;\n\tconst cardNumber = parseCardRef(cardRef);\n\tconst label = options.label ?? `卡${cardRef}`;\n\tconst steps = { push: (step: PostDispatchStep) => options.onStep?.(step) };');
body = body.replaceAll('\n\t\t\tnode: nodeName,', '').replaceAll('\n\t\tnode: nodeName,', '').replaceAll('\n\t\t\t\tnode: nodeName,', '').replaceAll('\n\t\t\t\t\tnode: nodeName,', '');
body = body.replaceAll('satisfies ChainStep', 'satisfies PostDispatchStep');
body = body.replaceAll('node: nodeName, ', '');
body = body.replaceAll('\n\t\t\tworkflow: recipe.名字,', '').replaceAll('\n\t\tworkflow: recipe.名字,', '').replaceAll('\n\t\t\t\tworkflow: recipe.名字,', '');
body = body.replaceAll(/\n\s*\.\.\.\(v2Dispatch \? \{ instance: readControl\(recipe, options\)\.实例, round: v2Dispatch\.round \} : \{\}\),/g, '');
body = body.replaceAll('卡${cardRef}（节点 ${nodeName}）', '${label}');
body = body.replaceAll('options.运行器', 'options.runner').replaceAll('options.沙箱根', 'options.sandboxRoot').replaceAll('options.命令超时毫秒', 'options.commandTimeoutMs');
body = body.replace('const next = v2Dispatch\n\t\t\t\t? "请用 pao_query_flow 核对原实例、节点与轮次；验收定义需修正时，经 pao_control_node action=reopen 在原实例开新轮，旧卡保留。"\n\t\t\t\t: "owner 可按 failed→unclaimed→in_progress 重试，仍受尝试上限约束。";', 'const next = options.retryHint ?? "owner 可按 failed→unclaimed→in_progress 重试，仍受尝试上限约束。";');
body = body.replaceAll('AutoChainReviewEvent', 'PostDispatchReviewEvent').replaceAll('AutoChainReviewDecision', 'PostDispatchReviewDecision');
body = body.replace('worktreeTarget.kind === "managed"', 'options.worktreeTarget?.kind === "managed"');
utility = utility.replaceAll('AutoChainOptions', 'PostDispatchOptions').replaceAll('AutoChainReviewDecision', 'PostDispatchReviewDecision');
let reviewType = source.slice(source.indexOf('export interface AutoChainReviewEvent {'), source.indexOf('\nexport interface AutoChainReport {'));
reviewType = reviewType.replaceAll('AutoChainReviewEvent', 'PostDispatchReviewEvent').replaceAll('AutoChainReviewDecision', 'PostDispatchReviewDecision');
reviewType = reviewType.replace('\tworkflow: string;\n\tinstance?: string;\n\tnode: string;\n\tround?: number;\n', '');
const receiptType = `export interface PostDispatchReceiptEvent {\n cardRef: string;\n attempt: number;\n result: WorkerReceipt["status"];\n receipt: WorkerReceipt;\n recorded: boolean;\n}\n`;
const header = `/** 派发结束并释放执行锁后的共同完成链；直接任务与工作流共用核查、验收及交付。 */
import { baselineSnapshotPath, captureContentTree, checkBoundaryWrite, diffAgainstBaseline } from "../cards/baseline.ts";
import { deliverCard } from "../cards/delivery.ts";
import { changeCardStatus, parseCardRef, projectRootForCards } from "../cards/index.ts";
import { reviewCardForDelivery, verifyCard } from "../cards/verifier.ts";
import { nowString } from "../shared/time.ts";
import { logWarn } from "../shared/log.ts";
import type { WorktreeTarget } from "../worktrees/types.ts";
import { classifyWorkerFailure, locateDispatchCard } from "./dispatch-core.ts";
import type { WorkerReceipt } from "./receipt.ts";
import type { WorkerRunner } from "./runner.ts";
export type PostDispatchStage = "派发" | "回执" | "越界" | "验收" | "交卷" | "完成" | "失败" | "停审";
export interface PostDispatchStep { cardRef: string; stage: PostDispatchStage; note: string; }
${receiptType}
${reviewType}
export interface PostDispatchOptions {
 cardsDir: string;
 cardRef: string;
 operator: string;
 runner: WorkerRunner;
 receipt: WorkerReceipt;
 receiptWriteError?: string;
 signal?: AbortSignal;
 sandboxRoot?: string;
 commandTimeoutMs?: number;
 now?: () => string;
 worktreeTarget?: WorktreeTarget;
 /** 独立审核在派发前取得的原项目版本；结束后必须仍然相同。 */
 reviewSourceTree?: string;
 independentReview?: boolean;
 /** 由调用方提供原有显示语境；不参与业务判断。 */
 label?: string;
 retryHint?: string;
 onStep?: (step: PostDispatchStep) => void;
 onReceipt?: (event: PostDispatchReceiptEvent) => void | Promise<void>;
 onReviewRequired?: (event: PostDispatchReviewEvent) => PostDispatchReviewDecision | Promise<PostDispatchReviewDecision>;
}
async function emitReceipt(options: PostDispatchOptions, event: PostDispatchReceiptEvent): Promise<void> {
 if (!options.onReceipt || options.runner.isStopped()) return;
 try { await options.onReceipt(event); }
 catch (error) { logWarn("[pao] 完成链回执回调失败（卡" + event.cardRef + "）：" + (error instanceof Error ? error.message : String(error))); }
}
/** 返回停因表示不能继续；undefined 表示本次核查、验收和必要交付完成。 */
export async function completeDispatchedTask(options: PostDispatchOptions): Promise<string | undefined> {
`;
if (/nodeName|v2Dispatch|recipe\./.test(body)) throw new Error('公共链仍依赖工作流上下文：' + body.split('\n').filter(line => /nodeName|v2Dispatch|recipe\./.test(line)).join('\n'));
writeFileSync(commonPath, header + body + utility);
const adapter = `\treturn completeDispatchedTask({
 cardsDir, cardRef, operator, runner: options.运行器, ...chainReceipt,
 signal: options.signal, sandboxRoot: options.沙箱根, commandTimeoutMs: options.命令超时毫秒,
 now: options.now, worktreeTarget, reviewSourceTree, independentReview: !!independentReview,
 label: \`卡\${cardRef}（节点 \${nodeName}）\`,
 ...(v2Dispatch ? { retryHint: "请用 pao_query_flow 核对原实例、节点与轮次；验收定义需修正时，经 pao_control_node action=reopen 在原实例开新轮，旧卡保留。" } : {}),
 onStep: step => steps.push({ ...step, node: nodeName }),
 onReceipt: event => emitReceipt(options, {
  ...event, workflow: recipe.名字, node: nodeName,
  ...(v2Dispatch ? { instance: readControl(recipe, options).实例, round: v2Dispatch.round } : {}),
 }),
 ...(options.onReviewRequired ? { onReviewRequired: (event: PostDispatchReviewEvent) => options.onReviewRequired!({
  ...event, workflow: recipe.名字, node: nodeName,
  ...(v2Dispatch ? { instance: readControl(recipe, options).实例, round: v2Dispatch.round } : {}),
 }) } : {}),
 });
}
`;
source = source.slice(0,start) + adapter + source.slice(end);
source = source.replace('import {\n\tbaselineSnapshotPath,\n\tcaptureContentTree,\n\tcheckBoundaryWrite,\n\tdiffAgainstBaseline,\n} from "../cards/baseline.ts";', 'import { captureContentTree } from "../cards/baseline.ts";');
source = source.replace('import { deliverCard } from "../cards/delivery.ts";\n', '').replace('changeCardStatus, formatCardNumber, parseCardRef, projectRootForCards', 'formatCardNumber, projectRootForCards').replace('import { reviewCardForDelivery, verifyCard } from "../cards/verifier.ts";\n', '').replace('\n\tclassifyWorkerFailure,', '').replace('\tconst cardNumber = parseCardRef(cardRef);\n', '');
source = source.replace('import type { WorkerReceipt }', 'import { completeDispatchedTask, type PostDispatchReviewEvent } from "../worker/post-dispatch.ts";\nimport type { WorkerReceipt }');
writeFileSync(autoPath, source);
