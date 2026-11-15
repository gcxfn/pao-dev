"""用途：补齐离线Git依赖及依赖记录后继续用户要求的第一题重启；输入r5冻结输入、官方Debian包缓存，输出独立r6，不重试模型。"""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dispatch_r4', HERE / 'dispatch-first-r4.py')
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
OLD = dispatch.RUN.with_name('real-run-20261024-prepared-r5')
RUN = OLD.with_name('real-run-20261024-prepared-r6')
dispatch.RUN = RUN
dispatch.NAME = 'pao-refactor-first-approved-20261024-r6'
dispatch.LINUX = dispatch.BASE + '/pao-dev/' + RUN.relative_to(dispatch.ROOT).as_posix()

def check_previous():
    if not dispatch.read(OLD / 'terminal-receipt.json')['writers_stopped_observed']:
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
    shutil.copy2(dispatch.BENCH / 'map_bench_pao/pao_agent.py', RUN / 'map_bench_pao/pao_agent.py')
    cache = HERE / '安装预检缓存/debian-bookworm-git'
    packages = sorted(cache.glob('*.deb'))
    if len(packages) != 35:
        raise ValueError('Git系统依赖缓存与真实验证集合不符')
    archive = RUN / 'git-system-dependencies.zip'
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_STORED) as bundle:
        for path in packages:
            bundle.write(path, path.name)
    dispatch.write(RUN / 'system-dependencies-manifest.json', {
        'source': 'Debian官方HTTPS bookworm/bookworm-security，apt-get --download-only install git',
        'target_image': '966d9a7bac7c', 'git_version_verified': '2.39.5',
        'offline_probe': '真实同镜像network=none，dpkg安装全部35包、git init/commit/rev-parse退出0',
        'files': [{'path': p.name, 'sha256': dispatch.sha(p)} for p in packages]})
    config = dispatch.read(RUN / 'run-config.json')
    config['job_name'] = 'pao-first-refactor-20261024-r6'
    config['jobs_dir'] = dispatch.LINUX + '/jobs'
    kwargs = config['agents'][0]['kwargs']
    kwargs.update(source_archive=dispatch.LINUX + '/source.zip',
        node_archive=dispatch.LINUX + '/node-v24.18.0-linux-x64.tar.xz',
        system_dependencies_archive=dispatch.LINUX + '/' + archive.name,
        system_dependencies_sha256=dispatch.sha(archive))
    dispatch.write(RUN / 'run-config.json', config)
    dispatch.write(RUN / 'revision.json', {'previous': OLD.name,
        'authorization': '用户2026-10-24：重启，保证第一题正常运行；此前r5只有安装预检，没有模型作答',
        'scope': '仅html-js-filter一次，group/deepseek high，零模型自动重试；后两题不启动',
        'changes': '离线官方Git依赖包及真实依赖版本记录，其他继承r5',
        'source_task_tests_model_unchanged_from_r4': True,
        'limits': '完整隔离等A项及P5未验收'})
    dispatch.write(RUN / 'preparation-scope.json', {'model_run_authorized': True,
        'authorization': '用户2026-10-24：重启第一题', 'task_count': 1,
        'limits': '仅一次模型作答，预检通过才启动；不以修安装为由重复付费作答'})
    dispatch.write(RUN / 'run-freeze.json', {'files': [{'path': p.relative_to(RUN).as_posix(), 'sha256': dispatch.sha(p)}
        for p in sorted(RUN.rglob('*')) if p.is_file() and p.name != 'run-freeze.json']})
    result = dispatch.docker('run', '--rm', '-v', 'D:/AI/workspace:/mnt/d/AI/workspace',
        '-v', 'D:/AI/workspace:' + dispatch.BASE, 'pao-benchmark-controller:20261021',
        dispatch.PYTHON, dispatch.LINUX + '/bench_controller.py', 'validate', '--run', dispatch.LINUX, timeout=120)
    print(result.stdout.strip())
    print('PREPARED', RUN)

if __name__ == '__main__':
    {'prepare': prepare, 'launch': dispatch.launch}[sys.argv[1]]()
