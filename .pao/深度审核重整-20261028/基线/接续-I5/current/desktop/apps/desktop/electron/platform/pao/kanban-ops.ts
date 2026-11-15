/**
 * 看板卡操作桥（S7-B，窄接口）：只代「用户」执行取消。
 *
 * 安全边界（与 flow-control-query 同一口径）：
 * 1. project 只由主进程按已登记 workspaceId 解析后传入，本模块不收渲染层路径；
 * 2. 卡路径经工作区内复核（resolve＋双 realpath＋越界拒绝）＋文件名卡号一致后才读卡，
 *    卡的真实状态以盘上现读为准，不采信渲染层快照；
 * 3. 状态机白名单、单写者（owner）校验、读-合并-写全部在内核 changeCardStatus 一处，
 *    本桥不预判业务——内核拒绝（终态无出边、非 owner 等）原样作为该卡失败原因返回。
 *
 * 动作面刻意只有「取消」：完成必须走验收链（卡协议），认领/重试要求 owner 身份；
 * 更宽的动作面属于卡协议演进，不归看板。
 */
import { basename } from "node:path";
import { resolveExistingWorkspacePath } from "../files/workspace-paths";
import { loadDriver, reasonOf } from "./bridge-common";
import type { KanbanCardOpInput, KanbanCardOpResult } from "../../../contracts/kanban";
import type { PaoCardOpsModule, PaoCardStatusChangeInput } from "@pi-gui/pi-sdk-driver";

/** 内核 PaoCardError 的结构化形状（code 字段；非内核错误没有）。 */
interface PaoCardErrorShape {
  readonly code?: string;
}

async function loadDefaultModule(): Promise<PaoCardOpsModule> {
  return (await loadDriver("loadPaoCardOps"))();
}

/** 卡文件名「卡NNNN-目标.md」里的卡号；不合格式的卡文件一律拒，不猜。 */
function cardNumberFromFileName(fileName: string): number | undefined {
  const match = /^卡(\d+)-.*\.md$/.exec(fileName);
  if (!match) return undefined;
  const number = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(number) ? number : undefined;
}

export interface KanbanCardOpsOptions {
  /** Overrides the lazy driver import (tests). */
  readonly loadModule?: () => Promise<PaoCardOpsModule>;
}

export interface KanbanCardOps {
  /** 单卡操作：成功带内核迁移文案，失败带原因；一次只处理一张，调用方逐卡汇总。 */
  run(project: string, input: KanbanCardOpInput): Promise<KanbanCardOpResult>;
}

export function createKanbanCardOps(options: KanbanCardOpsOptions = {}): KanbanCardOps {
  const module = () => options.loadModule?.() ?? loadDefaultModule();
  return {
    async run(project, input): Promise<KanbanCardOpResult> {
      try {
        // 入口校验已限定 action ∈ KANBAN_CARD_ACTIONS（现只有取消）；桥内仍显式断言，
        // 未来扩动作时这里是唯一的分发点，不静默透传未知动作。
        if (input.action !== "取消") {
          return { ok: false, message: `看板只支持「取消」操作，收到：${input.action}` };
        }
        const cardPath = await resolveExistingWorkspacePath(project, input.cardPath);
        const fileName = basename(cardPath);
        const fileNameNumber = cardNumberFromFileName(fileName);
        if (fileNameNumber === undefined || fileNameNumber !== input.cardNumber) {
          return {
            ok: false,
            message: `卡号与卡文件不一致（卡文件 ${fileName}，提交卡号 ${input.cardNumber}），拒绝操作。`,
          };
        }
        const cards = await module();
        const card = cards.readCard(cardPath);
        const previousStatus = card.frontmatter.status;
        const change: PaoCardStatusChangeInput = {
          操作者: "用户",
          to: "canceled",
          ...(input.reason === undefined ? {} : { 依据: input.reason }),
          时间: new Date().toISOString(),
        };
        const updated = cards.changeCardStatus(card, change);
        return {
          ok: true,
          message: `${fileName}：${previousStatus} → ${updated.frontmatter.status}`,
        };
      } catch (error) {
        // 内核拒绝（迁移白名单/单写者/盘上状态不一致）是逐卡失败原因，不是桥故障；
        // 结构化码原样带出，便于批量结果里区分「终态不可取消」与「环境失败」。
        const code = (error as PaoCardErrorShape)?.code;
        return {
          ok: false,
          message: code !== undefined ? `[${code}] ${reasonOf(error)}` : reasonOf(error),
        };
      }
    },
  };
}
