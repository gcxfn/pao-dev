"""用途：保留原冻结运行，创建仅修正SDK启动参数的新版本。输入：旧冻结清单与修正入口；输出：独立r2冻结目录，不调用模型。"""
from pathlib import Path
import hashlib
import json
import shutil

root=Path(__file__).resolve().parents[2]
old=root/'.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared'
new=old.with_name(old.name+'-r2')
new.mkdir(exist_ok=False)
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
write=lambda path,value:path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for item in json.loads((old/'run-freeze.json').read_text(encoding='utf-8'))['files']:
    source=old/item['path']
    if sha(source)!=item['sha256']:
        raise ValueError('原冻结输入已变：'+item['path'])
    target=new/item['path']
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(source,target)
shutil.copy2(Path(__file__).parent/'benchmark-organized-entry.mjs',new/'organized-post/benchmark-organized-entry.mjs')
manifest=new/'organized-post/manifest.json'
data=json.loads(manifest.read_text(encoding='utf-8'))
for item in data['files']:
    item['sha256']=sha(new/item['path'])
write(manifest,data)
config=json.loads((new/'run-config.json').read_text(encoding='utf-8'))
def remap(value):
    if isinstance(value,str):return value.replace(old.name,new.name)
    if isinstance(value,list):return [remap(x) for x in value]
    if isinstance(value,dict):return {k:remap(v) for k,v in value.items()}
    return value
config=remap(config)
config['job_name']+='-r2'
config['agents'][0]['kwargs']['organization_manifest_sha256']=sha(manifest)
write(new/'run-config.json',config)
write(new/'revision.json',{'previous':old.name,'reason':'组织模式实际省略--tools，SDK入口须允许原生默认工具装配；其他任务、模型、源码包与组织配方不变','model_attempts_used':0,'authorization':'用户已批准仅第一题一次；先前在模型前暂停，不额外授权重试'})
write(new/'run-freeze.json',{'files':[{'path':p.relative_to(new).as_posix(),'sha256':sha(p)} for p in sorted(new.rglob('*')) if p.is_file()]})
print(new)
