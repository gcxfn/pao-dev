"""用途：无模型核查真实Harbor配置解析和网络覆写路径列表。"""
import json
from pathlib import Path
from harbor.models.job.config import JobConfig
from harbor.environments.base import BaseEnvironment

run = Path('/run/desktop/mnt/host/d/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020/benchmark/real-run-20261025-prepared-r14')
config = JobConfig.model_validate_json((run / 'run-config.json').read_text())
paths = config.environment.kwargs['extra_docker_compose']
assert isinstance(paths, list) and len(paths) == 1
normalized = BaseEnvironment._normalize_extra_docker_compose_paths(paths)
assert normalized == [run / 'network-override.yaml'], normalized
print(json.dumps({'actual_harbor_job_config':'passed','actual_path_normalizer':'passed','models_called':0}))
