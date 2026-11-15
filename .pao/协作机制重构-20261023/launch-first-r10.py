"""用途：按用户MiniMax选择启动第一题r9；输入冻结包，输出本轮控制器；失败允许另轮修复重试。"""
import importlib.util
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('dispatch_r4',HERE/'dispatch-first-r4.py')
dispatch=importlib.util.module_from_spec(spec); spec.loader.exec_module(dispatch)
dispatch.RUN=dispatch.BENCH/'real-run-20261024-prepared-r10'
dispatch.NAME='pao-refactor-first-approved-20261024-r10'
dispatch.MODEL='openai/minimax-code/MiniMax-M3.1-Flash'
dispatch.LINUX=dispatch.BASE+'/pao-dev/'+dispatch.RUN.relative_to(dispatch.ROOT).as_posix()
OLD=dispatch.RUN.with_name('real-run-20261024-prepared-r9')
def check_previous():
    if not dispatch.read(OLD/'terminal-receipt.json')['writers_stopped_observed']:
        raise RuntimeError('上一轮未确认停写')
    for name in dispatch.read(OLD/'runtime-containers.json')['containers']:
        state=json.loads(dispatch.docker('inspect','--format','{{json .State}}',name).stdout)
        if any(state.get(k) for k in ('Running','Paused','Restarting','Pid')):
            raise RuntimeError('上一轮仍可能写入：'+name)
dispatch.check_previous=check_previous
dispatch.write(dispatch.RUN/'retry-authorization.json',{
    'authorization':'用户要求改用MiniMax，只过流程；第一题不限重试直到完成的授权继续有效',
    'scope':'仅html-js-filter，minimax-code/MiniMax-M3.1-Flash high；不启动后两题',
    'supersedes':'此前DeepSeek模型选择；历史冻结输入不修改', 'attempt':10})
dispatch.launch()
receipt=dispatch.read(dispatch.RUN/'approved-launch.json')
receipt.update(authorization='用户改用MiniMax，只过流程；允许第一题失败修复后重试直到完成',
    retry_policy='每次独立留档，先修复再重试，不刷分')
dispatch.write(dispatch.RUN/'approved-launch.json',receipt)
