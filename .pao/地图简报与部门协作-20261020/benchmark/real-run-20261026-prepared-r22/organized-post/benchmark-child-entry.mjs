// 用途：给真实部长/工人CLI安装同一基准宿主；参数、会话、RPC及父亡停止复用内核。
import { createBenchmarkFactories } from './benchmark-host-factories.mjs';

const source = process.env.PAO_BENCH_SOURCE;
const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.PAO_CODING_AGENT_DIR;
if (!source || !agentDir || !process.env.PAO_HOME) throw Error('子角色缺少隔离基准现场');
const { extensionFactories, load } = await createBenchmarkFactories(source, agentDir);
const { setupCli } = await load('cli/setup.js');
const { main } = await load('main.js');
setupCli();
await main(process.argv.slice(2), { extensionFactories });
