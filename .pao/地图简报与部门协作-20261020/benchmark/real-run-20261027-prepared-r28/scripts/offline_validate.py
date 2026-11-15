"""离线运行真实 Harbor/Pydantic 校验；缺依赖保留原错误，不安装，不调用模型。"""
from __future__ import annotations
import importlib.metadata
import json
import sys
from pathlib import Path
import yaml
from harbor.models.job.config import JobConfig

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from map_bench_pao.pao_agent import PAOAgent, PAOOptions
from validate_preparation import validate_preparation


def main():
    summary = validate_preparation(ROOT)
    for path in sorted((ROOT / 'configs').glob('*.yaml')):
        config = yaml.safe_load(path.read_text(encoding='utf-8'))
        parsed = JobConfig.model_validate(config)
        agent = parsed.agents[0]
        options = PAOOptions.model_validate(agent.kwargs)
        if options.profile != path.stem or agent.import_path != 'map_bench_pao:PAOAgent':
            raise ValueError(f'{path.name}: 入口或 profile 错误')
        if PAOAgent.options_model is not PAOOptions:
            raise ValueError('适配器未使用同一 options schema')
    version = importlib.metadata.version('harbor')
    if version != '0.24.0':
        raise ValueError(f'Harbor 版本不匹配：{version}')
    print(json.dumps({**summary, 'harbor_version': version, 'harbor_schema_valid': True}, ensure_ascii=False))


if __name__ == '__main__':
    main()
