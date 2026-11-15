"""用途：收取r4预检失败证据并复核停写；输入原版试次与实际Docker，输出补充终局记录，不重试、不评分、不改冻结输入。"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / '.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared-r4'
DOCKER = 'D:/Docker/resources/bin/docker.exe'
def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))
def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
def docker(*args):
    return subprocess.run([DOCKER, *args], capture_output=True, text=True, encoding='utf-8', timeout=30)

states = []
for name in read(RUN / 'runtime-containers.json')['containers']:
    result = docker('inspect', '--format', '{{json .State}}', name)
    result.check_returncode()
    state = json.loads(result.stdout)
    if any(state.get(key) for key in ('Running', 'Paused', 'Restarting', 'Pid')):
        raise RuntimeError('本轮仍可能写入：' + name)
    states.append({'name': name, 'state': state})
trial_path = next((RUN / 'jobs').glob('*preflight/*/result.json'))
trial = read(trial_path)
if trial.get('agent_execution') is not None or trial.get('verifier_result') is not None:
    raise RuntimeError('与预检失败状态不符，需人工核查')
freeze_ok = all(hashlib.sha256((RUN / item['path']).read_bytes()).hexdigest() == item['sha256']
    for item in read(RUN / 'run-freeze.json')['files'])
if not freeze_ok:
    raise ValueError('冻结身份改变')
out = RUN / 'final-evidence'
out.mkdir(exist_ok=False)
source = next(item['name'] for item in states if item['name'] != 'pao-refactor-first-approved-20261024-r4')
copies = []
for remote, local in (('/app/.pao', 'app-pao'), ('/logs/agent/organization', 'organization')):
    result = docker('cp', source + ':' + remote, str(out / local))
    copies.append({'remote': remote, 'returncode': result.returncode,
        'message': result.stderr.strip() or result.stdout.strip()})
    if result.returncode and 'Could not find' not in result.stderr:
        raise RuntimeError('留证失败：' + result.stderr)
summary = read(RUN / 'resource-summary.json')
receipt = {'at': datetime.now(timezone.utc).isoformat(), 'state': 'preflight_failed',
    'writers_stopped_observed': True, 'containers': states, 'frozen_inputs_unchanged': freeze_ok,
    'original_trial': trial_path.relative_to(RUN).as_posix(),
    'exception_info': trial.get('exception_info'), 'agent_execution': trial.get('agent_execution'),
    'official_reward': None, 'reward_reason': '安装阶段失败，未作答、未运行官方评分，不能填0',
    'model_usage': None, 'model_execution_started': False,
    'organization_and_worktree_evidence': copies,
    'resource_samples': summary['samples'], 'resource_stop': summary['stop'],
    'original_control_writers_stopped': read(RUN / 'control-status.json').get('writers_stopped'),
    'control_caveat': '控制器失败时保守记录false；本补充通过真实容器exited/Pid=0独立确认停写，不改原状态',
    'mechanism_caveat': '操作系统隔离等A项及P5未验收；安装未完成，不证明流程修复有效',
    'automatic_retries': 0}
write(RUN / 'final-receipt.json', receipt)
print(json.dumps({'state': receipt['state'], 'writers_stopped': True, 'frozen_inputs_unchanged': freeze_ok,
    'official_reward': None, 'samples': summary['samples']}, ensure_ascii=False))
