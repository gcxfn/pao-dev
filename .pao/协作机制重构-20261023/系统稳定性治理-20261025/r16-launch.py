"""用途：单次启动已冻结r16并后台观测；凭证仅放子进程环境。

输入：已有本机模型凭证、r16冻结配置、r12停写回执。
输出：本轮启动回执、后台PID与日志。只创建本轮专用网络与进程。
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'
RUN = BENCH / 'real-run-20261025-prepared-r16'
NAME = 'pao-stability-first-20261025-r16'
DOCKER = 'D:/Docker/resources/bin/docker.exe'

def main():
    sys.path.insert(0, str(BENCH))
    import launch_run
    import runner_common
    if (RUN / 'approved-controller-id.txt').exists():
        raise FileExistsError('本轮已启动，禁止重放')
    previous = BENCH / 'real-run-20261025-prepared-r15'
    launch_run.verify_previous(previous)
    with socket.create_connection(('127.0.0.1',3425),timeout=5):
        pass
    env = dict(os.environ)
    if not env.get('PAO_BENCH_API_KEY'):
        models = json.loads(Path('C:/Users/ASUS/.pi/agent/models.json').read_text(encoding='utf-8'))
        key = models['providers']['magpie']['apiKey']
        if not isinstance(key,str) or not key or key.startswith('!'):
            raise ValueError('现有凭证不是支持的值或环境变量引用')
        env['PAO_BENCH_API_KEY'] = env.get(key[1:]) if key.startswith('$') else key
        if not env['PAO_BENCH_API_KEY']:
            raise ValueError('现有凭证引用为空')
    snapshot = HERE / 'r16-runtime-snapshot'
    snapshot.mkdir(exist_ok=False)
    files = {}
    for name in ('launch_run.py','watch_run.py','runner_common.py','bench_controller.py'):
        destination = snapshot / name
        shutil.copy2(BENCH / name,destination)
        files[name] = hashlib.sha256(destination.read_bytes()).hexdigest()
    runner_common.write_json(snapshot / 'manifest.json',files)
    created = subprocess.run([DOCKER,'network','create','--driver','bridge','--subnet','192.168.64.0/24','--label','pao.run='+NAME,NAME],capture_output=True,text=True,encoding='utf-8',check=True)
    runner_common.write_json(RUN / 'network-receipt.json',{'name':NAME,'id':created.stdout.strip(),'subnet':'192.168.64.0/24','scope':'this_run_only'})
    result = launch_run.launch(RUN,previous=previous,environ=env)
    monitor = ROOT / '.pao/协作机制重构-20261023/resource-monitor.py'
    processes = {}
    for role,args in (
        ('watch',[str(snapshot/'watch_run.py'),'--run',str(RUN),'--controller',NAME,'--interval','15','--max-seconds','7200']),
        ('resource_monitor',[str(monitor),'--run-dir',str(RUN),'--controller-name',NAME,'--interval','30']),
    ):
        with (RUN/(role+'.stdout.log')).open('xb') as out, (RUN/(role+'.stderr.log')).open('xb') as err:
            process = subprocess.Popen([sys.executable,*args],stdout=out,stderr=err,stdin=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW,env={k:v for k,v in env.items() if k!='PAO_BENCH_API_KEY'})
        processes[role]={'pid':process.pid,'script':args[0]}
    runner_common.write_json(RUN/'background-processes.json',processes)
    print(json.dumps({'launch':result,'background_processes':processes},ensure_ascii=False))

if __name__ == '__main__':
    main()
