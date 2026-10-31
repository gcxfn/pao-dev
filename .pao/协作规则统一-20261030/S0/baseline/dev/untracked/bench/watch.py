"""按本轮身份观察 Docker 与控制事实；只在真实停写后签发终局回执。"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import time
import traceback
from typing import Callable

if __package__:
    from . import controller as bench_controller
    from . import runner_common
else:
    import bench_controller
    import runner_common


DOCKER_EXE = "D:/Docker/resources/bin/docker.exe"


def query(docker: str, *args: str, timeout: int = 30) -> str:
    command = [docker, *args]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (subprocess.TimeoutExpired, OSError) as error:
        if isinstance(error, subprocess.TimeoutExpired):
            stdout = error.output
            stderr = error.stderr
        else:
            stdout = ""
            stderr = ""
        result = subprocess.CompletedProcess(
            command,
            None,
            stdout=stdout,
            stderr=stderr,
        )
        evidence = runner_common.command_evidence(
            *command,
            stage="watch_docker",
            completed=result,
        )
        error.evidence = evidence
        raise
    evidence = runner_common.command_evidence(
        *command,
        stage="watch_docker",
        completed=result,
    )
    if result.returncode != 0:
        error = RuntimeError("Docker 查询失败")
        error.evidence = evidence
        raise error
    return result.stdout


def trial_identities(run: Path) -> list[dict]:
    """读取真实 jobs/<job>/<trial>/config.json，并保留预检/正式阶段。"""
    identities = []
    # Harbor 的真实层级是 jobs/<job>/<trial>/config.json；job 自身的配置没有
    # trial_name，不能混入试次身份。
    for config_path in sorted((run / "jobs").glob("*/*/config.json")):
        config = runner_common.read_json(config_path)
        trial = config.get("trial_name")
        if not isinstance(trial, str) or not trial:
            raise ValueError("试次配置缺少 trial_name：" + str(config_path))
        job = config_path.parents[1]
        job_config_path = job / "config.json"
        job_name = None
        if job_config_path.is_file():
            job_config = runner_common.read_json(job_config_path)
            job_name = job_config.get("job_name")
            if job_name is not None and (
                not isinstance(job_name, str) or not job_name
            ):
                raise ValueError("Job 配置缺少有效 job_name：" + str(job_config_path))
        identities.append(
            {
                "trial": trial,
                "job_name": job_name,
                "job_dir": job.name,
                "phase": (
                    "preflight"
                    if isinstance(job_name, str) and job_name.endswith("-preflight")
                    else "formal"
                ),
            }
        )
    return identities


def expected_projects(run: Path) -> set[str]:
    projects = set()
    for identity in trial_identities(run):
        projects.add(bench_controller.compose_project(identity["trial"], "env"))
        if identity["phase"] != "preflight":
            projects.add(
                bench_controller.compose_project(identity["trial"], "verifier")
                + "__trial"
            )
    return projects


def score_container_name(run: Path) -> str:
    """与控制器评分容器使用同一个本轮身份推导。"""
    run_sources_path = run / "run-sources.json"
    if not run_sources_path.is_file():
        raise FileNotFoundError("缺少 run-sources.json，不能推导评分容器身份")
    # 控制器按评分入口的 run 根路径命名，与配置里给模型使用的容器路径无关。
    return "pao-score-" + hashlib.sha256(str(run).encode()).hexdigest()[:16]


def planned_identities(
    run: Path,
    controller: str,
    control: dict | None,
    trials: list[dict],
) -> list[dict]:
    """区分本阶段必须出现的身份和本轮已创建、须持续观察的历史身份。"""
    control_state = (control or {}).get("state")
    model_started = (control or {}).get("model_execution_started")
    if control_state == "preflight" or model_started is False:
        phase = "preflight"
    elif control_state in {
        "running",
        "paused",
        "finished",
        "execution_error",
        "missing_score",
        "mechanism_stopped",
        "stop_unconfirmed",
    }:
        phase = "formal"
    elif trials:
        phase = "unknown"
    else:
        phase = "not_started"
    planned = [{"kind": "controller", "name": controller, "role": "controller"}]
    observed = list(planned)
    for identity in trials:
        trial = identity["trial"]
        env_identity = (
            {
                "kind": "project",
                "project": bench_controller.compose_project(trial, "env"),
                "trial": trial,
                "role": "env",
                "phase": identity["phase"],
            }
        )
        observed.append(env_identity)
        if (
            (phase != "preflight" and identity["phase"] != "preflight")
            or (phase == "preflight" and identity["phase"] == "preflight")
        ):
            planned.append(env_identity)
        if phase != "preflight" and identity["phase"] != "preflight":
            result_path = run / "jobs" / identity["job_dir"] / trial / "result.json"
            trial_result = runner_common.read_json(result_path) if result_path.is_file() else None
            # 明确异常终局可以发生在评分前；未创建的 verifier 不等于仍在写入。
            # 已创建的评分容器仍在 observed 中发现并逐一核查实际状态。
            ended_before_score = (
                (control or {}).get("writers_stopped") is True
                and isinstance(trial_result, dict)
                and bool(trial_result.get("exception_info"))
                and trial_result.get("verifier_result") is None
            )
            verifier_identity = {
                "kind": "project",
                "project": (
                    bench_controller.compose_project(trial, "verifier")
                    + "__trial"
                ),
                "trial": trial,
                "role": "verifier",
                "phase": identity["phase"],
            }
            if not ended_before_score:
                planned.append(verifier_identity)
            observed.append(verifier_identity)
    score_dir = run / "current-score"
    scoring_started = score_dir.is_dir()
    scoring_complete = scoring_started and any(
        (score_dir / name).is_file()
        for name in ("result.json", "command-evidence.json")
    )
    score_identity = {
        "kind": "container",
        "name": score_container_name(run),
        "role": "score",
        "phase": "scoring",
    }
    observed.append(score_identity)
    if scoring_started and not scoring_complete:
        planned.append(
            score_identity
        )
    return [{"phase": phase, "identities": planned, "observed_identities": observed}]


def project_families(planned: list[dict]) -> list[tuple[str, dict]]:
    """返回当前轮项目的精确前缀和计划角色。"""
    families = []
    for item in planned:
        if item["kind"] != "project":
            continue
        base = (
            bench_controller.compose_project(item["trial"], "env")
            if item["role"] == "env"
            else bench_controller.compose_project(item["trial"], "verifier")
            + "__trial"
        )
        families.append((base, item))
    return families


def match_project(project: str, families: list[tuple[str, dict]]) -> dict | None:
    for base, item in families:
        if project == base or project.startswith(base + "__"):
            return item
    return None


def _discover_scope(
    run: Path,
    controller: str,
    *,
    docker: str = DOCKER_EXE,
    runner: Callable[..., str] = query,
) -> tuple[list[dict], dict]:
    control_path = run / "control-status.json"
    control = runner_common.read_json(control_path) if control_path.is_file() else None
    trials = trial_identities(run)
    plan = planned_identities(run, controller, control, trials)[0]
    planned = plan["identities"]
    observed = plan["observed_identities"]
    families = project_families(observed)
    score_container = score_container_name(run)
    rows = runner(docker, "ps", "-a", "--size=false", "--format", "{{json .}}")
    controllers = [
        row for row in rows.splitlines()
        if row.strip()
        and json.loads(row).get("Names") == controller
    ]
    if len(controllers) > 1:
        raise ValueError("本轮控制器身份重复，不能确认停写")
    controller_created = bool(controllers) or (run / "approved-controller-id.txt").is_file()
    if planned[0]["kind"] == "controller" and not controller_created:
        planned = planned[1:]
    if not planned:
        raise RuntimeError("本轮尚无已创建的可核实身份")
    plan["identities"] = planned
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
        matched = match_project(project, families)
        if (
            item["Names"] not in {controller, score_container}
            and matched is None
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
        if item["Names"] == controller:
            role = "controller"
            matched_identity = next(
                (planned_item for planned_item in planned
                 if planned_item["kind"] == "controller"),
                None,
            )
        elif item["Names"] == score_container:
            role = "score"
            matched_identity = next(
                (planned_item for planned_item in planned
                 if planned_item.get("role") == "score"),
                None,
            )
        elif matched is not None:
            role = matched["role"]
            matched_identity = matched
        else:
            role = "unexpected_project"
            matched_identity = None
        found.append(
            {
                "name": item["Names"],
                "project": project or None,
                "role": role,
                "trial": matched.get("trial") if matched is not None else None,
                "planned": matched_identity is not None,
                "state": state,
            }
        )
    found.sort(key=lambda item: item["name"])
    names = [item["name"] for item in found]
    if len(names) != len(set(names)):
        raise ValueError("本轮容器身份重复，不能确认停写")
    discovered_projects = {
        item["project"] for item in found
        if item["project"] is not None and item["planned"]
    }
    discovered_roles = {
        (item["trial"], item["role"])
        for item in found
        if item["trial"] is not None and item["role"] in {"env", "verifier"}
    }
    missing = []
    for planned_item in planned:
        if planned_item["kind"] == "project":
            if (planned_item["trial"], planned_item["role"]) not in discovered_roles:
                missing.append(
                    {
                        "kind": "project",
                        "project": planned_item["project"],
                        "role": planned_item["role"],
                    }
                )
        elif planned_item["kind"] == "container":
            if not any(item["name"] == planned_item["name"] for item in found):
                missing.append(
                    {
                        "kind": "container",
                        "name": planned_item["name"],
                        "role": planned_item["role"],
                    }
                )
    controller_found = any(item["name"] == controller for item in found)
    if controller_created and not controller_found:
        missing.insert(
            0,
            {
                "kind": "container",
                "name": controller,
                "role": "controller",
            },
        )
    retired = []
    creator = next((item for item in found if item["name"] == controller), None)
    creator_exit = creator["state"].get("ExitCode") if creator is not None else None
    candidates = []
    for item in planned:
        if (
            item.get("role") != "verifier"
            or not any(entry.get("project") == item.get("project") for entry in missing)
            or (item["trial"], "env") not in discovered_roles
        ):
            continue
        identity = next((entry for entry in trials if entry["trial"] == item["trial"]), None)
        if identity is None:
            continue
        result_path = run / "jobs" / identity["job_dir"] / item["trial"] / "result.json"
        if not result_path.is_file():
            continue
        trial_result = runner_common.read_json(result_path)
        if (
            trial_result.get("exception_info")
            and isinstance(trial_result.get("finished_at"), str)
            and trial_result["finished_at"]
            and trial_result.get("verifier") is None
            and trial_result.get("verifier_result") is None
        ):
            candidates.append(item)
    if (
        candidates and creator is not None
        and isinstance(creator_exit, int) and not isinstance(creator_exit, bool)
        and creator_exit != 0 and all(not is_active(item["state"]) for item in found)
    ):
        # 创建者已失败停止，作答容器也已停止；后续评分资源不能再由本轮创建。
        # 只处理尚未发现的评分阶段，不能把缺失作答容器或未知状态当作停写。
        mounts = runner_common.read_json(run / "run-sources.json")["container_mounts"]
        config = bench_controller.validate(run, final_run=run, container_mounts=mounts)
        identity_path = run / "approved-controller-id.txt"
        launch_path = run / "runtime-launch.json"
        if identity_path.is_file() and launch_path.is_file():
            expected_id = identity_path.read_text(encoding="utf-8").strip()
            launch_identity = runner_common.read_json(launch_path)
            actual_id = runner(docker, "inspect", "--format", "{{.Id}}", controller).strip()
            if (
                len(expected_id) != 64 or any(c not in "0123456789abcdef" for c in expected_id)
                or actual_id != expected_id
                or launch_identity.get("container_id") != expected_id
                or launch_identity.get("container_name") != controller
                or config["job_name"] != controller
            ):
                raise ValueError("停止观察时控制器完整 ID 或冻结运行身份不一致")
            retired = candidates
            planned = [item for item in planned if item not in retired]
            missing = [
                item for item in missing
                if not any(item.get("project") == entry["project"] for entry in retired)
            ]
    scope_complete = controller_found and not missing
    scope = {
        "phase": plan["phase"],
        "planned_identities": planned,
        "observed_identities": observed,
        "created_trial_identities": trials,
        "discovered_container_names": names,
        "discovered_projects": sorted(discovered_projects),
        "missing_identities": missing,
        "retired_uncreated_stages": retired,
        "controller_found": controller_found,
        "score_expected": score_container
        if any(item.get("role") == "score" for item in planned)
        else None,
        "scope_complete": scope_complete,
    }
    runner_common.write_json(
        run / "runtime-containers.json",
        {
            "at": runner_common.now(),
            "containers": names,
            "scope": scope,
        },
    )
    runner_common.write_json(
        run / "container-scope.json",
        {"at": runner_common.now(), **scope},
    )
    return found, scope


def discover(
    run: Path,
    controller: str,
    *,
    docker: str = DOCKER_EXE,
    runner: Callable[..., str] = query,
) -> list[dict]:
    return _discover_scope(run, controller, docker=docker, runner=runner)[0]


def is_active(state: dict) -> bool:
    if any(not isinstance(state.get(key), bool) for key in ("Running", "Paused", "Restarting")):
        raise ValueError("Docker 容器运行状态字段不完整，不能确认停止")
    return runner_common.container_active(state)


def _reward_row(path: Path, run: Path) -> dict:
    relative = path.relative_to(run).as_posix()
    try:
        value = runner_common.read_json_value(path)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        return {
            "result": relative,
            "status": "malformed",
            "reward": None,
            "error": f"{type(error).__name__}: {error}",
            "exception": None,
            "agent_result": None,
            "official_verifier_result_exists": False,
        }
    if not isinstance(value, dict):
        return {
            "result": relative,
            "status": "malformed",
            "reward": None,
            "error": f"结果根必须是对象，实际为 {type(value).__name__}",
            "exception": None,
            "agent_result": None,
            "official_verifier_result_exists": False,
        }
    verifier = value.get("verifier_result")
    official_verifier_result_exists = isinstance(verifier, dict)
    rewards = verifier.get("rewards") if isinstance(verifier, dict) else None
    present = isinstance(rewards, dict) and "reward" in rewards
    reward = rewards.get("reward") if present else None
    if not present or reward is None:
        status = "missing"
        error = None
    elif runner_common.finite_number(reward) and math.isfinite(reward):
        status = "valid"
        error = None
    else:
        status = "malformed"
        error = "奖励必须是非布尔有限数值"
    return {
        "result": relative,
        "status": status,
        "reward": reward if status == "valid" else None,
        "error": error,
        "exception": value.get("exception_info"),
        "agent_result": value.get("agent_result"),
        "official_verifier_result_exists": official_verifier_result_exists,
    }


def reward_rows(run: Path) -> list[dict]:
    return [
        _reward_row(path, run)
        for path in sorted((run / "jobs").glob("*task-*/*/result.json"))
    ]


def terminal_facts(
    run: Path,
    control: dict | None,
    rewards: list[dict] | None = None,
) -> dict:
    """把业务失败与实际停写分开；只读取已有控制事实，不改写控制状态。"""
    raw_status = (control or {}).get("state")
    status = (
        raw_status
        if isinstance(raw_status, str) and raw_status
        else "unknown"
    )
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
    rewards = reward_rows(run) if rewards is None else rewards
    valid_rewards = [row for row in rewards if row["status"] == "valid"]
    malformed_rewards = [row for row in rewards if row["status"] == "malformed"]
    official_verifier_result_count = sum(
        row["official_verifier_result_exists"] for row in rewards
    )
    business_failed = (
        True
        if status in {
            "failed",
            "execution_error",
            "missing_score",
            "mechanism_stopped",
            "stop_unconfirmed",
        }
        else False
        if status == "finished"
        else None
    )
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
        "business_finished": status == "finished",
        "business_failed": business_failed,
        "error": control_error,
        "preflight_error": preflight_error,
        "trial_result_exists": bool(rewards),
        "trial_result_count": len(rewards),
        "official_verifier_result_count": official_verifier_result_count,
        "formal_result_exists": official_verifier_result_count > 0,
        "valid_reward_count": len(valid_rewards),
        "missing_reward_count": sum(
            row["status"] == "missing" for row in rewards
        ),
        "malformed_reward_count": len(malformed_rewards),
        "model_execution_started": model_execution_started,
        "scoring": (
            "official_result_available"
            if valid_rewards
            else "official_result_malformed"
            if malformed_rewards
            else "official_result_missing_reward"
            if official_verifier_result_count
            else "not_run"
            if model_execution_started is False
            else "verifier_not_run"
            if rewards
            else "missing_or_not_run"
        ),
        "allow_failure_without_formal_result": allowed,
    }


def _reward_note(
    facts: dict,
    rewards: list[dict],
    *,
    controller_crash: bool,
) -> str:
    status = facts["business_status"]
    status_notes = {
        "finished": "控制器已结束（finished）；",
        "paused": "控制器已暂停，没有证明成功或正常作答；",
        "running": "控制器仍在运行，不能判定业务成功或失败；",
        "preflight": "控制器仍处于预检（preflight）；",
        "unknown": "控制状态未知，不能判定业务成功或失败；",
        "failed": "控制器报告失败（failed）；",
        "execution_error": "业务执行异常（execution_error）；",
        "missing_score": "控制器报告缺失分（missing_score）；",
        "mechanism_stopped": "控制器已停止机制（mechanism_stopped），不能当作成功；",
        "stop_unconfirmed": "控制器停写尚未确认（stop_unconfirmed），不能当作成功；",
    }
    prefix = status_notes.get(status, f"控制器状态为 {status}；")
    if facts["valid_reward_count"]:
        detail = "官方 verifier reward 原样保留，缺失项保持 null。"
    elif facts["malformed_reward_count"]:
        detail = "存在官方 verifier 结果但 reward 畸形，不填 0；原异常另存。"
    elif facts["official_verifier_result_count"]:
        detail = "官方 verifier 结果存在但没有 reward，不填 0；原异常另存。"
    elif rewards:
        detail = (
            "trial result 存在，但官方 verifier 未运行；"
            "reward 缺失，不填 0；原异常另存。"
        )
    elif status == "missing_score":
        detail = "没有官方 verifier 结果，reward 缺失，不填 0。"
    elif facts["model_execution_started"] is False:
        detail = "官方评分未运行，不填 0。"
    elif controller_crash:
        detail = "控制器异常退出且没有正式评分结果；不将缺失解释为 0。"
    else:
        detail = "没有正式评分结果；不将缺失解释为 0。"
    return prefix + detail


def observe_once(
    run: Path,
    controller: str,
    *,
    docker: str = DOCKER_EXE,
    runner: Callable[..., str] = query,
) -> dict:
    containers, scope = _discover_scope(run, controller, docker=docker, runner=runner)
    controller_state = next(
        (item["state"] for item in containers if item["name"] == controller),
        None,
    )
    control_path = run / "control-status.json"
    control = runner_common.read_json(control_path) if control_path.is_file() else None
    controller_stopped = (
        controller_state is not None and not is_active(controller_state)
    )
    all_stopped = bool(containers) and all(
        not is_active(item["state"]) for item in containers
    )
    writers_stopped = control is not None and control.get("writers_stopped") is True
    rewards = reward_rows(run)
    facts = terminal_facts(run, control, rewards)
    controller_exit_code = (
        controller_state.get("ExitCode") if controller_state is not None else None
    )
    controller_crash = (
        controller_stopped
        and isinstance(controller_exit_code, int)
        and not isinstance(controller_exit_code, bool)
        and controller_exit_code != 0
    )
    result = {
        "at": runner_common.now(),
        "controller_stopped": controller_stopped,
        "containers_stopped": all_stopped,
        "writers_stopped": writers_stopped,
        "actual_stop_observed": controller_stopped and all_stopped and scope["scope_complete"],
        "container_identities_verified": scope["scope_complete"],
        "scope": scope,
        "controller_exit_code": controller_exit_code,
        "controller_crash": controller_crash,
        "business_terminal": facts,
        "containers": containers,
        "control_status": control,
    }
    actual_stop = controller_stopped and all_stopped and scope["scope_complete"]
    if actual_stop and (
        writers_stopped
        or facts["allow_failure_without_formal_result"]
        or controller_crash
    ):
        valid_rewards = [row for row in rewards if row["status"] == "valid"]
        malformed_rewards = [
            row for row in rewards if row["status"] == "malformed"
        ]
        receipt = {
            **result,
            "writers_stopped_observed": True,
            "official_rewards": [row["reward"] for row in valid_rewards],
            "reward_rows": rewards,
            "reward_note": _reward_note(
                facts,
                rewards,
                controller_crash=controller_crash,
            ),
            "official_reward_status": facts["scoring"],
            "exceptions": [
                row["exception"] for row in rewards if row["exception"] is not None
            ],
            "reward_errors": [
                {
                    "result": row["result"],
                    "status": row["status"],
                    "error": row["error"],
                }
                for row in rewards
                if row["error"] is not None
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
                "scope": scope,
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


def _record_watch_failure(run: Path, error: BaseException) -> dict:
    """持久化观察失败；写证失败返回可并入 watch-error 的完整记录。"""
    evidence = getattr(error, "evidence", None)
    stage = (
        evidence.get("stage")
        if isinstance(evidence, dict) and isinstance(evidence.get("stage"), str)
        else "watch_observation"
    )
    return bench_controller.record_observer_error(run, error, stage=stage)


def _write_watch_error(run: Path, payload: dict, original: BaseException) -> None:
    """保留原观察错误；watch-error 写失败时同时暴露两项错误。"""
    try:
        runner_common.write_json(run / "watch-error.json", payload)
    except BaseException as evidence_error:
        grouped = BaseExceptionGroup(
            "观察失败且 watch-error 写入失败",
            [original, evidence_error],
        )
        grouped.stages = ("watch_observation", "watch_bookkeeping")
        raise grouped from original


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
            observation_error = _record_watch_failure(run, error)
            _write_watch_error(
                run,
                {
                    "at": runner_common.now(),
                    "error_type": type(error).__name__,
                    "error": repr(error),
                    "evidence": getattr(error, "evidence", None),
                    "traceback": traceback.format_exc(),
                    "observer_error": observation_error,
                },
                error,
            )
            raise
        if result["terminal"]:
            return result
        if time.monotonic() - started >= max_seconds:
            error = TimeoutError("观察到期仍不能确认本轮停写")
            observation_error = _record_watch_failure(run, error)
            _write_watch_error(
                run,
                {
                    "at": runner_common.now(),
                    "error_type": type(error).__name__,
                    "error": repr(error),
                    "traceback": traceback.format_exc(),
                    "last_state": result,
                    "observer_error": observation_error,
                },
                error,
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
