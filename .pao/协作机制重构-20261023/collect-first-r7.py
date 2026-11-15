"""用途：核查r7停止并收取摘要；输入原始结果/冻结清单，输出补充终局证据，不评分、不作答。"""
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dispatch_r4', HERE / 'dispatch-first-r4.py')
dispatch = importlib.util.module_from_spec(spec); spec.loader.exec_module(dispatch)
run = dispatch.BENCH / 'real-run-20261024-prepared-r7'
states = []
for name in dispatch.read(run / 'runtime-containers.json')['containers']:
    state = json.loads(dispatch.docker('inspect','--format','{{json .State}}',name).stdout)
    if any(state.get(key) for key in ('Running','Paused','Restarting','Pid')):
        raise RuntimeError('r7仍可能写入：'+name)
    states.append({'name':name,'state':state})
for item in dispatch.read(run / 'run-freeze.json')['files']:
    if dispatch.sha(run / item['path']) != item['sha256']:
        raise RuntimeError('冻结输入改变：'+item['path'])
receipt = dispatch.read(run / 'terminal-receipt.json')
dispatch.write(run / 'final-receipt.json', {
    'state':receipt['control_status']['state'], 'reason':receipt['control_status']['stop_reason'],
    'writers_stopped_observed':True, 'containers':states,'frozen_inputs_unchanged':True,
    'official_rewards':receipt['official_rewards'], 'agent_results':receipt['agent_results'],
    'exception_types':[e.get('exception_type') if e else None for e in receipt['exceptions']],
    'resource_summary':dispatch.read(run/'resource-summary.json'),
    'evidence':'final-evidence/project-pao、organization及pao.txt已从本轮停止容器真实复制',
    'root_causes':'自动部长持续工具调用但触发固定10分钟任务超时；子角色CLI未继承SDK工作树装配；主控随后移动实例正本，被监督正确拦截',
    'reward_note':'无官方评分不填0，不修改或重新评分此轮',
    'next':'按用户不限重试授权修复公共子进程接线后建立r8；后两题不启动'})
print('r7 stopped, frozen unchanged, evidence collected, official reward unknown')
