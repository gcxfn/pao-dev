"""用途：凭证环境传递修复后另建r15，保留r14失败原件。

输入：已审核的通用入口与r14显式来源。输出：r15冻结、启动和后台证据。
"""
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'

def main():
    source_script = (HERE / 'r14-prepare.py').read_text(encoding='utf-8')
    prepare = HERE / 'r15-prepare.py'
    prepare.write_text(source_script.replace('r14','r15'),encoding='utf-8')
    # r15来源继承已记录的r13明确输入，不覆盖r14。
    subprocess.run([sys.executable,str(prepare)],check=True)
    launch_script = (HERE / 'r14-launch.py').read_text(encoding='utf-8')
    launch_script = launch_script.replace('import importlib.util\n','')
    launch_script = launch_script.replace('r14','r15')
    launch_script = launch_script.replace("previous = BENCH / 'real-run-20261024-prepared-r12'","previous = BENCH / 'real-run-20261025-prepared-r14'")
    launch = HERE / 'r15-launch.py'
    launch.write_text(launch_script,encoding='utf-8')
    subprocess.run([sys.executable,str(launch)],check=True)

if __name__ == '__main__':
    main()
