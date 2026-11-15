// 用途：验证Harbor组织模式的真实参数形状及拒绝边界；不创建会话或调用模型。
import assert from 'node:assert/strict';
import {parseBenchmarkArgs} from './benchmark-organized-entry.mjs';
const args=['--print','--mode','json','--session-dir','/logs/agent/sessions','--provider','benchmark','--model','group/deepseek','--thinking','high'];
const normal=parseBenchmarkArgs([...args,'原始题目']);
assert.equal(normal.values.tools,undefined);
assert.equal(normal.values.thinking,'high');
assert.deepEqual(normal.positionals,['原始题目']);
assert.equal(parseBenchmarkArgs([...args,'--tools','read,bash,edit,write','原始题目']).values.tools,'read,bash,edit,write');
assert.throws(()=>parseBenchmarkArgs([...args,'--tools','bash','原始题目']));
assert.throws(()=>parseBenchmarkArgs([...args,'第一题','第二题']));
assert.throws(()=>parseBenchmarkArgs(['--print','--mode','text','原始题目']));
console.log('组织参数省略tools、显式共同工具通过；其他工具、两题及非JSON拒绝；模型调用0');
