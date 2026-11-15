"""用途：保留r2环境失败证据并准备r3；输入r2冻结材料；输出新运行目录，不调用模型。"""
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil

base = Path('D:/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020/benchmark')
old = base / 'real-run-20261022-r2'
run = base / 'real-run-20261022-r3'
temp = Path(__file__).resolve().parent
results = [json.loads(p.read_text(encoding='utf-8')) for p in (old/'jobs/pao-fixed-three-20261022-r2').glob('*/result.json')]
assert len(results) == 3
assert all(r.get('agent_execution') is None and r.get('agent_result') is None for r in results)
assert all('spawnSync git ENOENT' in r['exception_info']['exception_message'] for r in results)
proof = {'at': datetime.now(timezone.utc).isoformat(), 'state': 'preparation_failed',
         'reason': '组织初始化依赖Git，但适配器未声明Git；部分容器也缺少监控依赖Python',
         'model_execution_started': False, 'model_calls': 0,
         'evidence': [str(p.relative_to(old)) for p in (old/'jobs/pao-fixed-three-20261022-r2').glob('*/result.json')],
         'next_run': run.name, 'auto_resume': False}
(old/'启动问题记录.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
run.mkdir(exist_ok=False)
for directory in ('map_bench_pao','scripts','organized-post'):
    shutil.copytree(old/directory, run/directory, ignore=shutil.ignore_patterns('__pycache__'))
for name in ('source.zip','source-manifest.json','authorization.json','run-config-draft.json','map_bench_pao_organized.py'):
    shutil.copy2(old/name, run/name)
config_path = run/'run-config-draft.json'
text = config_path.read_text(encoding='utf-8').replace('real-run-20261022-r2', run.name).replace('pao-fixed-three-20261022-r2','pao-fixed-three-20261022-r3')
config_path.write_text(text, encoding='utf-8')
for name in ('controller.py','launch-and-watch.py','finalize-inputs.py','prepare-run.py','validate-organization.ps1'):
    path = temp/name
    text = path.read_text(encoding='utf-8-sig').replace('real-run-20261022-r2',run.name).replace('pao-bench-fixed-three-20261022-r2','pao-bench-fixed-three-20261022-r3')
    path.write_text(text,encoding='utf-8')
adapter = run/'map_bench_pao/pao_agent.py'
text = adapter.read_text(encoding='utf-8')
needle = 'environment, ("bash", "coreutils", "curl", "tar", "unzip", "xz")'
assert needle in text
text = text.replace(needle,'environment, ("bash", "coreutils", "curl", "tar", "unzip", "xz", "git", "python3")')
needle = '        await environment.upload_file(archive, self._REMOTE_SOURCE_ARCHIVE)'
check = '''        # 实际运行版本检查后才声明依赖就绪，准备失败时不调用模型。
        await self.exec_as_agent(environment, command=(
            "python3 -c " + shlex.quote(
                "import json,pathlib,subprocess; "
                "data={name:subprocess.check_output([name,'--version'],text=True).strip() "
                "for name in ('git','python3')}; "
                "pathlib.Path('/tmp/benchmark-prerequisites.json').write_text(json.dumps(data))"
            )
        ))
'''
assert needle in text
text = text.replace(needle,check+needle)
adapter.write_text(text,encoding='utf-8')
(run/'status.json').write_text(json.dumps({'state':'prepared','expected':3,'auto_resume':False}),encoding='utf-8')
print(json.dumps({'new_run':str(run),'prior_model_calls':0},ensure_ascii=False))
