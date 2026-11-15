"""用途：封存三题输入与后台脚本；输入新run和本轮脚本，输出最终config与freeze，不调用模型。"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil

TEMP = Path(__file__).resolve().parent
RUN = Path('D:/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020/benchmark/real-run-20261022-r3')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def write(path, data): path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
manifest_path = RUN/'organized-post/manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['created_at'] = datetime.now(timezone.utc).isoformat()
for item in manifest['files']:
    item['sha256'] = sha(RUN/item['path'])
write(manifest_path, manifest)
config = json.loads((RUN/'run-config-draft.json').read_text(encoding='utf-8'))
config['agents'][0]['kwargs']['organization_manifest_sha256'] = sha(manifest_path)
write(RUN/'run-config.json', config)
(RUN/'runtime-scripts').mkdir(exist_ok=True)
for name in ('controller.py','launch-and-watch.py','resource-monitor.py','resource-monitor-selftest.py','prepare-run.py','validate-organization.ps1'):
    shutil.copy2(TEMP/name, RUN/'runtime-scripts'/name)
files = ['run-config.json','authorization.json','source.zip','source-manifest.json','organized-post/manifest.json','preparation_agent.py']
files += [item['path'] for item in manifest['files']]
files += [p.relative_to(RUN).as_posix() for directory in ('map_bench_pao','scripts','runtime-scripts') for p in (RUN/directory).iterdir() if p.is_file()]
write(RUN/'run-freeze.json', {'at': datetime.now(timezone.utc).isoformat(),
    'files': [{'path': name, 'sha256': sha(RUN/name)} for name in sorted(set(files))]})
print(json.dumps({'frozen_files': len(set(files)), 'organization_manifest_sha256': sha(manifest_path)}))
