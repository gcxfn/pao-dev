"""按冻结运行身份预览或清理本轮已停止的容器和网络；默认不执行删除。"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Callable

if __package__:
    from . import network_runtime
    from . import runner_common
    from . import watch
else:
    import network_runtime
    import runner_common
    import watch


DOCKER_EXE = "D:/Docker/resources/bin/docker.exe"
DOCKER_TIMEOUT = 30
MIN_ID_PREFIX = 12
EXTERNAL_NETWORK_SOURCE = "auto_external"


class CleanCommandError(RuntimeError):
    """保留失败命令、返回码和输出，避免把查询失败误判成资源不存在。"""

    def __init__(
        self,
        message: str,
        *,
        command: list[str],
        returncode: int | None,
        stdout: str,
        stderr: str,
    ) -> None:
        super().__init__(message)
        self.command = command
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    def evidence(self) -> dict[str, Any]:
        return {
            "command": self.command,
            "returncode": self.returncode,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "error": str(self),
        }


def verify_run_identity(run: Path) -> dict:
    """核对运行目录、控制器名、容器 ID 和授权记录必须互相对应。"""
    run = run.resolve()
    if not run.is_dir():
        raise FileNotFoundError(run)
    launch_path = run / "runtime-launch.json"
    containers_path = run / "runtime-containers.json"
    approved_id_path = run / "approved-controller-id.txt"
    approval_path = run / "launch-authorization.json"
    required = (launch_path, containers_path, approved_id_path, approval_path)
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise ValueError("运行身份证据不完整：" + "、".join(missing))

    launch = runner_common.read_json(launch_path)
    containers = runner_common.read_json(containers_path)
    approval = runner_common.read_json(approval_path)
    name = launch.get("container_name")
    container_id = launch.get("container_id")
    approved_id = approved_id_path.read_text(encoding="utf-8").strip()
    names = containers.get("containers")
    if not isinstance(name, str) or not name:
        raise ValueError("runtime-launch.json 缺少 container_name")
    if not isinstance(container_id, str) or not container_id:
        raise ValueError("runtime-launch.json 缺少 container_id")
    if approved_id != container_id:
        raise ValueError("批准文件中的控制器 ID 与启动回执不一致")
    if not isinstance(names, list) or not all(
        isinstance(item, str) and item for item in names
    ):
        raise ValueError("runtime-containers.json 的 containers 名单无效")
    if name not in names:
        raise ValueError("runtime-containers.json 不包含本次控制器")
    if containers.get("launch") not in (None, launch):
        raise ValueError("runtime-containers.json 的启动回执不一致")
    if approval.get("docker_authorized") is not True:
        raise ValueError("缺少持久化的 Docker 启动授权")
    if approval.get("run") != str(run):
        raise ValueError("启动授权对应的运行目录不一致")
    if approval.get("controller") != name:
        raise ValueError("启动授权对应的控制器不一致")
    if approval.get("run_config_sha256") != runner_common.digest(
        run / "run-config.json"
    ):
        raise ValueError("启动授权绑定的运行配置已经改变")
    if approval.get("run_freeze_sha256") != runner_common.digest(
        run / "run-freeze.json"
    ):
        raise ValueError("启动授权绑定的冻结清单已经改变")
    approved_container_id = approval.get("container_id")
    if approved_container_id not in (None, container_id):
        raise ValueError("启动授权对应的容器 ID 不一致")
    return {
        "run": str(run),
        "controller": name,
        "container_id": container_id,
        "image_id": launch.get("image_id"),
        "authorization": approval.get("at"),
        "runtime_container_names": list(names),
    }


def _invoke(
    runner: Callable[..., subprocess.CompletedProcess[str]],
    docker: str,
    *args: str,
    timeout: int = DOCKER_TIMEOUT,
) -> subprocess.CompletedProcess[str]:
    command = [docker, *args]
    try:
        completed = runner(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as error:
        raise CleanCommandError(
            "Docker 命令超时",
            command=command,
            returncode=None,
            stdout=str(error.output or ""),
            stderr=str(error.stderr or ""),
        ) from error
    except OSError as error:
        raise CleanCommandError(
            f"Docker 命令无法启动：{error}",
            command=command,
            returncode=None,
            stdout="",
            stderr=str(error),
        ) from error
    if not isinstance(completed, subprocess.CompletedProcess):
        raise TypeError("runner 必须返回 subprocess.CompletedProcess")
    return completed


def _query(
    runner: Callable[..., subprocess.CompletedProcess[str]],
    docker: str,
    *args: str,
    timeout: int = DOCKER_TIMEOUT,
) -> str:
    completed = _invoke(runner, docker, *args, timeout=timeout)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise CleanCommandError(
            "Docker 查询失败：" + (detail or "没有返回错误文本"),
            command=[docker, *args],
            returncode=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
        )
    return completed.stdout or ""


def _mutate(
    runner: Callable[..., subprocess.CompletedProcess[str]],
    docker: str,
    *args: str,
    timeout: int = DOCKER_TIMEOUT,
) -> str:
    completed = _invoke(runner, docker, *args, timeout=timeout)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise CleanCommandError(
            "Docker 操作失败：" + (detail or "没有返回错误文本"),
            command=[docker, *args],
            returncode=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
        )
    return completed.stdout or ""


def _parse_json_lines(text: str, *, kind: str) -> list[dict[str, Any]]:
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"Docker {kind} 列表包含无效 JSON：{error}") from error
        if not isinstance(value, dict):
            raise ValueError(f"Docker {kind} 列表项不是对象")
        rows.append(value)
    return rows


def _labels(text: Any) -> dict[str, str]:
    if not isinstance(text, str) or not text:
        return {}
    return dict(
        part.split("=", 1)
        for part in text.split(",")
        if "=" in part
    )


def _inspect_labels(value: dict[str, Any]) -> dict[str, str]:
    config = value.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    if not isinstance(labels, dict):
        labels = value.get("Labels")
    if not isinstance(labels, dict):
        return {}
    return {
        str(key): item
        for key, item in labels.items()
        if isinstance(key, str) and isinstance(item, str)
    }


def _name(value: Any) -> str:
    return value.lstrip("/") if isinstance(value, str) else ""


def _same_id(left: Any, right: Any) -> bool:
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    left = left.strip().lower()
    right = right.strip().lower()
    if not left or not right:
        return False
    if left == right:
        return True
    if min(len(left), len(right)) < MIN_ID_PREFIX:
        return False
    return left.startswith(right) or right.startswith(left)


def _inspect_one(
    runner: Callable[..., subprocess.CompletedProcess[str]],
    docker: str,
    value: str,
    *,
    kind: str,
) -> dict[str, Any]:
    if kind == "container":
        text = _query(runner, docker, "inspect", "--type", "container", value)
    elif kind == "network":
        text = _query(runner, docker, "network", "inspect", value)
    else:
        raise ValueError("未知 inspect 类型：" + kind)
    try:
        rows = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"Docker {kind} inspect 返回无效 JSON：{error}") from error
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise ValueError(f"Docker {kind} inspect 必须返回单个对象数组")
    return rows[0]


def _network_not_found(
    completed: subprocess.CompletedProcess[str],
    identifier: str,
) -> bool:
    """只接受带本次标识符的缺失错误，或完整独立的遗留缺失短语。"""
    if not network_runtime._not_found(completed, identifier):
        return False
    text = (completed.stderr or completed.stdout or "").lower()
    expected = re.escape(identifier.lower())
    if re.search(rf"\bnetwork\s+{expected}\s+not found\b", text):
        return True
    if re.search(rf"\bno such network\s*:?\s*{expected}\b", text):
        return True
    return (
        re.search(r"(?<![\w.-])network not found(?![\w.-])", text)
        is not None
    )


def _inspect_network_optional(
    runner: Callable[..., subprocess.CompletedProcess[str]],
    docker: str,
    identifier: str,
) -> dict[str, Any] | None:
    """按精确 ID 检查网络；只有 Docker 明确报告不存在时才返回 None。"""
    completed = _invoke(runner, docker, "network", "inspect", identifier)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        if _network_not_found(completed, identifier):
            return None
        raise CleanCommandError(
            "Docker 网络查询失败：" + (detail or "没有返回错误文本"),
            command=[docker, "network", "inspect", identifier],
            returncode=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
        )
    try:
        rows = json.loads(completed.stdout or "")
    except json.JSONDecodeError as error:
        raise ValueError(f"Docker network inspect 返回无效 JSON：{error}") from error
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise ValueError("Docker network inspect 必须返回单个对象数组")
    return rows[0]


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _created_before(value: dict[str, Any], completed_at: datetime | None) -> bool | None:
    created = _timestamp(value.get("Created"))
    if created is None or completed_at is None:
        return None
    return created <= completed_at


def _state(value: dict[str, Any]) -> tuple[dict[str, Any] | None, bool | None]:
    state = value.get("State")
    if not isinstance(state, dict):
        return None, None
    flags = [state.get(key) for key in ("Running", "Paused", "Restarting")]
    if not all(isinstance(item, bool) for item in flags):
        return state, None
    return state, any(flags)


def _project_families(run: Path, controller: str) -> tuple[list[tuple[str, dict]], str | None]:
    trials = watch.trial_identities(run)
    control_path = run / "control-status.json"
    control = runner_common.read_json(control_path) if control_path.is_file() else None
    plan = watch.planned_identities(run, controller, control, trials)[0]
    families = watch.project_families(plan["observed_identities"])
    score_name = (
        watch.score_container_name(run)
        if (run / "run-sources.json").is_file()
        else None
    )
    return families, score_name


def _score_ids(run: Path) -> set[str]:
    path = run / "command-evidence.jsonl"
    if not path.is_file():
        return set()
    identifiers = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict) or value.get("stage") != "score_create":
            continue
        if value.get("returncode") != 0:
            continue
        stdout = value.get("stdout")
        if isinstance(stdout, str) and stdout.strip():
            identifiers.add(stdout.strip())
    return identifiers


def _terminal_evidence(run: Path, runtime_names: list[str]) -> dict[str, Any]:
    path = run / "terminal-receipt.json"
    evidence = {
        "ready": False,
        "path": str(path),
        "completed_at": None,
        "names": set(),
        "projects": set(),
        "error": None,
    }
    if not path.is_file():
        evidence["error"] = "缺少 terminal-receipt.json，成果日志尚未完成收取"
        return evidence
    try:
        receipt = runner_common.read_json(path)
        if receipt.get("writers_stopped_observed") is not True:
            raise ValueError("terminal-receipt 尚未确认本轮写者停止")
        scope = runner_common.validate_terminal_scope(receipt, runtime_names)
        completed_at = _timestamp(receipt.get("at"))
        if completed_at is None:
            raise ValueError("terminal-receipt 缺少有效完成时间")
        if not isinstance(receipt.get("business_terminal"), dict):
            raise ValueError("terminal-receipt 缺少业务终态")
        if not isinstance(receipt.get("reward_rows"), list):
            raise ValueError("terminal-receipt 缺少已收取的结果行")
        discovered = scope.get("discovered_container_names")
        projects = scope.get("discovered_projects")
        if not isinstance(discovered, list) or not isinstance(projects, list):
            raise ValueError("terminal-receipt 的范围名单无效")
        evidence.update(
            {
                "ready": True,
                "completed_at": completed_at,
                "names": set(discovered),
                "projects": set(projects),
            }
        )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, RuntimeError) as error:
        evidence["error"] = f"终局回执不可用：{type(error).__name__}: {error}"
    return evidence


def _previous_receipt(run: Path) -> dict[str, Any]:
    path = run / "clean-receipt.json"
    if not path.is_file():
        return {
            "attempts": [],
            "deleted_containers": [],
            "deleted_networks": [],
        }
    value = runner_common.read_json(path)
    attempts = value.get("attempts")
    containers = value.get("deleted_containers")
    networks = value.get("deleted_networks")
    return {
        "attempts": attempts if isinstance(attempts, list) else [],
        "deleted_containers": containers if isinstance(containers, list) else [],
        "deleted_networks": networks if isinstance(networks, list) else [],
    }


def _previous_deleted(previous: dict[str, Any], key: str) -> dict[str, dict[str, Any]]:
    rows = previous.get(key)
    result = {}
    if not isinstance(rows, list):
        return result
    for row in rows:
        if not isinstance(row, dict):
            continue
        identifier = row.get("id")
        if isinstance(identifier, str) and identifier:
            result[identifier] = row
    return result


def _auto_network_context(run: Path) -> dict[str, Any] | None:
    """读取并复用 network_runtime 的冻结计划与运行身份校验。"""
    try:
        context = network_runtime._validated_context(run)
    except (
        network_runtime.NetworkRuntimeError,
        OSError,
        UnicodeError,
        ValueError,
    ) as error:
        raise ValueError(f"自动网络冻结身份无效：{error}") from error
    return context if context.get("auto") is True else None


def _external_network_receipt(
    run: Path,
    context: dict[str, Any],
) -> tuple[dict[str, Any], str, str]:
    """按 network_runtime 固定契约读取并核对本次运行的网络收据。"""
    path = run / network_runtime.RECEIPT_PATH
    if not path.is_file():
        raise ValueError(
            "自动网络缺少 runtime-network.json，无法证明网络写入者，拒绝清理"
        )
    try:
        receipt = runner_common.read_json(path)
        network_id = network_runtime._receipt_matches(receipt, context=context)
    except (
        network_runtime.NetworkRuntimeError,
        OSError,
        UnicodeError,
        ValueError,
    ) as error:
        raise ValueError(f"runtime-network.json 无效：{error}") from error
    if _timestamp(receipt.get("at")) is None:
        raise ValueError("runtime-network.json 缺少有效写入时间")
    if not isinstance(receipt.get("created_at"), str) or not receipt["created_at"]:
        raise ValueError("runtime-network.json 缺少 Docker 网络创建时间")
    if receipt.get("endpoints") != {}:
        raise ValueError("runtime-network.json 未证明网络 endpoint 为空")
    try:
        receipt_sha256 = runner_common.digest(path)
    except OSError as error:
        raise ValueError(f"runtime-network.json 无法计算摘要：{error}") from error
    return receipt, network_id, receipt_sha256


def _validate_external_network_inspect(
    inspected: dict[str, Any],
    *,
    context: dict[str, Any],
    receipt: dict[str, Any],
    expected_id: str,
) -> dict[str, Any]:
    """按同一冻结身份核对 Docker 实况，并交叉核对运行收据。"""
    try:
        observed = network_runtime._validate_inspected_network(
            inspected,
            context=context,
            expected_id=expected_id,
            stage="clean_validate",
        )
    except network_runtime.NetworkRuntimeError as error:
        raise ValueError(f"自动网络 Docker 实况无效：{error}") from error
    if receipt.get("created_at") != observed["created_at"]:
        raise ValueError("runtime-network.json 的创建时间与 Docker 实况不一致")
    if receipt.get("endpoints") != observed["endpoints"]:
        raise ValueError("runtime-network.json 的 endpoint 证据与 Docker 实况不一致")
    return observed


def _previous_external_deleted(
    previous: dict[str, Any],
    *,
    receipt: dict[str, Any],
    receipt_sha256: str,
) -> bool:
    """只有本运行曾按同一完整 ID 删除时，网络缺失才算已完成清理。"""
    for row in _previous_deleted(previous, "deleted_networks").values():
        previous_id = row.get("id")
        if (
            row.get("source") == EXTERNAL_NETWORK_SOURCE
            and isinstance(previous_id, str)
            and previous_id.lower() == str(receipt.get("network_id")).lower()
            and row.get("name") == receipt.get("network_name")
            and row.get("run_identity_sha256")
            == receipt.get("run_identity_sha256")
            and row.get("receipt_sha256") == receipt_sha256
        ):
            return True
    return False


def _project_match(project: str, families: list[tuple[str, dict]]) -> bool:
    return bool(project) and watch.match_project(project, families) is not None


def _ownership_check(
    *,
    kind: str,
    name: str,
    project: str,
    created_before_receipt: bool | None,
    terminal: dict[str, Any],
    families: list[tuple[str, dict]],
) -> tuple[bool, list[str], list[str]]:
    evidence = []
    blockers = []
    if kind == "controller":
        if terminal["ready"]:
            if name not in terminal["names"]:
                blockers.append("容器名未出现在 terminal-receipt 已观察容器中")
            else:
                evidence.append("terminal-receipt-container-name")
        return not blockers, evidence, blockers
    if kind in {"compose", "network"}:
        if not _project_match(project, families):
            blockers.append("Compose project 标签不属于冻结试次身份")
        else:
            evidence.append("compose-project-label=" + project)
        if project not in terminal["projects"]:
            blockers.append("Compose project 未出现在 terminal-receipt 已观察项目中")
        else:
            evidence.append("terminal-receipt-project")
    if terminal["ready"] and kind in {"controller", "score", "compose"}:
        if name not in terminal["names"]:
            blockers.append("容器名未出现在 terminal-receipt 已观察容器中")
        else:
            evidence.append("terminal-receipt-container-name")
    if created_before_receipt is None:
        blockers.append("无法确认容器创建时间早于终局回执")
    elif created_before_receipt is not True:
        blockers.append("容器创建于终局回执之后，可能复用了旧名字")
    else:
        evidence.append("created-before-terminal-receipt")
    if not terminal["ready"]:
        blockers.append(terminal["error"] or "终局回执不可用")
    return not blockers, evidence, blockers


def _container_candidate(
    *,
    role: str,
    inspected: dict[str, Any],
    project: str,
    identity_basis: list[str],
    terminal: dict[str, Any],
    families: list[tuple[str, dict]],
) -> dict[str, Any]:
    container_id = inspected.get("Id")
    name = _name(inspected.get("Name"))
    state, active = _state(inspected)
    created_ok = _created_before(inspected, terminal["completed_at"])
    kind = "controller" if role == "controller" else "score" if role == "score" else "compose"
    owned, ownership_evidence, blockers = _ownership_check(
        kind=kind,
        name=name,
        project=project,
        created_before_receipt=created_ok,
        terminal=terminal,
        families=families,
    )
    ownership_evidence = [*identity_basis, *ownership_evidence]
    if not isinstance(container_id, str) or not container_id:
        owned = False
        blockers.append("inspect 缺少容器 ID")
    if active is None:
        blockers.append("容器活动状态未知")
    return {
        "kind": "container",
        "role": role,
        "id": container_id,
        "name": name,
        "project": project or None,
        "state": state,
        "active": active,
        "ownership": {
            "verified": owned,
            "evidence": ownership_evidence,
            "blockers": blockers,
        },
        "action": (
            "stop_then_reinspect"
            if owned and active is True and role == "controller"
            else "remove"
            if owned and active is False
            else "preserve"
        ),
    }


def _identity_conflict(
    *,
    role: str,
    inspected: dict[str, Any] | None,
    reason: str,
    row_id: str | None = None,
) -> dict[str, Any]:
    container_id = inspected.get("Id") if isinstance(inspected, dict) else row_id
    name = _name(inspected.get("Name")) if isinstance(inspected, dict) else ""
    state, active = _state(inspected or {})
    return {
        "kind": "container",
        "role": role + "_identity_conflict",
        "id": container_id,
        "name": name,
        "project": None,
        "state": state,
        "active": active,
        "ownership": {
            "verified": False,
            "evidence": [],
            "blockers": [reason],
        },
        "action": "preserve",
    }


def _discover_containers(
    run: Path,
    *,
    identity: dict[str, Any],
    terminal: dict[str, Any],
    families: list[tuple[str, dict]],
    score_name: str | None,
    runner: Callable[..., subprocess.CompletedProcess[str]],
    docker: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    errors = []
    try:
        rows = _parse_json_lines(
            _query(
                runner,
                docker,
                "ps",
                "-a",
                "--size=false",
                "--format",
                "{{json .}}",
            ),
            kind="container",
        )
    except (CleanCommandError, ValueError) as error:
        return [], [
            error.evidence() if isinstance(error, CleanCommandError) else str(error)
        ]

    score_ids = _score_ids(run)
    controller_id = identity["container_id"]
    controller_name = identity["controller"]
    candidates = []

    def inspect_candidate(row: dict[str, Any], *, role: str, project: str) -> None:
        row_id = row.get("ID")
        if not isinstance(row_id, str) or not row_id:
            errors.append("Docker ps 返回了缺少 ID 的候选容器")
            return
        try:
            inspected = _inspect_one(runner, docker, row_id, kind="container")
        except (CleanCommandError, ValueError) as error:
            errors.append(
                error.evidence() if isinstance(error, CleanCommandError) else str(error)
            )
            return
        if not _same_id(inspected.get("Id"), row_id):
            errors.append(f"列表 ID 与 inspect ID 不一致：{row_id}")
            return
        inspected_project = _inspect_labels(inspected).get(
            "com.docker.compose.project", ""
        )
        if role == "harbor" and inspected_project != project:
            errors.append(
                f"容器 {row_id} 的列表与 inspect Compose project 不一致"
            )
            return
        if role == "harbor":
            project = inspected_project
        candidate = _container_candidate(
            role=role,
            inspected=inspected,
            project=project,
            identity_basis=(
                ["approved-controller-id=" + controller_id]
                if role == "controller"
                else ["score-create-id=" + sorted(score_ids)[0]]
                if role == "score" and score_ids
                else []
            ),
            terminal=terminal,
            families=families,
        )
        candidates.append(candidate)

    for row in rows:
        row_id = row.get("ID")
        name = _name(row.get("Names"))
        labels = _labels(row.get("Labels"))
        project = labels.get("com.docker.compose.project", "")
        if _same_id(row_id, controller_id):
            inspect_candidate(row, role="controller", project=project)
        elif name == controller_name:
            try:
                inspected = (
                    _inspect_one(runner, docker, row_id, kind="container")
                    if isinstance(row_id, str) and row_id
                    else None
                )
            except (CleanCommandError, ValueError) as error:
                errors.append(
                    error.evidence()
                    if isinstance(error, CleanCommandError)
                    else str(error)
                )
                inspected = None
            candidates.append(
                _identity_conflict(
                    role="controller",
                    inspected=inspected,
                    reason=(
                        "控制器名字对应的 Docker ID 不是冻结批准 ID；"
                        "可能是外来容器复用了名字"
                    ),
                    row_id=row_id if isinstance(row_id, str) else None,
                )
            )
        elif score_name and name == score_name:
            if not isinstance(row_id, str) or not row_id or not any(
                _same_id(row_id, identifier) for identifier in score_ids
            ):
                try:
                    inspected = (
                        _inspect_one(runner, docker, row_id, kind="container")
                        if isinstance(row_id, str) and row_id
                        else None
                    )
                except (CleanCommandError, ValueError) as error:
                    errors.append(
                        error.evidence()
                        if isinstance(error, CleanCommandError)
                        else str(error)
                    )
                    inspected = None
                candidates.append(
                    _identity_conflict(
                        role="score",
                        inspected=inspected,
                        reason=(
                            "评分容器名字没有对应的本次 score_create 容器 ID；"
                            "拒绝按名字删除"
                        ),
                        row_id=row_id if isinstance(row_id, str) else None,
                    )
                )
            else:
                inspect_candidate(row, role="score", project="")
        elif _project_match(project, families):
            inspect_candidate(row, role="harbor", project=project)
    return candidates, errors


def _network_candidate(
    *,
    inspected: dict[str, Any],
    terminal: dict[str, Any],
    families: list[tuple[str, dict]],
) -> dict[str, Any]:
    labels = _inspect_labels(inspected)
    project = labels.get("com.docker.compose.project", "")
    created_ok = _created_before(inspected, terminal["completed_at"])
    owned, evidence, blockers = _ownership_check(
        kind="network",
        name="",
        project=project,
        created_before_receipt=created_ok,
        terminal=terminal,
        families=families,
    )
    endpoints = inspected.get("Containers")
    endpoints_known = isinstance(endpoints, dict)
    endpoint_count = len(endpoints) if endpoints_known else None
    endpoint_free = endpoint_count == 0
    if not endpoints_known:
        blockers.append("网络 endpoint 无法读取")
    elif not endpoint_free:
        blockers.append("网络仍有 endpoint，保留不删")
    return {
        "kind": "network",
        "id": inspected.get("Id"),
        "name": inspected.get("Name"),
        "project": project or None,
        "endpoint_count": endpoint_count,
        "endpoint_free": endpoint_free,
        "ownership": {
            "verified": owned,
            "evidence": evidence,
            "blockers": blockers,
        },
        "action": "remove" if owned and endpoint_free else "preserve",
    }


def _discover_networks(
    *,
    terminal: dict[str, Any],
    families: list[tuple[str, dict]],
    runner: Callable[..., subprocess.CompletedProcess[str]],
    docker: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    try:
        rows = _parse_json_lines(
            _query(runner, docker, "network", "ls", "--format", "{{json .}}"),
            kind="network",
        )
    except (CleanCommandError, ValueError) as error:
        return [], [
            error.evidence() if isinstance(error, CleanCommandError) else str(error)
        ]
    candidates = []
    errors = []
    for row in rows:
        row_id = row.get("ID")
        if not isinstance(row_id, str) or not row_id:
            errors.append("Docker network ls 返回了缺少 ID 的网络")
            continue
        try:
            inspected = _inspect_one(runner, docker, row_id, kind="network")
        except (CleanCommandError, ValueError) as error:
            errors.append(
                error.evidence() if isinstance(error, CleanCommandError) else str(error)
            )
            continue
        if not _same_id(inspected.get("Id"), row_id):
            errors.append(f"网络列表 ID 与 inspect ID 不一致：{row_id}")
            continue
        labels = _inspect_labels(inspected)
        project = labels.get("com.docker.compose.project", "")
        if not _project_match(project, families):
            continue
        candidates.append(
            _network_candidate(
                inspected=inspected,
                terminal=terminal,
                families=families,
            )
        )
    return candidates, errors


def _discover_external_network(
    run: Path,
    *,
    previous: dict[str, Any],
    runner: Callable[..., subprocess.CompletedProcess[str]],
    docker: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    """只按本运行 receipt 的完整 ID 精确认领自动 external 网络。"""
    try:
        context = _auto_network_context(run)
    except ValueError as error:
        return [], [str(error)]
    if context is None:
        return [], []
    try:
        receipt, network_id, receipt_sha256 = _external_network_receipt(
            run,
            context,
        )
    except (CleanCommandError, ValueError) as error:
        evidence = error.evidence() if isinstance(error, CleanCommandError) else str(error)
        return [], [evidence]
    try:
        inspected = _inspect_network_optional(runner, docker, network_id)
    except (CleanCommandError, ValueError) as error:
        evidence = error.evidence() if isinstance(error, CleanCommandError) else str(error)
        return [], [evidence]
    if inspected is None:
        if _previous_external_deleted(
            previous,
            receipt=receipt,
            receipt_sha256=receipt_sha256,
        ):
            return [], []
        return [], [
            "runtime-network.json 记录的完整网络 ID 当前不存在，"
            "且没有本清理回执证明已删除"
        ]
    try:
        observed = _validate_external_network_inspect(
            inspected,
            context=context,
            receipt=receipt,
            expected_id=network_id,
        )
    except ValueError as error:
        return [], [str(error)]
    endpoints = observed["endpoints"]
    endpoint_free = endpoints == {}
    return [
        {
            "kind": "network",
            "ownership_kind": EXTERNAL_NETWORK_SOURCE,
            "id": observed["network_id"],
            "name": observed["network_name"],
            "project": None,
            "subnet": observed["subnet"],
            "endpoint_count": len(endpoints),
            "endpoint_free": endpoint_free,
            "receipt_path": str(run / network_runtime.RECEIPT_PATH),
            "receipt_sha256": receipt_sha256,
            "run_identity_sha256": receipt["run_identity_sha256"],
            "plan_sha256": receipt["plan_sha256"],
            "run_freeze_sha256": receipt["run_freeze_sha256"],
            "ownership": {
                "verified": True,
                "evidence": [
                    "runtime-network-receipt",
                    "network-inspect-id=" + observed["network_id"],
                    "network-plan-frozen",
                    "run-freeze-frozen",
                    "run-identity-label",
                    "run-freeze-label",
                    "created-at-match",
                ],
                "blockers": [] if endpoint_free else ["网络仍有 endpoint，保留不删"],
            },
            "action": "remove" if endpoint_free else "preserve",
        }
    ], []


def _blockers(
    *,
    terminal: dict[str, Any],
    containers: list[dict[str, Any]],
    networks: list[dict[str, Any]],
    errors: list[Any],
) -> list[dict[str, Any]]:
    blockers = []
    if errors:
        blockers.append({"stage": "discovery", "errors": errors})
    if not terminal["ready"]:
        blockers.append({"stage": "evidence", "error": terminal["error"]})
    for item in containers:
        if item["ownership"]["verified"] is not True:
            blockers.append(
                {
                    "stage": "container_identity",
                    "id": item["id"],
                    "name": item["name"],
                    "error": item["ownership"]["blockers"],
                }
            )
        active = item["active"]
        if active is True and item["role"] != "controller":
            blockers.append(
                {
                    "stage": "active_writer",
                    "id": item["id"],
                    "name": item["name"],
                    "error": "活动写者不得删除",
                }
            )
        if active is None:
            blockers.append(
                {
                    "stage": "unknown_writer",
                    "id": item["id"],
                    "name": item["name"],
                    "error": "活动状态未知，不得删除",
                }
            )
    for item in networks:
        if item.get("ownership_kind") != EXTERNAL_NETWORK_SOURCE:
            continue
        if item["ownership"]["verified"] is not True:
            blockers.append(
                {
                    "stage": "external_network_identity",
                    "id": item["id"],
                    "name": item["name"],
                    "error": item["ownership"]["blockers"],
                }
            )
        if item.get("endpoint_free") is not True:
            blockers.append(
                {
                    "stage": "external_network_endpoint",
                    "id": item["id"],
                    "name": item["name"],
                    "error": "自动 external 网络仍有 endpoint，禁止清理",
                }
            )
    return blockers


def _summary(
    *,
    terminal: dict[str, Any],
    containers: list[dict[str, Any]],
    networks: list[dict[str, Any]],
    errors: list[Any],
    previous: dict[str, Any],
) -> dict[str, Any]:
    if errors:
        return {
            "containers": containers,
            "networks": networks,
            "errors": errors,
            "already_deleted_containers": [],
            "already_deleted_networks": [],
            "missing_terminal_containers": [],
        }
    present_ids = {
        item["id"].lower()
        for item in containers
        if isinstance(item["id"], str)
    }
    previous_containers = _previous_deleted(previous, "deleted_containers")
    already_deleted_containers = [
        row
        for identifier, row in previous_containers.items()
        if identifier.lower() not in present_ids
    ]
    present_names = {
        item["name"]
        for item in containers
        if isinstance(item["name"], str) and item["name"]
    }
    previously_deleted_names = {
        row.get("name")
        for row in previous_containers.values()
        if isinstance(row.get("name"), str) and row.get("name")
    }
    missing_terminal_containers = sorted(
        terminal["names"] - present_names - previously_deleted_names
    )
    present_network_ids = {
        item["id"].lower()
        for item in networks
        if isinstance(item["id"], str)
    }
    previous_networks = _previous_deleted(previous, "deleted_networks")
    already_deleted_networks = [
        row
        for identifier, row in previous_networks.items()
        if identifier.lower() not in present_network_ids
    ]
    return {
        "containers": containers,
        "networks": networks,
        "errors": errors,
        "already_deleted_containers": already_deleted_containers,
        "already_deleted_networks": already_deleted_networks,
        "missing_terminal_containers": missing_terminal_containers,
    }


def _refresh(
    run: Path,
    *,
    identity: dict[str, Any],
    terminal: dict[str, Any],
    families: list[tuple[str, dict]],
    score_name: str | None,
    runner: Callable[..., subprocess.CompletedProcess[str]],
    docker: str,
    previous: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    containers, container_errors = _discover_containers(
        run,
        identity=identity,
        terminal=terminal,
        families=families,
        score_name=score_name,
        runner=runner,
        docker=docker,
    )
    networks, network_errors = _discover_networks(
        terminal=terminal,
        families=families,
        runner=runner,
        docker=docker,
    )
    external_networks, external_errors = _discover_external_network(
        run,
        previous=previous,
        runner=runner,
        docker=docker,
    )
    networks.extend(external_networks)
    errors = [*container_errors, *network_errors, *external_errors]
    blockers = _blockers(
        terminal=terminal,
        containers=containers,
        networks=networks,
        errors=errors,
    )
    plan = _summary(
        terminal=terminal,
        containers=containers,
        networks=networks,
        errors=errors,
        previous=previous,
    )
    if plan["missing_terminal_containers"]:
        blockers.append(
            {
                "stage": "missing_container_resource",
                "names": plan["missing_terminal_containers"],
                "error": (
                    "终局回执记录的容器当前不存在，且没有本清理回执证明已删除；"
                    "不能当作清理完成"
                ),
            }
        )
    return plan, blockers


def _container_validation(
    inspected: dict[str, Any],
    *,
    item: dict[str, Any],
    identity: dict[str, Any],
    terminal: dict[str, Any],
    families: list[tuple[str, dict]],
    score_ids: set[str],
) -> tuple[bool, list[str]]:
    blockers = []
    if not _same_id(inspected.get("Id"), item["id"]):
        blockers.append("重新 inspect 的容器 ID 与预览不一致")
    name = _name(inspected.get("Name"))
    if name != item["name"]:
        blockers.append("重新 inspect 的容器名字与预览不一致")
    state, active = _state(inspected)
    if active is None:
        blockers.append("重新 inspect 的容器状态未知")
    elif active:
        blockers.append("重新 inspect 的容器仍活动")
    labels = _inspect_labels(inspected)
    project = labels.get("com.docker.compose.project", "")
    role = item["role"]
    if role == "controller":
        if not _same_id(inspected.get("Id"), identity["container_id"]):
            blockers.append("控制器 ID 与冻结批准 ID 不一致")
    elif role == "score":
        if not any(_same_id(inspected.get("Id"), value) for value in score_ids):
            blockers.append("评分容器 ID 与 score_create 回执不一致")
    else:
        if project != item["project"] or not _project_match(project, families):
            blockers.append("Compose project 标签发生变化")
    created_ok = _created_before(inspected, terminal["completed_at"])
    if created_ok is not True:
        blockers.append("创建时间不能证明该容器早于终局回执")
    if terminal["ready"] and item["name"] not in terminal["names"]:
        blockers.append("容器名已不在终局回执范围内")
    return not blockers, blockers


def _network_validation(
    inspected: dict[str, Any],
    *,
    run: Path,
    item: dict[str, Any],
    terminal: dict[str, Any],
    families: list[tuple[str, dict]],
) -> tuple[bool, list[str]]:
    if item.get("ownership_kind") == EXTERNAL_NETWORK_SOURCE:
        try:
            context = _auto_network_context(run)
            if context is None:
                return False, ["自动网络冻结身份已不再是 auto"]
            receipt, network_id, receipt_sha256 = _external_network_receipt(
                run,
                context,
            )
            if network_id.lower() != str(item.get("id", "")).lower():
                return False, ["runtime-network.json 的网络 ID 与预览不一致"]
            if receipt_sha256 != item.get("receipt_sha256"):
                return False, ["runtime-network.json 在预览后发生变化"]
            _validate_external_network_inspect(
                inspected,
                context=context,
                receipt=receipt,
                expected_id=network_id,
            )
        except (CleanCommandError, ValueError) as error:
            return False, [str(error)]
        return True, []
    blockers = []
    if not _same_id(inspected.get("Id"), item["id"]):
        blockers.append("重新 inspect 的网络 ID 与预览不一致")
    labels = _inspect_labels(inspected)
    project = labels.get("com.docker.compose.project", "")
    if project != item["project"] or not _project_match(project, families):
        blockers.append("网络 Compose project 标签发生变化")
    if project not in terminal["projects"]:
        blockers.append("网络 project 不在 terminal-receipt 范围内")
    if _created_before(inspected, terminal["completed_at"]) is not True:
        blockers.append("网络创建时间不能证明它属于已完成本轮")
    endpoints = inspected.get("Containers")
    if not isinstance(endpoints, dict):
        blockers.append("网络 endpoint 无法读取")
    elif endpoints:
        blockers.append("网络重新检查后仍有 endpoint")
    return not blockers, blockers


def _merge_deleted(
    previous: list[dict[str, Any]],
    current: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    merged = {}
    for row in [*previous, *current]:
        if not isinstance(row, dict):
            continue
        identifier = row.get("id")
        if isinstance(identifier, str) and identifier:
            merged[identifier] = row
    return list(merged.values())


def _write_receipt(
    run: Path,
    *,
    previous: dict[str, Any],
    identity: dict[str, Any],
    mode: str,
    result: dict[str, Any],
    deleted_containers: list[dict[str, Any]],
    deleted_networks: list[dict[str, Any]],
    action_errors: list[Any],
) -> str:
    path = run / "clean-receipt.json"
    attempts = previous.get("attempts")
    history = list(attempts) if isinstance(attempts, list) else []
    history.append(
        {
            "at": runner_common.now(),
            "mode": mode,
            "controller": identity["controller"],
            "deleted_containers": deleted_containers,
            "deleted_networks": deleted_networks,
            "errors": action_errors,
            "completed": result.get("completed"),
            "safe_to_execute": result.get("safe_to_execute"),
            "blockers": result.get("blockers", []),
            "actions": result.get("actions", []),
        }
    )
    runner_common.write_json(
        path,
        {
            "at": runner_common.now(),
            "run": identity["run"],
            "controller": identity["controller"],
            "attempts": history,
            "deleted_containers": _merge_deleted(
                previous.get("deleted_containers", []),
                deleted_containers,
            ),
            "deleted_networks": _merge_deleted(
                previous.get("deleted_networks", []),
                deleted_networks,
            ),
        },
    )
    return str(path)


def clean(
    run: Path,
    *,
    execute: bool = False,
    confirm_run: str | None = None,
    docker: str = DOCKER_EXE,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> dict:
    run = run.resolve()
    if execute and confirm_run != run.name:
        raise ValueError("执行清理必须用 --confirm-run 精确确认运行目录名")
    identity = verify_run_identity(run)
    terminal = _terminal_evidence(run, identity["runtime_container_names"])
    previous = _previous_receipt(run)
    try:
        families, score_name = _project_families(run, identity["controller"])
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, RuntimeError) as error:
        families = []
        score_name = None
        family_error = f"无法推导冻结试次身份：{type(error).__name__}: {error}"
    else:
        family_error = None

    execute_command = runner or subprocess.run
    plan, blockers = _refresh(
        run,
        identity=identity,
        terminal=terminal,
        families=families,
        score_name=score_name,
        runner=execute_command,
        docker=docker,
        previous=previous,
    )
    if family_error is not None:
        plan["errors"].append(family_error)
        blockers.append({"stage": "identity", "error": family_error})
    result = {
        "ok": False,
        "mode": "execute" if execute else "preview",
        "safe_to_execute": not blockers,
        "completed": False,
        **identity,
        "terminal_receipt": {
            "ready": terminal["ready"],
            "at": (
                terminal["completed_at"].isoformat()
                if terminal["completed_at"] is not None
                else None
            ),
            "error": terminal["error"],
        },
        **plan,
        "blockers": blockers,
        "actions": [],
    }
    if not execute:
        result["ok"] = not plan["errors"] and not blockers
        return result

    action_errors: list[Any] = []
    deleted_containers: list[dict[str, Any]] = []
    deleted_networks: list[dict[str, Any]] = []

    active_controller = next(
        (
            item
            for item in plan["containers"]
            if item["role"] == "controller"
            and item["ownership"]["verified"] is True
            and item["active"] is True
        ),
        None,
    )
    if active_controller is not None:
        try:
            _mutate(
                execute_command,
                docker,
                "stop",
                "--time",
                "10",
                active_controller["id"],
            )
            result["actions"].append(
                {
                    "action": "stop_controller",
                    "id": active_controller["id"],
                    "ok": True,
                }
            )
        except CleanCommandError as error:
            action_errors.append(error.evidence())
            result["actions"].append(
                {
                    "action": "stop_controller",
                    "id": active_controller["id"],
                    "ok": False,
                    "error": error.evidence(),
                }
            )

    refreshed, blockers = _refresh(
        run,
        identity=identity,
        terminal=terminal,
        families=families,
        score_name=score_name,
        runner=execute_command,
        docker=docker,
        previous=previous,
    )
    if action_errors:
        blockers.append({"stage": "stop_controller", "errors": action_errors})
    active_controllers = [
        item
        for item in refreshed["containers"]
        if item["role"] == "controller" and item["active"] is True
    ]
    if active_controllers:
        blockers.append(
            {
                "stage": "controller_still_active",
                "containers": [
                    {"id": item["id"], "name": item["name"]}
                    for item in active_controllers
                ],
                "error": "控制器仍未停止，禁止删除任何候选资源",
            }
        )
    result.update(refreshed)
    result["blockers"] = blockers
    result["safe_to_execute"] = not blockers

    if blockers:
        pass
    else:
        score_ids = _score_ids(run)
        for item in list(result["containers"]):
            if item["action"] != "remove":
                continue
            try:
                inspected = _inspect_one(
                    execute_command,
                    docker,
                    item["id"],
                    kind="container",
                )
                valid, reasons = _container_validation(
                    inspected,
                    item=item,
                    identity=identity,
                    terminal=terminal,
                    families=families,
                    score_ids=score_ids,
                )
                if not valid:
                    action_errors.append(
                        {
                            "action": "remove_container",
                            "id": item["id"],
                            "error": reasons,
                        }
                    )
                    result["actions"].append(
                        {
                            "action": "remove_container",
                            "id": item["id"],
                            "ok": False,
                            "error": reasons,
                        }
                    )
                    break
                _mutate(execute_command, docker, "rm", item["id"])
                deleted = {
                    "id": item["id"],
                    "name": item["name"],
                    "role": item["role"],
                    "project": item["project"],
                }
                deleted_containers.append(deleted)
                result["actions"].append(
                    {
                        "action": "remove_container",
                        "id": item["id"],
                        "name": item["name"],
                        "ok": True,
                    }
                )
            except (CleanCommandError, ValueError) as error:
                evidence = (
                    error.evidence()
                    if isinstance(error, CleanCommandError)
                    else {
                        "action": "remove_container",
                        "id": item["id"],
                        "error": str(error),
                    }
                )
                action_errors.append(evidence)
                result["actions"].append(
                    {
                        "action": "remove_container",
                        "id": item["id"],
                        "ok": False,
                        "error": evidence,
                    }
                )
                break

        if not action_errors:
            for item in result["networks"]:
                if item["action"] != "remove":
                    continue
                try:
                    inspected = _inspect_one(
                        execute_command,
                        docker,
                        item["id"],
                        kind="network",
                    )
                    valid, reasons = _network_validation(
                        inspected,
                        run=run,
                        item=item,
                        terminal=terminal,
                        families=families,
                    )
                    if not valid:
                        if item.get("ownership_kind") == EXTERNAL_NETWORK_SOURCE:
                            evidence = {
                                "action": "remove_network",
                                "id": item["id"],
                                "name": item["name"],
                                "error": reasons,
                            }
                            action_errors.append(evidence)
                            result["actions"].append(
                                {
                                    **evidence,
                                    "ok": False,
                                    "retained": True,
                                }
                            )
                            break
                        result["actions"].append(
                            {
                                "action": "remove_network",
                                "id": item["id"],
                                "name": item["name"],
                                "ok": True,
                                "retained": True,
                                "reason": reasons,
                            }
                        )
                        continue
                    _mutate(execute_command, docker, "network", "rm", item["id"])
                    deleted = {
                        "id": item["id"],
                        "name": item["name"],
                        "project": item["project"],
                    }
                    if item.get("ownership_kind") == EXTERNAL_NETWORK_SOURCE:
                        deleted.update(
                            {
                                "source": EXTERNAL_NETWORK_SOURCE,
                                "network_name": item["name"],
                                "subnet": item["subnet"],
                                "receipt_sha256": item["receipt_sha256"],
                                "run_identity_sha256": item["run_identity_sha256"],
                                "plan_sha256": item["plan_sha256"],
                                "run_freeze_sha256": item["run_freeze_sha256"],
                            }
                        )
                    deleted_networks.append(deleted)
                    result["actions"].append(
                        {
                            "action": "remove_network",
                            "id": item["id"],
                            "name": item["name"],
                            "ok": True,
                        }
                    )
                except (CleanCommandError, ValueError) as error:
                    evidence = (
                        error.evidence()
                        if isinstance(error, CleanCommandError)
                        else {
                            "action": "remove_network",
                            "id": item["id"],
                            "error": str(error),
                        }
                    )
                    action_errors.append(evidence)
                    result["actions"].append(
                        {
                            "action": "remove_network",
                            "id": item["id"],
                            "ok": False,
                            "error": evidence,
                        }
                    )
                    break

    result["errors"] = [*result["errors"], *action_errors]
    result["deleted_containers"] = deleted_containers
    result["deleted_networks"] = deleted_networks
    result["completed"] = (
        not action_errors
        and not result["blockers"]
        and all(item["active"] is False for item in result["containers"])
        and all(
            item["action"] != "remove" or any(
                _same_id(item["id"], deleted["id"]) for deleted in deleted_containers
            )
            for item in result["containers"]
        )
        and all(
            item.get("endpoint_free") is True
            for item in result["networks"]
        )
        and all(
            item["ownership"]["verified"] is True
            for item in result["networks"]
        )
        and all(
            item["action"] != "remove" or any(
                _same_id(item["id"], deleted["id"])
                for deleted in deleted_networks
            )
            for item in result["networks"]
        )
    )
    result["ok"] = not result["errors"] and not result["blockers"]
    try:
        result["receipt"] = _write_receipt(
            run,
            previous=previous,
            identity=identity,
            mode="execute",
            result=result,
            deleted_containers=deleted_containers,
            deleted_networks=deleted_networks,
            action_errors=result["errors"],
        )
    except (OSError, UnicodeError, ValueError) as error:
        result["ok"] = False
        result["errors"].append(
            {"action": "write_clean_receipt", "error": f"{type(error).__name__}: {error}"}
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm-run")
    parser.add_argument("--docker", default=DOCKER_EXE)
    args = parser.parse_args()
    print(
        json.dumps(
            clean(
                args.run,
                execute=args.execute,
                confirm_run=args.confirm_run,
                docker=args.docker,
            ),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
