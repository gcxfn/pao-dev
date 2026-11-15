"""用途：冻结修复后的三角色共同宿主与当前内核；输入r7、开发代码，输出新r8，不启动。"""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dispatch_r4', HERE / 'dispatch-first-r4.py')
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
OLD = dispatch.BENCH / 'real-run-20261024-prepared-r9'
RUN = OLD.with_name('real-run-20261024-prepared-r10')
LINUX = dispatch.BASE + '/pao-dev/' + RUN.relative_to(dispatch.ROOT).as_posix()

if not dispatch.read(OLD / 'terminal-receipt.json')['writers_stopped_observed']:
    raise RuntimeError('r7尚未确认停写')
for name in dispatch.read(OLD / 'runtime-containers.json')['containers']:
    state = json.loads(dispatch.docker('inspect', '--format', '{{json .State}}', name).stdout)
    if any(state.get(key) for key in ('Running', 'Paused', 'Restarting', 'Pid')):
        raise RuntimeError('r7仍可能写入：' + name)
files = dispatch.read(OLD / 'run-freeze.json')['files']
for item in files:
    if dispatch.sha(OLD / item['path']) != item['sha256']:
        raise ValueError('r7冻结输入改变：' + item['path'])
RUN.mkdir(exist_ok=False)
for item in files:
    target = RUN / item['path']; target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(OLD / item['path'], target)
host_source = HERE / 'benchmark-sdk-host'
for path in host_source.glob('*.mjs'):
    shutil.copy2(path, RUN / 'organized-post' / path.name)
shutil.copy2(dispatch.BENCH / 'bench_controller.py', RUN / 'bench_controller.py')
source = dispatch.ROOT / 'PAO'
names = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
records = []
with zipfile.ZipFile(RUN / 'source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(set(x.decode('utf-8') for x in names.split(b'\0') if x)):
        path = source / name; parts = Path(name).parts
        if not path.is_file() or any(p in {'.git','node_modules','dist','.pao','.agents','archive'} for p in parts): continue
        if any(p.startswith('.env') or p.endswith(('.pem','.key','.pfx')) for p in parts): continue
        if len(parts) > 1 and parts[0] not in {'packages','scripts'}: continue
        archive.write(path, name.replace('\\','/'))
        records.append({'path': name, 'sha256': dispatch.sha(path), 'bytes': path.stat().st_size})
dispatch.write(RUN / 'source-manifest.json', {'files': records,
    'source_sha256': dispatch.sha(RUN / 'source.zip'), 'identity': '修复地图派发恢复接线的当前开发源码快照'})
kit = RUN / 'organized-post'
dispatch.write(kit / 'manifest.json', {'files': [
    {'path':p.relative_to(RUN).as_posix(),'sha256':dispatch.sha(p)}
    for p in sorted(kit.iterdir()) if p.is_file() and p.name != 'manifest.json']})
config = dispatch.read(RUN / 'run-config.json')
config['job_name'] = 'pao-first-refactor-20261024-r10'; config['jobs_dir'] = LINUX + '/jobs'
kwargs = config['agents'][0]['kwargs']
for key in ('source_archive','node_archive','system_dependencies_archive'):
    kwargs[key] = LINUX + '/' + Path(kwargs[key]).name
kwargs.update(source_sha256=dispatch.sha(RUN / 'source.zip'),
    organization_manifest_sha256=dispatch.sha(kit / 'manifest.json'))
dispatch.write(RUN / 'run-config.json', config)
dispatch.write(RUN / 'revision.json', {'previous': OLD.name,
    'authorization': '用户2026-10-24：跑，不限重试，反正这次跑完',
    'changes': '地图派发阶段失效保留引用交原部长复核，监控阻塞显式标记待处理；沿用MiniMax与三角色共同宿主',
    'task_tests_model_unchanged': True, 'limits': '仍非实际OS隔离，A/P5整体未验收'})
dispatch.write(RUN / 'preparation-scope.json', {'model_run_authorized': True,
    'task_count':1,'authorization':'用户明确允许第一题不限重试直到完成；后两题不启动'})
dispatch.write(RUN / 'run-freeze.json', {'files': [
    {'path':p.relative_to(RUN).as_posix(),'sha256':dispatch.sha(p)}
    for p in sorted(RUN.rglob('*')) if p.is_file() and p.name != 'run-freeze.json']})
print(dispatch.docker('run','--rm','-v','D:/AI/workspace:/mnt/d/AI/workspace',
    '-v','D:/AI/workspace:'+dispatch.BASE,'pao-benchmark-controller:20261021',
    dispatch.PYTHON,LINUX+'/bench_controller.py','validate','--run',LINUX,timeout=120).stdout.strip())
print('PREPARED',RUN)
