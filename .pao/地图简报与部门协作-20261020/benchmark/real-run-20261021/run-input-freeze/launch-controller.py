"""用途：启动本次 Docker 宿主并仅从本机配置向进程环境传递凭证；输入：模式；输出：原始运行日志。"""
import json
import os
from pathlib import Path
import subprocess
import sys

mode = sys.argv[1]
provider = json.loads(Path('C:/Users/ASUS/.pi/agent/models.json').read_text(encoding='utf-8-sig'))['providers']['magpie']
key = provider['apiKey']
if key.startswith('$'):
    key = os.environ[key[1:]]
elif key.startswith('!'):
    raise ValueError('拒绝隐式执行凭证命令')
env = dict(os.environ, PAO_BENCH_API_KEY=key)
base = '/run/desktop/mnt/host/d/AI/workspace'
args = ['docker', 'run', '--rm', '--name', f'pao-bench-controller-{mode}-20261021',
        '-e', 'PAO_BENCH_API_KEY', '-e', 'HARBOR_TELEMETRY=0',
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-v', 'D:/AI/workspace:/mnt/d/AI/workspace',
        '-v', f'D:/AI/workspace:{base}',
        'pao-benchmark-controller:20261021',
        '/mnt/d/AI/workspace/临时文件夹/地图简报基准-20261020/f-harbor-linux/.venv/bin/python',
        base + '/临时文件夹/地图简报基准-20261020/controller.py', mode]
output = Path('D:/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020/benchmark/real-run-20261021')
output.mkdir(exist_ok=True)
with (output / f'controller-{mode}.log').open('xb') as log:
    process = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for line in iter(process.stdout.readline, b''):
        log.write(line)
        log.flush()
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
    code = process.wait()
(output / f'controller-{mode}.exit').write_text(str(code), encoding='ascii')
raise SystemExit(code)
