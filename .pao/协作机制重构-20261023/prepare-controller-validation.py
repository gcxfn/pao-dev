"""用途：准备仅做真实 Harbor 配置解析的隔离样本；输入历史冻结适配器，输出新验证目录，不运行题目或模型。"""
from pathlib import Path
import hashlib
import json
import shutil

root = Path(__file__).resolve().parents[2]
bench = root / '.pao/地图简报与部门协作-20261020/benchmark'
old = bench / 'real-run-20261023'
run = Path(__file__).resolve().parent / '控制器配置验证'
run.mkdir(exist_ok=False)
for name in ('map_bench_pao', 'organized-post'):
    shutil.copytree(old / name, run / name, ignore=shutil.ignore_patterns('__pycache__'))
for name in ('map_bench_pao_organized.py', 'preparation_agent.py'):
    shutil.copy2(old / name, run / name)
shutil.copy2(bench / 'bench_controller.py', run / 'bench_controller.py')
base = '/run/desktop/mnt/host/d/AI/workspace/'
def mapped(value):
    if isinstance(value, str) and value.replace('\\', '/').startswith('D:/AI/workspace/'):
        return base + value.replace('\\', '/')[len('D:/AI/workspace/'):]
    if isinstance(value, list):
        return [mapped(item) for item in value]
    if isinstance(value, dict):
        return {key: mapped(item) for key, item in value.items()}
    return value
config = mapped(json.loads((old / 'run-config.json').read_text(encoding='utf-8')))
linux_run = base + run.relative_to(root.parent).as_posix()
config['job_name'] = 'pao-controller-config-validation-20261024'
config['jobs_dir'] = linux_run + '/jobs'
config['environment'].setdefault('kwargs', {})['keep_containers'] = True
(run / 'run-config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
files = sorted(p for p in run.rglob('*') if p.is_file())
(run / 'run-freeze.json').write_text(json.dumps({'files': [
    {'path': p.relative_to(run).as_posix(), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files
]}, ensure_ascii=False, indent=2), encoding='utf-8')
(run / '验证范围.md').write_text('仅校验当前控制器、真实 Harbor JobConfig 和冻结适配器配置。引用历史源码包，不代表重构源码已冻结待跑；禁止用此目录执行 run。模型调用 0。', encoding='utf-8')
print(linux_run)
