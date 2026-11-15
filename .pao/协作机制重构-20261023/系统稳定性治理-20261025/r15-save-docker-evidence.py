"""用途：保存r15实际退出状态及对应Docker虚拟机重启日志，不操作容器。"""
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
out = HERE / 'r15-docker-interruption'
out.mkdir(exist_ok=True)
names = ['pao-stability-first-20261025-r15','html-js-filter__hmccyb7__env-main-1']
states = []
for name in names:
    result = subprocess.run(['D:/Docker/resources/bin/docker.exe','inspect','--format','{{json .State}}',name],capture_output=True,text=True,encoding='utf-8',timeout=20,check=True)
    states.append({'name':name,'state':json.loads(result.stdout)})
(out/'actual-container-states.json').write_text(json.dumps(states,ensure_ascii=False,indent=2),encoding='utf-8')
rows = Path('C:/Users/ASUS/AppData/Local/Docker/log/vm/init.log').read_text(encoding='utf-8').splitlines()
selected = []
non_json_lines = 0
for line in rows:
    if not line.startswith('{'):
        non_json_lines += 1
        continue
    row = json.loads(line)
    at = row.get('time','')
    # 不复制容器exec请求等可能含凭证的API日志，只取内核和引擎事件。
    if '2026-10-25T04:06:' <= at <= '2026-10-25T04:08:59' and row.get('component') in {'kmsg','command','init','control','poweroff'}:
        if any(token in row.get('msg','').lower() for token in ['boot','starting up','initialization','fatal','shut','kernel','oom']):
            selected.append(row)
(out/'docker-vm-events.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'states':len(states),'docker_events':len(selected),'non_json_lines_not_parsed':non_json_lines}))
