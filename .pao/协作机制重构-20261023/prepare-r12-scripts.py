"""用途：从r11既有脚本建立独立r12准备、启动及观察脚本；不改历史运行。"""
from pathlib import Path

here = Path(__file__).resolve().parent
for stem in ('prepare-first', 'launch-first', 'watch-first'):
    text = (here / f'{stem}-r11.py').read_text(encoding='utf-8-sig')
    text = text.replace('prepared-r11', 'prepared-r12').replace('prepared-r10', 'prepared-r11')
    text = text.replace('approved-20261024-r11', 'approved-20261024-r12')
    text = text.replace('refactor-20261024-r11', 'refactor-20261024-r12')
    text = text.replace("'attempt':11", "'attempt':12")
    text = text.replace('r11独立', 'r12独立').replace('r7尚未确认停写', '上一轮尚未确认停写').replace('r7仍可能写入', '上一轮仍可能写入').replace('r7冻结输入改变', '上一轮冻结输入改变')
    text = text.replace('裁决与恢复接口代码审核后的当前开发源码快照', '提示词、便捷派发与生命周期返修经主控审核后的源码快照')
    text = text.replace('主控裁决证据正文、显式交卷、待裁决原因与关闭顺序审核修复；沿用MiniMax与三角色共同宿主', '部门简介动态注入、结构化便捷派发、角色提示及生命周期关闭返修；沿用原题、官方测试与MiniMax high')
    target = here / f'{stem}-r12.py'
    if target.exists():
        raise FileExistsError(target)
    target.write_text(text, encoding='utf-8')
print('r12 scripts prepared')
