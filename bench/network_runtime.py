"""创建并证明自动基准运行共享外部网络的归属；不负责清理。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Callable

if __package__:
    from . import network
    from . import runner_common
else:
    import network
    import runner_common


PLAN_PATH = "network-plan.json"
FREEZE_PATH = "run-freeze.json"
RECEIPT_PATH = "runtime-network.json"
OVERRIDE_PATH = "network-override.yaml"
IDENTITY_LABEL = "pao.bench.run-identity-sha256"
FREEZE_LABEL = "pao.bench.run-freeze-sha256"
FULL_DOCKER_ID = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
IDENTITY_KEYS = frozenset(
    {"run", "job_name", "controller_name", "source_manifest_sha256"}
)

DockerRunner = Callable[..., subprocess.CompletedProcess[str]]


class NetworkRuntimeError(RuntimeError):
    """外部网络启动失败；evidence 保留 Docker 命令和已创建资源信息。"""

    def __init__(
        self,
        message: str,
        *,
        stage: str,
        evidence: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.evidence = evidence or {}


def _identity_sha256(identity: dict[str, Any]) -> str:
    # 与稳定网络名共用同一规范化编码，避免身份摘要出现第二套规则。
    return hashlib.sha256(network._canonical_json(identity)).hexdigest()


def _read_json(path: Path, *, stage: str) -> dict[str, Any]:
    try:
        return runner_common.read_json(path)
    except Exception as error:
        raise NetworkRuntimeError(
            f"外部网络校验无法读取 {path}：{type(error).__name__}: {error}",
            stage=stage,
            evidence={"path": str(path), "error": repr(error)},
        ) from error


def _freeze_hashes(freeze: dict[str, Any]) -> dict[str, str]:
    files = freeze.get("files")
    if not isinstance(files, list):
        raise NetworkRuntimeError(
            "run-freeze.json 缺少 files 数组",
            stage="validate_freeze",
            evidence={"run_freeze": freeze},
        )
    hashes: dict[str, str] = {}
    for item in files:
        if not isinstance(item, dict):
            raise NetworkRuntimeError(
                "run-freeze.json 的 files 含非对象项",
                stage="validate_freeze",
            )
        relative = item.get("path")
        sha256 = item.get("sha256")
        if not isinstance(relative, str) or not isinstance(sha256, str):
            raise NetworkRuntimeError(
                "run-freeze.json 的文件记录缺少 path 或 sha256",
                stage="validate_freeze",
                evidence={"record": item},
            )
        if relative in hashes:
            raise NetworkRuntimeError(
                "run-freeze.json 重复记录文件：" + relative,
                stage="validate_freeze",
            )
        hashes[relative] = sha256
    return hashes


def _require_frozen_file(
    run: Path,
    relative: str,
    freeze_hashes: dict[str, str],
) -> str:
    expected = freeze_hashes.get(relative)
    if not isinstance(expected, str):
        raise NetworkRuntimeError(
            f"run-freeze.json 未冻结 {relative}",
            stage="validate_freeze",
        )
    try:
        actual = runner_common.digest(run / relative)
    except Exception as error:
        raise NetworkRuntimeError(
            f"冻结文件无法读取：{relative}：{type(error).__name__}: {error}",
            stage="validate_freeze",
            evidence={"path": str(run / relative), "error": repr(error)},
        ) from error
    if actual != expected:
        raise NetworkRuntimeError(
            f"冻结文件摘要不符：{relative}",
            stage="validate_freeze",
            evidence={"expected": expected, "actual": actual},
        )
    return actual


def _absolute_plan_path(value: Any, label: str) -> Path:
    if not isinstance(value, str):
        raise NetworkRuntimeError(
            f"{label} 路径必须是字符串",
            stage="validate_plan",
        )
    path = Path(value)
    if not path.is_absolute():
        raise NetworkRuntimeError(
            f"{label} 路径必须是绝对路径：{value}",
            stage="validate_plan",
        )
    return path.resolve()


def _validated_context(run: Path) -> dict[str, Any]:
    run = run.resolve()
    run_sources_path = run / "run-sources.json"
    run_sources = _read_json(run_sources_path, stage="load_run_sources")
    network_record = run_sources.get("network")
    if not isinstance(network_record, dict):
        return {"auto": False, "mode": None}
    if network_record.get("mode") != "auto":
        return {"auto": False, "mode": network_record.get("mode")}

    plan_path = run / PLAN_PATH
    freeze_path = run / FREEZE_PATH
    override_path = run / OVERRIDE_PATH
    plan = _read_json(plan_path, stage="load_network_plan")
    freeze = _read_json(freeze_path, stage="load_run_freeze")
    config = _read_json(run / "run-config.json", stage="load_run_config")
    approval = _read_json(run / "approved-launch.json", stage="load_approval")

    if plan.get("mode") != "auto":
        raise NetworkRuntimeError(
            "run-sources.json 声明 auto，但 network-plan.json 不是 auto",
            stage="validate_plan",
        )
    if plan.get("network_scope") != "shared_external":
        raise NetworkRuntimeError(
            "自动网络计划的 network_scope 必须是 shared_external",
            stage="validate_plan",
        )
    if plan.get("observation_used") is not True:
        raise NetworkRuntimeError(
            "自动网络计划必须声明使用只读网络观察",
            stage="validate_plan",
        )

    freeze_hashes = _freeze_hashes(freeze)
    plan_sha256 = _require_frozen_file(run, PLAN_PATH, freeze_hashes)
    override_sha256 = _require_frozen_file(
        run, OVERRIDE_PATH, freeze_hashes
    )
    _require_frozen_file(run, "run-sources.json", freeze_hashes)

    identity = plan.get("run_identity")
    if not isinstance(identity, dict) or set(identity) != IDENTITY_KEYS:
        raise NetworkRuntimeError(
            "网络计划的 run_identity 字段不完整或含未知字段",
            stage="validate_identity",
            evidence={"run_identity": identity},
        )
    if not all(isinstance(identity[key], str) and identity[key] for key in IDENTITY_KEYS):
        raise NetworkRuntimeError(
            "网络计划的 run_identity 字段必须是非空字符串",
            stage="validate_identity",
            evidence={"run_identity": identity},
        )
    expected_identity_values = {
        "run": str(run),
        "job_name": config.get("job_name"),
        "controller_name": approval.get("controller"),
        "source_manifest_sha256": run_sources.get("source_manifest_sha256"),
    }
    for key, expected in expected_identity_values.items():
        if identity[key] != expected:
            raise NetworkRuntimeError(
                f"网络运行身份与当前运行不一致：{key}",
                stage="validate_identity",
                evidence={"expected": expected, "actual": identity[key]},
            )

    expected_network_name = network.stable_network_name(identity)
    if plan.get("network_name") != expected_network_name:
        raise NetworkRuntimeError(
            "网络名与完整 run_identity 的稳定摘要不一致",
            stage="validate_identity",
            evidence={
                "expected": expected_network_name,
                "actual": plan.get("network_name"),
            },
        )

    observation = plan.get("observation")
    try:
        rebuilt = network.build_external_network_plan(identity, observation)
    except Exception as error:
        raise NetworkRuntimeError(
            f"冻结网络观察无效：{type(error).__name__}: {error}",
            stage="validate_plan",
        ) from error
    for key in ("network_name", "subnet"):
        if plan.get(key) != rebuilt.get(key):
            raise NetworkRuntimeError(
                f"自动网络计划与冻结观察不一致：{key}",
                stage="validate_plan",
                evidence={"expected": rebuilt.get(key), "actual": plan.get(key)},
            )

    override = plan.get("override")
    if not isinstance(override, dict):
        raise NetworkRuntimeError(
            "自动网络计划缺少 override",
            stage="validate_plan",
        )
    if _absolute_plan_path(override.get("path"), "override") != override_path:
        raise NetworkRuntimeError(
            "自动网络计划的 override 路径与当前运行不一致",
            stage="validate_plan",
        )
    if override.get("sha256") != override_sha256:
        raise NetworkRuntimeError(
            "自动网络计划的 override 摘要与实际文件不一致",
            stage="validate_plan",
        )
    expected_override = network.render_external_network_override(
        expected_network_name
    )
    try:
        actual_override = override_path.read_text(encoding="utf-8")
    except Exception as error:
        raise NetworkRuntimeError(
            f"外部网络覆写无法读取：{type(error).__name__}: {error}",
            stage="load_override",
            evidence={"path": str(override_path)},
        ) from error
    if actual_override != expected_override:
        raise NetworkRuntimeError(
            "外部网络覆写内容与稳定网络名不一致",
            stage="validate_plan",
        )

    if _absolute_plan_path(network_record.get("plan"), "plan") != plan_path:
        raise NetworkRuntimeError(
            "run-sources.json 的网络计划路径与当前运行不一致",
            stage="validate_plan",
        )
    if network_record.get("plan_sha256") != plan_sha256:
        raise NetworkRuntimeError(
            "run-sources.json 的网络计划摘要不一致",
            stage="validate_plan",
        )
    if _absolute_plan_path(
        network_record.get("override"), "override"
    ) != override_path:
        raise NetworkRuntimeError(
            "run-sources.json 的网络覆写路径与当前运行不一致",
            stage="validate_plan",
        )
    if network_record.get("override_sha256") != override_sha256:
        raise NetworkRuntimeError(
            "run-sources.json 的网络覆写摘要不一致",
            stage="validate_plan",
        )
    for key in ("mode", "network_scope", "network_name", "subnet"):
        if network_record.get(key) != plan.get(key):
            raise NetworkRuntimeError(
                f"run-sources.json 与 network-plan.json 不一致：{key}",
                stage="validate_plan",
            )

    identity_sha256 = _identity_sha256(identity)
    run_freeze_sha256 = runner_common.digest(freeze_path)
    labels = {
        IDENTITY_LABEL: identity_sha256,
        FREEZE_LABEL: run_freeze_sha256,
    }
    return {
        "auto": True,
        "run": run,
        "plan": plan,
        "identity": identity,
        "identity_sha256": identity_sha256,
        "plan_path": plan_path,
        "plan_sha256": plan_sha256,
        "freeze_path": freeze_path,
        "run_freeze_sha256": run_freeze_sha256,
        "override_path": override_path,
        "override_sha256": override_sha256,
        "labels": labels,
    }


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _result_evidence(result: Any) -> dict[str, Any]:
    return {
        "returncode": getattr(result, "returncode", None),
        "stdout": _text(getattr(result, "stdout", "")),
        "stderr": _text(getattr(result, "stderr", "")),
    }


def _invoke(
    runner: DockerRunner,
    docker: str,
    args: tuple[str, ...],
    *,
    stage: str,
) -> subprocess.CompletedProcess[str]:
    command = [docker, *args]
    try:
        return runner(docker, *args, timeout=30)
    except Exception as error:
        raise NetworkRuntimeError(
            f"Docker 网络命令失败：{type(error).__name__}: {error}",
            stage=stage,
            evidence={
                "command": command,
                "error": repr(error),
                "error_type": type(error).__name__,
            },
        ) from error


def _not_found(result: Any, identifier: str) -> bool:
    text = (_text(getattr(result, "stderr", "")) + "\n" + _text(
        getattr(result, "stdout", "")
    )).lower()
    identifier = identifier.lower()
    messages = {
        f"no such network: {identifier}",
        f"error: no such network: {identifier}",
        f"error response from daemon: network {identifier} not found",
    }
    return any(line.strip() in messages for line in text.splitlines())


def _inspect_network(
    docker: str,
    identifier: str,
    *,
    runner: DockerRunner,
    allow_missing: bool = False,
    stage: str,
) -> dict[str, Any] | None:
    args = ("network", "inspect", identifier)
    result = _invoke(runner, docker, args, stage=stage)
    if result.returncode != 0:
        if allow_missing and _not_found(result, identifier):
            return None
        raise NetworkRuntimeError(
            f"Docker 网络检查失败：{_text(result.stderr or result.stdout)}",
            stage=stage,
            evidence={"command": [docker, *args], **_result_evidence(result)},
        )
    try:
        value = json.loads(_text(result.stdout))
    except json.JSONDecodeError as error:
        raise NetworkRuntimeError(
            f"Docker 网络检查返回的 JSON 无效：{error}",
            stage=stage,
            evidence={"command": [docker, *args], **_result_evidence(result)},
        ) from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise NetworkRuntimeError(
            "Docker 网络检查必须返回恰好一个对象",
            stage=stage,
            evidence={"command": [docker, *args], **_result_evidence(result)},
        )
    return value[0]


def _validate_inspected_network(
    inspected: dict[str, Any],
    *,
    context: dict[str, Any],
    expected_id: str | None,
    stage: str,
) -> dict[str, Any]:
    network_id = inspected.get("Id")
    if not isinstance(network_id, str) or not FULL_DOCKER_ID.fullmatch(network_id):
        raise NetworkRuntimeError(
            "Docker 网络检查未返回完整网络 ID",
            stage=stage,
            evidence={"network_id": network_id},
        )
    if expected_id is not None and network_id.lower() != expected_id.lower():
        raise NetworkRuntimeError(
            "Docker 网络 ID 与预期不一致",
            stage=stage,
            evidence={"expected": expected_id, "actual": network_id},
        )
    expected_name = context["plan"]["network_name"]
    if inspected.get("Name") != expected_name:
        raise NetworkRuntimeError(
            "Docker 网络名称与冻结计划不一致",
            stage=stage,
            evidence={"expected": expected_name, "actual": inspected.get("Name")},
        )
    ipam = inspected.get("IPAM")
    configs = ipam.get("Config") if isinstance(ipam, dict) else None
    if not isinstance(configs, list) or len(configs) != 1 or not isinstance(
        configs[0], dict
    ):
        raise NetworkRuntimeError(
            "Docker 网络 IPAM 必须恰好包含一个配置",
            stage=stage,
            evidence={"ipam": ipam},
        )
    subnet = configs[0].get("Subnet")
    if subnet != context["plan"]["subnet"]:
        raise NetworkRuntimeError(
            "Docker 网络子网与冻结计划不一致",
            stage=stage,
            evidence={"expected": context["plan"]["subnet"], "actual": subnet},
        )
    labels = inspected.get("Labels")
    if labels != context["labels"]:
        raise NetworkRuntimeError(
            "Docker 网络标签与本次运行身份或冻结摘要不一致",
            stage=stage,
            evidence={"expected": context["labels"], "actual": labels},
        )
    endpoints = inspected.get("Containers")
    if not isinstance(endpoints, dict):
        raise NetworkRuntimeError(
            "Docker 网络 endpoint 无法读取",
            stage=stage,
        )
    if endpoints:
        raise NetworkRuntimeError(
            "Docker 网络已有 endpoint，拒绝复用",
            stage=stage,
            evidence={"endpoints": sorted(endpoints)},
        )
    created_at = inspected.get("Created")
    if not isinstance(created_at, str) or not created_at:
        raise NetworkRuntimeError(
            "Docker 网络检查未返回创建时间",
            stage=stage,
        )
    return {
        "network_id": network_id,
        "network_name": inspected["Name"],
        "subnet": subnet,
        "created_at": created_at,
        "labels": labels,
        "endpoints": endpoints,
    }


def _receipt_matches(
    receipt: dict[str, Any],
    *,
    context: dict[str, Any],
) -> str:
    expected = {
        "run": str(context["run"]),
        "mode": context["plan"]["mode"],
        "network_scope": context["plan"]["network_scope"],
        "plan_path": str(context["plan_path"]),
        "plan_sha256": context["plan_sha256"],
        "run_freeze_path": str(context["freeze_path"]),
        "run_freeze_sha256": context["run_freeze_sha256"],
        "run_identity": context["identity"],
        "run_identity_sha256": context["identity_sha256"],
        "network_name": context["plan"]["network_name"],
        "subnet": context["plan"]["subnet"],
        "labels": context["labels"],
    }
    for key, value in expected.items():
        if receipt.get(key) != value:
            raise NetworkRuntimeError(
                f"runtime-network.json 与冻结运行不一致：{key}",
                stage="validate_receipt",
                evidence={"expected": value, "actual": receipt.get(key)},
            )
    network_id = receipt.get("network_id")
    if not isinstance(network_id, str) or not FULL_DOCKER_ID.fullmatch(network_id):
        raise NetworkRuntimeError(
            "runtime-network.json 缺少完整网络 ID",
            stage="validate_receipt",
            evidence={"network_id": network_id},
        )
    return network_id


def _reuse_existing(
    context: dict[str, Any],
    receipt: dict[str, Any],
    *,
    docker: str,
    runner: DockerRunner,
) -> dict[str, Any]:
    expected_id = _receipt_matches(receipt, context=context)
    inspected = _inspect_network(
        docker,
        expected_id,
        runner=runner,
        stage="reuse_inspect",
    )
    assert inspected is not None
    observed = _validate_inspected_network(
        inspected,
        context=context,
        expected_id=expected_id,
        stage="reuse_validate",
    )
    if receipt.get("created_at") != observed["created_at"]:
        raise NetworkRuntimeError(
            "runtime-network.json 的网络创建时间与 Docker 实况不一致",
            stage="reuse_validate",
            evidence={
                "expected": observed["created_at"],
                "actual": receipt.get("created_at"),
            },
        )
    return {
        "created": False,
        "reused": True,
        **observed,
        "plan_sha256": context["plan_sha256"],
        "run_freeze_sha256": context["run_freeze_sha256"],
        "run_identity_sha256": context["identity_sha256"],
    }


def _fresh_observation(
    context: dict[str, Any],
    *,
    docker: str,
) -> None:
    observation = None
    try:
        observation = network.observe_live_networks(docker)
        planned_observation = dict(observation)
        planned_observation["candidate_subnet"] = context["plan"]["subnet"]
        network.build_external_network_plan(
            context["identity"],
            planned_observation,
        )
    except Exception as error:
        raise NetworkRuntimeError(
            f"启动前网络复查失败：{type(error).__name__}: {error}",
            stage="fresh_observation",
            evidence={
                "planned_subnet": context["plan"]["subnet"],
                "error": repr(error),
                "observation": observation,
            },
        ) from error


def _create_network(
    context: dict[str, Any],
    *,
    docker: str,
    runner: DockerRunner,
) -> dict[str, Any]:
    args = [
        "network",
        "create",
        "--label",
        f"{IDENTITY_LABEL}={context['identity_sha256']}",
        "--label",
        f"{FREEZE_LABEL}={context['run_freeze_sha256']}",
        "--subnet",
        context["plan"]["subnet"],
        context["plan"]["network_name"],
    ]
    command = [docker, *args]
    result = _invoke(runner, docker, tuple(args), stage="create")
    create_evidence = {
        "command": command,
        **_result_evidence(result),
    }
    if result.returncode != 0:
        returned_id = _text(result.stdout).strip()
        raise NetworkRuntimeError(
            "Docker 外部网络创建失败："
            + (_text(result.stderr or result.stdout) or "未返回错误文本"),
            stage="create",
            evidence={
                **create_evidence,
                "network_id": returned_id or None,
                "network_name": context["plan"]["network_name"],
                "subnet": context["plan"]["subnet"],
                "labels": context["labels"],
            },
        )
    output_lines = _text(result.stdout).splitlines()
    if len(output_lines) != 1:
        raise NetworkRuntimeError(
            "Docker 外部网络创建未返回唯一网络 ID",
            stage="create",
            evidence=create_evidence,
        )
    network_id = output_lines[0].strip()
    if not FULL_DOCKER_ID.fullmatch(network_id):
        raise NetworkRuntimeError(
            "Docker 外部网络创建未返回完整网络 ID",
            stage="create",
            evidence={**create_evidence, "network_id": network_id},
        )
    try:
        inspected = _inspect_network(
            docker,
            network_id,
            runner=runner,
            stage="post_create_inspect",
        )
        assert inspected is not None
        observed = _validate_inspected_network(
            inspected,
            context=context,
            expected_id=network_id,
            stage="post_create_validate",
        )
    except Exception as error:
        if isinstance(error, NetworkRuntimeError):
            error.evidence = {
                "network_id": network_id,
                "network_name": context["plan"]["network_name"],
                "subnet": context["plan"]["subnet"],
                "labels": context["labels"],
                "create": create_evidence,
                **error.evidence,
            }
        raise

    receipt = {
        "at": runner_common.now(),
        "run": str(context["run"]),
        "mode": context["plan"]["mode"],
        "network_scope": context["plan"]["network_scope"],
        "plan_path": str(context["plan_path"]),
        "plan_sha256": context["plan_sha256"],
        "run_freeze_path": str(context["freeze_path"]),
        "run_freeze_sha256": context["run_freeze_sha256"],
        "run_identity": context["identity"],
        "run_identity_sha256": context["identity_sha256"],
        **observed,
    }
    receipt_path = context["run"] / RECEIPT_PATH
    try:
        runner_common.write_json(receipt_path, receipt)
    except Exception as error:
        raise NetworkRuntimeError(
            "外部网络已创建，但 runtime-network.json 写入失败："
            f"{type(error).__name__}: {error}",
            stage="write_receipt",
            evidence={
                "receipt_path": str(receipt_path),
                "network_id": network_id,
                "network_name": context["plan"]["network_name"],
                "subnet": context["plan"]["subnet"],
                "labels": context["labels"],
                "create": create_evidence,
                "write_error": repr(error),
            },
        ) from error
    return {
        "created": True,
        "reused": False,
        **receipt,
    }


def ensure_external_network(
    run: Path,
    docker: str,
    runner: DockerRunner,
) -> dict[str, Any]:
    """确保 auto 计划对应网络存在；非 auto 计划保持旧启动行为。"""
    run = run.resolve()
    context = _validated_context(run)
    if context["auto"] is not True:
        return {
            "created": False,
            "reused": False,
            "mode": context["mode"],
        }

    receipt_path = run / RECEIPT_PATH
    if receipt_path.exists():
        receipt = _read_json(receipt_path, stage="load_receipt")
        return _reuse_existing(
            context,
            receipt,
            docker=docker,
            runner=runner,
        )

    existing = _inspect_network(
        docker,
        context["plan"]["network_name"],
        runner=runner,
        allow_missing=True,
        stage="preflight_name_inspect",
    )
    if existing is not None:
        raise NetworkRuntimeError(
            "同名 Docker 网络已存在，但本运行没有 runtime-network.json 收据；"
            "拒绝接管",
            stage="preflight_name",
            evidence={
                "network_id": existing.get("Id"),
                "network_name": existing.get("Name"),
            },
        )

    _fresh_observation(context, docker=docker)
    # 实时观察后再核对一次名称，避免复查期间出现同名资源后尝试接管。
    existing = _inspect_network(
        docker,
        context["plan"]["network_name"],
        runner=runner,
        allow_missing=True,
        stage="post_observation_name_inspect",
    )
    if existing is not None:
        raise NetworkRuntimeError(
            "启动前复查发现同名 Docker 网络，但本运行没有归属收据；拒绝接管",
            stage="post_observation_name",
            evidence={
                "network_id": existing.get("Id"),
                "network_name": existing.get("Name"),
            },
        )
    return _create_network(context, docker=docker, runner=runner)
