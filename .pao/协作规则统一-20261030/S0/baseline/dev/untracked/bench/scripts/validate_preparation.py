"""用途：标准库准备一致性校验；输入：清单与 JSON 形式 YAML；输出：JSON，不冒充 Harbor 校验。"""
import ast
import hashlib
import json
import re
from pathlib import Path


def resolve_recorded_path(value):
    """把 Windows 记录路径映射到 WSL 的 /mnt/<drive>；本机存在时原样使用。"""
    path = Path(value)
    if path.exists() or not re.match(r"^[A-Za-z]:[\\/]", value):
        return path
    drive = value[0].lower()
    suffix = Path(value[2:].replace("\\", "/").lstrip("/"))
    return Path("/mnt") / drive / suffix


def validate_preparation(root):
    m = json.loads((root / 'fixed-manifest.json').read_text(encoding='utf-8'))
    assert m['benchmark']['commit'] == '452bf305c6daa62fc59061d22133a7cbc7c1572e'
    assert m['benchmark']['tag'] == 'v4.0.0'
    assert m['dataset']['version'] == '4.0.0' and m['dataset']['task_count'] == 66
    assert m['benchmark']['dataset'] == 'terminal-bench/terminal-bench@4.0.0'
    profiles = {'single', 'pre-pao', 'post-pao'}
    assert {p.stem for p in (root / 'configs').glob('*.yaml')} == profiles
    baseline = None
    for name in sorted(profiles):
        c = json.loads((root / f'configs/{name}.yaml').read_text(encoding='utf-8'))
        assert c['tasks'] == [{'name': t['dataset_task_name'], 'ref': t['hub_task_ref']} for t in m['dataset']['selected']]
        assert len(c['agents']) == 1
        a, p = c['agents'][0], m['profiles'][name]
        kw = a['kwargs']
        assert a['import_path'] == 'map_bench_pao:PAOAgent' and kw['profile'] == name
        assert a['model_name'] == m['fairness_fixed']['model_name']
        assert kw['thinking'] == m['fairness_fixed']['thinking'] and kw['tools'] == m['fairness_fixed']['tool_allowlist']
        assert kw['no_extensions'] is False
        assert kw['source_sha256'] == p['source_archive_sha256'] and kw['source_archive'] == p['source_archive']
        assert a['env'] == c['environment']['env'] == m['fairness_fixed']['environment']
        common = {key: c[key] for key in ('tasks', 'n_attempts', 'n_concurrent_trials', 'retry', 'environment', 'verifier')}
        common['agent'] = {key: value for key, value in a.items() if key != 'kwargs'}
        common['kwargs'] = {key: kw[key] for key in ('thinking', 'tools', 'no_extensions', 'source_build_command',
                                                   'model_data_archive', 'model_data_sha256')}
        assert kw['model_data_sha256'] == m['fairness_fixed']['model_data_sha256']
        assert kw['source_build_command'] == m['fairness_fixed']['source_build_command']
        assert hashlib.sha256(resolve_recorded_path(kw['model_data_archive']).read_bytes()).hexdigest() == kw['model_data_sha256']
        if baseline is None:
            baseline = common
        assert common == baseline, f'{name}: 公平项不一致'
        assert c['n_attempts'] == 1 and c['n_concurrent_trials'] == 1 and c['retry']['max_retries'] == 0
        assert c['verifier'] == {'disable': False}
        assert c['environment']['type'] == 'docker' and c['environment']['force_build'] is True
        assert all(c['environment'].get(k) is None for k in ('override_cpus', 'override_memory_mb', 'override_storage_mb'))
        if name == 'pre-pao':
            assert kw['archive_format'] == 'zip'
            for field, digest_field in [('source_archive', 'source_sha256'), ('source_overlay_archive', 'source_overlay_sha256')]:
                assert kw[digest_field] == (p['source_archive_sha256'] if field == 'source_archive' else p['source_overlay_sha256'])
                assert hashlib.sha256(resolve_recorded_path(kw[field]).read_bytes()).hexdigest() == kw[digest_field]
        elif kw['source_sha256'] == 'pending':
            assert kw['source_archive'] == 'pending'
        else:
            assert kw['archive_format'] == 'zip'
            assert hashlib.sha256(resolve_recorded_path(kw['source_archive']).read_bytes()).hexdigest() == kw['source_sha256']
    assert m['profiles']['single']['source_archive_sha256'] == m['profiles']['post-pao']['source_archive_sha256']
    assert m['profiles']['single']['source_archive'] == m['profiles']['post-pao']['source_archive']
    for path in [*root.glob('*.py'), *(root / 'map_bench_pao').glob('*.py'), *(root / 'scripts').glob('*.py')]:
        ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    public = json.loads((root / 'public-inputs.json').read_text(encoding='utf-8'))
    for t in public['tasks']:
        for item in t['files']:
            path = item['path']
            assert path in {'instruction.md', 'task.toml'} or path.startswith('environment/')
            assert not any(part in {'solution', 'tests', 'cheat'} for part in Path(path).parts)
    pending = ['最终源码封板'] if any(m['profiles'][p]['source_archive_sha256'] == 'pending' for p in profiles) else []
    run = root / 'real-run-20261021'
    if not (root / 'real-run-authorization.json').is_file():
        pending.append('真实模型与 Docker 授权')
    if not (run / 'linux-controller-environment.json').is_file():
        pending.append('Linux Harbor 完整必需依赖')
    for profile in ('single', 'post-pao'):
        native = run / f'native-smoke-{profile}.json'
        if native.is_file() and json.loads(native.read_text(encoding='utf-8')).get('ok') is True:
            continue  # 原生子进程、真实工具、逐字节文件核验；历史 Harbor 404 原件仍保留。
        summary = run / f'smoke-{profile}-summary.json'
        stats = json.loads(summary.read_text(encoding='utf-8'))['stats'] if summary.is_file() else None
        if not stats or stats['n_errored_trials'] or not stats['n_completed_trials'] or not all(
            metric.get('mean') == 1 for evaluation in stats['evals'].values() for metric in evaluation['metrics']):
            pending.append(f'{profile} 容器安装/运行/合成验收')
    return {'ok': True, 'validation': '准备一致性与语法检查；运行就绪判断引用单独的真实容器证据',
            'profiles': sorted(profiles), 'task_count': 3, 'ready_for_real_run': not pending,
            'pending': pending, 'limits': ['PAO 全角色总量覆盖须按正式轨迹核对，未知不填零',
                                         '修复前运行失败如实记失败，不回填修复']}


if __name__ == '__main__':
    print(json.dumps(validate_preparation(Path(__file__).resolve().parents[1]), ensure_ascii=False))
