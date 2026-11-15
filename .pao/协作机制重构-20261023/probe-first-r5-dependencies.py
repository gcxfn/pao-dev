"""用途：在第一题原镜像断网验证真实ZIP/XZ解压和Node安装；输入r5冻结归档，输出无模型探针证据。"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'
RUN = BENCH / 'real-run-20261024-prepared-r5'
# 复用已有测试的Harbor依赖替身，仅取得纯命令生成函数；Docker内执行真实Python/Node，不模拟安装。
sys.path.insert(0, str(BENCH))
spec = importlib.util.spec_from_file_location('probe_adapter', BENCH / 'test_pao_agent.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
config = json.loads((RUN / 'run-config.json').read_text(encoding='utf-8'))
sha = config['agents'][0]['kwargs']['node_sha256']
command = ('set -euo pipefail; python3 -c "import zipfile,tarfile,lzma"; '
    'python3 -m zipfile -e /inputs/source.zip /tmp/probe-source; '
    'python3 -m zipfile -e /model-data.zip /tmp/probe-source; '
    'cp /inputs/node-v24.18.0-linux-x64.tar.xz /tmp/pao-node.tar.xz; '
    + adapter.PAOAgent._node_install_command(sha))
model_data = BENCH / 'build-data-freeze-20261021/model-data.zip'
result = subprocess.run(['D:/Docker/resources/bin/docker.exe', 'run', '--rm', '--network', 'none',
    '--name', 'pao-r5-archive-probe', '-v', str(RUN) + ':/inputs:ro',
    '-v', str(model_data) + ':/model-data.zip:ro', '966d9a7bac7c', 'bash', '-lc', command],
    capture_output=True, text=True, encoding='utf-8', timeout=180)
evidence = {'image': '966d9a7bac7c', 'network': 'none', 'model_calls': 0,
    'exit_code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr,
    'checks': '真实当前源码ZIP与模型数据ZIP解压、冻结Node XZ校验与Python解压、Node/npm版本执行',
    'limits': '不代表npm依赖安装、SDK预检或模型链通过'}
(RUN / 'dependency-probe.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
result.check_returncode()
print(result.stdout)
