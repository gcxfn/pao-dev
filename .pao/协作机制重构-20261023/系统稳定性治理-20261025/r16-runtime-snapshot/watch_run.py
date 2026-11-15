"""按本轮身份观察 Docker 与控制事实；只在真实停写后签发终局回执。"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import traceback
from typing import Callable

import bench_controller
import runner_common


DOCKER_EXE = "D:/Docker/resources/bin/docker.exe"


def query(docker: str, *args: str, timeout: int = 30) -> str:
    result = subprocess.run(
        [docker, *args],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Docker 查询失败：" + (result.stderr.strip() or result.stdout.strip())
        )
    return result.stdout


def expected_projects(run: Path) -> set[str]:
    projects = set()
    # Harbor 的真实层级是 jobs/<job>/<trial>/config.json；job 自身的配置没有
    # trial_name，不能混入试次身份。
    for config_path in sorted((run / "jobs").glob("*/*/config.json")):
        config = runner_common.read_json(config_path)
        trial = config.get("trial_name")
        if not isinstance(trial, str) or not trial:
            raise ValueError("试次配置缺少 trial_name：" + str(config_path))
        projects.add(bench_controller.compose_project(trial))
        projects.add(bench_controller.compose_project(trial) + "__verifier__trial")
    return projects


def score_container_name(run: Path) -> str:
    """与控制器评分容器使用同一个本轮身份推导。"""
    run_sources_path = run / "run-sources.json"
    if not run_sources_path.is_file():
        raise FileNotFoundError("缺少 run-sources.json，不能推导评分容器身份")
    # 控制器按评分入口的 run 根路径命名，与配置里给模型使用的容器路径无关。
    return "pao-score-" + hashlib.sha256(str(run).encode()).hexdigest()[:16]


def discover(
    run: Path,
    controller: str,
    *,
    docker: str = DOCKER_EXE,
    runner: Callable[..., str] = query,
) -> list[dict]:
    projects = expected_projects(run)
    score_container = score_container_name(run)
    rows = runner(docker, "ps", "-a", "--format", "{{json .}}")
    found = []
    for line in rows.splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        if not isinstance(item, dict) or not isinstance(item.get("Names"), str):
            raise ValueError("Docker ps 返回项无效")
        labels = dict(
            part.split("=", 1)
            for part in item.get("Labels", "").split(",")
            if "=" in part
        )
        project = labels.get("com.docker.compose.project", "")
        role = (
            "controller"
            if item["Names"] == controller
            else "score"
            if item["Names"] == score_container
            else "workflow"
        )
        in_expected_project = any(
            project == value or project.startswith(value + "__")
            for value in projects
        )
        if (
            item["Names"] not in {controller, score_container}
            and not in_expected_project
        ):
            continue
        state_text = runner(
            docker,
            "inspect",
            "--format",
            "{{json .State}}",
            item["Names"],
        )
        state = json.loads(state_text)
        if not isinstance(state, dict):
            raise ValueError("Docker inspect 返回的状态无效")
        found.append({"name": item["Names"], "role": role, "state": state})
    if not any(item["name"] == controller for item in found):
        raise RuntimeError("本轮控制器不见，不能声称正常退出")
    found.sort(key=lambda item: item["name"])
    runner_common.write_json(
        run / "runtime-containers.json",
        {"at": runner_common.now(), "containers": [item["name"] for item in found]},
    )
    return found


def is_active(state: dict) -> bool:
    # Docker 停止后仍保留 Pid 与 ExitCode，只有这些运行标志表示仍可能写入。
    return any(state.get(key) for key in ("Running", "Paused", "Restarting"))


def reward_rows(run: Path) -> list[dict]:
    rows = []
    for path in sorted((run / "jobs").glob("*task-*/*/result.json")):
        value = runner_common.read_json(path)
        verifier = value.get("verifier_result")
        rewards = verifier.get("rewards") if isinstance(verifier, dict) else None
        reward = rewards.get("reward") if isinstance(rewards, dict) else None
        rows.append(
            {
                "result": path.relative_to(run).as_posix(),
                "reward": reward,
                "exception": value.get("exception_info"),
                "agent_result": value.get("agent_result"),
            }
        )
    return rows


def terminal_facts(run: Path, control: dict | None) -> dict:
    """把业务失败与实际停写分开；只读取已有控制事实，不改写控制状态。"""
    status = (control or {}).get("state")
    preflight_path = run / "preflight-summary.json"
    preflight = (
        runner_common.read_json(preflight_path)
        if preflight_path.is_file()
        else None
    )
    preflight_error = None
    if isinstance(preflight, dict):
        rows = preflight.get("trial_results")
        if isinstance(rows, list):
            errors = [
                row.get("exception_info")
                for row in rows
                if isinstance(row, dict) and row.get("exception_info")
            ]
            if errors:
                preflight_error = errors
    control_error = (control or {}).get("error")
    model_execution_started = (control or {}).get("model_execution_started")
    rewards = reward_rows(run)
    allowed = (
        status == "failed"
        and not rewards
        and (
            control_error is not None
            or preflight_error is not None
        )
    )
    return {
        "business_status": status,
        "business_failed": status == "failed",
        "error": control_error,
        "preflight_error": preflight_error,
        "formal_result_exists": bool(rewards),
        "model_execution_started": model_execution_started,
        "scoring": (
            "official_result_available"
            if rewards
            else "not_run"
            if model_execution_started is False
            else "missing_or_not_run"
        ),
        "allow_failure_without_formal_result": allowed,
    }


def observe_once(
    run: Path,
    controller: str,
    *,
    docker: str = DOCKER_EXE,
    runner: Callable[..., str] = query,
) -> dict:
    containers = discover(run, controller, docker=docker, runner=runner)
    controller_state = next(
        item["state"] for item in containers if item["name"] == controller
    )
    control_path = run / "control-status.json"
    control = runner_common.read_json(control_path) if control_path.is_file() else None
    controller_stopped = not is_active(controller_state)
    all_stopped = all(not is_active(item["state"]) for item in containers)
    writers_stopped = control is not None and control.get("writers_stopped") is True
    facts = terminal_facts(run, control)
    controller_exit_code = controller_state.get("ExitCode")
    controller_crash = (
        controller_stopped
        and isinstance(controller_exit_code, int)
        and not isinstance(controller_exit_code, bool)
        and controller_exit_code != 0
    )
    container_names = [item["name"] for item in containers]
    if len(container_names) != len(set(container_names)):
        raise ValueError("本轮容器身份重复，不能确认停写")
    result = {
        "at": runner_common.now(),
        "controller_stopped": controller_stopped,
        "containers_stopped": all_stopped,
        "writers_stopped": writers_stopped,
        "actual_stop_observed": controller_stopped and all_stopped,
        "container_identities_verified": True,
        "controller_exit_code": controller_exit_code,
        "controller_crash": controller_crash,
        "business_terminal": facts,
        "containers": containers,
        "control_status": control,
    }
    actual_stop = controller_stopped and all_stopped
    if actual_stop and (
        writers_stopped
        or facts["allow_failure_without_formal_result"]
        or controller_crash
    ):
        rewards = reward_rows(run)
        abnormal_exit_without_result = (
            controller_crash
            and not rewards
            and not facts["allow_failure_without_formal_result"]
            and not writers_stopped
        )
        if (
            not rewards
            and not facts["allow_failure_without_formal_result"]
            and not abnormal_exit_without_result
        ):
            raise ValueError("停写后没有找到正式试次 result.json")
        receipt = {
            **result,
            "writers_stopped_observed": True,
            "official_rewards": [row["reward"] for row in rewards],
            "reward_note": (
                "仅原版 verifier_result；缺失保持 null，真实 0.0 原样保留"
                if rewards
                else (
                    "预检失败且明确未启动正式模型；官方评分未运行，不填 0"
                    if facts["model_execution_started"] is False
                    else "控制器异常退出且没有正式评分结果；不将缺失解释为 0"
                    if abnormal_exit_without_result
                    else "没有正式评分结果；不将缺失解释为 0"
                )
            ),
            "exceptions": [
                row["exception"] for row in rewards if row["exception"] is not None
            ],
            "agent_results": [row["agent_result"] for row in rewards],
        }
        runner_common.write_json(run / "terminal-receipt.json", receipt)
        runner_common.write_json(
            run / "controller-exit.json",
            {
                "at": result["at"],
                "writers_stopped": writers_stopped,
                "writers_stopped_observed": True,
                "actors_stopped_observed": True,
                "controller_exit_code": controller_exit_code,
                "controller_crash": controller_crash,
                "terminal_basis": (
                    "writers_stopped"
                    if writers_stopped
                    else "controller_crash"
                    if controller_crash
                    else "failed_before_formal_result"
                ),
                "business_status_preserved": control.get("state")
                if control is not None
                else None,
            },
        )
        result["terminal"] = True
    else:
        runner_common.write_json(
            run / "watch-state.json",
            {
                **result,
                "terminal": False,
                "note": "控制器、写入确认或本轮容器尚未同时满足停写条件",
            },
        )
        result["terminal"] = False
    return result


def watch(
    run: Path,
    controller: str,
    *,
    docker: str = DOCKER_EXE,
    runner: Callable[..., str] = query,
    interval: float = 15.0,
    max_seconds: float = 3600.0,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    started = time.monotonic()
    while True:
        try:
            result = observe_once(
                run,
                controller,
                docker=docker,
                runner=runner,
            )
        except BaseException as error:
            runner_common.write_json(
                run / "watch-error.json",
                {
                    "at": runner_common.now(),
                    "error_type": type(error).__name__,
                    "error": repr(error),
                    "traceback": traceback.format_exc(),
                },
            )
            raise
        if result["terminal"]:
            return result
        if time.monotonic() - started >= max_seconds:
            error = TimeoutError("观察到期仍不能确认本轮停写")
            runner_common.write_json(
                run / "watch-error.json",
                {
                    "at": runner_common.now(),
                    "error_type": type(error).__name__,
                    "error": repr(error),
                    "traceback": traceback.format_exc(),
                    "last_state": result,
                },
            )
            raise error
        sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--controller", required=True)
    parser.add_argument("--interval", type=float, default=15.0)
    parser.add_argument("--max-seconds", type=float, default=3600.0)
    parser.add_argument("--docker", default=DOCKER_EXE)
    args = parser.parse_args()
    print(
        json.dumps(
            watch(
                args.run.resolve(),
                args.controller,
                docker=args.docker,
                interval=args.interval,
                max_seconds=args.max_seconds,
            ),
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
