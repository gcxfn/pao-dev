"""用途：执行用户2026-10-24新增重试授权的第一题r7；输入已校验冻结包，输出独立运行，不启动后两题。"""
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dispatch_r4', HERE / 'dispatch-first-r4.py')
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
dispatch.RUN = dispatch.BENCH / 'real-run-20261024-prepared-r7'
dispatch.NAME = 'pao-refactor-first-approved-20261024-r7'
dispatch.LINUX = dispatch.BASE + '/pao-dev/' + dispatch.RUN.relative_to(dispatch.ROOT).as_posix()
OLD = dispatch.RUN.with_name('real-run-20261024-prepared-r6')

def check_previous():
    if not dispatch.read(OLD / 'final-receipt.json')['writers_stopped_observed']:
        raise RuntimeError('上一轮未确认停写')

dispatch.check_previous = check_previous
dispatch.write(dispatch.RUN / 'retry-authorization.json', {
    'authorization': '用户2026-10-24：跑，不限重试，反正这次跑完',
    'scope': '仅第一题html-js-filter，group/deepseek high；允许修复后重试直到完成并取得官方评分',
    'supersedes': '此前零自动重试和仅一次授权；冻结包内preparation-scope只反映授权前准备时点',
    'boundaries': '每次独立留档，保留原题和官方测试；不启动后两题，不操作正式PAO_HOME',
    'attempt': 7, 'previous': OLD.name})
dispatch.launch()
receipt = dispatch.read(dispatch.RUN / 'approved-launch.json')
receipt.update(authorization='用户2026-10-24：跑，不限重试，反正这次跑完',
    retry_policy='允许修复后创建独立尝试；本容器内部不盲目重试，完整保留每次异常')
dispatch.write(dispatch.RUN / 'approved-launch.json', receipt)
