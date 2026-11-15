"""用途：审核初始化契约后独立冻结并启动第一题r17。

输入：当前开发来源与r16实际停写证据。输出：独立r17及后台观测。
"""
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent

def main():
    for name in ('r17-prepare.py', 'r17-launch.py'):
        if (HERE / name).exists():
            raise FileExistsError(name)
    prepare = HERE / 'r17-prepare.py'
    prepare.write_text((HERE / 'r16-prepare.py').read_text(encoding='utf-8').replace('r16', 'r17'), encoding='utf-8')
    subprocess.run([sys.executable, str(prepare)], check=True)
    launch = HERE / 'r17-launch.py'
    content = (HERE / 'r16-launch.py').read_text(encoding='utf-8').replace('r16', 'r17')
    content = content.replace("previous = BENCH / 'real-run-20261025-prepared-r15'", "previous = BENCH / 'real-run-20261025-prepared-r16'")
    launch.write_text(content, encoding='utf-8')
    subprocess.run([sys.executable, str(launch)], check=True)

if __name__ == '__main__':
    main()
