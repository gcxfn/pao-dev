"""用途：对照固定离线首轮请求组成；输入：实际SDK捕获的前后摘要；输出：可复核字符差值，不推算token或费用。"""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
before = json.loads((root / '请求组成测量-基线/汇总.json').read_text(encoding='utf-8'))
after = json.loads((root / '请求组成测量/汇总.json').read_text(encoding='utf-8'))
rows = []
for current in after['rows']:
    if current['turn'] != 1:
        continue
    previous = next(row for row in before['rows'] if row['role'] == current['role'] and row['turn'] == 1)
    old = previous['serializedContextCharacters']
    new = current['serializedContextCharacters']
    rows.append({'role': current['role'], 'before': old, 'after': new, 'delta': new - old, 'percent': round((new - old) / old * 100, 3)})
result = {'scope': '同一SDK与依赖、同一目录和固定离线输入；旧PAO业务源码对照当前构建，并非两个完整历史发行版。仅装PAO扩展，未装完整CLI内建扩展；继承开发项目AGENTS、部长无节点、无隔离宿主。JSON序列化UTF-16字符，不是HTTP字节/token/费用/质量。', 'conclusion': '此固定装配中主控和部长请求略增，工人不变；不能宣称整体请求负担下降。实际派发工人用户消息减329字符是另一个测量范围。', 'rows': rows}
(root / '请求组成前后对照.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(rows, ensure_ascii=False))
