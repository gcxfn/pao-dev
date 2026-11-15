// 用途：显式启用各角色已注册的流水线、地图、审核与监督确认工具；不放宽工作流部长 shell 权限。
import { appendFileSync } from 'node:fs';
const owner = [
  'pao_start_flow',
  'pao_query_flow',
  'pao_push_flow',
  'pao_control_node',
  'pao_decision_pack',
  'pao_ack_supervision',
];
const minister = [
  'pao_minister_submit_cards',
  'pao_minister_save_node_map',
  'pao_minister_review_worker',
  'pao_breakdown_done',
  'pao_submit_decision',
  'pao_request_ruling',
  'pao_ack_supervision',
];
export default function benchmarkOrganization(pi) {
  const role = (process.env.PAO_ROLE || '主控').toLowerCase();
  if (role === 'worker') return; // 保留 worker 原生白名单和禁止递归派发的边界。
  const isMinister = role === 'minister' || role === '部长';
  pi.on('session_start', () => {
    const all = new Set(pi.getAllTools().map((tool) => tool.name));
    const required = isMinister ? minister : owner;
    for (const name of required) {
      if (!all.has(name)) throw new Error(`本角色未注册流水线、地图或监督工具：${name}`);
    }
    const optional = ['tool_search', 'pao_dispatch_brief', 'pao_save_dispatch_recon'];
    const active = [...new Set([...pi.getActiveTools(), ...required, ...optional.filter((name) => all.has(name))])];
    pi.setActiveTools(active);
    const proof = { role, activated: required, active, at: new Date().toISOString() };
    appendFileSync(process.env.PAO_BENCH_ORG_ACTIVATION_LOG || '/logs/agent/organization/tool-activation.jsonl',
      JSON.stringify(proof) + '\n');
  });
  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections.benchmark_organization = isMinister
      ? '本轮已建立侦察、规划、实施、审核部门。遵守绑定节点职责与真实会话身份。派卡后结束当前模型轮次，不用sleep等待；结果由宿主通知。侦察和规划要真实调用pao_minister_save_node_map保存结构化地图，zero_cards_reason只解释零卡，不能冒充地图。实施小任务少卡；可机械判断的条件用跑:、存在:或包含:，质量判断必须由当前绑定负责部长通过pao_minister_review_worker或审核判定留证。定期监督对照目标、进展、改动、检查、阻塞和证据，实际检查后调用pao_ack_supervision。不得读取/tests、/solution或基准答案。'
      : '本轮必须使用预设工作流“基准开发流水线”。主控负责启动、查询、处理阻塞和最终报告；不得绕过部门自行调查和编码。把用户原始任务全文作为“任务”参数启动工作流。派部门后结束当前模型轮次，不用sleep等待；宿主会继续后台并通知。主控每30分钟监督部门，实际检查后调用pao_ack_supervision。最终官方测试独立运行，不得读取/tests、/solution或基准答案。';
  });
}
