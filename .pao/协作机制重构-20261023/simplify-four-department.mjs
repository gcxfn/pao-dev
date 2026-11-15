// 用途：删除测试运行时的源码转写；输入已改好的源夹具，输出直接引用源夹具的测试。
import { readFileSync, writeFileSync } from 'node:fs';
const path = new URL('../../PAO/packages/coding-agent/test/pao/workflow-four-department-real.test.ts', import.meta.url);
let source = readFileSync(path, 'utf8');
const start = source.indexOf('function resolveFixtureImports(');
const end = source.indexOf('function createDesktopWorktreeHost(', start);
if (start < 0 || end < 0) throw new Error('无法定位临时源码转写层');
source = source.slice(0, start) + source.slice(end);
source = source.replace('dirname, join, relative, resolve, sep', 'join, relative, resolve, sep');
source = source.replace('\tconst fixtureCopies = createFixtureCopies(controlRoot);\n', '');
source = source.replace('\t\tfixtureCopies,\n', '');
source = source.replaceAll('fixture.fixtureCopies.worker', 'WORKER_FIXTURE');
source = source.replaceAll('fixture.fixtureCopies.minister', 'MINISTER_FIXTURE');
writeFileSync(path, source);
