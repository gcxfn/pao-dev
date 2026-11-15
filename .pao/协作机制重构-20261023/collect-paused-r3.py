"""用途：保留本轮暂停现场并结束采样；输入r3结果与已停止容器，输出证据快照和真实停写凭据。"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
run = root / '.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared-r3'
docker = 'D:/Docker/resources/bin/docker.exe'
source = 'html-js-filter__tafh2ht__env-main-1'
names = ['pao-refactor-first-approved-20261024-r3', source, 'html-js-filter__fmst2uk__env-main-1']
states = []
for name in names:
    state = json.loads(subprocess.check_output([docker, 'inspect', '--format', '{{json .State}}', name], text=True))
    if state['Running'] or state['Paused'] or state['Restarting'] or state['Pid'] != 0:
        raise RuntimeError('仍可能写入：' + name)
    states.append({'name': name, 'state': state})
status = json.loads((run / 'control-status.json').read_text(encoding='utf-8'))
if status['state'] != 'paused' or not status.get('writers_stopped'):
    raise RuntimeError('控制器尚未确认暂停')
out = run / 'pause-evidence'
out.mkdir(exist_ok=False)
for remote, local in [('/app/.pao', 'app-pao'), ('/app/filter.py', 'filter.py'), ('/app/selfcheck_filter.py', 'selfcheck_filter.py'), ('/app/selftest', 'selftest'), ('/tmp/harbor-pao-home/工作流/基准开发流水线.md', 'runtime-recipe.md')]:
    subprocess.run([docker, 'cp', source + ':' + remote, str(out / local)], check=True, capture_output=True)
trial_path = run / 'jobs/pao-first-refactor-20261024-r3-task-1/html-js-filter__TAfh2hT/result.json'
trial = json.loads(trial_path.read_text(encoding='utf-8'))
receipt = {'at': datetime.now(timezone.utc).isoformat(), 'state': 'paused', 'writers_stopped': True,
    'containers': states, 'model_retries': 0, 'official_reward': None, 'reward_reason': '用户主动暂停；verifier未运行，不能记0分',
    'exception_type': (trial.get('exception_info') or {}).get('exception_type'),
    'agent_execution': trial.get('agent_execution'), 'reported_usage': trial.get('agent_result'),
    'usage_caveat': '会话覆盖不完整，元数据仅观察下界；自定义端点真实单价未知，0费用不是账单',
    'input_integrity_caveat': '本次基准内部发生三次工作流实例及运行配方修改，不作为原冻结机制成功验收',
    'evidence_files': [{'path': p.relative_to(run).as_posix(), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(out.rglob('*')) if p.is_file()]}
(run / 'terminal-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(run / 'controller-exit.json').write_text(json.dumps({'at': receipt['at'], 'state': 'paused', 'exit_code': states[0]['state']['ExitCode'], 'writers_stopped': True, 'source': 'actual-docker-inspect'}) + '\n', encoding='utf-8')
print(json.dumps({'state': 'paused', 'evidence_files': len(receipt['evidence_files']), 'exception_type': receipt['exception_type'], 'official_reward': None}, ensure_ascii=False))
