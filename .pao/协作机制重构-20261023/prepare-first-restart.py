"""用途：按用户重新启动第一题的授权创建r3；输入r2冻结文件和已验同Node安装包，输出新冻结运行与专用启动器。"""
from pathlib import Path
import hashlib
import json
import shutil

root = Path(__file__).resolve().parents[2]
scripts = Path(__file__).parent
old = root / '.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared-r2'
new = old.with_name('real-run-20261024-prepared-r3')
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
write = lambda p, data: p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
if json.loads((old / 'control-status.json').read_text())['state'] != 'execution_error':
    raise RuntimeError('上轮未处于预期失败终态')
archive = scripts / 'node-v24.18.0-linux-x64.tar.xz'
if digest(archive) != '55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742':
    raise RuntimeError('Node安装包摘要不匹配')
new.mkdir(exist_ok=False)
for item in json.loads((old / 'run-freeze.json').read_text(encoding='utf-8'))['files']:
    source = old / item['path']
    if digest(source) != item['sha256']:
        raise RuntimeError('原冻结输入变更：' + item['path'])
    target = new / item['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
shutil.copy2(archive, new / archive.name)
adapter = new / 'map_bench_pao/pao_agent.py'
text = adapter.read_text(encoding='utf-8')
needle = '        node_install = (\n'
assert text.count(needle) == 1
text = text.replace(needle, "        await environment.upload_file(Path(__file__).resolve().parents[1] / 'node-v24.18.0-linux-x64.tar.xz', '/tmp/pao-node.tar.xz')\n" + needle)
download = '            "curl -fsSLo /tmp/pao-node.tar.xz "\n            "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz; "\n'
assert text.count(download) == 1
adapter.write_text(text.replace(download, ''), encoding='utf-8')
config = json.loads((new / 'run-config.json').read_text(encoding='utf-8'))
config = json.loads(json.dumps(config).replace(old.name, new.name))
config['job_name'] = 'pao-first-refactor-20261024-r3'
write(new / 'run-config.json', config)
write(new / 'revision.json', {'previous': old.name, 'authorization': '用户2026-10-24明确要求：重新启动第一题', 'reason': '从已停止且预检通过的容器只读提取同摘要Node安装包；正式安装通过Harbor上传并原样校验，不再在线下载Node', 'model': 'group/deepseek', 'thinking': 'high', 'attempts': 1, 'automatic_retries': 0, 'tasks': ['terminal-bench/html-js-filter'], 'source_task_tests_unchanged': True})
write(new / 'run-freeze.json', {'files': [{'path': p.relative_to(new).as_posix(), 'sha256': digest(p)} for p in sorted(new.rglob('*')) if p.is_file() and p.name != 'run-freeze.json']})
launcher = (scripts / 'launch-approved-first.py').read_text(encoding='utf-8')
start = launcher.index("previous = run.with_name(")
end = launcher.index('with socket.create_connection', start)
launcher = launcher[:start] + "previous = run.with_name('real-run-20261024-prepared-r2')\nstatus = json.loads((previous / 'control-status.json').read_text(encoding='utf-8'))\nif status['state'] != 'execution_error' or not status.get('writers_stopped'):\n    raise RuntimeError('上轮尚未确认停止')\nfor previous_name in ['pao-refactor-first-approved-20261024-r2', 'html-js-filter__faxwmr5__env-main-1', 'html-js-filter__8nzfkgf__env-main-1']:\n    previous_state = json.loads(subprocess.check_output([docker, 'inspect', '--format', '{{json .State}}', previous_name], text=True))\n    if previous_state['Running'] or previous_state['Paused'] or previous_state['Restarting']:\n        raise RuntimeError('上轮容器仍活动：' + previous_name)\n" + launcher[end:]
launcher = launcher.replace('real-run-20261024-prepared-r2', 'real-run-20261024-prepared-r3', 1).replace("name = 'pao-refactor-first-approved-20261024-r2'", "name = 'pao-refactor-first-approved-20261024-r3'")
launcher = launcher.replace('用户明确批准：仅第一题一次', '用户2026-10-24明确要求：重新启动第一题；仅第一题一次').replace('preparation-scope.json保留冻结时未授权事实；本记录为后来取得的单题授权', '用户重新授权一次；保留上轮失败和冻结证据，不启动后两题')
(scripts / 'launch-restarted-first.py').write_text(launcher, encoding='utf-8')
print(new)
