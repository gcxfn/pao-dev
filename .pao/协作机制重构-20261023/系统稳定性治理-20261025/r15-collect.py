"""用途：用修复版观察器收取已停止r15，不启动/停止模型，不改冻结输入。"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'
RUN = BENCH / 'real-run-20261025-prepared-r15'

def main():
    snapshot = HERE / 'r15-watch-recovery'
    snapshot.mkdir(exist_ok=False)
    for name in ('watch_run.py','runner_common.py','bench_controller.py'):
        shutil.copy2(BENCH / name,snapshot / name)
    shutil.copy2(RUN / 'watch-error.json',snapshot / 'original-watch-error.json')
    manifest = {name:hashlib.sha256((snapshot/name).read_bytes()).hexdigest() for name in ('watch_run.py','runner_common.py','bench_controller.py')}
    (snapshot / 'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    result = subprocess.run([sys.executable,str(snapshot / 'watch_run.py'),'--run',str(RUN),'--controller','pao-stability-first-20261025-r15','--max-seconds','60'],capture_output=True,text=True,encoding='utf-8',timeout=90)
    (snapshot / 'stdout.json').write_text(result.stdout,encoding='utf-8')
    (snapshot / 'stderr.log').write_text(result.stderr,encoding='utf-8')
    result.check_returncode()
    value = json.loads(result.stdout)
    assert value['terminal'] and value['actual_stop_observed'] and value['controller_crash']
    print(json.dumps({'terminal':value['terminal'],'controller_crash':value['controller_crash'],'actual_stop_observed':value['actual_stop_observed'],'recovery_snapshot':str(snapshot)},ensure_ascii=False))

if __name__ == '__main__':
    main()
