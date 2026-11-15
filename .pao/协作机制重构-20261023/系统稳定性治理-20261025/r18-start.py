"""用途：SDK来源装配经审核后独立冻结并启动第一题r18。

输入：当前开发来源与r17实际停写证据。输出：独立r18及后台观测。
"""
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent

def main():
    for name in ('r18-prepare.py', 'r18-launch.py'):
        if (HERE / name).exists():
            raise FileExistsError(name)
    prepare = HERE / 'r18-prepare.py'
    prepare.write_text((HERE / 'r17-prepare.py').read_text(encoding='utf-8').replace('r17', 'r18'), encoding='utf-8')
    subprocess.run([sys.executable, str(prepare)], check=True)
    launch = HERE / 'r18-launch.py'
    content = (HERE / 'r17-launch.py').read_text(encoding='utf-8').replace('r17', 'r18')
    content = content.replace("previous = BENCH / 'real-run-20261025-prepared-r16'", "previous = BENCH / 'real-run-20261025-prepared-r17'")
    launch.write_text(content, encoding='utf-8')
    subprocess.run([sys.executable, str(launch)], check=True)

if __name__ == '__main__':
    main()
