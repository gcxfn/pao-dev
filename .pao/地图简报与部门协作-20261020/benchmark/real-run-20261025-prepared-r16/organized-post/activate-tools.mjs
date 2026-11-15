// 用途：使用原生扩展接口显式启用本角色需要的流水线工具；不改变工具权限或内核实现。
import { appendFileSync } from 'node:fs';
const owner = ['pao_start_flow', 'pao_query_flow', 'pao_push_flow', 'pao_control_node', 'pao_decision_pack', 'pao_ack_supervision'];
const minister = [
  'pao_minister_save_node_map',
  'pao_minister_submit_cards',
  'pao_minister_review_worker',
  'pao_minister_rework_cards',
  'pao_breakdown_done',
  'pao_submit_decision',
  'pao_request_ruling',
  'pao_ack_supervision',
];
export default function benchmarkOrganization(pi) {
  const role = (process.env.PAO_ROLE || '主控').toLowerCase();
  if (role === 'worker') return; // 保留执行者原生工具白名单和禁止递归派发的边界。
  const isMinister = role === 'minister' || role === '部长';
  pi.on('session_start', () => {
    const all = new Set(pi.getAllTools().map((tool) => tool.name));
    const required = isMinister ? minister : owner;
    for (const name of required) if (!all.has(name)) throw new Error('本角色未注册流水线工具：' + name);
    const optional = ['tool_search', 'pao_dispatch_brief', 'pao_save_dispatch_recon'];
    const active = [...new Set([...pi.getActiveTools(), ...required, ...optional.filter((name) => all.has(name))])];
    pi.setActiveTools(active);
    const proof = { role, activated: required, active, at: new Date().toISOString() };
    appendFileSync(process.env.PAO_BENCH_ORG_ACTIVATION_LOG || '/logs/agent/organization/tool-activation.jsonl', JSON.stringify(proof) + '\n');
  });
  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections.benchmark_organization = isMinister
      ? '本轮已建立侦察、规划、实施、审核部门。遵守绑定节点职责与真实会话身份。只读节点调用 pao_minister_save_node_map 保存面向后继的结构化业务地图；地图默认覆盖项目业务内容，排除 .git 与当前编排目录 .pao，不把流程控制文件当输入、成果或机械验收。实施节点提交具体工作卡交执行者，不自行编码。提交工作卡或结束拆解后立即结束本轮，不用 sleep、轮询或持续等待；后台结果与监督会唤醒你。收到工人结果或监督通知后，实际检查证据再审核、补卡或请求裁定；没有待处理结果时继续结束本轮。禁止以口头总结冒充节点完成。不得读取 /tests、/solution 或寻找基准答案。'
      : '本轮必须使用预设工作流“基准开发流水线”。主控负责启动、查询、处理阻塞和最终报告；不得绕过部门自行调查和编码。把用户原始任务全文作为“任务”参数启动工作流。启动后立即结束本轮，不用 sleep、轮询或持续等待；后台结果与监督会唤醒你。收到后台通知后实际检查当前实例、卡和证据再决定续跑、恢复或收口。发现真实阻塞应记录原因并保留现场，不伪造推进，不自行修改验收规则。不得读取 /tests、/solution 或寻找基准答案。';
  });
}
