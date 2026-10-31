"""核对冻结与显式授权后，启动本轮隔离网络及控制器。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from typing import Callable

if __package__:
    from . import controller as bench_controller
    from . import network_runtime
    from . import runner_common
else:
    import bench_controller
    import network_runtime
    import runner_common


DOCKER_EXE = "D:/Docker/resources/bin/docker.exe"
CONTROLLER_IMAGE = "pao-benchmark-controller:20261021"
LINUX_RUNTIME_SOURCE = Path(
    "D:/AI/workspace/临时文件夹/地图简报基准-20261020/f-harbor-linux"
)
LINUX_RUNTIME_CONTAINER_ROOT = (
    "/mnt/d/AI/workspace/临时文件夹/地图简报基准-20261020/f-harbor-linux"
)
LINUX_PYTHON = LINUX_RUNTIME_CONTAINER_ROOT + "/.venv/bin/python"
HARBOR_SOURCE = Path(
    "D:/AI/workspace/临时文件夹/地图简报基准-20261020/f-harbor-import/harbor-source"
)
HARBOR_CONTAINER_ROOT = (
    "/mnt/d/AI/workspace/临时文件夹/地图简报基准-20261020/f-harbor-import/harbor-source"
)
AUTHORIZATION_PATH = "launch-authorization.json"


def docker_query(
    docker: str,
    *args: str,
    timeout: int = 30,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [docker, *args],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def container_state(docker: str, name: str) -> dict:
    result = docker_query(
        docker,
        "inspect",
        "--format",
        "{{json .State}}",
        name,
    )
    if result.returncode != 0:
        raise RuntimeError("Docker 状态查询失败：" + (result.stderr or result.stdout))
    state = json.loads(result.stdout)
    if not isinstance(state, dict):
        raise ValueError("Docker inspect 返回的状态不是对象")
    return state


def container_image_id(docker: str, name: str) -> str:
    """查询容器实际使用的不可变镜像 ID；tag 只作为可重建的名称。"""
    result = docker_query(
        docker,
        "inspect",
        "--format",
        "{{.Image}}",
        name,
    )
    if result.returncode != 0:
        raise RuntimeError("Docker 镜像身份查询失败：" + (result.stderr or result.stdout))
    image_id = result.stdout.strip()
    if not image_id:
        raise ValueError("Docker inspect 未返回实际 image ID")
    return image_id


def verify_previous(
    previous: Path,
    *,
    docker: str = DOCKER_EXE,
    query: Callable[[str, str], dict] = container_state,
) -> dict:
    receipt_path = previous / "terminal-receipt.json"
    containers_path = previous / "runtime-containers.json"
    if not receipt_path.is_file() or not containers_path.is_file():
        raise ValueError("指定上一轮缺少 terminal-receipt.json 或 runtime-containers.json")
    receipt = runner_common.read_json(receipt_path)
    if receipt.get("writers_stopped_observed") is not True:
        raise RuntimeError("上一轮未确认停写")
    containers_record = runner_common.read_json(containers_path)
    names = containers_record.get("containers")
    if not isinstance(names, list) or not names or not all(
        isinstance(name, str) and name for name in names
    ):
        raise ValueError("上一轮容器名单无效")
    runner_common.validate_terminal_scope(receipt, names)
    scope = containers_record.get("scope")
    if not isinstance(scope, dict):
        raise ValueError("上一轮容器记录缺少观察阶段和范围")
    if scope != receipt.get("scope"):
        raise ValueError("上一轮终局回执与容器观察范围不一致")
    observed = []
    for name in names:
        state = query(docker, name)
        # 一次性评分容器正常退出后仍保留 Pid 与 ExitCode；Running 才是存活事实。
        if state.get("Running") or state.get("Paused") or state.get("Restarting"):
            raise RuntimeError("上一轮容器仍可能写入：" + name)
        observed.append({"name": name, "state": state})
    return {"receipt": receipt, "containers": observed, "scope": scope}


def _linux_interpreter_identity(linux_python: str, runtime_source: Path, docker: str) -> dict:
    """Windows 不能打开 WSL 链接时，由 Linux 只读解析同一挂载。"""
    script = (
        "import hashlib,json,sys; from pathlib import Path; "
        "root=Path(sys.argv[2]).resolve(strict=True); "
        "p=Path(sys.argv[1]).resolve(strict=True); "
        "assert p.is_relative_to(root), 'Linux Python 路径越过固定运行目录'; "
        "assert p.is_file(), 'Linux Python 不是文件'; "
        "cfg=root/'.venv'/'pyvenv.cfg'; "
        "print(json.dumps({'resolved_relative':str(p.relative_to(root)),"
        "'host_source_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),"
        "'host_source_bytes':p.stat().st_size,"
        "'venv_config_sha256':hashlib.sha256(cfg.read_bytes()).hexdigest()}))"
    )
    result = docker_query(
        docker, "run", "--rm", "--restart=no", "--network", "none",
        "-v", f"{runtime_source}:{LINUX_RUNTIME_CONTAINER_ROOT}:ro",
        CONTROLLER_IMAGE, "python3", "-c", script, linux_python,
        LINUX_RUNTIME_CONTAINER_ROOT, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError("Linux 解释器只读核验失败：" + (result.stderr or result.stdout))
    observed = json.loads(result.stdout)
    resolved_source = runtime_source / observed.pop("resolved_relative")
    return {
        "container_path": linux_python,
        "runtime_source": str(runtime_source),
        "runtime_container_root": LINUX_RUNTIME_CONTAINER_ROOT,
        "host_source_path": str(resolved_source),
        "inspection": "linux_container_readonly",
        **observed,
    }


def interpreter_identity(linux_python: str, runtime_source: Path, *, docker: str = DOCKER_EXE) -> dict:
    """只记录固定 Linux 运行目录中解释器与 venv 配置，不扫描整个工作区。"""
    prefix = LINUX_RUNTIME_CONTAINER_ROOT.rstrip("/") + "/"
    if not linux_python.startswith(prefix):
        raise ValueError("Linux Python 路径不在固定运行目录挂载根下")
    runtime_source = runtime_source.resolve()
    python_path = (runtime_source / linux_python[len(prefix):]).resolve()
    if not python_path.is_relative_to(runtime_source):
        raise ValueError("Linux Python 路径越过固定运行目录")
    try:
        exists = python_path.is_file()
    except OSError as error:
        if os.name != "nt" or error.winerror != 1920:
            raise
        return _linux_interpreter_identity(linux_python, runtime_source, docker)
    if not exists:
        raise FileNotFoundError("Linux Python 文件不存在：" + str(python_path))
    config_path = runtime_source / ".venv" / "pyvenv.cfg"
    if not config_path.is_file():
        raise FileNotFoundError("Linux venv 配置不存在：" + str(config_path))
    return {
        "container_path": linux_python,
        "runtime_source": str(runtime_source),
        "runtime_container_root": LINUX_RUNTIME_CONTAINER_ROOT,
        "host_source_path": str(python_path),
        "host_source_sha256": hashlib.sha256(python_path.read_bytes()).hexdigest(),
        "host_source_bytes": python_path.stat().st_size,
        "venv_config_sha256": hashlib.sha256(config_path.read_bytes()).hexdigest(),
    }


def authorization_identity(run: Path, config: dict, agent: dict) -> dict:
    return {
        "run": str(run.resolve()),
        "controller": config["job_name"],
        "run_config_sha256": runner_common.digest(run / "run-config.json"),
        "run_freeze_sha256": runner_common.digest(run / "run-freeze.json"),
        "model": runner_common.model_id(agent["model_name"]),
        "thinking": agent["kwargs"]["thinking"],
        "tasks": [task["name"] for task in config["tasks"]],
        "attempts": 1,
        "automatic_retries": 0,
    }


def write_launch_authorization(
    run: Path,
    *,
    real_model_calls_authorized: bool,
    docker_authorized: bool,
) -> dict:
    """显式记录本次付费模型与 Docker 授权；两项缺一不可。"""
    run = run.resolve()
    if not real_model_calls_authorized or not docker_authorized:
        raise ValueError("真实模型调用和 Docker 必须分别明确授权")
    if (run / "control-started.json").exists() or (
        run / "runtime-launch.json"
    ).exists():
        raise FileExistsError("本轮已经启动，不能再补记启动授权")
    mounts = runner_common.read_json(run / "run-sources.json")["container_mounts"]
    config = bench_controller.validate(
        run,
        final_run=run,
        container_mounts=mounts,
    )
    agent = runner_common.validate_run_config(config)
    value = {
        "at": runner_common.now(),
        **authorization_identity(run, config, agent),
        "real_model_calls_authorized": True,
        "docker_authorized": True,
    }
    runner_common.write_json(run / AUTHORIZATION_PATH, value)
    return value


def verify_launch_authorization(run: Path, config: dict, agent: dict) -> dict:
    path = run / AUTHORIZATION_PATH
    if not path.is_file():
        raise ValueError("缺少 launch-authorization.json；新运行不得付费或启动 Docker")
    approval = runner_common.read_json(path)
    expected = authorization_identity(run, config, agent)
    if approval.get("real_model_calls_authorized") is not True:
        raise ValueError("缺少真实模型调用授权")
    if approval.get("docker_authorized") is not True:
        raise ValueError("缺少 Docker 启动授权")
    for key, value in expected.items():
        if approval.get(key) != value:
            raise ValueError("启动授权与当前运行身份不一致：" + key)
    return approval


def restricted_mounts(run: Path, config: dict, mounts: dict[str, str]) -> list[tuple[Path, str, str]]:
    """只挂目标运行、缓存、Linux 环境及其现用 editable Harbor 源码。"""
    run = run.resolve()
    container_run = runner_common.container_path(run, mounts)
    harbor_cache = runner_common.absolute_path(
        runner_common.read_json(run / "run-sources.json")["harbor_cache"],
        "harbor_cache",
    )
    if not harbor_cache.is_dir():
        raise FileNotFoundError("Harbor 缓存目录不存在：" + str(harbor_cache))
    runtime_source = LINUX_RUNTIME_SOURCE.resolve()
    if not runtime_source.is_dir():
        raise FileNotFoundError("Linux 运行环境不存在：" + str(runtime_source))
    harbor_source = HARBOR_SOURCE.resolve()
    if not (harbor_source / "src" / "harbor" / "__init__.py").is_file():
        raise FileNotFoundError("现用 Harbor 源码不存在：" + str(harbor_source))
    workspace = Path("D:/AI/workspace").resolve()
    specs = [
        (run, container_run, "rw"),
        (harbor_cache, "/root/.cache/harbor", "rw"),
        (runtime_source, LINUX_RUNTIME_CONTAINER_ROOT, "ro"),
        (harbor_source, HARBOR_CONTAINER_ROOT, "ro"),
    ]
    for source, _target, _mode in specs:
        if source == workspace:
            raise ValueError("禁止把整个开发工作区挂入基准容器：" + str(source))
    return specs


def launch(
    run: Path,
    *,
    previous: Path | None = None,
    docker: str = DOCKER_EXE,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    query: Callable[[str, str], dict] = container_state,
    image_query: Callable[[str, str], str] = container_image_id,
    environ: dict[str, str] | None = None,
) -> dict:
    run = run.resolve()
    run_sources = runner_common.read_json(run / "run-sources.json")
    if (run / "control-started.json").exists():
        raise FileExistsError("本轮已有 control-started.json，拒绝启动重放")
    if (run / "control-request.json").exists():
        raise ValueError("本轮已有控制请求，拒绝自动恢复")
    mounts = run_sources["container_mounts"]
    config = bench_controller.validate(
        run,
        final_run=run,
        container_mounts=mounts,
    )
    agent = runner_common.validate_run_config(config)
    verify_launch_authorization(run, config, agent)
    approval = runner_common.read_json(run / "approved-launch.json")
    if approval.get("controller") not in (None, config["job_name"]):
        raise ValueError("授权控制器名与本轮配置不一致")
    if approval.get("tasks") != [config["tasks"][0]["name"]]:
        raise ValueError("授权题目范围与本轮配置不一致")
    if (
        approval.get("model") != runner_common.model_id(agent["model_name"])
        or approval.get("thinking") != agent["kwargs"]["thinking"]
        or approval.get("attempts") != 1
        or approval.get("automatic_retries") != 0
    ):
        raise ValueError("授权模型、思考强度、次数或重试范围不一致")
    if previous is not None:
        verify_previous(previous, docker=docker, query=query)
    env = dict(os.environ if environ is None else environ)
    if not env.get("PAO_BENCH_API_KEY"):
        raise ValueError("缺少现有环境变量 PAO_BENCH_API_KEY")
    container_run = runner_common.container_path(run, mounts)
    name = config["job_name"]
    python_identity = interpreter_identity(LINUX_PYTHON, LINUX_RUNTIME_SOURCE, docker=docker)
    mount_specs = restricted_mounts(run, config, mounts)
    execute = runner or docker_query
    # 自动网络只在冻结、授权、模型环境、上一轮和挂载校验全部通过后创建。
    network_runtime.ensure_external_network(run, docker, runner=execute)
    command = [
        docker,
        "run",
        "-d",
        "--name",
        name,
        "--restart=no",
        "-e",
        "PAO_BENCH_API_KEY",
        "-e",
        "HARBOR_TELEMETRY=0",
        "-e",
        "PYTHONIOENCODING=utf-8",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
    ]
    for source, target, mode in mount_specs:
        command.extend(["-v", f"{source}:{target}:{mode}"])
    command.extend(
        [
            CONTROLLER_IMAGE,
            LINUX_PYTHON,
            container_run + "/bench_controller.py",
            "run",
            "--run",
            container_run,
        ]
    )
    # 单次标记必须由控制器创建；入口只在 Docker 成功后保存启动回执。
    # 凭证只通过子进程环境传递；argv 中只保留变量名。
    result = execute(docker, *command[1:], timeout=60, env=env)
    if result.returncode != 0:
        raise RuntimeError("Docker 控制器启动失败：" + (result.stderr or result.stdout))
    container_id = result.stdout.strip()
    if not container_id:
        raise RuntimeError("Docker 启动未返回容器 ID")
    image_id = image_query(docker, name)
    runtime_receipt = {
        "at": runner_common.now(),
        "container_name": name,
        "container_id": container_id,
        "image_name": CONTROLLER_IMAGE,
        "image_id": image_id,
        "interpreter": python_identity,
    }
    runner_common.write_json(run / "runtime-launch.json", runtime_receipt)
    runner_common.write_json(
        run / "runtime-containers.json",
        {
            "at": runner_common.now(),
            "containers": [name],
            "launch": runtime_receipt,
        },
    )
    (run / "approved-controller-id.txt").write_text(
        container_id + "\n", encoding="utf-8"
    )
    return {
        "started": name,
        "container_id": container_id,
        "image_id": image_id,
        "interpreter": python_identity,
        "auto_restart": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--authorize-real-model-calls", action="store_true")
    parser.add_argument("--authorize-docker", action="store_true")
    args = parser.parse_args()
    if args.authorize_real_model_calls or args.authorize_docker:
        write_launch_authorization(
            args.run,
            real_model_calls_authorized=args.authorize_real_model_calls,
            docker_authorized=args.authorize_docker,
        )
    print(
        json.dumps(
            launch(args.run, previous=args.previous),
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
