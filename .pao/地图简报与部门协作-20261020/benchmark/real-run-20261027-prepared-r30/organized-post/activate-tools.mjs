// 用途：使用原生扩展接口显式启用本角色需要的流水线工具；不改变工具权限或内核实现。
import { appendFileSync } from 'node:fs';
const owner = [
  'pao_start_flow',
  'pao_query_flow',
  'pao_push_flow',
  'pao_control_node',
  'pao_decision_pack',
  'pao_change_status',
  'pao_deliver_card',
  'pao_ack_supervision',
];
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
  const isMinister = role === 'minister' || role === '部长';
  const isWorker = role === 'worker';
  pi.on('session_start', (_event, ctx) => {
    const all = new Set(pi.getAllTools().map((tool) => tool.name));
    const before = [...pi.getActiveTools()];
    if (isWorker) {
      appendFileSync(
        process.env.PAO_BENCH_ORG_ACTIVATION_LOG || '/logs/agent/organization/tool-activation.jsonl',
        JSON.stringify({
          role,
          session_id: ctx.sessionManager.getSessionId(),
          activated: [],
          active: before,
          registered: [...all],
          required_registered: [],
          worktree_host_installed: all.has('pao_worktree_list'),
          at: new Date().toISOString(),
        }) + '\n',
      );
      return; // worker 保留执行者原生工具白名单，不激活任何 owner/部长能力。
    }
    const required = isMinister ? minister : owner;
    for (const name of required) if (!all.has(name)) throw new Error('本角色未注册流水线工具：' + name);
    const optional = ['tool_search', 'pao_dispatch_brief', 'pao_save_dispatch_recon'];
    // 主控的真实职责是协调；不给独立拉部长、改流程正本或调试内核的入口。
    // 部长仍由内核角色门禁约束，保持其原有工具选择。
    const active = isMinister
      ? [...new Set([...pi.getActiveTools(), ...required, ...optional.filter((name) => all.has(name))])]
      : [...required, ...['pao_inventory'].filter(name => all.has(name))];
    pi.setActiveTools(active);
    const actual = [...pi.getActiveTools()];
    const proof = { role, session_id: ctx.sessionManager.getSessionId(), activated: required, active: actual,
      registered: [...all], required_registered: required.filter((name) => all.has(name)),
      worktree_host_installed: all.has('pao_worktree_list'), at: new Date().toISOString() };
    appendFileSync(process.env.PAO_BENCH_ORG_ACTIVATION_LOG || '/logs/agent/organization/tool-activation.jsonl', JSON.stringify(proof) + '\n');
  });
  if (isWorker) return;
  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections.benchmark_organization = isMinister
      ? '本轮已建立侦察、规划、实施、审核部门。遵守绑定节点职责与真实会话身份。只读节点调用 pao_minister_save_node_map 保存面向后继的结构化业务地图；地图默认覆盖项目业务内容，排除 .git 与当前编排目录 .pao，不把流程控制文件当输入、成果或机械验收。实施节点提交具体工作卡交执行者，不自行编码。提交工作卡或结束拆解后立即结束本轮，不用 sleep、轮询或持续等待；后台结果与监督会唤醒你。收到工人结果或监督通知后，实际检查证据再审核、补卡或请求裁定；没有待处理结果时继续结束本轮。禁止以口头总结冒充节点完成。不得读取 /tests、/solution 或寻找基准答案。'
      : '本轮必须使用预设工作流“基准开发流水线”。owner 是当前主控会话，不是人类用户。主控负责启动、查询、处理阻塞和最终报告，只协调，不自行编码，也不得读取 /tests、/solution 或修改官方任务解法与测试。把用户原始任务全文作为“任务”参数启动工作流。收到后台通知后，先实际检查实例、卡和证据。需要裁决时用 pao_decision_pack 读取卡面和原始 verification 证据，对 fail/not_run 逐项查证；不得把泛泛一句确认当作逐项 basis。接受偏差必须为每项填写当前 attempt、原始 verification_index、原 condition 和该条 basis，同时提供总验收 basis。普通未验证事项由主控处理；只有真实人工门、授权、权限或范围边界才询问人类。人工裁决后依次执行 pao_change_status → pao_deliver_card → 核实交卷结果 → pao_push_flow；pao_change_status 只改卡状态，人工链不能靠 pao_push_flow 补交卷。使用 pao_change_status 时 operator 必须与卡面 owner 完全一致；仅 owner 为“主控”的卡可用 operator=“主控”，不得伪造部门身份。failed 不可直转 delivered；合法返修保持原实例、轮次、owner、attempt 与历史：拆解中由原绑定部长继续，拆解后当前轮原卡由部长使用 pao_minister_rework_cards，审核范围变化走主控 pao_control_node action=rework。真实人工确认、恢复和重开仍走界面门。不得重建实例、伪造状态或绕过失败恢复。启动或裁决完成后结束本轮；不用 sleep、轮询或持续等待，后台结果与监督会唤醒。';
  });
}
