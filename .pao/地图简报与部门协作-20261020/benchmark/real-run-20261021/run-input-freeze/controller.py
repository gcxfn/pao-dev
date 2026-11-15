"""用途：运行固定 Harbor 准备/九次真实对比；输入：只含环境引用的配置；输出：隔离证据，不读取隐藏验收正文。"""
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import urllib.error

WORKSPACE = Path('/run/desktop/mnt/host/d/AI/workspace')
BENCH = WORKSPACE / 'pao-dev/.pao/地图简报与部门协作-20261020/benchmark'
TEMP = WORKSPACE / '临时文件夹/地图简报基准-20261020'
RUN = BENCH / 'real-run-20261021'
RUN.mkdir(exist_ok=True)
home = TEMP / 'controller-home'
home.mkdir(exist_ok=True)
os.environ.update(HOME=str(home), HARBOR_TELEMETRY='0', TMPDIR='/tmp',
                  PYTHONPATH=str(BENCH))
sys.path.insert(0, str(BENCH))

def mapped(value):
    if isinstance(value, str) and value.startswith('D:/AI/workspace/'):
        return str(WORKSPACE / value[len('D:/AI/workspace/'):])
    if isinstance(value, dict):
        return {k: mapped(v) for k, v in value.items()}
    if isinstance(value, list):
        return [mapped(v) for v in value]
    return value

def write(name, value):
    (RUN / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + '\n', encoding='utf-8')

async def job(profile, install=False, installation_round=1, smoke=False):
    from harbor.models.job.config import JobConfig
    from harbor.job import Job
    config = mapped(json.loads((BENCH / 'configs' / f'{profile}.yaml').read_text(encoding='utf-8')))
    config['quiet'] = True
    if install:
        config['job_name'] = f'install-smoke{installation_round}-' + profile
        config['install_only'] = True
        config['tasks'] = config['tasks'][:1]
    if smoke:
        config['job_name'] = 'runtime-smoke-' + profile
        config['tasks'] = [{'path': str(TEMP / 'runtime-smoke')}]
        config['environment']['kwargs'] = {'keep_containers': True}
    output = RUN / 'jobs' / config['job_name']
    if output.exists():
        raise FileExistsError(f'拒绝覆盖或自动重跑：{output}')
    prefix = 'install-' if install else ('smoke-' if smoke else '')
    write('runtime-config-' + prefix + profile + '.json', config)
    parsed = JobConfig.model_validate(config)
    print('JOB_CREATE', parsed.job_name, flush=True)
    instance = await Job.create(parsed)
    print('JOB_RUN', parsed.job_name, flush=True)
    result = await instance.run()
    write(prefix + profile + '-summary.json', result.model_dump(mode='json'))
    print('JOB_DONE', parsed.job_name, result.stats.model_dump(mode='json'), flush=True)
    if smoke and (result.stats.n_errored_trials or any(
        metric.get('mean') != 1 for evaluation in result.stats.evals.values() for metric in evaluation.metrics)):
        raise RuntimeError('合成运行检查未通过；禁止当成正式题目成功。')
    return result

async def main():
    mode = sys.argv[1]
    if mode == 'diagnostics':
        subprocess.run([sys.executable, '-m', 'pip', 'check'], check=True)
        subprocess.run([sys.executable, '-m', 'unittest', 'test_pao_agent', 'test_usage'], cwd=BENCH, check=True)
        from harbor.models.job.config import JobConfig
        for profile in ('single', 'pre-pao', 'post-pao'):
            JobConfig.model_validate(mapped(json.loads((BENCH / 'configs' / f'{profile}.yaml').read_text(encoding='utf-8'))))
        data = {'harbor': importlib.metadata.version('harbor'), 'python': sys.version,
                'packages': sorted([{'name': d.metadata['Name'], 'version': d.version} for d in importlib.metadata.distributions()], key=lambda d:d['name'].lower()),
                'docker': subprocess.check_output(['docker', 'version', '--format', '{{json .Server}}'], text=True),
                'compose': subprocess.check_output(['docker', 'compose', 'version'], text=True),
                'adapter_sha256': hashlib.sha256((BENCH / 'map_bench_pao/pao_agent.py').read_bytes()).hexdigest()}
        write('linux-controller-environment.json', data)
        print('LINUX_CONTROLLER_OK', flush=True)
    elif mode == 'api-smoke':
        payload = {'model': 'group/deepseek', 'messages': [{'role': 'user', 'content': 'Reply with only BENCH_READY.'}],
                   'reasoning_effort': 'high', 'max_completion_tokens': 2048, 'stream': False}
        request = urllib.request.Request('http://host.docker.internal:3425/v1/chat/completions',
            data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + os.environ['PAO_BENCH_API_KEY']})
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                data = json.load(response)
                result = {'status': response.status, 'elapsed_sec': time.monotonic()-started,
                          'model': data.get('model'), 'usage': data.get('usage'),
                          'choices': [{'finish_reason': c.get('finish_reason'),
                                       'content': c.get('message', {}).get('content')} for c in data.get('choices', [])],
                          'scope': '单次连通校准，不纳入九次任务质量统计'}
        except urllib.error.HTTPError as error:
            detail = error.read().decode('utf-8', 'replace').replace(os.environ['PAO_BENCH_API_KEY'], '[redacted]')
            result = {'status': error.code, 'elapsed_sec': time.monotonic()-started, 'error': detail[:2000]}
        write('api-smoke.json', result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        if result['status'] != 200:
            raise RuntimeError('DeepSeek 连通检查失败；不启动正式付费试验')
    elif mode.startswith('smoke-'):
        await job(mode[len('smoke-'):], smoke=True)
    elif mode.startswith('install2-'):
        await job(mode[len('install2-'):], install=True, installation_round=2)
    elif mode.startswith('install-'):
        await job(mode[len('install-'):], install=True)
    elif mode == 'run':
        sys.path.insert(0, str(BENCH / 'scripts'))
        from validate_preparation import validate_preparation
        preparation = validate_preparation(BENCH)
        write('final-preparation-validation.json', preparation)
        if not preparation['ready_for_real_run']:
            raise RuntimeError(preparation['pending'])
        subprocess.run([sys.executable, '-m', 'unittest', 'test_pao_agent', 'test_usage'], cwd=BENCH, check=True)
        # 确认 Harbor 前缀已由公共解析器移除，不再把 magpie 误传给线上模型。
        from map_bench_pao import PAOAgent
        from harbor.models.model_api_format import ModelApiFormat
        config = mapped(json.loads((BENCH / 'configs/single.yaml').read_text(encoding='utf-8')))['agents'][0]
        agent = PAOAgent(logs_dir=RUN / 'preflight-agent', model_name=config['model_name'],
            model_base_url=config['model_base_url'], model_api_key_name=config['model_api_key_name'],
            model_api_format=ModelApiFormat.OPENAI_CHAT_COMPLETIONS, **config['kwargs'])
        parsed = agent._parse_model_name(config['model_name'])
        write('model-parse-preflight.json', {'input': config['model_name'], 'parsed': parsed})
        if parsed[1] != 'group/deepseek':
            raise RuntimeError(f'模型名解析仍有前缀：{parsed}')
        for profile in ('single', 'pre-pao', 'post-pao'):
            await job(profile)
    else:
        raise ValueError(mode)

asyncio.run(main())
