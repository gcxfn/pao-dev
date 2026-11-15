"""用途：用历史已停止评分容器中的现有代码核验新评分入口；输入旧成果，只写新验收目录，不调用模型、不改历史运行。"""
from pathlib import Path
import importlib.util
import json

root = Path(__file__).resolve().parents[2]
path = root / '.pao/地图简报与部门协作-20261020/benchmark/bench_controller.py'
spec = importlib.util.spec_from_file_location('bench_controller', path)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
run = Path(__file__).resolve().parent / '控制器评分集成'
run.mkdir(exist_ok=False)
task = Path('D:/AI/workspace/临时文件夹/PAO三题重启-20261023/controller-home/.cache/harbor/tasks/packages/terminal-bench/html-js-filter/f211960f1f7c66ace91c3d079db073ed0f841d458db4cad1f2f943cba6cc79f3')
controller.write(run / '验收范围.json', {'scope': '历史当前成果评分的真实 Docker 集成复验；状态为离线验收夹具，不是新控制器实际取消 Harbor 的证明', 'model_calls': 0})
controller.state(run, 'paused', writers_stopped=True)
controller.write(run / 'score-spec.json', {
    'source_container': 'pao-html-js-filter-direct-score-20261023-r2',
    'task_dir': str(task),
    'files': [{'path': p.relative_to(task).as_posix(), 'sha256': controller.digest(p)} for p in [task / 'task.toml', *sorted(p for p in (task / 'tests').rglob('*') if p.is_file())]],
    'artifacts': [{'target': '/app/filter.py'}],
})
result = controller.score_current(run, run / 'score-spec.json', 'D:/Docker/resources/bin/docker.exe')
print(json.dumps(result, ensure_ascii=False))
