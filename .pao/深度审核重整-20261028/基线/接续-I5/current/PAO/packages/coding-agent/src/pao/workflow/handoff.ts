import type { FlowControl } from "./control.ts";

/**
 * 只有可保存地图的只读零卡节点，才在有直接后继时强制交接。
 * 非只读零卡节点仍用零卡理由说明业务结果；叶子节点也不能仅因零卡而多交产物。
 */
export function requiresDispatchMapHandoff(flow: FlowControl, nodeName: string): boolean {
	const node = flow.节点.find((candidate) => candidate.名字 === nodeName);
	const def = flow.冻结配方.节点.find((candidate) => candidate.名字 === nodeName);
	if (!node || !def?.只读 || node.卡.length > 0) return false;
	return flow.冻结配方.节点.some(
		(candidate) => candidate.名字 !== nodeName && candidate.depends_on.includes(nodeName),
	);
}
