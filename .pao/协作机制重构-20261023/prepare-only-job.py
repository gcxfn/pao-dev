"""用途：在真实 Harbor/Docker 中仅安装并预检冻结新版第一题；不启动模型或官方评分。
输入：已冻结运行目录。输出：独立预检 Job、原始异常和摘要；模型地址强制指向不可用回环端口。
"""
import asyncio
import copy
import json
import re
from pathlib import Path
import sys

run = Path(sys.argv[1]).resolve()
attempt = sys.argv[2]
if not re.fullmatch(r'[a-z0-9-]+', attempt):
    raise ValueError('预检尝试名称只能包含小写字母、数字与连字符')
sys.path.insert(0, str(run))
from bench_controller import validate, harbor_execute

config = copy.deepcopy(validate(run))
config['job_name'] += '-install-only-' + attempt
config['agents'][0]['import_path'] = 'preparation_agent:PreparationOnlyAgent'
config['agents'][0]['model_base_url'] = 'http://127.0.0.1:1/v1'
config['verifier']['disable'] = True
marker = run / f'preparation-only-{attempt}-started.json'
with marker.open('x', encoding='utf-8') as file:
    json.dump({'scope': '安装与离线装配检查；无模型授权，真实模型端点未提供', 'config': config}, file, ensure_ascii=False, indent=2)

async def main():
    result = await harbor_execute(config)
    (run / f'preparation-only-{attempt}-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    trials = result['trial_results']
    if len(trials) != len(config['tasks']) or any(row.get('exception_info') for row in trials):
        raise RuntimeError('真实安装预检失败；未启动模型。异常见原始试验记录')
    print('真实第一题安装与组织工具预检通过；模型调用0，官方评分未运行')

asyncio.run(main())
