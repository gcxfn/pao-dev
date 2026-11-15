"""用途：冻结集中治理后的第一题r17；不启动模型或修改历史运行。

输入：r13显式来源与当前开发源码。输出：r17独立冻结目录及来源。
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'
RUN = BENCH / 'real-run-20261025-prepared-r17'
NAME = 'pao-stability-first-20261025-r17'

def main():
    if RUN.exists():
        raise FileExistsError(RUN)
    source = json.loads((HERE / 'r13-sources.json').read_text(encoding='utf-8'))
    override = HERE / 'r17-network-override.yaml'
    override.write_text('networks:\n  default:\n    external: true\n    name: ' + NAME + '\n', encoding='utf-8')
    source.update(
        run_dir=str(RUN), job_name=NAME, controller_name=NAME,
        extra_docker_compose_source=str(override),
        extra_docker_compose_sha256=hashlib.sha256(override.read_bytes()).hexdigest(),
        authorization='用户2026-10-25批准集中治理；必要离线检查后仅html-js-filter一次受控整链，所有角色MiniMax-M3.1-Flash high，零本轮自动重试，不启动后两题。网络仅使用本轮独立external桥接，不改原题和官方测试。',
    )
    target = HERE / 'r17-sources.json'
    with target.open('x', encoding='utf-8') as stream:
        json.dump(source, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    subprocess.run([sys.executable, str(BENCH / 'prepare_run.py'), '--sources', str(target)], check=True)
    print(json.dumps({'run':str(RUN),'network':NAME,'network_subnet':'192.168.64.0/24'}, ensure_ascii=False))

if __name__ == '__main__':
    main()
