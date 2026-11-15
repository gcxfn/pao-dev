"""用途：收取r6真实停写现场，用修复监督器回放原控制记录；输入停止容器与原版试次，输出终局和无模型回放证据，不新增作答。"""
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'
RUN = BENCH / 'real-run-20261024-prepared-r6'
def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))
def docker(*args):
    return subprocess.run(['D:/Docker/resources/bin/docker.exe', *args],
        capture_output=True, text=True, encoding='utf-8', timeout=60)
spec = importlib.util.spec_from_file_location('fixed_controller', BENCH / 'bench_controller.py')
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
states = []
for name in read(RUN / 'runtime-containers.json')['containers']:
    result = docker('inspect', '--format', '{{json .State}}', name)
    result.check_returncode()
    state = json.loads(result.stdout)
    if any(state.get(key) for key in ('Running', 'Paused', 'Restarting', 'Pid')):
        raise RuntimeError('本轮仍可能写入：' + name)
    states.append({'name': name, 'state': state})
trial_path = next((RUN / 'jobs').glob('*task-1/*/result.json'))
trial = read(trial_path)
source = controller.compose_project(trial['trial_name']) + '-main-1'
out = RUN / 'final-evidence'
project = out / 'project'
project.mkdir(parents=True, exist_ok=False)
copies = []
for remote, target in (('/app/.pao', project), ('/logs/agent/organization', out / 'organization'),
    ('/tmp/harbor-pi-agent/benchmark-worktrees/catalogs.json', out / 'worktree-catalogs.json')):
    result = docker('cp', source + ':' + remote, str(target))
    copies.append({'remote': remote, 'returncode': result.returncode, 'message': result.stderr.strip()})
    if result.returncode and 'Could not find' not in result.stderr:
        raise RuntimeError('实际取证失败：' + result.stderr)
replay = ROOT.parent / '临时文件夹/停链日期验证-20261024/r6-real-replay'
replay.mkdir(parents=True, exist_ok=False)
shutil.copy2(RUN / 'mechanism-identity.json', replay / 'mechanism-identity.json')
first = controller.observe_control_tree(replay, project)
second = controller.observe_control_tree(replay, project)
assert first['observation']['status'] == second['observation']['status'] == 'bound'
assert first['business_event_key'] == second['business_event_key']
replay_evidence = {'at': datetime.now(timezone.utc).isoformat(), 'status': 'passed',
    'source': str(project), 'model_calls': 0, 'observation': second['observation'],
    'latest_business_event': second['latest_business_event'],
    'progress_json_written': (replay / 'mechanism-progress.json').is_file(),
    'limits': '真实停止现场离线回放；不代表新一次模型链已通过'}
controller.write(replay / 'evidence.json', replay_evidence)
freeze_ok = all(controller.digest(RUN / item['path']) == item['sha256'] for item in read(RUN / 'run-freeze.json')['files'])
assert freeze_ok
resources = read(RUN / 'resource-summary.json')
controller.write(RUN / 'final-receipt.json', {'at': datetime.now(timezone.utc).isoformat(),
    'state': 'mechanism_stopped', 'reason': '监督器SafeLoader把未加引号时间转为datetime，JSON序列化失败',
    'writers_stopped_observed': True, 'containers': states, 'frozen_inputs_unchanged': freeze_ok,
    'official_rewards': (trial.get('verifier_result') or {}).get('rewards'),
    'reward_note': '未运行官方评分，不填0；Harbor进度Mean不当作官方奖励',
    'exception_info': trial.get('exception_info'), 'agent_execution': trial.get('agent_execution'),
    'agent_result': trial.get('agent_result'), 'evidence_collection': copies,
    'resource_samples': resources['samples'], 'resource_stop': resources['stop'],
    'fixed_controller_replay': str(replay / 'evidence.json'), 'automatic_retries': 0,
    'caveat': '修复只在开发监督器，冻结r6未改；真实调用已发生，不自行再作答；A/P5未验收'})
print(json.dumps({'writers_stopped': True, 'frozen_inputs_unchanged': freeze_ok,
    'replay': 'passed', 'reward': (trial.get('verifier_result') or {}).get('rewards'),
    'agent_execution': trial.get('agent_execution')}, ensure_ascii=False))
