from pathlib import Path
p=Path('/mnt/d/AI/workspace/pao-dev/plans/v2-ARCHITECTURE.md')
s=p.read_text(encoding='utf-8')
old='-  表示源码和任务上下文所属项目；／ 表示共同任务状态； 表示本次实际代码读写目录。'
new='-  表示源码和任务上下文所属项目；／ 表示共同任务状态； 表示本次实际代码读写目录。'
if s.count(old)!=1: raise SystemExit('architecture root line mismatch')
p.write_text(s.replace(old,new),encoding='utf-8')
p=Path('/mnt/d/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020/阶段待验矩阵.md')
s=p.read_text(encoding='utf-8')
old='冻结后改卡报告  |'
new='冻结后改卡报告  |'
if s.count(old)!=1: raise SystemExit('matrix card marker mismatch')
s=s.replace(old,new)
old='|  在停止未确认时仍可能主动释放名额'
new='|  在停止未确认时仍可能主动释放名额'
if s.count(old)!=1: raise SystemExit('matrix dispatch marker mismatch')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
