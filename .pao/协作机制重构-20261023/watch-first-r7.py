"""用途：只观测r7本轮容器并收取终局、停止采样；输入冻结运行目录，输出本轮运行留档；不作答、不重试、不评分。"""
import importlib.util
import json
from pathlib import Path
import subprocess
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / '.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared-r7'
NAME = 'pao-refactor-first-approved-20261024-r7'
DOCKER = 'D:/Docker/resources/bin/docker.exe'
spec = importlib.util.spec_from_file_location('r7_controller', RUN / 'bench_controller.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def write(name, value):
    module.write(RUN / name, value)

def command(*args):
    return subprocess.check_output([DOCKER, *args], text=True, encoding='utf-8', timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

def states():
    projects = set()
    for path in (RUN / 'jobs').glob('*/*/config.json'):
        trial = read(path).get('trial_name')
        if trial:
            projects.add(module.compose_project(trial))
            projects.add(module.compose_project(trial, 'verifier'))
    own = []
    rows = command('ps', '-a', '--format', '{{json .}}').splitlines()
    for row in rows:
        item = json.loads(row)
        labels = dict(pair.split('=', 1) for pair in item.get('Labels', '').split(',') if '=' in pair)
        project = labels.get('com.docker.compose.project', '')
        if item['Names'] == NAME or any(project == p or project.startswith(p + '__') for p in projects):
            state = json.loads(command('inspect', '--format', '{{json .State}}', item['Names']))
            own.append({'name': item['Names'], 'state': state})
    if not any(item['name'] == NAME for item in own):
        raise RuntimeError('本轮控制器不见，不能声称正常退出')
    write('runtime-containers.json', {'containers': [item['name'] for item in own]})
    return own

try:
    while True:
        observed = states()
        controller = next(item['state'] for item in observed if item['name'] == NAME)
        if not controller['Running'] and not controller['Restarting']:
            break
        time.sleep(15)
    stopped = all(not any(item['state'].get(key) for key in ('Running', 'Paused', 'Restarting', 'Pid')) for item in observed)
    result_paths = sorted((RUN / 'jobs').glob('*task-1/result.json'))
    trial_paths = sorted((RUN / 'jobs').glob('*task-1/*/result.json'))
    trials = [read(path) for path in trial_paths]
    # 官方奖励仅取真实verifier_result；没有结果或评分失败保持未知。
    rewards = [row.get('verifier_result', {}).get('rewards') if row.get('verifier_result') else None for row in trials]
    receipt = {'at': datetime.now(timezone.utc).isoformat(), 'control_status': read(RUN / 'control-status.json'),
        'containers': observed, 'writers_stopped_observed': stopped, 'automatic_retries': 0,
        'official_rewards': rewards or None,
        'reward_note': '仅原版试次verifier_result；缺失不填0，不追加评分或作答',
        'job_results': [str(path.relative_to(RUN)) for path in result_paths],
        'trial_results': [str(path.relative_to(RUN)) for path in trial_paths],
        'exceptions': [row.get('exception_info') for row in trials],
        'agent_results': [row.get('agent_result') for row in trials],
        'mechanism_acceptance': 'unverified', 'os_isolation_implemented': False}
    write('terminal-receipt.json', receipt)
    (RUN / 'controller.log').write_text(command('logs', NAME), encoding='utf-8')
    if stopped:
        write('controller-exit.json', {'at': receipt['at'], 'writers_stopped': True, 'controller_exit_code': controller['ExitCode']})
    else:
        write('monitor-stop.json', {'at': receipt['at'], 'reason': '控制器退出但本轮容器未全部停写；不误报停止'})
except BaseException as error:
    write('watch-error.json', {'at': datetime.now(timezone.utc).isoformat(), 'error': repr(error)})
    raise

