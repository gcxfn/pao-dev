"""用途：按2026-10-24用户授权冻结并派发第一题一次；输入当前开发源码和r3安装宿主，输出独立r4运行，不重试。"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'
OLD = BENCH / 'real-run-20261024-prepared-r3'
RUN = BENCH / 'real-run-20261024-prepared-r4'
DOCKER = 'D:/Docker/resources/bin/docker.exe'
NAME = 'pao-refactor-first-approved-20261024-r4'
MODEL = 'openai/group/deepseek'
BASE = '/run/desktop/mnt/host/d/AI/workspace'
LINUX = BASE + '/pao-dev/' + RUN.relative_to(ROOT).as_posix()
PYTHON = '/mnt/d/AI/workspace/临时文件夹/地图简报基准-20261020/f-harbor-linux/.venv/bin/python'
NODE = 'C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def docker(*args, **kwargs):
    return subprocess.run([DOCKER, *args], check=True, capture_output=True, text=True, encoding='utf-8', **kwargs)

def check_previous():
    previous = read(OLD / 'control-status.json')
    if previous['state'] != 'paused' or not previous.get('writers_stopped'):
        raise RuntimeError('上一轮尚未确认暂停')
    for name in read(OLD / 'runtime-containers.json')['containers']:
        state = json.loads(docker('inspect', '--format', '{{json .State}}', name).stdout)
        if state['Running'] or state['Paused'] or state['Restarting'] or state['Pid'] != 0:
            raise RuntimeError('上一轮仍可能写入：' + name)

def prepare():
    check_previous()
    frozen = read(OLD / 'run-freeze.json')['files']
    for item in frozen:
        if sha(OLD / item['path']) != item['sha256']:
            raise ValueError('历史冻结摘要不符：' + item['path'])
    RUN.mkdir(exist_ok=False)
    for item in frozen:
        target = RUN / item['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(OLD / item['path'], target)
    for relative in ('bench_controller.py', 'map_bench_pao/pao_agent.py', 'map_bench_pao/usage.py', 'organized-post/activate-tools.mjs'):
        shutil.copy2(BENCH / relative, RUN / relative)
    # 沿用已验证的SDK宿主装配，不用开发目录旧CLI适配器替代；补入本轮部长返修工具预检。
    probe = RUN / 'organized-post/probe-tools.mjs'
    text = probe.read_text(encoding='utf-8')
    needle = "        'pao_minister_review_worker',"
    if text.count(needle) != 1:
        raise ValueError('SDK预检接线与预期不同')
    probe.write_text(text.replace(needle, needle + "\n        'pao_minister_rework_cards',"), encoding='utf-8')
    bundle = RUN / 'organized-post/benchmark-worktree-host.mjs'
    # 标准esbuild CLI打包当前桌面服务，输出仅写新运行副本。
    subprocess.run([NODE, str(ROOT / 'desktop/node_modules/esbuild/bin/esbuild'),
        str(ROOT / '.pao/协作机制重构-20261023/benchmark-host-entry.ts'), '--bundle', '--platform=node',
        '--target=node22', '--format=esm', '--outfile=' + str(bundle)], check=True)
    source = ROOT / 'PAO'
    names = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    records = []
    # 归档当前源码与必需工程文件，不把本机配置、依赖、运行目录或凭证装入题目容器。
    with zipfile.ZipFile(RUN / 'source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(set(x.decode('utf-8') for x in names.split(b'\0') if x)):
            path = source / name
            parts = Path(name).parts
            if not path.is_file() or any(p in {'.git', 'node_modules', 'dist', '.pao', '.agents', 'archive'} for p in parts):
                continue
            if any(p.startswith('.env') or p.endswith(('.pem', '.key', '.pfx')) for p in parts):
                continue
            if len(parts) > 1 and parts[0] not in {'packages', 'scripts'}:
                continue
            data = path.read_bytes()
            archive.writestr(name.replace('\\', '/'), data)
            records.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    write(RUN / 'source-manifest.json', {'at': datetime.now(timezone.utc).isoformat(),
        'files': records, 'source_sha256': sha(RUN / 'source.zip'), 'identity': '当前开发源码快照，非整批验收通过声明'})
    kit = RUN / 'organized-post'
    write(kit / 'manifest.json', {'files': [{'path': p.relative_to(RUN).as_posix(), 'sha256': sha(p)}
        for p in sorted(kit.iterdir()) if p.is_file() and p.name != 'manifest.json']})
    config = read(OLD / 'run-config.json')
    config['job_name'] = 'pao-first-refactor-20261024-r4'
    config['jobs_dir'] = LINUX + '/jobs'
    opts = config['agents'][0]['kwargs']
    opts.update(source_archive=LINUX + '/source.zip', source_sha256=sha(RUN / 'source.zip'),
        node_archive=LINUX + '/node-v24.18.0-linux-x64.tar.xz',
        node_sha256=sha(RUN / 'node-v24.18.0-linux-x64.tar.xz'),
        organization_manifest_sha256=sha(kit / 'manifest.json'))
    write(RUN / 'run-config.json', config)
    write(RUN / 'revision.json', {'previous': OLD.name, 'authorization': '用户2026-10-24明确要求：派发第一题',
        'scope': '仅html-js-filter一次，group/deepseek high，零自动重试，原题及官方测试不变',
        'changes': '当前开发源码、当前桌面服务、B/C/D/E修复适配器及A监督器；沿用r3 SDK入口与组织配方',
        'limits': '操作系统权限隔离、外部首配方对照及主控唤醒等未完成，不作为完整机制验收通过'})
    write(RUN / 'preparation-scope.json', {'model_run_authorized': True, 'task_count': 1,
        'authorization': '用户2026-10-24：派发第一题', 'limits': '只运行一次；预检失败不作答、不自动重试；隔离仍未验收'})
    write(RUN / 'run-freeze.json', {'files': [{'path': p.relative_to(RUN).as_posix(), 'sha256': sha(p)}
        for p in sorted(RUN.rglob('*')) if p.is_file() and p.name != 'run-freeze.json']})
    result = docker('run', '--rm', '-v', 'D:/AI/workspace:/mnt/d/AI/workspace',
        '-v', 'D:/AI/workspace:' + BASE, 'pao-benchmark-controller:20261021',
        PYTHON, LINUX + '/bench_controller.py', 'validate', '--run', LINUX, timeout=120)
    print(result.stdout.strip())
    print('PREPARED', RUN)

def launch():
    check_previous()
    for item in read(RUN / 'run-freeze.json')['files']:
        if sha(RUN / item['path']) != item['sha256']:
            raise ValueError('本轮冻结摘要不符：' + item['path'])
    if (RUN / 'control-started.json').exists():
        raise RuntimeError('已启动过，禁止重放')
    cfg = read(RUN / 'run-config.json')
    if ([x['name'] for x in cfg['tasks']] != ['terminal-bench/html-js-filter'] or
        cfg['n_attempts'] != 1 or cfg['retry']['max_retries'] != 0 or
        cfg['agents'][0]['model_name'] != MODEL or cfg['agents'][0]['kwargs']['thinking'] != 'high'):
        raise ValueError('派发范围不符授权')
    with socket.create_connection(('127.0.0.1', 3425), timeout=10):
        pass
    provider = read(Path('C:/Users/ASUS/.pi/agent/models.json'))['providers']['magpie']
    key = provider['apiKey']
    if key.startswith('$'):
        key = os.environ[key[1:]]
    elif key.startswith('!'):
        raise ValueError('拒绝执行凭证命令')
    with (RUN / 'approved-launch.json').open('x', encoding='utf-8') as stream:
        json.dump({'at': datetime.now(timezone.utc).isoformat(), 'authorization': '用户2026-10-24：派发第一题',
            'model': MODEL.removeprefix('openai/'), 'thinking': 'high', 'tasks': ['terminal-bench/html-js-filter'],
            'attempts': 1, 'automatic_retries': 0, 'controller': NAME}, stream, ensure_ascii=False, indent=2)
    result = docker('run', '-d', '--name', NAME, '--restart=no', '-e', 'PAO_BENCH_API_KEY',
        '-e', 'HARBOR_TELEMETRY=0', '-e', 'PYTHONIOENCODING=utf-8',
        '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', 'D:/AI/workspace:/mnt/d/AI/workspace',
        '-v', 'D:/AI/workspace:' + BASE,
        '-v', str(ROOT / '.pao/协作机制重构-20261023/安装预检缓存') + ':/root/.cache/harbor',
        'pao-benchmark-controller:20261021', PYTHON, LINUX + '/bench_controller.py', 'run', '--run', LINUX,
        env=dict(os.environ, PAO_BENCH_API_KEY=key), timeout=60)
    (RUN / 'approved-controller-id.txt').write_text(result.stdout.strip() + '\n', encoding='utf-8')
    write(RUN / 'runtime-containers.json', {'containers': [NAME]})
    print('STARTED', NAME, result.stdout.strip()[:12])

if __name__ == '__main__':
    {'prepare': prepare, 'launch': launch}[sys.argv[1]]()
