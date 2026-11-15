import type { KanbanCard, KanbanCardStatus } from "../../../contracts/kanban";

/** 终态只有 delivered/canceled（失败可重试，属合法取消来源）；终态不再提供取消。 */
export function canPrepareCancel(card: KanbanCard): boolean {
  return card.status !== "delivered" && card.status !== "canceled";
}

/** 只有进行中的卡才提供终止：终止针对在跑的 worker。 */
export function canPrepareTerminate(card: KanbanCard): boolean {
  return card.status === "in_progress";
}

/**
 * 拖放目标裁决（纯函数）：看板操作面只绑定「用户取消」这一个内核合法动作。
 * - 拖进「取消」列且卡非终态 → 发起取消（终态无出边，内核状态机会拒，拖放层不发起）；
 * - 拖进「已交付」列 → 显式拒绝并点名验收链（完成不经看板）；
 * - 拖进其他列 → 拒绝并说明只支持取消。拒绝是可见反馈，不静默不动。
 */
export function kanbanDropAction(
  target: KanbanCardStatus,
  card: KanbanCard,
): { kind: "cancel" } | { kind: "rejected"; reason: string } {
  if (target === "canceled") {
    if (canPrepareCancel(card)) return { kind: "cancel" };
    return { kind: "rejected", reason: `卡已是终态（${card.status}），不能再取消。` };
  }
  if (target === "delivered") {
    return {
      kind: "rejected",
      reason: "完成必须走验收链（回执→越界核查→验收），不能在看板直接拖到已交付。",
    };
  }
  return {
    kind: "rejected",
    reason: "看板只支持拖到「取消」列；其他状态变更须回主控会话走 pao 工具。",
  };
}

/**
 * 卡号补零（卡0017），与内核 formatCardNumber（cards/counter.ts）同口径。
 * 内核 ./pao 出口 require 面已补（S11-导出面微批），但 playwright 单测把内核文件按 CJS
 * 转译后撞内核兄弟工作区包（pi-ai 等）缺 require 出口，electron 侧接线实测红已回退；
 * 渲染层 bundle 拖不动内核 barrel（整包 node 内建依赖、无更窄出口）——本地单源维持，
 * 本函数是渲染层唯一拷贝。
 */
export function formatCardNumber(number: number): string {
  return `卡${String(Math.trunc(number)).padStart(4, "0")}`;
}

/**
 * 卡号引用（卡NNNN）→ 数字；不认的格式返回 undefined，按缺卡显式处理。
 * 与 formatCardNumber 是同一命名规则的两个方向，收拢在此单源维护
 * （S10-D 五桥包收编，原 kanban-board.tsx 平行实现）。
 */
export function cardRefNumber(ref: string): number | undefined {
  const match = /^卡0*(\d+)$/.exec(ref.trim());
  return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
}

function cardDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

function identityLines(card: KanbanCard): string[] {
  return [
    `原卡路径：${card.path}`,
    `card_ref：${formatCardNumber(card.number)}　项目：${card.project}`,
    `status/attempt：${card.status} / ${card.attempts}`,
  ];
}

/**
 * 只生成可复制的主控指令，不碰卡、不发请求。
 * 明文写出工具名与全部标识，保证回原 owner 执行时能逐项核对。
 * 工具名为 pao_* 英文新名（定名表 §1；S9 收口门对齐）。
 */
export function buildCancelCommand(card: KanbanCard): string {
  const params = {
    cards_dir: cardDirectory(card.path),
    card_ref: formatCardNumber(card.number),
    operator: "用户",
    new_status: "canceled",
    basis: `看板发起取消请求：${formatCardNumber(card.number)}（${card.status}，尝试 ${card.attempts}）`,
  };
  return [
    "请回到原主控会话，核对卡面无误后执行下面这条指令（不要在看板直接改状态）：",
    `意图：请求取消这张卡。目标：${formatCardNumber(card.number)}（项目 ${card.project}）。范围：只把这一张卡置为 canceled，不动计划定义、其他卡与验收链。`,
    "工具：pao_change_status",
    `参数：${JSON.stringify(params)}`,
    ...identityLines(card),
    "执行前请再读一次卡面；执行后刷新看板核对。未执行前不要对外声称已取消。",
  ].join("\n");
}

/**
 * 终止只对进行中的卡；同样只生成指令。
 * 现读工具局限（已核 worker/index.ts）：pao_terminate_card 只按卡号匹配本会话运行中条目，
 * 不按项目/卡目录过滤，所以必须先盘点确认卡号唯一；同号多目标时本指令不精确，不执行。
 */
export function buildTerminateCommand(card: KanbanCard): string {
  const params = { card_ref: formatCardNumber(card.number), cards_dir: cardDirectory(card.path) };
  return [
    "请回到原主控会话，按顺序核对，不要在看板直接终止：",
    `意图：请求终止这张卡的运行中 worker。目标：${formatCardNumber(card.number)}（项目 ${card.project}）。范围：只终止这一张卡对应的运行中 worker，不改卡状态、不动其他卡。`,
    "1. 先执行 pao_inventory，确认这个卡号在本会话的运行中条目唯一；同号卡在多项目同时存在时不要执行，改由主控人工定位处理。",
    "2. 再读 live 输出确认卡死。",
    "3. 确认无误后执行下面这条指令：",
    "工具：pao_terminate_card",
    `参数：${JSON.stringify(params)}`,
    ...identityLines(card),
    "已知局限：pao_terminate_card 现按卡号匹配本会话运行中 worker，不按项目/卡目录过滤；卡目录只用于回执落卡定位。同号多目标时本指令无法只终止本卡。",
    "执行后刷新看板核对；未执行前不要对外声称已终止。",
  ].join("\n");
}
