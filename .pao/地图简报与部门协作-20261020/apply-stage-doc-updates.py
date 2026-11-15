from pathlib import Path
base = Path('/mnt/d/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020')

def replace_once(name, old, new):
    p = base / name
    s = p.read_text(encoding='utf-8')
    count = s.count(old)
    if count != 1:
        raise RuntimeError(f'{name}: expected 1 match, got {count}')
    p.write_text(s.replace(old, new), encoding='utf-8')

p = base / 'memory-context-report.md'
s = p.read_text(encoding='utf-8')
if '5 files, 70 tests passed（作者轮次）' not in s:
    raise RuntimeError('memory author count marker missing')
needle = '测试覆盖压缩后的投影、旧事实过滤、新事实保留和原始条目保留。'
start = s.index(needle)
line_start = s.rfind('\n', 0, start) + 1
line_end = s.index('\n', start)
line = s[line_start:line_end]
if '主审最终独验' not in line:
    s = s[:line_start] + '主审最终独验为 memory 相关 5 个文件共 71 例通过；上面保留作者轮次的 70 例原始记录，最终数字以主审独验为准。' + line + s[line_end:]
p.write_text(s, encoding='utf-8')
replace_once('memory-context-report.md', '当前全包错误输出未列出本任务修改的三个源码文件。', '当前全包错误输出未列出本任务修改的三个源码文件。此后主审在 stage3 实际运行内核类型检查，退出 0、日志为空。')
