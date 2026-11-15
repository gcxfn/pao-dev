"""用途：复制已有固定版本题目缓存供离线安装预检。输入：只读历史缓存；输出：本轮独立缓存与逐文件摘要。"""
from pathlib import Path
import hashlib
import json
import shutil

root = Path(__file__).resolve().parent
digest = 'f211960f1f7c66ace91c3d079db073ed0f841d458db4cad1f2f943cba6cc79f3'
relative = Path('tasks/packages/terminal-bench/html-js-filter') / digest
source = Path('D:/AI/workspace/临时文件夹/地图简报基准-20261020/controller-home/.cache/harbor') / relative
target = root / '安装预检缓存' / relative
shutil.copytree(source, target)
files = []
for path in sorted(source.rglob('*')):
    if not path.is_file():
        continue
    name = path.relative_to(source)
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    copied = hashlib.sha256((target / name).read_bytes()).hexdigest()
    if original != copied:
        raise RuntimeError(f'复制摘要不一致：{name}')
    files.append({'path': name.as_posix(), 'sha256': original})
result = {'scope': '原固定版本任务包逐文件无损复制；不重新宣称注册表内容摘要已独立计算，不改任务引用或测试', 'ref': 'sha256:' + digest, 'source': str(source), 'target': str(target), 'files': files}
(root / '安装预检缓存来源.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Copied and verified {len(files)} files')
