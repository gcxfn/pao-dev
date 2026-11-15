// 用途：把重复执行前三步的断言并入完整闭环，保留所有产物与 Git 提交检查。
// 输入/输出：小说离线集成测试文件；不改产品及测试时限。
import { readFileSync, writeFileSync } from 'node:fs';
const path = new URL('../../PAO/packages/coding-agent/test/pao/f-novel-loop.test.ts', import.meta.url);
let source = readFileSync(path, 'utf8');
const start = source.indexOf('\tit("第 1、2、3 步：');
const next = source.indexOf('\tit("五项写作、只读审核打回、返修与人工确认形成完整闭环"', start);
if (start < 0 || next < 0) throw new Error('未定位重复场景');
const duplicate = source.slice(start, next);
const assertionsStart = duplicate.indexOf('\t\tconst settingRel =');
const assertionsEnd = duplicate.lastIndexOf('\n\t}, 60000);');
if (assertionsStart < 0 || assertionsEnd < 0) throw new Error('未定位需保留的断言');
const assertions = duplicate.slice(assertionsStart, assertionsEnd);
source = source.slice(0, start) + source.slice(next);
const insertion = '\t\t\treports.push(await driver(fixture));';
if (!source.includes(insertion)) throw new Error('未定位合并位置');
source = source.replace(insertion, insertion + '\n\t\t\t{\n\t\t\t\tconst chain1 = reports[0]!;\n' + assertions + '\n\t\t\t}');
writeFileSync(path, source);
