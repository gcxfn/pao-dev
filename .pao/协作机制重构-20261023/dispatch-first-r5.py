"""用途：修复r4安装依赖后按用户新授权启动第一题r5；输入r4冻结输入及开发适配器，输出新运行，不重放历史、不重试模型。"""
import importlib.util
import json
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dispatch_r4', HERE / 'dispatch-first-r4.py')
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
OLD = dispatch.RUN
RUN = OLD.with_name('real-run-20261024-prepared-r5')
dispatch.RUN = RUN
dispatch.NAME = 'pao-refactor-first-approved-20261024-r5'
dispatch.LINUX = dispatch.BASE + '/pao-dev/' + RUN.relative_to(dispatch.ROOT).as_posix()

def check_previous():
    if not dispatch.read(OLD / 'final-receipt.json')['writers_stopped_observed']:
        raise RuntimeError('上一轮未确认停止')
    for name in dispatch.read(OLD / 'runtime-containers.json')['containers']:
        state = json.loads(dispatch.docker('inspect', '--format', '{{json .State}}', name).stdout)
        if any(state.get(key) for key in ('Running', 'Paused', 'Restarting', 'Pid')):
            raise RuntimeError('上一轮仍可能写入：' + name)

dispatch.check_previous = check_previous

def prepare():
    check_previous()
    files = dispatch.read(OLD / 'run-freeze.json')['files']
    for item in files:
        if dispatch.sha(OLD / item['path']) != item['sha256']:
            raise ValueError('上一轮冻结输入改变：' + item['path'])
    RUN.mkdir(exist_ok=False)
    for item in files:
        target = RUN / item['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(OLD / item['path'], target)
    for relative in ('map_bench_pao/pao_agent.py', 'bench_controller.py'):
        shutil.copy2(dispatch.BENCH / relative, RUN / relative)
    config = dispatch.read(RUN / 'run-config.json')
    config['job_name'] = 'pao-first-refactor-20261024-r5'
    config['jobs_dir'] = dispatch.LINUX + '/jobs'
    kwargs = config['agents'][0]['kwargs']
    kwargs.update(source_archive=dispatch.LINUX + '/source.zip',
        node_archive=dispatch.LINUX + '/node-v24.18.0-linux-x64.tar.xz')
    dispatch.write(RUN / 'run-config.json', config)
    dispatch.write(RUN / 'revision.json', {'previous': OLD.name,
        'authorization': '用户2026-10-24：重启，保证第一题正常运行',
        'scope': '仅html-js-filter一次，group/deepseek high，零自动重试；后两题不启动',
        'changes': '复用镜像Python标准库解压ZIP与Node XZ，移除unzip/xz系统包依赖；保留原始安装异常',
        'source_task_tests_model_unchanged_from_r4': True,
        'limits': '操作系统隔离等A项、P5收益未验收；不能保证外部服务永不失败'})
    dispatch.write(RUN / 'preparation-scope.json', {'model_run_authorized': True,
        'authorization': '用户2026-10-24：重启第一题', 'task_count': 1,
        'limits': '仅一次；真实安装预检通过才作答，保留所有原题与测试边界'})
    dispatch.write(RUN / 'run-freeze.json', {'files': [{'path': p.relative_to(RUN).as_posix(), 'sha256': dispatch.sha(p)}
        for p in sorted(RUN.rglob('*')) if p.is_file() and p.name != 'run-freeze.json']})
    result = dispatch.docker('run', '--rm', '-v', 'D:/AI/workspace:/mnt/d/AI/workspace',
        '-v', 'D:/AI/workspace:' + dispatch.BASE, 'pao-benchmark-controller:20261021',
        dispatch.PYTHON, dispatch.LINUX + '/bench_controller.py', 'validate', '--run', dispatch.LINUX, timeout=120)
    print(result.stdout.strip())
    print('PREPARED', RUN)

if __name__ == '__main__':
    {'prepare': prepare, 'launch': dispatch.launch}[sys.argv[1]]()
