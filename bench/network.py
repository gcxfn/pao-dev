"""只读检查 Docker/路由网络并选择基准运行可用的 /24；不创建或修改网络。"""

from __future__ import annotations

import copy
import hashlib
from ipaddress import IPv4Network, ip_network
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any


DOCKER_EXE = "D:/Docker/resources/bin/docker.exe"
BENCHMARK_POOL = IPv4Network("10.243.0.0/16")
CIDR_PATTERN = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3}/\d{1,2})(?![\d.])")
NETWORK_NAME_PATTERN = re.compile(r"^pao-bench-[0-9a-f]{16}$")
DOCKER_IPAM_ADDRESS_KEYS = frozenset({"Subnet", "IPRange", "Gateway"})


def _unique_networks(networks: list[IPv4Network]) -> list[IPv4Network]:
    return list(dict.fromkeys(networks))


def candidate_subnets() -> list[IPv4Network]:
    return list(BENCHMARK_POOL.subnets(new_prefix=24))


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def stable_network_name(run_identity: dict[str, Any]) -> str:
    """由完整 run 身份生成可复现、不会跨 run 复用的 Docker 网络名。"""
    if not isinstance(run_identity, dict) or not run_identity:
        raise ValueError("run 身份必须是非空对象")
    digest = hashlib.sha256(_canonical_json(run_identity)).hexdigest()
    return "pao-bench-" + digest[:16]


def render_external_network_override(network_name: str) -> str:
    """生成 Harbor trial 共用外部网络的 Compose 覆写。"""
    if not isinstance(network_name, str) or not NETWORK_NAME_PATTERN.fullmatch(
        network_name
    ):
        raise ValueError("自动网络名格式无效")
    return (
        "networks:\n"
        "  default:\n"
        "    external: true\n"
        f"    name: {network_name}\n"
    )


def _validate_ipam_subnets(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in DOCKER_IPAM_ADDRESS_KEYS:
                if not isinstance(item, str):
                    raise ValueError(f"Docker 网络 {key} 必须是字符串")
                try:
                    ip_network(item, strict=False)
                except ValueError as error:
                    raise ValueError(f"Docker 网络 {key} 无效：{item}") from error
            else:
                _validate_ipam_subnets(item)
    elif isinstance(value, list):
        for item in value:
            _validate_ipam_subnets(item)


def _validate_observation_source(
    label: str,
    state: Any,
    *,
    expected_source: str,
    network_item_type: type,
) -> dict[str, Any]:
    if not isinstance(state, dict):
        raise ValueError(f"{label}观察结果必须是对象")
    if state.get("ok") is not True:
        raise ValueError(f"{label}读取失败")
    if state.get("source") != expected_source:
        raise ValueError(f"{label}观察来源标识无效")
    if state.get("error") not in (None, ""):
        raise ValueError(f"{label}读取结果包含错误：{state['error']}")
    networks = state.get("networks")
    if not isinstance(networks, list):
        raise ValueError(f"{label}观察结果缺少 networks 数组")
    if any(not isinstance(item, network_item_type) for item in networks):
        raise ValueError(f"{label}观察结果包含无效网络项")
    return state


def build_external_network_plan(
    run_identity: dict[str, Any],
    observation: dict[str, Any],
) -> dict[str, Any]:
    """校验可信只读观察并生成共享外部网络计划；不访问或修改 Docker。"""
    if not isinstance(observation, dict):
        raise ValueError("网络观察结果必须是对象")
    if observation.get("ok") is not True:
        raise ValueError(
            "网络观察未成功：" + str(observation.get("error") or "未知读取失败")
        )
    if observation.get("writes_performed") is not False:
        raise ValueError("网络观察必须明确为只读")
    if observation.get("error") not in (None, ""):
        raise ValueError("成功的网络观察仍包含错误")

    docker_state = _validate_observation_source(
        "Docker 网络",
        observation.get("docker"),
        expected_source="docker",
        network_item_type=dict,
    )
    route_state = _validate_observation_source(
        "宿主路由",
        observation.get("host_route"),
        expected_source="host_route",
        network_item_type=str,
    )
    _validate_ipam_subnets(docker_state["networks"])

    candidate_text = observation.get("candidate_subnet")
    if not isinstance(candidate_text, str):
        raise ValueError("网络观察缺少候选 subnet")
    try:
        candidate = ip_network(candidate_text, strict=True)
    except ValueError as error:
        raise ValueError(f"候选 subnet 无效：{candidate_text}") from error
    if candidate not in candidate_subnets():
        raise ValueError("候选 subnet 不在既定 /24 池中：" + candidate_text)

    route_networks = []
    for text in route_state["networks"]:
        try:
            network = ip_network(text, strict=False)
        except ValueError as error:
            raise ValueError(f"宿主路由 subnet 无效：{text}") from error
        if network.prefixlen > 0:
            route_networks.append(network)
    existing = [
        *networks_from_value(docker_state["networks"]),
        *route_networks,
    ]
    conflicts = [str(network) for network in existing if candidate.overlaps(network)]
    if conflicts:
        raise ValueError(
            "候选 subnet 与现有网络或路由重叠："
            + "、".join(dict.fromkeys(conflicts))
        )

    network_name = stable_network_name(run_identity)
    return {
        "mode": "auto",
        "observation_used": True,
        "network_scope": "shared_external",
        "network_name": network_name,
        "subnet": str(candidate),
        "run_identity": copy.deepcopy(run_identity),
        "observation": {
            "ok": True,
            "candidate_subnet": candidate_text,
            "docker": copy.deepcopy(docker_state),
            "host_route": copy.deepcopy(route_state),
            "writes_performed": False,
        },
        "reason": (
            "同一题的预检与正式 Harbor trial 使用不同 Compose project，"
            "共享同一个外部网络以避免各 trial 自建同 subnet 冲突"
        ),
    }


def parse_networks(text: str) -> list[IPv4Network]:
    """从 `ip route`、`ip addr` 或纯文本中提取 CIDR。"""
    networks = []
    for value in CIDR_PATTERN.findall(text):
        try:
            network = ip_network(value, strict=False)
        except ValueError:
            continue
        if network.version == 4:
            networks.append(network)
    return networks


def parse_windows_route_table(text: str) -> list[IPv4Network]:
    """解析 Windows `route print` 的目的地址与掩码两列。"""
    networks = [
        network
        for network in parse_networks(text)
        if network.version == 4 and network.prefixlen > 0
    ]
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 3:
            continue
        destination, mask = fields[0], fields[1]
        if not (
            re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", destination)
            and re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", mask)
        ):
            continue
        try:
            network = ip_network(f"{destination}/{mask}", strict=False)
        except ValueError:
            continue
        # 默认路由只表示“其余流量从哪里出去”，不表示整个 IPv4 都被占用。
        if network.version == 4 and network.prefixlen > 0:
            networks.append(network)
    return _unique_networks(networks)


def parse_posix_route_table(text: str) -> list[IPv4Network]:
    """解析 POSIX `ip route show`，忽略默认路由但保留具体子网路由。"""
    networks = [
        network
        for network in parse_networks(text)
        if network.version == 4 and network.prefixlen > 0
    ]
    return _unique_networks(networks)


def networks_from_value(value: Any) -> list[IPv4Network]:
    """递归读取 IPAM JSON，同时接受其中嵌套的字符串 CIDR。"""
    if isinstance(value, str):
        return parse_networks(value)
    if isinstance(value, list):
        rows = []
        for item in value:
            rows.extend(networks_from_value(item))
        return rows
    if isinstance(value, dict):
        rows = []
        for key, item in value.items():
            if key in {"Subnet", "IPRange", "Gateway", "Destination"} and isinstance(
                item, str
            ):
                rows.extend(parse_networks(item))
            else:
                rows.extend(networks_from_value(item))
        return rows
    return []


def load_networks(source: str | Path | dict | list) -> list[IPv4Network]:
    if isinstance(source, (dict, list)):
        return networks_from_value(source)
    text = Path(source).read_text(encoding="utf-8")
    stripped = text.lstrip()
    if stripped.startswith(("{", "[")):
        return networks_from_value(json.loads(text))
    return parse_networks(text)


def collect_networks(*sources: str | Path | dict | list) -> list[IPv4Network]:
    networks = []
    for source in sources:
        networks.extend(load_networks(source))
    return networks


def select_free_subnet(
    *sources: str | Path | dict | list,
) -> IPv4Network:
    """返回池中第一个不与现有网络或路由重叠的 /24。"""
    used = collect_networks(*sources)
    for candidate in candidate_subnets():
        if not any(candidate.overlaps(network) for network in used):
            return candidate
    raise RuntimeError("10.243.0.0/16 中已没有可用 /24")


def docker_network_inputs(
    docker: str = DOCKER_EXE,
    *,
    timeout: int = 15,
) -> dict[str, Any]:
    """只查询现有 Docker 网络；任何失败原样返回给 doctor，不修改 Docker。"""
    command = [docker, "network", "ls", "-q"]
    try:
        listed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "ok": False,
            "command": command,
            "error": f"{type(error).__name__}: {error}",
            "networks": [],
        }
    if listed.returncode != 0:
        return {
            "ok": False,
            "command": command,
            "error": listed.stderr.strip() or listed.stdout.strip(),
            "networks": [],
        }
    details = []
    for network_id in [row.strip() for row in listed.stdout.splitlines() if row.strip()]:
        command = [docker, "network", "inspect", network_id]
        try:
            inspected = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=timeout,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            return {
                "ok": False,
                "command": command,
                "error": f"{type(error).__name__}: {error}",
                "networks": details,
            }
        if inspected.returncode != 0:
            return {
                "ok": False,
                "command": command,
                "error": inspected.stderr.strip() or inspected.stdout.strip(),
                "networks": details,
            }
        try:
            value = json.loads(inspected.stdout)
        except json.JSONDecodeError as error:
            return {
                "ok": False,
                "command": command,
                "error": f"Docker inspect 返回的 JSON 无效：{error}",
                "networks": details,
            }
        if not isinstance(value, list):
            return {
                "ok": False,
                "command": command,
                "error": "Docker inspect 返回值不是数组",
                "networks": details,
            }
        if any(not isinstance(item, dict) for item in value):
            return {
                "ok": False,
                "command": command,
                "error": "Docker inspect 返回数组中的网络项不是对象",
                "networks": details,
            }
        details.extend(value)
    return {"ok": True, "networks": details, "source": "docker"}


def host_route_inputs(
    *,
    timeout: int = 15,
) -> dict[str, Any]:
    """只读取宿主路由表；Windows 与 POSIX 都交给 ipaddress 判断重叠。"""
    command = ["route", "print"] if os.name == "nt" else ["ip", "route", "show"]
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "ok": False,
            "command": command,
            "error": f"{type(error).__name__}: {error}",
            "networks": [],
        }
    if completed.returncode != 0:
        return {
            "ok": False,
            "command": command,
            "error": completed.stderr.strip() or completed.stdout.strip(),
            "networks": [],
        }
    networks = (
        parse_windows_route_table(completed.stdout)
        if os.name == "nt"
        else parse_posix_route_table(completed.stdout)
    )
    return {
        "ok": True,
        "command": command,
        "networks": [str(network) for network in networks],
        "source": "host_route",
    }


def observe_live_networks(docker: str = DOCKER_EXE) -> dict[str, Any]:
    """汇总只读网络证据并选择候选 /24；不创建 Docker 网络。"""
    docker_state = docker_network_inputs(docker)
    route_state = host_route_inputs()
    sources: list[Any] = []
    input_errors = []
    for label, state in (
        ("Docker 网络", docker_state),
        ("宿主路由", route_state),
    ):
        if state.get("ok") is not True:
            detail = str(state.get("error") or "未知读取失败")
            input_errors.append(f"{label}读取失败：{detail}")
        elif not isinstance(state.get("networks"), list):
            input_errors.append(f"{label}读取结果缺少 networks 数组")
        else:
            sources.append(state["networks"])
    if input_errors:
        return {
            "ok": False,
            "candidate_subnet": None,
            "error": "；".join(input_errors),
            "docker": docker_state,
            "host_route": route_state,
            "writes_performed": False,
        }
    candidate = None
    selection_error = None
    try:
        candidate = str(select_free_subnet(*sources))
    except RuntimeError as error:
        selection_error = str(error)
    return {
        "ok": candidate is not None,
        "candidate_subnet": candidate,
        "error": selection_error,
        "docker": docker_state,
        "host_route": route_state,
        "writes_performed": False,
    }
