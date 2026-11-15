"""用途：冻结已验收源码、复制基础适配器并生成三题配置；不调用模型。
输入：开发仓、原三题固定配置。输出：新运行目录的源码ZIP、输入清单、授权与配置。
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path('D:/AI/workspace/pao-dev')
SOURCE = ROOT / 'PAO'
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'
RUN = BENCH / 'real-run-20261022-r3'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(name, data):
    (RUN / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

if (RUN / 'source.zip').exists():
    raise FileExistsError('源码已冻结，拒绝覆盖')
verified = ROOT / '.pao/分层监督与后台交付-20261021/checks/run-20261022-095001/source-after.json'
for item in json.loads(verified.read_text(encoding='utf-8-sig')):
    if digest(Path(item['path'])) != item['sha256'].lower():
        raise ValueError('源码偏离最后验收：' + item['path'])

names = subprocess.check_output(['git', '-C', str(SOURCE), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
files = sorted(set(part.decode('utf-8') for part in names.split(b'\0') if part))
records = []
with zipfile.ZipFile(RUN / 'source.zip', 'x', zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        path = SOURCE / name
        if not path.is_file():
            continue
        parts = Path(name).parts
        if any(part in {'.git', 'node_modules', 'dist', '.pao', '.agents', 'archive'} for part in parts):
            continue
        if any(part == '.env' or part.endswith(('.pem', '.key')) for part in parts):
            continue
        if len(parts) > 1 and parts[0] not in {'packages', 'scripts'}:
            continue
        data = path.read_bytes()
        archive.writestr(name.replace('\\', '/'), data)
        records.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
write('source-manifest.json', {'verified_against': str(verified), 'files': records,
                               'source_sha256': digest(RUN / 'source.zip')})
for folder in ('map_bench_pao', 'scripts'):
    (RUN / folder).mkdir(exist_ok=True)
for file in (BENCH / 'map_bench_pao').glob('*.py'):
    shutil.copy2(file, RUN / 'map_bench_pao' / file.name)
for name in ('single-entry.mjs', 'probe-single.mjs'):
    shutil.copy2(BENCH / 'scripts' / name, RUN / 'scripts' / name)
for name in ('test_pao_agent.py', 'test_usage.py'):
    shutil.copy2(BENCH / name, RUN / name)

config = json.loads((BENCH / 'real-run-20261021/organized-post-config.json').read_text(encoding='utf-8'))
config['job_name'] = 'pao-fixed-three-20261022'
config['jobs_dir'] = str(RUN / 'jobs')
options = config['agents'][0]['kwargs']
options['source_archive'] = str(RUN / 'source.zip')
options['source_sha256'] = digest(RUN / 'source.zip')
options.pop('organization_manifest_sha256', None)  # 组织文件完成后由启动器写入真实摘要。
assert len(config['tasks']) == 3 and config['n_attempts'] == 1
assert config['n_concurrent_trials'] == 1 and config['retry']['max_retries'] == 0
write('run-config-draft.json', config)
write('authorization.json', {'at': datetime.now(timezone.utc).isoformat(),
    'user': '批准进行三道题的测试，你直接后台程序运行，不用前台盯着；加上对性能占用情况的监控',
    'scope': '修复后的PAO，原固定三题各一次，总计3次；新目录，不续跑旧九项。',
    'model': 'group/deepseek', 'thinking': 'high', 'budget_limit': None,
    'docker': True, 'supervision_minutes': {'worker': 15, 'department': 30},
    'performance_interval_seconds': 30, 'auto_restart': False,
    'comparison_changes': '新源码、新组织交接和开始前Git基线，不回写旧样本，不单独归因于源码。'})
write('status.json', {'state': 'prepared', 'expected': 3, 'auto_resume': False})
print(json.dumps({'source_files': len(records), 'zip_bytes': (RUN/'source.zip').stat().st_size,
                  'source_sha256': options['source_sha256'], 'tasks': [t['name'] for t in config['tasks']]}, ensure_ascii=False))
