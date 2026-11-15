"""用途：收取r11停链现场；输入本轮真实容器、会话与终局记录，输出证据和用量；不调用模型或评分。"""
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dispatch', HERE / 'dispatch-first-r4.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
run = d.BENCH / 'real-run-20261024-prepared-r11'
receipt = d.read(run / 'terminal-receipt.json')
states = []
for name in d.read(run / 'runtime-containers.json')['containers']:
    state = json.loads(d.docker('inspect', '--format', '{{json .State}}', name).stdout)
    if any(state.get(key) for key in ('Running', 'Paused', 'Restarting', 'Pid')):
        raise RuntimeError('尚未停写：' + name)
    states.append({'name': name, 'state': state})
for item in d.read(run / 'run-freeze.json')['files']:
    if d.sha(run / item['path']) != item['sha256']:
        raise RuntimeError('冻结输入变化：' + item['path'])
evidence = run / 'final-evidence'
evidence.mkdir(exist_ok=True)
container = 'html-js-filter__dnimptg__env-main-1'
for source, target in [('/app/.pao', 'project-pao'), ('/logs/agent', 'agent'),
                       ('/tmp/harbor-pao-home', 'organization'), ('/app/filter.py', 'filter.py'),
                       ('/app/selftest_filter.py', 'selftest_filter.py')]:
    destination = evidence / target
    if destination.exists():
        raise RuntimeError('证据已存在，拒绝覆盖：' + str(destination))
    d.docker('cp', container + ':' + source, str(destination), timeout=90)
spec = importlib.util.spec_from_file_location('usage', run / 'map_bench_pao/usage.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
files = [path for path in evidence.rglob('*.jsonl') if u.classify_session_file(path)[0] == 'session']
usage = u.aggregate_session_usage(files)
d.write(evidence / 'observed-usage.json', {'at': datetime.now(timezone.utc).isoformat(),
    'usage': usage, 'files': [str(path.relative_to(run)) for path in files],
    'scope': '已复制原生会话观察下界；不保证所有辅助调用覆盖，完整费用未知'})
d.write(run / 'final-receipt.json', {'at': datetime.now(timezone.utc).isoformat(),
    'state': 'paused_after_session_stopchain', 'official_rewards': receipt.get('official_rewards'),
    'reward_note': '未运行官方评分，未知不填0；控制器进度条Mean不是本题官方奖励',
    'exceptions': receipt.get('exceptions'), 'containers': states,
    'writers_stopped_observed': True, 'frozen_inputs_unchanged': True,
    'observed_usage': usage, 'resource_summary': d.read(run / 'resource-summary.json'),
    'organization_outcome': '主控末轮19:39结束后通知衔接异常；session_shutdown暂停流程，无部长或工人在途',
    'runtime_errors': 'stale extension ctx与turn_end assistant持久化记录错误，具体关闭触发仍待源码复现',
    'next': '开发源码调查修复；保留原题、测试与冻结现场，不在本轮追加评分或模型作答'})
print(json.dumps({'writers_stopped': True, 'official_rewards': receipt.get('official_rewards'),
    'containers': len(states), 'usage': usage}, ensure_ascii=False))
