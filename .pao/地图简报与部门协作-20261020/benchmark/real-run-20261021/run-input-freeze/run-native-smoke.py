"""用途：修正测试模型名称后复用已安装容器做合成运行检查；凭证仅进程环境传递，输出独立新证据。"""
import json
import os
from pathlib import Path
import subprocess

temp = Path('D:/AI/workspace/临时文件夹/地图简报基准-20261020')
bench = Path('D:/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020/benchmark')
model = 'openai/group/deepseek'  # Harbor 的传输前缀；线上模型仍为 group/deepseek。
for profile in ('single', 'pre-pao', 'post-pao'):
    path=bench/'configs'/f'{profile}.yaml'
    config=json.loads(path.read_text(encoding='utf-8'))
    config['agents'][0]['model_name']=model
    path.write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for file in ('fixed-manifest.json','real-run-authorization.json'):
    path=bench/file; config=json.loads(path.read_text(encoding='utf-8'))
    if file.startswith('fixed'):
        config['fairness_fixed']['model_name']=model
    else:
        config['model_name']=model
        config['model_prefix_note']='openai 是 Harbor 支持的 OpenAI-compatible 传输前缀；实际服务和模型 group/deepseek 均未切换。'
    path.write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
container='runtime-smoke__s55ejf7__env-main-1'
subprocess.run(['docker','start',container],check=True)
subprocess.run(['docker','cp',str(temp/'native-smoke.mjs'),container+':/tmp/native-smoke.mjs'],check=True)
provider=json.loads(Path('C:/Users/ASUS/.pi/agent/models.json').read_text(encoding='utf-8-sig'))['providers']['magpie']
key=provider['apiKey']; key=os.environ[key[1:]] if key.startswith('$') else key
env=dict(os.environ,PAO_BENCH_API_KEY=key)
try:
    for profile in ('single','post-pao'):
        process=subprocess.run(['docker','exec','-e','PAO_BENCH_API_KEY',container,
            '/root/.local/pao-node/bin/node','/tmp/native-smoke.mjs',profile],env=env,capture_output=True,text=True,encoding='utf-8')
        output=bench/'real-run-20261021'/f'native-smoke-{profile}.json'
        if output.exists(): raise FileExistsError(output)
        output.write_text(process.stdout,encoding='utf-8')
        print(process.stdout,flush=True)
        if process.stderr: print(process.stderr,flush=True)
        process.check_returncode()
finally:
    subprocess.run(['docker','stop','--timeout','2',container],check=True)
