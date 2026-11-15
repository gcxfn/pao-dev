"""用途：评分r12已停止的现有成果；复用官方冻结测试与既有评分入口，不调用模型、不改产物。"""
import importlib.util
import json
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parents[1]
run = root / '.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared-r12'
path = run / 'bench_controller.py'
spec = importlib.util.spec_from_file_location('controller', path)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
docker = 'D:/Docker/resources/bin/docker.exe'
import subprocess
receipt = controller.read(run / 'terminal-receipt.json')
if not receipt['writers_stopped_observed']:
    raise RuntimeError('本轮未确认停止')
for name in controller.read(run / 'runtime-containers.json')['containers']:
    state = json.loads(subprocess.check_output([docker, 'inspect', '--format', '{{json .State}}', name], text=True))
    if any(state.get(k) for k in ('Running', 'Paused', 'Restarting', 'Pid')):
        raise RuntimeError('本轮仍可能写入：' + name)
for item in controller.read(run / 'run-freeze.json')['files']:
    if controller.digest(run / item['path']) != item['sha256']:
        raise RuntimeError('冻结输入改变：' + item['path'])
score_spec = controller.read(here / '控制器评分集成/score-spec.json')
score_spec['source_container'] = 'html-js-filter__r7qsiwj__env-main-1'
score_spec['artifacts'] = [{'target': '/app/filter.py'}]
target = run / 'score-spec.json'
if target.exists():
    raise FileExistsError('禁止覆盖已有评分规格')
controller.write(target, score_spec)
print(json.dumps(controller.score_current(run, target, docker), ensure_ascii=False))
