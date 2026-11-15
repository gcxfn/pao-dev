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
      : '本轮使用预设工作流“基准开发流水线”，把用户原始任务全文作为“任务”参数启动。owner 是当前主控会话；负责协调、处理阻塞和最终报告，不自行编码，不读取 /tests、/solution 或修改官方任务与测试。收到后台通知后先查实例、卡和证据。卡验收：用 pao_decision_pack 核对原始 verification，对 fail/not_run 逐项查证。接受偏差时，accepted_deviations 每项填写当前 attempt、原始 verification_index、原 condition 和具体 basis，同时提供总验收 basis。依次 pao_change_status → pao_deliver_card → 核实交卷结果；状态变更不等于交卷。operator 必须与卡面 owner 一致，仅 owner 为“主控”的卡可用 operator=“主控”。节点裁定：用 pao_query_flow 核对当前实例、节点、轮次、裁定通道和暂停。若是匹配的等待主控裁定，在卡验收、交卷完成后调用 pao_control_node action=rule，携 instance、node、round、result（pass/change/reject）、reason 和 references（真实 file:line）。普通节点 pass 只解除本次裁定暂停，不交付卡，也不替后续独立审核放行。裁定处理完再 pao_push_flow。普通质量问题由主控依据证据处理；人工裁定、真实人工确认、恢复、重开及新增授权仍须用户从界面确认，不用 confirm/resume/reopen 处理普通质量阻塞。failed 不可直转 delivered；返修保留原实例、轮次、owner、attempt 历史：拆解中由原部长继续，拆解后当前轮原卡由部长用 pao_minister_rework_cards，审核回边用 pao_control_node action=rework。启动或处理完成后结束本轮；不用 sleep 或轮询，后台结果会唤醒。';
  });
}
