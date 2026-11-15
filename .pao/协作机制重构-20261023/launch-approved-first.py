"""用途：按本次用户明确批准后台启动新版第一题一次；输入：已冻结运行与本机模型凭证；输出：独占启动记录，不重试。"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess

root = Path(__file__).resolve().parents[2]
run = root / '.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared-r2'
docker = 'D:/Docker/resources/bin/docker.exe'
name = 'pao-refactor-first-approved-20261024-r2'
base = '/run/desktop/mnt/host/d/AI/workspace'
linux_run = base + '/pao-dev/' + run.relative_to(root).as_posix()
for item in json.loads((run / 'run-freeze.json').read_text(encoding='utf-8'))['files']:
    if hashlib.sha256((run / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('冻结输入已变更：' + item['path'])
if (run / 'control-started.json').exists():
    raise RuntimeError('控制器已经启动，拒绝重放')
previous = run.with_name('real-run-20261024-prepared')
status = json.loads((previous / 'control-status.json').read_text(encoding='utf-8'))
if status['state'] != 'paused' or not status.get('writers_stopped') or status.get('completed'):
    raise RuntimeError('原准备运行尚未确认停止，或已消耗正式作答尝试')
if list(previous.glob('task-*-config.json')):
    raise RuntimeError('原运行已生成正式任务配置，须核实是否消耗模型尝试')
with socket.create_connection(('127.0.0.1', 3425), timeout=10):
    pass
provider = json.loads(Path('C:/Users/ASUS/.pi/agent/models.json').read_text(encoding='utf-8-sig'))['providers']['magpie']
key = provider['apiKey']
if key.startswith('$'):
    key = os.environ[key[1:]]
elif key.startswith('!'):
    raise ValueError('拒绝执行凭证命令')
with (run / 'approved-launch.json').open('x', encoding='utf-8') as file:
    json.dump({'at': datetime.now(timezone.utc).isoformat(), 'authorization': '用户明确批准：仅第一题一次', 'model': 'group/deepseek', 'thinking': 'high', 'tasks': ['terminal-bench/html-js-filter'], 'attempts': 1, 'automatic_retries': 0, 'controller': name, 'scope_note': 'preparation-scope.json保留冻结时未授权事实；本记录为后来取得的单题授权'}, file, ensure_ascii=False, indent=2)
result = subprocess.run([docker, 'run', '-d', '--name', name, '--restart=no',
    '-e', 'PAO_BENCH_API_KEY', '-e', 'HARBOR_TELEMETRY=0', '-e', 'PYTHONIOENCODING=utf-8',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', 'D:/AI/workspace:/mnt/d/AI/workspace', '-v', 'D:/AI/workspace:' + base,
    '-v', str(root / '.pao/协作机制重构-20261023/安装预检缓存') + ':/root/.cache/harbor',
    'pao-benchmark-controller:20261021',
    '/mnt/d/AI/workspace/临时文件夹/地图简报基准-20261020/f-harbor-linux/.venv/bin/python',
    linux_run + '/bench_controller.py', 'run', '--run', linux_run],
    env=dict(os.environ, PAO_BENCH_API_KEY=key), check=True, capture_output=True, text=True, timeout=60)
(run / 'approved-controller-id.txt').write_text(result.stdout.strip() + '\n', encoding='utf-8')
print('STARTED', name, result.stdout.strip()[:12])
