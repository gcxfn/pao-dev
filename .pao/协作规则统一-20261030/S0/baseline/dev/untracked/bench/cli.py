"""PAO 基准工具的唯一命令入口；各子命令复用现有实现。"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

if __package__:
    from . import clean as clean_module
    from . import controller
    from . import launch
    from . import network
    from . import prepare as prepare_module
    from . import report as report_module
    from . import runner_common
    from . import watch
else:
    import clean as clean_module
    import controller
    import launch
    import network
    import prepare as prepare_module
    import report as report_module
    import runner_common
    import watch


def _print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _optional_json(path: Path) -> dict[str, Any] | None:
    return runner_common.read_json(path) if path.is_file() else None


def _controller_name(run: Path) -> str:
    runtime = _optional_json(run / "runtime-launch.json")
    if runtime is not None:
        name = runtime.get("container_name")
        if isinstance(name, str) and name:
            return name
    config = runner_common.read_json(run / "run-config.json")
    name = config.get("job_name")
    if not isinstance(name, str) or not name:
        raise ValueError("run-config.json 缺少 job_name")
    return name


def _business_complete(run: Path) -> bool:
    control = _optional_json(run / "control-status.json")
    rewards = watch.reward_rows(run)
    facts = watch.terminal_facts(run, control, rewards)
    return (
        facts["business_status"] == "finished"
        and facts["valid_reward_count"] > 0
        and facts["missing_reward_count"] == 0
        and facts["malformed_reward_count"] == 0
    )


def _source_check(path: Path) -> dict[str, Any]:
    value = runner_common.read_json(path)
    required = {
        "run_parent",
        "run_dir",
        "pao_source",
        "benchmark_source",
        "task_source",
        "task_source_manifest",
        "container_mounts",
        "harbor_cache",
    }
    missing = sorted(required.difference(value))
    mounts = value.get("container_mounts")
    mount_error = None
    if not isinstance(mounts, dict):
        mount_error = "container_mounts 必须是对象"
    else:
        local_root = mounts.get("local_root")
        if not isinstance(local_root, str) or not Path(local_root).is_dir():
            mount_error = "container_mounts.local_root 不是现有目录"
    return {
        "ok": not missing and mount_error is None,
        "path": str(path.resolve()),
        "missing_keys": missing,
        "mount_error": mount_error,
    }


def doctor(
    *,
    sources: Path | None = None,
    run: Path | None = None,
    docker: str = launch.DOCKER_EXE,
) -> tuple[dict[str, Any], int]:
    package = Path(__file__).resolve().parent
    required = [
        package / "__main__.py",
        package / "controller.py",
        package / "prepare.py",
        package / "launch.py",
        package / "watch.py",
        package / "runner_common.py",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    try:
        live_network = network.observe_live_networks(docker)
    except Exception as error:
        live_network = {
            "ok": False,
            "error_type": type(error).__name__,
            "error": str(error),
            "writes_performed": False,
        }
    checks: dict[str, Any] = {
        "python": sys.version,
        "package": {"ok": not missing, "missing": missing},
        "network": live_network,
    }
    if sources is not None:
        checks["sources"] = _source_check(sources)
    if run is not None:
        resolved = run.resolve()
        checks["run"] = {
            "ok": False,
            "path": str(resolved),
            "config": None,
            "mounts": None,
        }
        try:
            config = controller.validate(resolved)
            mounts = runner_common.read_json(resolved / "run-sources.json")[
                "container_mounts"
            ]
            mount_specs = launch.restricted_mounts(resolved, config, mounts)
            checks["run"] = {
                "ok": True,
                "path": str(resolved),
                "config": {
                    "job_name": config["job_name"],
                    "tasks": [task["name"] for task in config["tasks"]],
                },
                "mounts": [
                    {
                        "source": str(source),
                        "target": target,
                        "mode": mode,
                    }
                    for source, target, mode in mount_specs
                ],
            }
        except Exception as error:
            checks["run"]["error"] = f"{type(error).__name__}: {error}"
    ok = all(
        item.get("ok") is True
        for item in checks.values()
        if isinstance(item, dict)
    )
    return {
        "ok": ok,
        "checks": checks,
        "model_calls": 0,
        "docker_writes": 0,
    }, 0 if ok else 1


def _status_payload(run: Path, controller_name: str, docker: str) -> dict[str, Any]:
    try:
        observed = watch.observe_once(
            run,
            controller_name,
            docker=docker,
        )
        return {
            "ok": True,
            "business_complete": _business_complete(run),
            "observation": observed,
        }
    except Exception as error:
        recorded = controller.record_observer_error(
            run,
            error,
            stage="status_observation",
        )
        control = _optional_json(run / "control-status.json")
        return {
            "ok": False,
            "business_complete": False,
            "observation_error": recorded,
            "control_status": control,
            "note": "观察失败已留证；没有修改控制状态或取消作业。",
        }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m bench",
        description="PAO 基准工具：离线准备、受控启动、观察、评分、报告与清理。",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor_parser = subparsers.add_parser("doctor", help="只读体检")
    doctor_parser.add_argument("--sources", type=Path)
    doctor_parser.add_argument("--run", type=Path)
    doctor_parser.add_argument("--docker", default=launch.DOCKER_EXE)

    prepare_parser = subparsers.add_parser("prepare", help="纯离线组装运行目录")
    prepare_parser.add_argument("--sources", type=Path, required=True)

    run_parser = subparsers.add_parser("run", help="准备或启动已冻结运行")
    run_input = run_parser.add_mutually_exclusive_group()
    run_input.add_argument("--sources", type=Path)
    run_input.add_argument("--run", type=Path)
    run_parser.add_argument("--previous", type=Path)
    run_parser.add_argument("--docker", default=launch.DOCKER_EXE)
    run_parser.add_argument(
        "--rehearsal",
        action="store_true",
        help="用回环脚本模型运行隔离产品工作流，不使用真实模型或 Docker",
    )
    run_parser.add_argument("--output", type=Path, help="隔离彩排输出目录")
    run_parser.add_argument("--node", type=Path, help="彩排使用的 Node 可执行文件绝对路径")
    run_parser.add_argument("--authorize-real-model-calls", action="store_true")
    run_parser.add_argument("--authorize-docker", action="store_true")

    status_parser = subparsers.add_parser("status", help="只读查询当前状态")
    status_parser.add_argument("--run", type=Path, required=True)
    status_parser.add_argument("--controller")
    status_parser.add_argument("--docker", default=launch.DOCKER_EXE)

    collect_parser = subparsers.add_parser("collect", help="观察并收取停写回执")
    collect_parser.add_argument("--run", type=Path, required=True)
    collect_parser.add_argument("--controller")
    collect_parser.add_argument("--docker", default=launch.DOCKER_EXE)
    collect_parser.add_argument("--interval", type=float, default=15.0)
    collect_parser.add_argument("--max-seconds", type=float, default=3600.0)

    score_parser = subparsers.add_parser("score", help="对已停止成果独立评分")
    score_parser.add_argument("--run", type=Path, required=True)
    score_parser.add_argument("--score-spec", type=Path, required=True)
    score_parser.add_argument("--docker", default=launch.DOCKER_EXE)
    score_parser.add_argument("--authorize-docker", action="store_true")

    report_parser = subparsers.add_parser("report", help="从现有证据生成报告")
    report_parser.add_argument("--run", type=Path, required=True)

    clean_parser = subparsers.add_parser("clean", help="按运行身份预览或精确清理容器与网络")
    clean_parser.add_argument("--run", type=Path, required=True)
    clean_parser.add_argument("--docker", default=clean_module.DOCKER_EXE)
    clean_parser.add_argument("--execute", action="store_true")
    clean_parser.add_argument("--confirm-run")
    clean_parser.add_argument("--authorize-docker", action="store_true")
    return parser


def _dispatch(args: argparse.Namespace) -> int:
    if args.command == "doctor":
        value, exit_code = doctor(
            sources=args.sources,
            run=args.run,
            docker=args.docker,
        )
        _print_json(value)
        return exit_code

    if args.command == "prepare":
        _print_json(prepare_module.prepare(args.sources))
        return 0

    if args.command == "run":
        if args.rehearsal:
            if args.sources is not None or args.run is not None or args.previous is not None:
                raise ValueError("隔离彩排不接受真实运行的 --sources、--run 或 --previous；输出用 --output")
            executable = str(args.node) if args.node is not None else shutil.which("node")
            if not executable or not Path(executable).is_absolute() or not Path(executable).is_file():
                raise ValueError("未找到 Node；请用 --node 指定现有可执行文件的绝对路径")
            command = [executable, str(Path(__file__).resolve().parent / "rehearsal" / "run-rehearsal.mjs")]
            if args.output is not None:
                command.extend(["--output", str(args.output.resolve())])
            completed = subprocess.run(
                command,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return completed.returncode
        if args.sources is None and args.run is None:
            raise ValueError("真实运行须指定 --sources 或 --run；隔离彩排使用 --rehearsal")
        if args.output is not None or args.node is not None:
            raise ValueError("--output 和 --node 仅用于 --rehearsal")
        if not args.authorize_real_model_calls or not args.authorize_docker:
            raise ValueError("新运行必须同时、分别明确授权真实模型调用与 Docker")
        if args.sources is not None:
            observation = network.observe_live_networks(args.docker)
            if observation.get("ok") is not True:
                raise RuntimeError(f"启动前网络观察失败：{observation.get('error')}")
            run = Path(
                prepare_module.prepare(args.sources, network_observation=observation)["run"]
            ).resolve()
        else:
            run = args.run.resolve()
        launch.write_launch_authorization(
            run,
            real_model_calls_authorized=True,
            docker_authorized=True,
        )
        result = launch.launch(
            run,
            previous=args.previous,
            docker=args.docker,
        )
        _print_json(
            {
                "run": str(run),
                "launch": result,
                "business_complete": False,
                "note": "命令只确认已启动；业务完成以 status、collect 或 report 为准。",
            }
        )
        return 0

    if args.command == "status":
        run = args.run.resolve()
        controller_name = args.controller or _controller_name(run)
        value = _status_payload(run, controller_name, args.docker)
        _print_json(value)
        return 0 if value["ok"] and value["business_complete"] else 2 if not value["ok"] else 1

    if args.command == "collect":
        run = args.run.resolve()
        controller_name = args.controller or _controller_name(run)
        value = watch.watch(
            run,
            controller_name,
            docker=args.docker,
            interval=args.interval,
            max_seconds=args.max_seconds,
        )
        _print_json(value)
        return 0 if _business_complete(run) else 1

    if args.command == "score":
        if not args.authorize_docker:
            raise ValueError("独立评分会启动 Docker 评分容器；请显式添加 --authorize-docker")
        _print_json(
            controller.score_current(
                args.run.resolve(),
                args.score_spec.resolve(),
                args.docker,
            )
        )
        return 0

    if args.command == "report":
        result = report_module.generate(args.run.resolve())
        _print_json(result)
        return 0 if result["business_complete"] else 1

    if args.command == "clean":
        if args.execute and not args.authorize_docker:
            raise ValueError("执行停止需要显式添加 --authorize-docker")
        result = clean_module.clean(
            args.run.resolve(),
            execute=args.execute,
            confirm_run=args.confirm_run,
            docker=args.docker,
        )
        _print_json(result)
        return 0 if result.get("ok") is True and (not args.execute or result.get("completed") is True) else 1

    raise AssertionError("未知子命令：" + args.command)


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        return _dispatch(args)
    except Exception as error:
        traceback.print_exc()
        print(
            json.dumps(
                {
                    "ok": False,
                    "command": args.command,
                    "error_type": type(error).__name__,
                    "error": str(error),
                    **(
                        {"stage": error.stage, "evidence": error.evidence}
                        if isinstance(error, launch.network_runtime.NetworkRuntimeError)
                        else {}
                    ),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1
