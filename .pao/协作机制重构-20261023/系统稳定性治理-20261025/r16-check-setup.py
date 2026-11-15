"""用途：用隔离目录执行实际Node组织装配，核查文件参数；零模型调用。

输入：当前setup、已冻结r16配方和绑定。输出：隔离home和装配结果证据。
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'
RUN = BENCH / 'real-run-20261025-prepared-r16'
NODE = 'C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'

def main():
    scratch = Path(tempfile.mkdtemp(prefix='r16-setup-',dir='D:/AI/workspace/临时文件夹/PAO稳定性验证-20261025'))
    kit = scratch / 'kit'
    kit.mkdir()
    shutil.copy2(RUN / 'organized-post/kit.json',kit / 'kit.json')
    shutil.copy2(BENCH / 'organized-post/activate-tools.mjs',kit / 'activate-tools.mjs')
    home,agent,evidence,project = [scratch/name for name in ('home','agent','evidence','project')]
    project.mkdir()
    env = dict(os.environ)
    env.update(PAO_HOME=str(home),PI_CODING_AGENT_DIR=str(agent),PAO_CODING_AGENT_DIR=str(agent),PI_SKIP_VERSION_CHECK='1')
    result = subprocess.run([NODE,str(BENCH / 'organized-post/setup.mjs'),str(ROOT / 'PAO'),str(kit / 'kit.json'),str(home),str(agent),str(evidence),str(project),str(RUN / 'role-model-binding.json')],cwd=project,env=env,capture_output=True,text=True,encoding='utf-8',timeout=60)
    (scratch/'stdout.log').write_text(result.stdout,encoding='utf-8')
    (scratch/'stderr.log').write_text(result.stderr,encoding='utf-8')
    (HERE/'r16-setup-check.json').write_text(json.dumps({'scratch':str(scratch),'exit_code':result.returncode,'model_calls':0},ensure_ascii=False,indent=2),encoding='utf-8')
    result.check_returncode()
    proof = json.loads((evidence/'organization-setup.json').read_text(encoding='utf-8'))
    assert proof['ok'] and proof['role_model_check']['consistent']
    print(json.dumps({'actual_node_setup':'passed','departments':len(proof['departments']),'models_called':0,'scratch':str(scratch)},ensure_ascii=False))

if __name__ == '__main__':
    main()
