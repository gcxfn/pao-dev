"""用途：核查r9停止并收取摘要；输入原始结果/冻结清单，输出补充终局证据，不评分、不作答。"""
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dispatch_r4', HERE / 'dispatch-first-r4.py')
dispatch = importlib.util.module_from_spec(spec); spec.loader.exec_module(dispatch)
run = dispatch.BENCH / 'real-run-20261024-prepared-r9'
states = []
for name in dispatch.read(run / 'runtime-containers.json')['containers']:
    state = json.loads(dispatch.docker('inspect','--format','{{json .State}}',name).stdout)
    if any(state.get(key) for key in ('Running','Paused','Restarting','Pid')):
        raise RuntimeError('r9仍可能写入：'+name)
    states.append({'name':name,'state':state})
for item in dispatch.read(run / 'run-freeze.json')['files']:
    if dispatch.sha(run / item['path']) != item['sha256']:
        raise RuntimeError('冻结输入改变：'+item['path'])
receipt = dispatch.read(run / 'terminal-receipt.json')
dispatch.write(run / 'final-receipt.json', {
    'state':receipt['control_status']['state'], 'reason':'原卡返修时派发阶段地图失效未接入已有复核路径，保留现场后暂停',
    'writers_stopped_observed':True, 'containers':states,'frozen_inputs_unchanged':True,
    'official_rewards':receipt['official_rewards'], 'agent_results':receipt['agent_results'],
    'exception_types':[e.get('exception_type') if e else None for e in receipt['exceptions']],
    'resource_summary':dispatch.read(run/'resource-summary.json'),
    'evidence':'final-evidence/project-pao、organization及pao.txt已从本轮停止容器真实复制',
    'root_causes':'工人回执verification缺条件被拒，随后返修触发dispatch阶段地图过期；自动链仅识别prepare阶段未携带staleMapRef，无法进入已有原部长复核路径；监控blocker存在但needs_manual_check为false',
    'reward_note':'无官方评分不填0，不修改或重新评分此轮',
    'next':'按用户授权修复地图恢复接线后建立MiniMax r10；后两题不启动'})
print('r9 stopped, frozen unchanged, evidence collected, official reward unknown')
