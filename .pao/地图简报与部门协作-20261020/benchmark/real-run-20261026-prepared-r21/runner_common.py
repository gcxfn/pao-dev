"""治理运行器的共享文件、摘要和模型绑定校验；不承载运行状态机。"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import subprocess
import tempfile
import zipfile
from typing import Any
import base64


def now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def digest(path: Path | str) -> str:
    path = Path(path)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(
        path.read_text(encoding="utf-8"),
        parse_constant=lambda value: (_ for _ in ()).throw(
            ValueError(f"JSON 含非有限数值：{value}：{path}")
        ),
    )
    if not isinstance(value, dict):
        raise ValueError(f"JSON 根必须是对象：{path}")
    return value


def read_json_value(path: Path) -> Any:
    """读取任意 JSON 根类型；用于需要定位单文件畸形而不提前终止的收证。"""
    return json.loads(
        path.read_text(encoding="utf-8"),
        parse_constant=lambda value: (_ for _ in ()).throw(
            ValueError(f"JSON 含非有限数值：{value}：{path}")
        ),
    )


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(path.name + ".pending")
    pending.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    pending.replace(path)


def absolute_path(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{label} 必须是绝对路径：{value}")
    return path.resolve()


def model_id(model_name: str) -> str:
    """与 Harbor 的 provider/model 拆分保持一致。"""
    parts = model_name.split("/", 1)
    if len(parts) == 1 or not parts[1]:
        raise ValueError("模型名必须包含 provider/model")
    return parts[1]


def load_model_metadata(
    path: Path,
    expected_sha256: str,
    model_name: str,
    thinking: str,
) -> dict[str, Any]:
    actual = digest(path)
    if actual != expected_sha256:
        raise ValueError("模型元数据摘要不符")
    root = read_json(path)
    models = root.get("models")
    if not isinstance(models, dict):
        raise ValueError("模型元数据缺少 models 对象")
    entry = models.get(model_name)
    if not isinstance(entry, dict):
        raise ValueError("可信模型元数据没有完整选定模型：" + model_name)
    if entry.get("id") != model_id(model_name):
        raise ValueError("模型元数据 id 与选定模型不一致")
    for key in ("contextWindow", "maxTokens"):
        value = entry.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"模型元数据 {key} 必须是正整数")
    inputs = entry.get("input")
    if not isinstance(inputs, list) or not inputs or not all(
        isinstance(item, str) and item for item in inputs
    ):
        raise ValueError("模型元数据 input 必须是非空字符串数组")
    mapping = entry.get("thinkingLevelMap")
    if not isinstance(mapping, dict) or mapping.get(thinking) != thinking:
        raise ValueError("模型元数据没有选定思考强度的真实映射")
    return entry


def validate_run_config(
    config: dict[str, Any],
    *,
    expected_task: str = "terminal-bench/html-js-filter",
) -> dict[str, Any]:
    validate_execution_contract(config, expected_task=expected_task)
    agents = config.get("agents")
    agent = agents[0]
    kwargs = agent.get("kwargs") or {}
    environment = config.get("environment") or {}
    if (
        environment.get("type") != "docker"
        or (environment.get("kwargs") or {}).get("keep_containers") is not True
    ):
        raise ValueError("需要保留 Docker 试次容器")
    if (config.get("verifier") or {}).get("disable") is not False:
        raise ValueError("正式运行不能关闭评分")
    return agent


def validate_execution_contract(
    config: dict[str, Any],
    *,
    expected_task: str = "terminal-bench/html-js-filter",
) -> None:
    """核对冻结运行共同的题目、次数、重试、代理和模型选择契约。"""
    tasks = config.get("tasks")
    if (
        not isinstance(tasks, list)
        or not tasks
        or any(
            not isinstance(task, dict)
            or not isinstance(task.get("name"), str)
            for task in tasks
        )
    ):
        raise ValueError("题目列表为空或格式无效")
    if any(task["name"] != expected_task for task in tasks):
        raise ValueError("题目范围不符")
    names = [task["name"] for task in tasks]
    if len(names) != len(set(names)):
        raise ValueError("题目列表重复")
    if len(tasks) != 1:
        raise ValueError("治理运行只允许一个题目")
    if config.get("n_attempts") != 1 or config.get("n_concurrent_trials") != 1:
        raise ValueError("治理运行只允许一次、串行执行")
    if (config.get("retry") or {}).get("max_retries") != 0:
        raise ValueError("治理运行禁止自动重试")
    agents = config.get("agents")
    if not isinstance(agents, list) or len(agents) != 1:
        raise ValueError("治理运行只允许一个主代理")
    agent = agents[0]
    if agent.get("import_path") != "map_bench_pao_organized:OrganizedPAOAgent":
        raise ValueError("治理运行只允许组织代理入口")
    kwargs = agent.get("kwargs") or {}
    if kwargs.get("profile") != "post-pao" or kwargs.get("thinking") != "high":
        raise ValueError("治理运行只允许 post-pao high")
    if kwargs.get("no_extensions") is not False:
        raise ValueError("治理运行不能关闭原生扩展")
    if kwargs.get("tools") != "read,bash,edit,write":
        raise ValueError("共同初始工具范围不符")
    if agent.get("model_api_key_name") != "PAO_BENCH_API_KEY":
        raise ValueError("凭证只允许现有 PAO_BENCH_API_KEY")
    if not agent.get("model_name"):
        raise ValueError("缺少选定模型")
    model_parts = agent["model_name"].split("/", 1)
    binding = agent.get("source_metadata")
    if (
        len(model_parts) != 2
        or not all(model_parts)
        or not isinstance(binding, dict)
        or binding.get("model_name") != agent["model_name"]
        or binding.get("provider") != model_parts[0]
        or binding.get("model") != model_parts[1]
        or binding.get("thinking") != kwargs.get("thinking")
        or not isinstance(binding.get("selected_model_name"), str)
        or model_id(binding["selected_model_name"]) != binding["model"]
    ):
        raise ValueError("模型配置与选定来源绑定不一致")


def finite_number(value: Any) -> bool:
    """仅明确有限实数可充当奖励，布尔值不能冒充 1/0。"""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def container_active(state: dict[str, Any]) -> bool:
    """Docker 停止后仍保留 Pid 与 ExitCode；仅运行标志表示可能继续写入。"""
    return any(state.get(key) is True for key in ("Running", "Paused", "Restarting"))


def validate_terminal_scope(receipt: dict[str, Any], containers: list[str]) -> dict[str, Any]:
    """核对终局回执的完整观察集合与同轮实际容器名单。"""
    scope = receipt.get("scope")
    if not isinstance(scope, dict):
        raise ValueError("终局回执缺少容器范围事实")
    discovered = scope.get("discovered_container_names")
    missing = scope.get("missing_identities")
    if scope.get("scope_complete") is not True or missing != []:
        raise RuntimeError("终局回执的容器范围不完整")
    if (
        not isinstance(discovered, list)
        or not discovered
        or not all(isinstance(name, str) and name for name in discovered)
        or len(discovered) != len(set(discovered))
    ):
        raise ValueError("终局回执的已发现容器名单无效")
    if set(discovered) != set(containers):
        raise ValueError("终局回执与同轮容器名单不一致")
    return scope


def command_evidence(
    *args: str,
    stage: str,
    completed: subprocess.CompletedProcess[Any],
) -> dict[str, Any]:
    """保存命令结果；二进制输出编码为 base64，凭证不进入记录。"""
    def json_safe_output(value: str | bytes | None) -> Any:
        if not isinstance(value, bytes):
            return value
        return {
            "encoding": "base64",
            "data": base64.b64encode(value).decode("ascii"),
        }

    return {
        "stage": stage,
        "argv": list(args),
        "returncode": completed.returncode,
        "stdout": json_safe_output(completed.stdout),
        "stderr": json_safe_output(completed.stderr),
    }


def container_path(path: Path, mounts: dict[str, str]) -> str:
    local_root = Path(mounts["local_root"]).resolve()
    container_root = mounts["container_root"].rstrip("/")
    try:
        relative = path.resolve().relative_to(local_root)
    except ValueError as error:
        raise ValueError(f"路径不在声明挂载根下：{path}") from error
    return container_root + "/" + relative.as_posix()


def staged_path(
    recorded: str,
    staging: Path,
    final_run: Path,
    mounts: dict[str, str],
) -> Path:
    """把最终运行目录中记录的容器路径映射到当前暂存目录。"""
    final_container = container_path(final_run, mounts)
    staging_container = container_path(staging, mounts)
    if recorded == final_container:
        return staging
    prefix = final_container.rstrip("/") + "/"
    if not recorded.startswith(prefix):
        raise ValueError("配置引用不在最终运行目录内：" + recorded)
    relative = PurePosixPath(recorded[len(prefix):])
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("配置引用越过最终运行目录：" + recorded)
    path = staging.joinpath(*relative.parts).resolve()
    if not path.is_relative_to(staging.resolve()):
        raise ValueError("配置引用越过暂存目录：" + recorded)
    return path


def validate_run_references(
    config: dict[str, Any],
    staging: Path,
    final_run: Path,
    mounts: dict[str, str],
) -> None:
    """逐项核对最终配置引用在当前暂存目录中存在且摘要吻合。"""
    agent = validate_run_config(config)
    kwargs = agent["kwargs"]
    override_root = staged_path(kwargs["configuration_root"], staging, final_run, mounts)
    expected_binding = {
        "model_name": agent["model_name"],
        "selected_model_name": agent["source_metadata"]["selected_model_name"],
        "provider": agent["source_metadata"]["provider"],
        "model": agent["source_metadata"]["model"],
        "thinking": agent["kwargs"]["thinking"],
    }
    if read_json(override_root / "role-model-binding.json") != expected_binding:
        raise ValueError("角色模型绑定与选定模型不一致")
    kit = read_json(override_root / "organized-post" / "kit.json")
    for node in kit["workflow"]["节点"]:
        if (
            node.get("模型") != expected_binding["provider"] + "/" + expected_binding["model"]
            or node.get("模型") != agent["model_name"]
            or node.get("思考强度") != expected_binding["thinking"]
            or node.get("档位") != "primary"
        ):
            raise ValueError("工作流角色模型配置不一致")
    for department in kit["departments"]:
        if (
            "默认档位:primary" not in department.get("recipe", "")
            or f"模型名:{agent['model_name']}" not in department.get("recipe", "")
            or f"思考强度:{expected_binding['thinking']}" not in department.get("recipe", "")
        ):
            raise ValueError("部门配方默认档位不一致")
    records = (
        ("source_archive", "source_sha256"),
        ("model_data_archive", "model_data_sha256"),
        ("node_archive", "node_sha256"),
        ("system_dependencies_archive", "system_dependencies_sha256"),
        ("model_metadata_path", "model_metadata_sha256"),
    )
    for path_key, sha_key in records:
        value = kwargs.get(path_key)
        expected = kwargs.get(sha_key)
        if not value or not expected:
            raise ValueError(f"配置缺少冻结引用：{path_key}/{sha_key}")
        path = staged_path(value, staging, final_run, mounts)
        if not path.is_file():
            raise FileNotFoundError("配置引用文件不存在：" + value)
        if digest(path) != expected:
            raise ValueError("配置引用摘要不符：" + value)
    compose = config.get("environment", {}).get("kwargs", {}).get(
        "extra_docker_compose"
    )
    if compose is not None:
        if not isinstance(compose, list) or not compose or not all(
            isinstance(item, str) and item for item in compose
        ):
            raise ValueError("extra_docker_compose 必须是非空文件路径列表")
        for value in compose:
            path = staged_path(value, staging, final_run, mounts)
            if not path.is_file():
                raise FileNotFoundError("网络覆写引用文件不存在：" + value)
    jobs = config.get("jobs_dir")
    staged_path(jobs, staging, final_run, mounts)


def git_source_files(repo: Path) -> list[str]:
    if not (repo / ".git").exists():
        raise FileNotFoundError(f"当前 PAO 源码不是 Git 工作树：{repo}")
    output = subprocess.check_output(
        [
            "git",
            "-C",
            str(repo),
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ]
    )
    names = sorted(
        {
            item.decode("utf-8")
            for item in output.split(b"\0")
            if item
        }
    )
    for name in names:
        relative = PurePosixPath(name.replace("\\", "/"))
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Git 来源路径越界：" + name)
    return names


def source_excluded(relative: PurePosixPath) -> bool:
    blocked_directories = {
        ".git",
        "node_modules",
        "dist",
        ".pao",
        ".agents",
        "archive",
        "__pycache__",
    }
    if any(part in blocked_directories for part in relative.parts):
        return True
    if relative.name == ".npmrc" or relative.name.startswith(".env"):
        return True
    return relative.suffix.lower() in {".pem", ".key", ".pfx", ".pyc"}


def build_source_archive(repo: Path, archive_path: Path) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    with zipfile.ZipFile(archive_path, "x", zipfile.ZIP_DEFLATED) as archive:
        for name in git_source_files(repo):
            relative = PurePosixPath(name.replace("\\", "/"))
            if source_excluded(relative):
                continue
            source = repo / relative
            if not source.is_file():
                continue
            data = source.read_bytes()
            archive.writestr(relative.as_posix(), data)
            records.append(
                {
                    "path": relative.as_posix(),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "bytes": len(data),
                }
            )
    return {
        "at": now(),
        "repo": str(repo),
        "archive": str(archive_path),
        "archive_sha256": digest(archive_path),
        "files": records,
    }


def copy_file(source: Path, destination: Path) -> dict[str, Any]:
    if not source.is_file():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(source.read_bytes())
    return {
        "source": str(source),
        "destination": str(destination),
        "sha256": digest(destination),
    }


def copy_tree_files(source: Path, destination: Path) -> list[dict[str, Any]]:
    if not source.is_dir():
        raise FileNotFoundError(source)
    records = []
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if not path.is_file() or source_excluded(PurePosixPath(relative.as_posix())):
            continue
        records.append(copy_file(path, destination / relative))
    return records


def file_records(root: Path, *, exclude: set[str] | None = None) -> list[dict[str, Any]]:
    excluded = exclude or set()
    return [
        {
            "path": path.relative_to(root).as_posix(),
            "sha256": digest(path),
        }
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.relative_to(root).as_posix() not in excluded
    ]


def temporary_sibling(run_dir: Path) -> Path:
    return Path(
        tempfile.mkdtemp(
            prefix=f".{run_dir.name}.preparing-",
            dir=run_dir.parent,
        )
    ).resolve()
