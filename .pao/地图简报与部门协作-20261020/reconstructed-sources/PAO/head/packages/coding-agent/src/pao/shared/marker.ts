/**
 * 卡正文流归属标记（§11）的唯一实现：生成与解析都在这里。
 * 此前 driver 生成/解析、cards/metrics 按冻结格式重述正则——cards 反向 import driver
 * 会成环，正本下沉本模块（不 import 任何东西，任何层可安全引用）后同源。
 * 格式冻结：卡面/实例清单/回执按它解析，不改语义不改形状。
 */

/** 卡正文首行的流归属标记：查流/重建清单靠它从卡反查 节点↔卡号（可从卡重建的依据）。 */
export function workflowMarker(workflow: string, node: string): string {
	return `<!-- pao-workflow:流=${workflow}/节点=${node} -->`;
}

export const WORKFLOW_MARKER_PATTERN = /^<!--\s*pao-workflow:流=([^/\s]+)\/节点=([^/\s]+)\s*-->/;

/** 从卡正文解析流归属标记（§11.6 按需技能挂载也走它:卡→节点→配方技能声明）。 */
export function parseWorkflowMarker(body: string): { 流: string; 节点: string } | undefined {
	const match = WORKFLOW_MARKER_PATTERN.exec(body.trimStart());
	return match ? { 流: match[1], 节点: match[2] } : undefined;
}
