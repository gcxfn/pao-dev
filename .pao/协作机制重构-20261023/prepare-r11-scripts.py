"""用途：为用户新授权建立r11脚本；输入已审核r10模板，输出独立r11准备、启动和观察脚本，不修改历史运行。"""
from pathlib import Path
here=Path(__file__).resolve().parent
for stem in ('prepare-first','launch-first','watch-first'):
    text=(here/f'{stem}-r10.py').read_text(encoding='utf-8-sig')
    text=text.replace('prepared-r10','prepared-r11').replace('prepared-r9','prepared-r10')
    text=text.replace('approved-20261024-r10','approved-20261024-r11')
    text=text.replace('refactor-20261024-r10','refactor-20261024-r11')
    text=text.replace("'attempt':10", "'attempt':11")
    text=text.replace('地图派发阶段失效保留引用交原部长复核，监控阻塞显式标记待处理；沿用MiniMax与三角色共同宿主','主控裁决证据正文、显式交卷、待裁决原因与关闭顺序审核修复；沿用MiniMax与三角色共同宿主')
    text=text.replace('修复地图派发恢复接线的当前开发源码快照','裁决与恢复接口代码审核后的当前开发源码快照')
    text=text.replace('用户要求改用MiniMax，只过流程；第一题不限重试直到完成的授权继续有效','用户2026-10-24重新授权：重启第一题；沿用MiniMax high，仅第一题')
    text=text.replace('用户改用MiniMax，只过流程；允许第一题失败修复后重试直到完成','用户2026-10-24重新授权：重启第一题；仅html-js-filter，沿用MiniMax high')
    text=text.replace('用户2026-10-24：跑，不限重试，反正这次跑完','用户2026-10-24：重启第一题')
    text='"""用途：r11独立'+stem+'；用户重新授权第一题，原题与官方测试不变，MiniMax high。"""\n'+text[text.index('\n')+1:]
    (here/f'{stem}-r11.py').write_text(text,encoding='utf-8')
print('r11 scripts prepared')
