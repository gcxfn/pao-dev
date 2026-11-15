"""用途：Linux后台运行固定三题一次；输入：冻结配置；输出：官方结果与结局状态。
只用新目录，旧九项停止记录不改变。程序不自动重启或重跑。
"""
import asyncio
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import traceback

WORKSPACE = Path('/run/desktop/mnt/host/d/AI/workspace')
RUN = WORKSPACE / 'pao-dev/.pao/地图简报与部门协作-20261020/benchmark/real-run-20261022-r3'
TEMP = WORKSPACE / '临时文件夹/PAO三题复测-20261022'
os.environ.update(HOME=str(TEMP / 'controller-home'), HARBOR_TELEMETRY='0', TMPDIR='/tmp')
Path(os.environ['HOME']).mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(RUN))

def now():
    return datetime.now(timezone.utc).isoformat()

def write(name, value):
    path = RUN / name
    new = path.with_suffix(path.suffix + '.new')
    new.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + '\n', encoding='utf-8')
    new.replace(path)

def mapped(value):
    if isinstance(value, str) and value.replace('\\', '/').startswith('D:/AI/workspace/'):
        return str(WORKSPACE / value.replace('\\', '/')[len('D:/AI/workspace/'):])
    if isinstance(value, list):
        return [mapped(item) for item in value]
    if isinstance(value, dict):
        return {key: mapped(item) for key, item in value.items()}
    return value

def summarize():
    config = json.loads((RUN / 'run-config.json').read_text(encoding='utf-8'))
    rows = []
    for task in config['tasks']:
        found = []
        for path in (RUN / 'jobs' / config['job_name']).glob('*/result.json'):
            data = json.loads(path.read_text(encoding='utf-8'))
            trial_config = json.loads((path.parent / 'config.json').read_text(encoding='utf-8'))
            if trial_config['task']['name'] == task['name']:
                found.append((path, data))
        if len(found) > 1:
            raise ValueError('同题出现多个结果，禁止混算：' + task['name'])
        if not found:
            rows.append({'task': task['name'], 'state': 'no_final_result'})
            continue
        path, data = found[0]
        exception = data.get('exception_info')
        rewards = (data.get('verifier_result') or {}).get('rewards')
        rows.append({'task': task['name'], 'state': 'execution_error' if exception else 'finished',
                     'rewards': rewards, 'exception': exception,
                     'agent_started_at': data.get('agent_execution', {}).get('started_at') if data.get('agent_execution') else None,
                     'agent_result': data.get('agent_result'), 'result': str(path.relative_to(RUN))})
    write('results-summary.json', {'at': now(), 'rows': rows, 'expected': 3,
                                  'note': '官方结果按原件；费用未核实，缓存/用量不可当免费。'})
    lines = ['# 三题后台运行结果', '', f'更新时间：{now()}。自动汇总，待主控审核。', '',
             '| 任务 | 状态 | 官方奖励 | 结果 |', '|---|---|---|---|']
    for row in rows:
        link = f"[原件]({row['result']})" if row.get('result') else '尚无'
        lines.append(f"| {row['task'].split('/')[-1]} | {row['state']} | {row.get('rewards', '未知')} | {link} |")
    lines += ['', '配置：DeepSeek high，三题各一次、题间串行、不自动重试；部门按15/30分钟监督。',
              '本轮以新源码、组织地图交接和开始前Git基线运行，不回写旧九项结果。',
              '资源原始记录与自动性能摘要由独立监控程序生成；性能数值本身不证明代码结构优劣。',
              '', '[资源采样](resources.jsonl) · [性能摘要](性能摘要.md) · [运行状态](status.json)']
    (RUN / '三题结果.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return rows

async def main():
    from harbor.models.job.config import JobConfig
    from harbor.job import Job
    from map_bench_pao_organized import OrganizedOptions
    if (RUN / 'user-stop.json').exists():
        raise RuntimeError('本轮已被用户停止，拒绝启动')
    raw = json.loads((RUN / 'run-config.json').read_text(encoding='utf-8'))
    config = mapped(raw)
    OrganizedOptions.model_validate(config['agents'][0]['kwargs'])
    parsed = JobConfig.model_validate(config)
    if not Path(config['jobs_dir']).is_absolute():
        raise ValueError('Linux运行目录必须是绝对路径')
    for key in ('source_archive', 'model_data_archive'):
        path = Path(config['agents'][0]['kwargs'][key])
        if not path.is_absolute() or not path.is_file():
            raise FileNotFoundError(f'Linux冻结输入不可读取：{key}: {path}')
    assert len(config['tasks']) == 3 and config['n_attempts'] == 1
    assert config['retry']['max_retries'] == 0 and config['n_concurrent_trials'] == 1
    if sys.argv[1:] == ['--validate']:
        write('linux-config-validation.json', {'ok': True, 'at': now(), 'model_calls': 0,
              'job': parsed.job_name, 'tasks': [t['name'] for t in config['tasks']]})
        print('CONFIG_VALIDATED_NO_MODEL_CALLS', flush=True)
        return
    freeze = json.loads((RUN / 'run-freeze.json').read_text(encoding='utf-8'))
    for item in freeze['files']:
        actual = hashlib.sha256((RUN / item['path']).read_bytes()).hexdigest()
        if actual != item['sha256']:
            raise ValueError('冻结输入被修改：' + item['path'])
    if (RUN / 'jobs' / parsed.job_name).exists():
        raise FileExistsError('本轮已启动，禁止自动重跑')
    # 三个真实题目环境先完整安装并检查Git、构建和SDK；此阶段不调用模型。
    preflight_config = copy.deepcopy(config)
    preflight_config['job_name'] = parsed.job_name + '-preflight'
    preflight_config['agents'][0]['import_path'] = 'preparation_agent:PreparationOnlyAgent'
    preflight_config['verifier']['disable'] = True
    preflight_parsed = JobConfig.model_validate(preflight_config)
    if (RUN / 'jobs' / preflight_parsed.job_name).exists():
        raise FileExistsError('准备预检已执行，禁止自动重复')
    write('status.json', {'state': 'preflight_running', 'at': now(), 'expected': 3,
                          'model_execution_started': False, 'auto_resume': False})
    print('THREE_TASK_PREFLIGHT_NO_MODEL_CALLS', preflight_parsed.job_name, flush=True)
    preflight = await Job.create(preflight_parsed)
    preflight_result = await preflight.run()
    write('preflight-summary.json', preflight_result.model_dump(mode='json'))
    preflight_rows = preflight_result.model_dump(mode='json')['trial_results']
    if len(preflight_rows) != 3 or any(row.get('exception_info') for row in preflight_rows):
        raise RuntimeError('真实三题环境准备预检失败；正式模型测试未启动，详情见preflight-summary.json')
    for trial_dir in (RUN / 'jobs' / preflight_parsed.job_name).iterdir():
        if trial_dir.is_dir() and not (trial_dir / 'agent/preparation-complete.txt').is_file():
            raise RuntimeError('准备预检缺少实际完成证据：' + trial_dir.name)
    write('preflight-passed.json', {'at': now(), 'tasks': 3, 'model_calls': 0,
                                   'source': 'preflight-summary.json'})
    print('THREE_TASK_PREFLIGHT_PASSED_NO_MODEL_CALLS', flush=True)
    write('status.json', {'state': 'running', 'at': now(), 'expected': 3, 'auto_resume': False})
    print('THREE_TASK_JOB_CREATE', parsed.job_name, flush=True)
    job = await Job.create(parsed)
    print('THREE_TASK_JOB_RUN', parsed.job_name, flush=True)
    result = await job.run()
    write('harbor-summary.json', result.model_dump(mode='json'))
    rows = summarize()
    failed = any(row['state'] != 'finished' for row in rows)
    write('status.json', {'state': 'failed' if failed else 'finished', 'at': now(), 'auto_resume': False,
          'expected': 3, 'official_results': sum(r['state'] == 'finished' for r in rows),
          'execution_errors': sum(r['state'] == 'execution_error' for r in rows),
          'no_final_result': sum(r['state'] == 'no_final_result' for r in rows)})

if __name__ == '__main__':
    code = 0
    try:
        asyncio.run(main())
    except Exception as error:
        code = 1
        traceback.print_exc()
        write('status.json', {'state': 'failed', 'at': now(), 'auto_resume': False,
                              'error': f'{type(error).__name__}: {error}'})
        try:
            summarize()
        except Exception as summary_error:
            write('summary-error.json', {'at': now(), 'error': str(summary_error)})
    finally:
        if '--validate' not in sys.argv:
            write('controller-exit.json', {'exit_code': code, 'at': now()})
    raise SystemExit(code)
