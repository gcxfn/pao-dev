"""用途：复用既有资源采样器，补认本轮SDK入口；输入：旧采样器；输出：本轮脚本及来源摘要，不启动模型。"""
from pathlib import Path
import hashlib

root=Path(__file__).resolve().parent
source=root.parent/'地图简报与部门协作-20261020/benchmark/real-run-20261023/runtime-scripts/resource-monitor.py'
text=source.read_text(encoding='utf-8')
needle='        if script.startswith("/tmp/harbor-pao-source/") and script.endswith('
replacement='        if script=="/tmp/benchmark-organization/benchmark-organized-entry.mjs":\n            pao_entry="cli"\n        elif script.startswith("/tmp/harbor-pao-source/") and script.endswith('
assert text.count(needle)==1
(root/'resource-monitor.py').write_text(text.replace(needle,replacement),encoding='utf-8')
(root/'资源采样器来源.txt').write_text(str(source)+'\nSHA256 '+hashlib.sha256(source.read_bytes()).hexdigest()+'\n本轮仅增加固定SDK入口身份识别；沿用既有30秒采样，不以采样判断业务完成。\n',encoding='utf-8')
print('Prepared existing monitor with fixed SDK entry identity')
