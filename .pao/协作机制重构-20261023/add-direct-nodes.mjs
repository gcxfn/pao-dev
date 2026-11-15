// 用途：收敛直接节点与部长拆卡的共同落卡路径；输入为当前源码，输出为同文件修改。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const root = 'D:/AI/workspace/pao-dev';
const dir = join(root, 'PAO/packages/coding-agent/src/pao/workflow');
const backup = join(root, '.pao/协作机制重构-20261023/直接节点修改前');
mkdirSync(backup, {recursive:true});
const path = join(dir, 'control.ts');
copyFileSync(path, join(backup,'control.ts'));
let s = readFileSync(path,'utf8').replaceAll('\r\n','\n');
if (s.includes('export async function prepareDirectNode')) throw Error('已经转换，禁止重跑');
const start = s.indexOf('\t\tif (node.拆解结束 || !inputs.length)', s.indexOf('export async function addNodeCards'));
const end = s.indexOf('\n\t});\n}', start);
const body = s.slice(start,end).replace(/^\t\t/gm, '\t');
const helper = `async function createNodeCards(\n\trecipe: WorkflowRecipe,\n\toptions: DriverOptions,\n\tflow: FlowControl,\n\tnode: NodeControl,\n\tinputs: NodeCardInput[],\n): Promise<string[]> {\n${body}\n}\n`;
s = s.slice(0,start) + '\t\treturn createNodeCards(recipe, options, flow, node, inputs);' + s.slice(end);
const position = s.indexOf('export async function addNodeCards');
s = s.slice(0,position) + helper + `
/** 直接节点没有部长身份；在原控制锁内落一张卡并结束编排，重复推进只复用映射。 */
export async function prepareDirectNode(recipe: WorkflowRecipe, options: DriverOptions, nodeName: string): Promise<void> {
	const tree = await currentContentTree(options, readControl(recipe, options).节点.some(node => node.判定?.结果 === "pass" || node.放行修复));
	await mutate(recipe, options, async flow => {
		const node = flow.节点.find(candidate => candidate.名字 === nodeName);
		const def = flow.冻结配方.节点.find(candidate => candidate.名字 === nodeName);
		if (!node || def?.执行方式 !== "直接" || def.只读 || def.审核) fail("不是可直接执行的节点");
		if (flow.暂停 || !ready(flow, node, projectRootForCards(flow.卡目录), tree)) fail("实例已暂停或前置未完成");
		if (node.部长会话) fail("直接节点不能冒用部长会话");
		if (node.拆解结束) return;
		if (!node.卡.length) await createNodeCards(recipe, options, flow, node, [{ goal: def.目标, acceptance: def.验收 }]);
		if (node.卡.length !== 1) fail("直接节点卡映射异常，保留现场核查");
		node.拆解结束 = true;
	});
}
` + s.slice(position);
s = s.replace(': !node.部长会话\n', ': !node.部长会话 && def.执行方式 !== "直接"\n');
s = s.replace('const node = flow.节点.find((n) => n.名字 === nodeName);\n\t\tif (!node || !session.trim()', 'const node = flow.节点.find((n) => n.名字 === nodeName);\n\t\tif (flow.冻结配方.节点.find(n => n.名字 === nodeName)?.执行方式 === "直接") fail("直接节点不启动部长");\n\t\tif (!node || !session.trim()');
writeFileSync(path,s);
