"""用途：收取r10官方结果及停止证据；输入本轮冻结包、真实会话，输出final-receipt，不重跑模型或评分。"""
import importlib.util,json,subprocess
from pathlib import Path
from datetime import datetime,timezone
here=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('dispatch',here/'dispatch-first-r4.py')
d=importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
r=d.BENCH/'real-run-20261024-prepared-r10'
receipt=d.read(r/'terminal-receipt.json')
states=[]
for name in d.read(r/'runtime-containers.json')['containers']:
 state=json.loads(d.docker('inspect','--format','{{json .State}}',name).stdout)
 if any(state.get(k) for k in ('Running','Paused','Restarting','Pid')): raise RuntimeError('仍有写者:'+name)
 states.append({'name':name,'state':state})
for item in d.read(r/'run-freeze.json')['files']:
 if d.sha(r/item['path'])!=item['sha256']: raise RuntimeError('冻结输入变化:'+item['path'])
spec=importlib.util.spec_from_file_location('usage',r/'map_bench_pao/usage.py')
u=importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
files=[p for p in (r/'final-evidence').rglob('*.jsonl') if u.classify_session_file(p)[0]=='session']
usage=u.aggregate_session_usage(files)
d.write(r/'final-evidence/observed-usage.json',{'at':datetime.now(timezone.utc).isoformat(),'usage':usage,'files':[str(p.relative_to(r)) for p in files],'scope':'仅实际复制会话去重汇总；不保证全部辅助或未返回用量调用覆盖，费用未知'})
trial=d.read(r/'jobs/pao-first-refactor-20261024-r10-task-1/html-js-filter__KLE6d8h/result.json')
ctrf=d.read(r/'jobs/pao-first-refactor-20261024-r10-task-1/html-js-filter__KLE6d8h/verifier/ctrf.json')
context=d.read(r/'final-evidence/project-pao/benchmark/execution-contexts/card-0001-attempt-1.json')
d.write(r/'final-receipt.json',{'at':datetime.now(timezone.utc).isoformat(),'state':'officially_scored','official_rewards':trial['verifier_result']['rewards'],'exception_info':trial['exception_info'],'official_tests':ctrf['results']['summary'],'test_outcomes':[{'name':t['name'],'status':t['status']} for t in ctrf['results']['tests']],'writers_stopped_observed':True,'containers':states,'frozen_inputs_unchanged':True,'resource_summary':d.read(r/'resource-summary.json'),'observed_usage':usage,'usage_scope':'仅已收取会话的观察下界，Harbor原生统计为空，不能冒充完整账单','execution_context':context,'organization_outcome':'未完成：卡0001机械检查后因3条自报not_run留owner裁决，仍in_progress；卡0002未派，审核节点未开始；主会话关闭后挂起','runtime_errors':'原生pao.txt出现Extension error (builtin:pao): 会话控制权不匹配，保留原始日志，尚未定位根因','watch_and_sampler':'旧PID34824/16080已不存在；终局观察手动补收、资源汇总通过既有脚本生成，未冒充原后台持续存活','next':'真实官方reward=0已取得，按授权结束不刷分；机制完整通过及A/P5仍未验收，不自动重试'})
print(json.dumps({'reward':trial['verifier_result']['rewards'],'tests':ctrf['results']['summary'],'usage':usage,'stopped_containers':len(states)},ensure_ascii=False))
