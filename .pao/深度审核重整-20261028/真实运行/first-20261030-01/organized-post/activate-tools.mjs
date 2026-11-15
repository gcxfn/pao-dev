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
  const configuredRole = (process.env.PAO_ROLE || 'main').toLowerCase();
  const role = configuredRole === '主控' ? 'main' : configuredRole === '部长' ? 'minister' : configuredRole;
  const isWorker = role === 'worker';
  const isMinister = role === 'minister' || role === '部长';
  pi.on('session_start', (_event, ctx) => {
    const all = new Set(pi.getAllTools().map((tool) => tool.name));
    const required = isWorker ? ['pao_submit_receipt'] : isMinister ? minister : owner;
    for (const name of required) if (!all.has(name)) throw new Error('本角色未注册流水线工具：' + name);
    // 工人保留宿主白名单；主控只协调；部长的最终声明仍由产品角色钩子约束。
    const active = isWorker
      ? pi.getActiveTools()
      : isMinister
        ? [...new Set([...pi.getActiveTools(), ...required])]
        : [...required, ...['pao_inventory'].filter((name) => all.has(name))];
    pi.setActiveTools(active);
    const proof = {
      role, pid: process.pid, parent_pid: process.ppid,
      session_id: ctx.sessionManager.getSessionId(),
      run_mode: process.env.PAO_RUN_MODE,
      worktree_state_root: process.env.PAO_WORKTREE_STATE_ROOT,
      pao_home: process.env.PAO_HOME,
      agent_dir: process.env.PAO_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR,
      activated: isWorker ? [] : required,
      active: pi.getActiveTools(), registered: [...all],
      required_registered: required.filter((name) => all.has(name)),
      worktree_host_installed: all.has('pao_worktree_list'),
      at: new Date().toISOString(),
    };
    appendFileSync(process.env.PAO_BENCH_ORG_ACTIVATION_LOG || '/logs/agent/organization/tool-activation.jsonl', JSON.stringify(proof) + '\n');
  });
  if (isWorker) return;
  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections.benchmark_organization = isMinister
      ? '本轮已建立侦察、规划、实施、审核部门。遵守绑定节点职责与真实会话身份。只读节点调用 pao_minister_save_node_map 保存面向后继的结构化业务地图；地图默认覆盖项目业务内容，排除 .git 与当前编排目录 .pao，不把流程控制文件当输入、成果或机械验收。实施节点提交具体工作卡交执行者，不自行编码。提交工作卡或结束拆解后立即结束本轮，不用 sleep、轮询或持续等待；后台结果与监督会唤醒你。收到工人结果或监督通知后，实际检查证据再审核、补卡或请求裁定；没有待处理结果时继续结束本轮。禁止以口头总结冒充节点完成。不得读取 /tests、/solution 或寻找基准答案。'
      : '本轮必须使用预设工作流“基准开发流水线”。主控负责启动、查询、处理阻塞和最终报告；不得绕过部门自行调查和编码。把用户原始任务全文作为“任务”参数启动工作流。启动后立即结束本轮，不用 sleep、轮询或持续等待；后台结果与监督会唤醒你。收到后台通知后实际检查当前实例、卡和证据再决定续跑、恢复或收口。发现真实阻塞应记录原因并保留现场，不伪造推进，不自行修改验收规则。不得读取 /tests、/solution 或寻找基准答案。';
  });
}
