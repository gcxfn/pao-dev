"""原生会话识别和可观察用量汇总；不把执行映射、派发日志或默认零价当模型会话。"""
from __future__ import annotations

import json
from pathlib import Path


def session_role(path: Path) -> str:
    """按原生会话的受管路径归属角色；未知布局单独计数，不猜成已覆盖角色。"""
    parts = Path(path).parts
    if "部长会话" in parts:
        return "minister"
    if "worker会话" in parts:
        return "worker"
    if "native-default-sessions" in parts:
        return "main"
    if "worker-sessions" in parts:
        return "worker"
    if "sessions" in parts:
        return "main"
    return "other"


def classify_session_file(path: Path) -> tuple[str, str | None]:
    """按原生会话头分类；损坏候选由调用方依据路径暴露，不能静默过滤。"""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        return "corrupt", f"{type(exc).__name__}: {exc}"
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            first = json.loads(line)
        except json.JSONDecodeError as exc:
            return "corrupt", f"第 {line_number} 行无法解析：{exc}"
        if not isinstance(first, dict):
            return "non_session", None
        identity = first.get("id")
        if first.get("type") == "session" and isinstance(identity, str) and identity:
            return "session", None
        return "non_session", None
    return "corrupt", "空 JSONL 没有原生会话头"


def aggregate_session_usage(session_files: list[Path]) -> dict:
    seen: dict[tuple, str] = {}
    session_roles: dict[str, str] = {}
    totals = dict(input=0, output=0, cache=0, cache_write=0)
    models: dict[str, dict] = {}
    unknown_tokens = events_count = 0
    errors: list[str] = []
    if not session_files:
        errors.append("没有原生会话文件，不能按零用量处理")
    for path in session_files:
        try:
            events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            errors.append(f"{path}: {type(exc).__name__}: {exc}")
            continue
        session_id = next((e.get("id") for e in events if isinstance(e, dict) and e.get("type") == "session"), None)
        if not isinstance(session_id, str) or not session_id:
            errors.append(f"{path}: 缺少 session id，无法可靠去重")
            session_id = str(path.resolve())
        else:
            role = session_role(path)
            previous_role = session_roles.setdefault(session_id, role)
            if previous_role != role:
                errors.append(
                    f"{path}: 同一会话出现在多个角色路径：{previous_role}/{role}"
                )
        current_model = "unknown"
        for position, event in enumerate(events, 1):
            if not isinstance(event, dict):
                errors.append(f"{path}:{position}: 事件不是对象")
                continue
            kind = event.get("type")
            if kind == "model_change":
                current_model = f'{event.get("provider", "unknown")}/{event.get("modelId", "unknown")}'
                continue
            message = event.get("message", {})
            message = message if isinstance(message, dict) else {}
            is_assistant = kind == "message" and message.get("role") == "assistant"
            is_tool = kind == "message" and message.get("role") == "toolResult"
            is_status = kind == "custom" and event.get("customType") in {"pao-precompaction-usage-status", "pao-native-usage-status"}
            if is_assistant and message.get("stopReason") == "aborted" and message.get("errorMessage") == "Operation aborted before provider request":
                continue
            usage = message.get("usage") if is_assistant or is_tool else event.get("usage")
            data = event.get("data") or {}
            missing_status = is_status and isinstance(data, dict) and (data.get("status") == "请求未返回用量" or data.get("usageReported") is False)
            # 与 nativeEntryUsage 对齐：辅助事件没有 usage 时忽略；显式未知状态才入账为 unknown。
            has_auxiliary_usage = kind in {"usage", "compaction", "branch_summary"} and usage is not None
            if not (is_assistant or (is_tool and usage is not None) or has_auxiliary_usage or missing_status):
                continue
            identity = event.get("id")
            if not isinstance(identity, str) or not identity:
                errors.append(f"{path}:{position}: 缺少事件 id，使用同会话行号临时去重")
                identity = f"line:{position}"
            key = (session_id, identity)
            fingerprint = json.dumps(event, sort_keys=True, ensure_ascii=False)
            if key in seen:
                if seen[key] != fingerprint:
                    errors.append(f"{path}:{position}: 同身份事件内容冲突")
                continue
            seen[key] = fingerprint
            events_count += 1
            raw = usage if isinstance(usage, dict) else {}
            values = {}
            token_unknown = False
            for name in ("input", "output", "cacheRead", "cacheWrite"):
                value = raw.get(name)
                valid = isinstance(value, int) and not isinstance(value, bool) and value >= 0
                values[name] = value if valid else 0
                token_unknown |= not valid
            uncertain_failure = is_assistant and message.get("stopReason") in {"error", "aborted"} and sum(values.values()) == 0
            unknown_tokens += int(token_unknown or uncertain_failure)
            model_source = message if is_assistant or is_tool else event
            model_id = model_source.get("model") or model_source.get("responseModel")
            provider = model_source.get("provider")
            model_name = f"{provider}/{model_id}" if isinstance(provider, str) and isinstance(model_id, str) else current_model
            bucket = models.setdefault(model_name, dict(input=0, output=0, cache=0, cache_write=0))
            additions = dict(input=values["input"] + values["cacheRead"] + values["cacheWrite"], output=values["output"],
                             cache=values["cacheRead"], cache_write=values["cacheWrite"])
            for name, value in additions.items():
                totals[name] += value
                bucket[name] += value
    role_session_counts = {role: 0 for role in ("main", "minister", "worker", "other")}
    for role in session_roles.values():
        role_session_counts[role] += 1
    return {
        **totals,
        "models": models,
        "events": events_count,
        "role_session_counts": role_session_counts,
        "unknown_tokens": unknown_tokens,
        "errors": errors,
        "cost_status": "unknown",
        "cost_source": "未提供经核实的单价来源；原始 usage.cost.total=0 不视为免费",
        "complete": (
            bool(session_files)
            and not errors
            and unknown_tokens == 0
        ),
    }
