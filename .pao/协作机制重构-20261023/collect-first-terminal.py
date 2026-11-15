"""用途：收取第一题终局；输入本轮结果与Docker状态，输出停写凭据并停止本轮采样。"""
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[2]
run = root / '.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared-r2'
names = ['pao-refactor-first-approved-20261024-r2', 'html-js-filter__faxwmr5__env-main-1', 'html-js-filter__8nzfkgf__env-main-1']
states = []
for name in names:
    result = subprocess.run(['D:/Docker/resources/bin/docker.exe', 'inspect', '--format', '{{json .State}}', name], check=True, capture_output=True, text=True)
    state = json.loads(result.stdout)
    if state['Running'] or state['Paused'] or state['Restarting'] or state['Pid'] != 0:
        raise RuntimeError(f'本轮容器仍可能写入：{name}')
    states.append({'name': name, 'state': state})
summary = json.loads((run / 'task-1-summary.json').read_text(encoding='utf-8-sig'))
trial = summary['trial_results'][0]
if trial['agent_execution'] is not None or trial['verifier_result'] is not None:
    raise RuntimeError('结果与预期安装失败不一致，需重新人工核查')
receipt = {
    'at': datetime.now(timezone.utc).isoformat(), 'state': 'execution_error',
    'containers': states, 'writers_stopped': True, 'automatic_retries': 0,
    'official_reward': None, 'official_reward_reason': '安装阶段失败，未运行官方评分；聚合mean不是奖励',
    'exception_type': trial['exception_info']['exception_type'],
    'exception_reason': '下载Node.js时curl退出35，nodejs.org:443 SSL_ERROR_SYSCALL',
    'agent_execution_started': False, 'model_calls_by_trial_lifecycle': 0,
    'reported_input_tokens': summary['stats']['n_input_tokens'],
    'reported_output_tokens': summary['stats']['n_output_tokens'],
    'reported_cost_usd': summary['stats']['cost_usd'],
    'organization_and_worktrees': '本次正式试次未进入模型执行，没有部门派发或审核工作树证据；既有离线/预检证据不替代本次实测',
    'source': 'task-1-summary.json',
}
(run / 'terminal-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(run / 'controller-exit.json').write_text(json.dumps({'at': receipt['at'], 'exit_code': states[0]['state']['ExitCode'], 'state': 'execution_error', 'writers_stopped': True, 'source': 'actual-docker-inspect'}, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt, ensure_ascii=False, indent=2))
