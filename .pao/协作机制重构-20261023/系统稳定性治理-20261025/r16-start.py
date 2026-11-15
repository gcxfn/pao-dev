"""用途：WSL内存调整生效后独立冻结并运行第一题r16。

输入：已审核的通用入口、已有显式来源和r15停写证据。
输出：r16冻结、启动及后台观测；不覆盖历史输入。
"""
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent

def main():
    for name in ('r16-prepare.py','r16-launch.py'):
        if (HERE / name).exists():
            raise FileExistsError(name)
    prepare = HERE / 'r16-prepare.py'
    prepare.write_text((HERE / 'r14-prepare.py').read_text(encoding='utf-8').replace('r14','r16'),encoding='utf-8')
    subprocess.run([sys.executable,str(prepare)],check=True)
    launch = HERE / 'r16-launch.py'
    content = (HERE / 'r15-launch.py').read_text(encoding='utf-8')
    content = content.replace('r15','r16')
    content = content.replace("previous = BENCH / 'real-run-20261025-prepared-r14'", "previous = BENCH / 'real-run-20261025-prepared-r15'")
    launch.write_text(content,encoding='utf-8')
    subprocess.run([sys.executable,str(launch)],check=True)

if __name__ == '__main__':
    main()
