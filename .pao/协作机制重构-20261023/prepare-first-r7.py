"""用途：仅准备日期解析修复后的r7；输入r6冻结包和开发监督器，输出新冻结包，不启动模型。"""
import importlib.util
import json
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dispatch_r4', HERE / 'dispatch-first-r4.py')
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
OLD = dispatch.BENCH / 'real-run-20261024-prepared-r6'
RUN = OLD.with_name('real-run-20261024-prepared-r7')
LINUX = dispatch.BASE + '/pao-dev/' + RUN.relative_to(dispatch.ROOT).as_posix()

if not dispatch.read(OLD / 'final-receipt.json')['writers_stopped_observed']:
    raise RuntimeError('r6尚未确认停写')
for name in dispatch.read(OLD / 'runtime-containers.json')['containers']:
    state = json.loads(dispatch.docker('inspect', '--format', '{{json .State}}', name).stdout)
    if any(state.get(key) for key in ('Running', 'Paused', 'Restarting', 'Pid')):
        raise RuntimeError('r6仍可能写入：' + name)
files = dispatch.read(OLD / 'run-freeze.json')['files']
for item in files:
    if dispatch.sha(OLD / item['path']) != item['sha256']:
        raise ValueError('r6冻结输入改变：' + item['path'])
RUN.mkdir(exist_ok=False)
for item in files:
    target = RUN / item['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(OLD / item['path'], target)
shutil.copy2(dispatch.BENCH / 'bench_controller.py', RUN / 'bench_controller.py')
config = dispatch.read(RUN / 'run-config.json')
config['job_name'] = 'pao-first-refactor-20261024-r7'
config['jobs_dir'] = LINUX + '/jobs'
kwargs = config['agents'][0]['kwargs']
for key in ('source_archive', 'node_archive', 'system_dependencies_archive'):
    kwargs[key] = LINUX + '/' + Path(kwargs[key]).name
dispatch.write(RUN / 'run-config.json', config)
dispatch.write(RUN / 'revision.json', {
    'previous': OLD.name, 'authorization': '尚未授权新的付费作答，仅准备',
    'changes': '监督器安全YAML读取保留时间原文，其他业务输入继承r6',
    'source_task_tests_model_unchanged_from_r6': True,
    'evidence': '16项离线回归及r6真实流程记录回放通过，无新模型调用'})
dispatch.write(RUN / 'preparation-scope.json', {
    'model_run_authorized': False, 'task_count': 1,
    'limits': '只准备，不启动；r6已发生模型调用，新增作答需明确授权'})
dispatch.write(RUN / 'run-freeze.json', {'files': [
    {'path': p.relative_to(RUN).as_posix(), 'sha256': dispatch.sha(p)}
    for p in sorted(RUN.rglob('*')) if p.is_file() and p.name != 'run-freeze.json']})
result = dispatch.docker('run', '--rm', '-v', 'D:/AI/workspace:/mnt/d/AI/workspace',
    '-v', 'D:/AI/workspace:' + dispatch.BASE, 'pao-benchmark-controller:20261021',
    dispatch.PYTHON, LINUX + '/bench_controller.py', 'validate', '--run', LINUX, timeout=120)
print(result.stdout.strip())
print('PREPARED_ONLY', RUN)
