"""用途：冻结新版源码和复用桌面隔离服务的基准输入；不启动安装、题目或模型。
输入：本轮已验收源码、历史四部门组织配置。输出：独立待批准运行目录，仅第一题一次。
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = Path(__file__).resolve().parent
BENCH = ROOT / '.pao/地图简报与部门协作-20261020/benchmark'
OLD = BENCH / 'real-run-20261023'
RUN = BENCH / 'real-run-20261024-prepared'
SOURCE = ROOT / 'PAO'
RUN.mkdir(exist_ok=False)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

identity = EVIDENCE / '最终源码与发行身份.json'
for item in json.loads(identity.read_text(encoding='utf-8'))['changes']:
    path = ROOT / item['repo'] / item['path']
    if item['after'] is not None and sha(path) != item['after']:
        raise ValueError('源码偏离最终验收身份：' + str(path))
names = subprocess.check_output(['git', '-C', str(SOURCE), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
records = []
with zipfile.ZipFile(RUN / 'source.zip', 'x', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(set(p.decode('utf-8') for p in names.split(b'\0') if p)):
        path = SOURCE / name
        parts = Path(name).parts
        if not path.is_file() or any(p in {'.git', 'node_modules', 'dist', '.pao', '.agents', 'archive'} for p in parts):
            continue
        if any(p.startswith('.env') or p.endswith(('.pem', '.key', '.pfx')) for p in parts):
            continue
        if len(parts) > 1 and parts[0] not in {'packages', 'scripts'}:
            continue
        data = path.read_bytes()
        archive.writestr(name.replace('\\', '/'), data)
        records.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
write(RUN / 'source-manifest.json', {'at': datetime.now(timezone.utc).isoformat(), 'verified_identity_sha256': sha(identity), 'files': records, 'source_sha256': sha(RUN / 'source.zip')})
for name in ('map_bench_pao', 'scripts', 'organized-post'):
    shutil.copytree(OLD / name, RUN / name, ignore=shutil.ignore_patterns('__pycache__'))
for name in ('map_bench_pao_organized.py', 'preparation_agent.py'):
    shutil.copy2(OLD / name, RUN / name)
shutil.copy2(BENCH / 'bench_controller.py', RUN / 'bench_controller.py')
for name in ('benchmark-organized-entry.mjs', 'benchmark-worktree-host.mjs'):
    shutil.copy2(EVIDENCE / name, RUN / 'organized-post' / name)

# 仅修改新副本：安装复用宿主的 SDK 入口，组织规则和隐藏测试边界保持原样。
adapter = RUN / 'map_bench_pao_organized.py'
text = adapter.read_text(encoding='utf-8')
old_upload = "('setup.mjs', 'kit.json', 'activate-tools.mjs', 'probe-tools.mjs')"
assert text.count(old_upload) == 1
text = text.replace(old_upload, "('setup.mjs', 'kit.json', 'activate-tools.mjs', 'probe-tools.mjs', 'benchmark-organized-entry.mjs', 'benchmark-worktree-host.mjs')")
needle = "        for role in ('main', 'minister', 'worker'):"
assert text.count(needle) == 1
replacement = '''        launcher = (
            '#!/bin/sh\\n'
            f'export PAO_BENCH_SOURCE={shlex.quote(self._REMOTE_SOURCE_DIR)}\\n'
            'exec "$HOME/.local/pao-node/bin/node" /tmp/benchmark-organization/benchmark-organized-entry.mjs "$@"\\n'
        )
        await self.exec_as_agent(environment, command=(
            f"printf '%s' {shlex.quote(launcher)} > {self._REMOTE_LAUNCHER} && "
            f"chmod 755 {self._REMOTE_LAUNCHER}"
        ))
''' + needle
text = text.replace(needle, replacement)
adapter.write_text(text, encoding='utf-8')

probe = RUN / 'organized-post/probe-tools.mjs'
text = probe.read_text(encoding='utf-8')
start = text.index('const { builtInExtensions } =')
end = text.index('\ntry {', start)
text = text[:start] + '''const { createOrganized } = await import('./benchmark-organized-entry.mjs');
const { runtime, host } = await createOrganized({source,cwd,agentDir,probe:true});
''' + text[end:]
probe.write_text(text, encoding='utf-8')
kit_files = sorted(p for p in (RUN / 'organized-post').iterdir() if p.is_file() and p.name != 'manifest.json')
write(RUN / 'organized-post/manifest.json', {'files': [{'path': p.relative_to(RUN).as_posix(), 'sha256': sha(p)} for p in kit_files]})

base = '/run/desktop/mnt/host/d/AI/workspace/'
def mapped(value):
    if isinstance(value, str) and value.replace('\\', '/').startswith('D:/AI/workspace/'):
        return base + value.replace('\\', '/')[len('D:/AI/workspace/'):]
    if isinstance(value, list):
        return [mapped(v) for v in value]
    if isinstance(value, dict):
        return {k: mapped(v) for k, v in value.items()}
    return value
config = mapped(json.loads((OLD / 'run-config.json').read_text(encoding='utf-8')))
linux_run = base + RUN.relative_to(ROOT.parent).as_posix()
config['job_name'] = 'pao-first-refactor-20261024'
config['jobs_dir'] = linux_run + '/jobs'
config['tasks'] = config['tasks'][:1]
config['environment'].setdefault('kwargs', {})['keep_containers'] = True
options = config['agents'][0]['kwargs']
options['source_archive'] = linux_run + '/source.zip'
options['source_sha256'] = sha(RUN / 'source.zip')
options['organization_manifest_sha256'] = sha(RUN / 'organized-post/manifest.json')
write(RUN / 'run-config.json', config)
write(RUN / 'preparation-scope.json', {
    'model_run_authorized': False,
    'task_count': 1,
    'remaining_original_tasks': '未加入本轮，不会自动启动第二或第三题',
    'organization': '保留历史四部门协议作回归样本；SDK宿主注入既有桌面隔离服务。不是直接执行收益对照。',
    'limits': '真实安装、完整链和在途暂停待验；本文件不代表付费授权。',
})
files = sorted(p for p in RUN.rglob('*') if p.is_file())
write(RUN / 'run-freeze.json', {'files': [{'path': p.relative_to(RUN).as_posix(), 'sha256': sha(p)} for p in files]})
print(json.dumps({'run': linux_run, 'source_files': len(records), 'source_bytes': (RUN / 'source.zip').stat().st_size, 'source_sha256': options['source_sha256'], 'model_calls': 0}, ensure_ascii=False))
