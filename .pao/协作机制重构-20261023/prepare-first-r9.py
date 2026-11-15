"""用途：按用户要求切换MiniMax，仅冻结第一题；输入r8及修正的无模型角色预检，输出r9。"""
import importlib.util
import json
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dispatch_r4', HERE / 'dispatch-first-r4.py')
dispatch = importlib.util.module_from_spec(spec); spec.loader.exec_module(dispatch)
OLD = dispatch.BENCH / 'real-run-20261024-prepared-r8'
RUN = OLD.with_name('real-run-20261024-prepared-r9')
LINUX = dispatch.BASE + '/pao-dev/' + RUN.relative_to(dispatch.ROOT).as_posix()
MODEL = 'minimax-code/MiniMax-M3.1-Flash'
for name in dispatch.read(OLD / 'runtime-containers.json')['containers']:
    state = json.loads(dispatch.docker('inspect','--format','{{json .State}}',name).stdout)
    if any(state.get(key) for key in ('Running','Paused','Restarting','Pid')):
        raise RuntimeError('r8仍可能写入：'+name)
for item in dispatch.read(OLD/'run-freeze.json')['files']:
    if dispatch.sha(OLD/item['path']) != item['sha256']:
        raise RuntimeError('r8冻结输入改变：'+item['path'])
RUN.mkdir(exist_ok=False)
for item in dispatch.read(OLD/'run-freeze.json')['files']:
    target=RUN/item['path']; target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(OLD/item['path'],target)
shutil.copy2(HERE/'benchmark-sdk-host/probe-child-rpc.mjs',RUN/'organized-post/probe-child-rpc.mjs')
for relative in ('organized-post/setup.mjs','organized-post/kit.json'):
    path=RUN/relative
    path.write_text(path.read_text(encoding='utf-8').replace('group/deepseek',MODEL)
        .replace('DeepSeek high','MiniMax high'),encoding='utf-8')
base=RUN/'map_bench_pao/pao_agent.py'
text=base.read_text(encoding='utf-8')
needle='contextWindow=1048576, maxTokens=384000'
if text.count(needle)!=1: raise RuntimeError('模型元数据接线不符')
base.write_text(text.replace('本机已登记的 DeepSeek 组元数据','本机已登记的 MiniMax 模型元数据')
    .replace(needle,'contextWindow=1048576, maxTokens=524288'),encoding='utf-8')
kit=RUN/'organized-post'
dispatch.write(kit/'manifest.json',{'files':[
    {'path':p.relative_to(RUN).as_posix(),'sha256':dispatch.sha(p)}
    for p in sorted(kit.iterdir()) if p.is_file() and p.name!='manifest.json']})
config=dispatch.read(RUN/'run-config.json')
config.update(job_name='pao-first-refactor-20261024-r9',jobs_dir=LINUX+'/jobs')
agent=config['agents'][0]
agent.update(model_name='openai/'+MODEL,model_base_url='http://host.docker.internal:3425',
    model_api_format='anthropic_messages')
kwargs=agent['kwargs']
for key in ('source_archive','node_archive','system_dependencies_archive'):
    kwargs[key]=LINUX+'/'+Path(kwargs[key]).name
kwargs['organization_manifest_sha256']=dispatch.sha(kit/'manifest.json')
dispatch.write(RUN/'run-config.json',config)
dispatch.write(RUN/'revision.json',{'previous':OLD.name,
    'authorization':'用户：或者用minimax吧，节省点token，只是过流程；此前已授权第一题不限重试直到完成',
    'changes':'使用本机已登记MiniMax-M3.1-Flash/high及anthropic-messages协议；修正无模型子角色预检缺少工作流身份夹具',
    'source_task_tests_unchanged_from_r8':True,
    'limits':'模型已变，仅验证流程，不能作DeepSeek前后质量/费用对照，不承诺实际token或费用下降'})
dispatch.write(RUN/'preparation-scope.json',{'model_run_authorized':True,'task_count':1,
    'authorization':'用户授权MiniMax跑第一题流程，允许失败修复后重试；后两题不启动'})
dispatch.write(RUN/'run-freeze.json',{'files':[
    {'path':p.relative_to(RUN).as_posix(),'sha256':dispatch.sha(p)}
    for p in sorted(RUN.rglob('*')) if p.is_file() and p.name!='run-freeze.json']})
result=dispatch.docker('run','--rm','-v','D:/AI/workspace:/mnt/d/AI/workspace',
    '-v','D:/AI/workspace:'+dispatch.BASE,'pao-benchmark-controller:20261021',
    dispatch.PYTHON,LINUX+'/bench_controller.py','validate','--run',LINUX,timeout=120)
print(result.stdout.strip()); print('PREPARED',RUN)
