// 用途：一次性收拢部长/直接节点共用的基线固定。输入：control.ts；输出：原文件。
import fs from 'node:fs';
const file = 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/workflow/control.ts';
let source = fs.readFileSync(file, 'utf8');
if (source.includes('async function captureNodeBaseline')) throw Error('已执行，不重复修改');
const begin = source.indexOf('\t\tif (!node.基线 && !node.基线错误) {', source.indexOf('export async function bindMinister'));
const end = source.indexOf('\n\t\tconst def = flow.冻结配方.节点.find', begin);
if (begin < 0 || end < 0) throw Error('找不到唯一基线块');
const block = source.slice(begin, end).replace(/^\t/gm, '');
const helper = `async function captureNodeBaseline(node: NodeControl, options: DriverOptions, flow: FlowControl): Promise<void> {\n${block}\n}\n`;
source = source.slice(0, begin) + '\t\tawait captureNodeBaseline(node, options, flow);' + source.slice(end);
source = source.replace('export async function bindMinister(', helper + 'export async function bindMinister(');
source = source.replace('\t\tif (node.拆解结束) return;\n\t\tif (!node.卡.length)', '\t\tif (node.拆解结束) return;\n\t\tawait captureNodeBaseline(node, options, flow);\n\t\tif (!node.卡.length)');
fs.writeFileSync(file, source);
