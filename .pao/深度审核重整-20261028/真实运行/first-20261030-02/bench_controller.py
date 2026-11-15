"""用途：串行运行冻结的 Harbor 实验、暂停和独立评分；不编排产品任务。

输入：新运行目录中的 run-config.json、run-freeze.json，以及冻结的适配器。
输出：control-status.json、control-request.json、机制身份与进度证据、每题原版 Harbor 结果和评分原件。
冻结运行不可复用；不自动重试、恢复或替换实验。运行需要原 Linux Harbor 环境。
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from datetime import datetime, timezone
import yaml

if __package__:
    from . import runner_common
else:
    import runner_common


class ControlLoader(yaml.SafeLoader):
    """控制记录时间作为原文保存，避免YAML隐式日期类型进入JSON证据。"""


ControlLoader.add_constructor("tag:yaml.org,2002:timestamp", ControlLoader.construct_scalar)


class IntegrityError(RuntimeError):
    """冻结输入或运行身份冲突；必须停止相关写入。"""


CANCEL_CONFIRM_TIMEOUT_SECONDS = 2.0


def now():
    return datetime.now(timezone.utc).isoformat()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, data):
    runner_common.write_json(Path(path), data)


def command(
    run,
    stage,
    *args,
    timeout=60,
    env=None,
    text=True,
):
    """执行并保存原始命令证据；凭证只经环境传递，不进入 argv 或记录。"""
    failure = None
    try:
        completed = subprocess.run(
            list(args),
            check=False,
            capture_output=True,
            text=text,
            **({"encoding": "utf-8"} if text else {}),
            timeout=timeout,
            env=env,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
    except subprocess.TimeoutExpired as error:
        failure = error
        completed = subprocess.CompletedProcess(
            list(args),
            None,
            stdout=error.output,
            stderr=error.stderr,
        )
    except OSError as error:
        failure = error
        completed = subprocess.CompletedProcess(
            list(args),
            None,
            stdout="" if text else b"",
            stderr="" if text else b"",
        )
    evidence = runner_common.command_evidence(*args, stage=stage, completed=completed)
    path = Path(run) / "command-evidence.jsonl"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(evidence, ensure_ascii=False, allow_nan=False) + "\n")
    if failure is not None:
        failure.evidence = evidence
        raise failure
    if completed.returncode != 0:
        error = subprocess.CalledProcessError(
            completed.returncode,
            list(args),
            output=completed.stdout,
            stderr=completed.stderr,
        )
        error.evidence = evidence
        raise error
    return completed


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inside(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise IntegrityError(f"冻结文件越过运行目录：{relative}")
    return path


INSTANCE_RELATIVE = PurePosixPath(".pao/benchmark/工作流实例-基准开发流水线.md")
CONTROL_PATH = PurePosixPath("/app/.pao/benchmark")
CONFIG_IDENTITY_KEYS = (
    "source_sha256", "model_data_sha256", "node_sha256",
    "node_archive", "organization_manifest_sha256", "profile",
)


def validate(run, *, final_run=None, container_mounts=None):
    """校验冻结运行。

    准备阶段输入仍位于临时目录，但配置按最终运行目录记录容器路径；传入
    final_run 与 container_mounts 时只对该映射做离线校验。
    """
    run = Path(run).resolve()
    final_run = Path(final_run).resolve() if final_run else run
    config = read(run / "run-config.json")
    freeze = read(run / "run-freeze.json")
    files = freeze["files"]
    required = {
        "run-config.json",
        "preparation_agent.py",
        "map_bench_pao_organized.py",
        "map_bench_pao/__init__.py",
        "map_bench_pao/pao_agent.py",
        "map_bench_pao/usage.py",
        "model-metadata.json",
    }
    if not required.issubset({item["path"] for item in files}):
        raise IntegrityError("冻结清单必须包含 run-config.json、准备代理和完整模型适配器")
    for item in files:
        if digest(inside(run, item["path"])) != item["sha256"]:
            raise IntegrityError("冻结输入已改变：" + item["path"])
    # 题目、次数、重试、代理与模型选择只从共享执行契约校验；此处继续核对
    # 冻结文件、Harbor 结构、容器挂载与保留评分等运行事实。
    runner_common.validate_run_config(config)
    if container_mounts is None:
        local_jobs = Path(config["jobs_dir"])
        if not local_jobs.is_absolute() or not local_jobs.resolve().is_relative_to(run):
            raise ValueError("jobs_dir 必须位于新运行目录内")
    else:
        jobs = PurePosixPath(config["jobs_dir"])
        if not jobs.is_absolute():
            raise ValueError("jobs_dir 必须是绝对容器路径")
        container_root = str(container_mounts["container_root"]).rstrip("/") + "/"
        logged = jobs.as_posix()
        if not logged.startswith(container_root):
            raise ValueError("jobs_dir 必须位于声明的容器挂载根下")
        relative = logged[len(container_root):]
        if not relative or PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts:
            raise ValueError("jobs_dir 越过声明的容器挂载根")
        local_root = Path(container_mounts["local_root"]).resolve()
        mapped = (local_root / PurePosixPath(relative)).resolve()
        if mapped != final_run / "jobs":
            raise ValueError("jobs_dir 必须位于新运行目录内")
    agent = config["agents"][0]
    missing = [key for key in CONFIG_IDENTITY_KEYS if key not in agent["kwargs"]]
    if missing:
        raise ValueError("冻结配置缺少机制身份字段：" + ", ".join(missing))
    return config


def frozen_recipe_digest(text):
    recipe = frontmatter(text).get("冻结配方")
    if not isinstance(recipe, dict) or not recipe:
        raise ValueError("实例的冻结配方缺失或损坏")
    return hashlib.sha256(json.dumps(recipe, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def frontmatter(text):
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("实例缺少frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise ValueError("实例frontmatter未闭合") from error
    fields = yaml.load("\n".join(lines[1:end]), Loader=ControlLoader)
    if not isinstance(fields, dict):
        raise ValueError("实例frontmatter不是对象")
    return fields


def instance_identity(path):
    """解析监督所需的最小 frontmatter，不把正文状态当成配方身份。"""
    try:
        text = Path(path).read_text(encoding="utf-8")
        fields = frontmatter(text)
    except (OSError, UnicodeError, ValueError) as error:
        raise IntegrityError(f"实例身份无法读取或解析：{path}") from error
    required = ("实例", "owner", "工作流")
    missing = [key for key in required if not isinstance(fields.get(key), str) or not fields[key].strip()]
    if missing:
        raise ValueError("实例缺少绑定字段：" + ", ".join(missing))
    return {
        "instance_id": fields["实例"], "owner": fields["owner"], "workflow": fields["工作流"],
        "control_path": str(CONTROL_PATH), "recipe_sha256": frozen_recipe_digest(text),
    }


def mechanism_identity(run, config):
    """记录运行前冻结身份；列表字段只来自冻结配置和冻结清单。"""
    freeze = read(run / "run-freeze.json")
    agent = config["agents"][0]
    return {
        "at": now(), "job_name": config["job_name"], "run_dir": str(run),
        "run_config_sha256": digest(run / "run-config.json"),
        "run_freeze_sha256": digest(run / "run-freeze.json"),
        "frozen_files": {item["path"]: item["sha256"] for item in freeze["files"]},
        "model_name": agent.get("model_name"),
        "identity": {key: agent["kwargs"].get(key) for key in CONFIG_IDENTITY_KEYS},
        "instance_relative_path": INSTANCE_RELATIVE.as_posix(),
        "bound_instance": None,
        "active_job": None, "task_bindings": {},
        "isolation_status": "unverified",
        "os_isolation_implemented": False,
        "isolation_reason": "尚未取得控制正本位于容器外、冻结输入只读挂载的宿主证据；同容器同用户 bash 可写项目内控制面",
    }


def ensure_identity(run, config):
    """身份文件只创建一次，防止把运行中改过的配置重新封成“原身份”。"""
    path = run / "mechanism-identity.json"
    if path.exists():
        raise FileExistsError("本轮机制身份已存在，禁止重新绑定或复用运行目录")
    identity = mechanism_identity(run, config)
    write(path, identity)
    return identity


def bind_instance(run, path):
    """只绑定一次首实例；后续任何不同实例都触发机制验收停止。"""
    identity = read(run / "mechanism-identity.json")
    if identity.get("bound_instance"):
        return identity["bound_instance"]
    item = instance_identity(path)
    identity["bound_instance"] = item
    if identity.get("active_job"):
        identity["task_bindings"][identity["active_job"]] = item
    identity["bound_at"] = now()
    write(run / "mechanism-identity.json", identity)
    write(run / "bound-instance.json", {"at": now(), **item})
    return item


def activate_task(run, config):
    """只有冻结的外层逐题入口能允许下一题的新实例，保留前题绑定。"""
    path = run / "mechanism-identity.json"
    identity = read(path)
    if config["job_name"] in identity["task_bindings"]:
        raise IntegrityError("同一Harbor Job不能重复启动")
    identity["active_job"] = config["job_name"]
    identity["task_bindings"][config["job_name"]] = None
    identity["bound_instance"] = None
    identity.pop("bound_at", None)
    write(path, identity)


def request_pause(run, after_current=False):
    requested = run / "control-request.json"
    # 立即暂停不能被较弱的“当前题后暂停”覆盖。
    if requested.exists() and read(requested)["mode"] == "immediate":
        return
    write(requested, {"at": now(), "mode": "after_current" if after_current else "immediate"})


def request(run):
    path = run / "control-request.json"
    if not path.exists():
        return None
    value = read(path)["mode"]
    if value not in {"immediate", "after_current"}:
        raise ValueError("未知暂停指令")
    return value


def state(run, value, **detail):
    identity = read(run / "mechanism-identity.json") if (run / "mechanism-identity.json").exists() else {}
    write(run / "control-status.json", {
        "at": now(), "state": value, "pid": os.getpid(), "auto_resume": False,
        "mechanism_acceptance": identity.get("isolation_status", "unverified"),
        "os_isolation_implemented": identity.get("os_isolation_implemented", False),
        **detail,
    })


def append_jsonl(path, item):
    with Path(path).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(item, ensure_ascii=False) + "\n")


def record_observer_error(run, error, *, stage="observation"):
    """普通观察失败只留证，不改业务状态；记录失败本身也不能取消作业。"""
    item = {
        "at": now(),
        "stage": stage,
        "type": type(error).__name__,
        "error": repr(error),
        "evidence": getattr(error, "evidence", None),
    }
    paths = []
    persisted = []
    for name in ("observations.jsonl", "observer-errors.json"):
        path = Path(run) / name
        try:
            if name.endswith(".jsonl"):
                append_jsonl(path, item)
            else:
                previous = read(path) if path.exists() else {"errors": []}
                previous.setdefault("errors", []).append(item)
                write(path, previous)
            persisted.append(str(path))
        except BaseException as bookkeeping_error:
            item.setdefault("bookkeeping_errors", []).append(
                {
                    "path": str(path),
                    "type": type(bookkeeping_error).__name__,
                    "error": repr(bookkeeping_error),
                }
            )
            paths.append(str(path))
    item["persisted_paths"] = persisted
    if paths:
        prefix = (
            "观察错误证据未落盘"
            if not persisted
            else "观察错误证据仅部分落盘"
        )
        print(
            prefix
            + "："
            + ", ".join(paths)
            + "；原始错误="
            + repr(error),
            file=sys.stderr,
        )
    return item


def notify(run, kind, *, instance=None, blocker="", owner="", detail="", business_event=""):
    """固定身份键去重；状态未变化时重复观察不重复告警。"""
    key = "|".join((kind, instance or "", blocker, owner))
    path = run / "notifications.jsonl"
    rows = []
    if path.exists():
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    if any(row.get("key") == key for row in rows):
        return False
    event = {"at": now(), "key": key, "kind": kind, "instance": instance,
             "blocker": blocker, "owner": owner, "detail": detail,
             "business_event": business_event}
    append_jsonl(path, event)
    return True


def stop_acceptance(run, reason, **evidence):
    """停止本次机制验收；保留现场，不允许自动恢复或重放。"""
    stop = {"at": now(), "state": "stopped", "reason": reason, **evidence}
    write(run / "mechanism-acceptance-stopped.json", stop)
    state(run, "mechanism_stopped", stop_reason=reason, writers_stopped=False)
    notify(run, "mechanism_acceptance_stopped", blocker=reason,
           owner=evidence.get("owner", ""), detail=evidence.get("path", ""))
    return stop


def recipe_observation(run, path):
    """宿主可见的项目状态观察；输出不声明能阻止同用户写入。"""
    identity = read(run / "mechanism-identity.json")
    if not identity.get("bound_instance"):
        return {"status": "waiting_for_first_instance"}
    path = Path(path)
    if not path.is_file():
        return {"status": "moved_or_missing", "path": str(path)}
    item = instance_identity(path)
    bound = identity["bound_instance"]
    reasons = []
    if item["instance_id"] != bound["instance_id"]:
        reasons.append("instance_changed")
    if item["owner"] != bound["owner"]:
        reasons.append("owner_changed")
    if item["workflow"] != bound["workflow"]:
        reasons.append("workflow_changed")
    if item["recipe_sha256"] != bound["recipe_sha256"]:
        reasons.append("recipe_changed")
    return {"status": "changed" if reasons else "bound", "reasons": reasons, "observed": item}


def discover_instance(root):
    path = Path(root) / INSTANCE_RELATIVE
    return path if path.is_file() else None


def observe_business(run, root, *, quiet_after_seconds=900):
    """摘要来自控制正本的业务记录；静默只提醒，不取消模型请求。"""
    identity = read(run / "mechanism-identity.json")
    path = discover_instance(root)
    bound = identity.get("bound_instance") or {}
    if path and not bound:
        bound = bind_instance(run, path)
        identity = read(run / "mechanism-identity.json")
    observed = recipe_observation(run, path) if path else {
        "status": "moved_or_missing" if bound else "waiting_for_first_instance"}
    previous = read(run / "mechanism-progress.json") if (run / "mechanism-progress.json").exists() else {}
    try:
        flow = frontmatter(path.read_text(encoding="utf-8")) if path else {}
    except (OSError, UnicodeError, ValueError) as error:
        raise IntegrityError("控制正本无法读取或解析") from error
    records = flow.get("记录", [])
    if not isinstance(records, list) or any(not isinstance(row, dict) for row in records):
        raise IntegrityError("控制正本的业务记录损坏")
    latest = records[-1] if records else None
    latest_at = (latest or {}).get("时间") or identity.get("bound_at")
    blocker = flow.get("裁定") or flow.get("暂停")
    event_key = json.dumps(latest, ensure_ascii=False, sort_keys=True)
    progress_at = previous.get("progress_observed_at") if previous.get("business_event_key") == event_key else now()
    progress_at = progress_at or now()
    current = {
        "at": now(), "instance": bound.get("instance_id"), "observation": observed,
        "active_execution": None, "active_execution_status": "unknown",
        "blocker": blocker, "responsible_party": (blocker.get("通道") if isinstance(blocker, dict) else None) or bound.get("owner"),
        "latest_business_event": latest, "latest_business_event_at": latest_at,
        "business_event_key": event_key, "progress_observed_at": progress_at,
        "needs_manual_check": bool(blocker), "os_isolation_implemented": False,
    }
    if blocker:
        notify(run, "workflow_blocked", instance=current["instance"],
               blocker=json.dumps(blocker, ensure_ascii=False, sort_keys=True),
               owner=current["responsible_party"] or "", business_event=latest)
    quiet = (datetime.now(timezone.utc) - datetime.fromisoformat(progress_at)).total_seconds()
    if bound and not blocker and quiet >= quiet_after_seconds and flow.get("状态") != "已完成":
        current["needs_manual_check"] = True
        notify(run, "progress_check_needed", instance=current["instance"], blocker=event_key,
               owner=current["responsible_party"] or "", detail="无新业务事件；不据此判失败或取消请求")
    write(run / "mechanism-progress.json", current)
    return current


def observe_runtime(run, config, docker):
    """仅观察本Job的真实Compose项目；不把容器存活冒充工人活动。"""
    directory = Path(config["jobs_dir"]) / config["job_name"]
    trials = [read(path)["trial_name"] for path in directory.glob("*/config.json")]
    projects = {compose_project(name) for name in trials}
    rows = command(
        run,
        "runtime_ps",
        docker,
        "ps",
        "-a",
        "--size=false",
        "--format",
        "{{json .}}",
        timeout=15,
    ).stdout.splitlines()
    containers = []
    for line in rows:
        row = json.loads(line)
        labels = dict(item.split("=", 1) for item in row.get("Labels", "").split(",") if "=" in item)
        if labels.get("com.docker.compose.project") in projects and labels.get("com.docker.compose.service") == "main":
            containers.append(row)
    if len(containers) > 1:
        raise IntegrityError("单题出现多个执行容器，拒绝继续机制验收")
    if not containers:
        return None
    container = containers[0]["Names"]
    if containers[0].get("State") != "running":
        # 终局不能复用最后一次活态快照；从本Job的停止容器收取实际正本。
        with tempfile.TemporaryDirectory(prefix="supervision-final-", dir=run) as temporary:
            root = Path(temporary)
            try:
                command(
                    run,
                    "runtime_artifact_copy",
                    docker,
                    "cp",
                    container + ":/app/.pao",
                    str(root),
                    timeout=30,
                )
            except subprocess.CalledProcessError:
                bound = read(run / "mechanism-identity.json").get("bound_instance")
                if bound:
                    raise
                return None
            return observe_control_tree(run, root)
    script = (
        "if [ -d /app/.pao ]; then find /app/.pao -type f -name '工作流实例-*.md' -print0 "
        "| tar --null -T - -c; else tar -c -T /dev/null; fi"
    )
    try:
        content = command(
            run,
            "runtime_exec",
            docker,
            "exec",
            container,
            "bash",
            "-o",
            "pipefail",
            "-c",
            script,
            timeout=15,
            text=False,
        ).stdout
    except subprocess.CalledProcessError as execution_error:
        try:
            running = command(
                run,
                "runtime_stop_check",
                docker,
                "inspect",
                "--format",
                "{{json .State.Running}}",
                container,
                timeout=15,
            ).stdout
        except BaseException as query_error:
            grouped = BaseExceptionGroup(
                "Docker 执行失败且停机核查失败",
                [execution_error, query_error],
            )
            grouped.stages = ("runtime_exec", "runtime_stop_check")
            raise grouped from execution_error
        if json.loads(running) is False:
            return observe_runtime(run, config, docker)
        raise execution_error
    (run / "supervision-last-control.tar").write_bytes(content)
    snapshot = run / "supervision-snapshot"
    snapshot.mkdir(exist_ok=True)
    instances = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(content)) as archive:
            for member in archive:
                if not member.isfile() or member.size > 8 * 1024 * 1024:
                    raise IntegrityError("监督快照包含无效控制文件")
                relative = PurePosixPath(member.name.lstrip("/"))
                if not relative.is_relative_to(PurePosixPath("app/.pao")) or ".." in relative.parts:
                    raise IntegrityError("监督快照路径越界")
                text = archive.extractfile(member).read().decode("utf-8")
                identity = frontmatter(text).get("实例")
                if not isinstance(identity, str) or not identity:
                    raise IntegrityError("监督快照缺少实例身份")
                instances.setdefault(identity, []).append(relative.as_posix())
                if relative.as_posix() == "app/" + INSTANCE_RELATIVE.as_posix():
                    destination = snapshot / INSTANCE_RELATIVE
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_text(text, encoding="utf-8")
    except IntegrityError:
        raise
    except (ValueError, UnicodeError, tarfile.TarError) as error:
        raise IntegrityError("监督快照无法解析") from error
    bound = read(run / "mechanism-identity.json").get("bound_instance") or {}
    expected = bound.get("instance_id")
    expected_path = "app/" + INSTANCE_RELATIVE.as_posix()
    if (len(instances) > 1 or any(paths != [expected_path] for paths in instances.values())
            or (expected and set(instances) != {expected})):
        raise IntegrityError("控制正本被搬走、重建或出现其他实例：" + json.dumps(instances, ensure_ascii=False))
    current_path = snapshot / INSTANCE_RELATIVE
    if not any("app/" + INSTANCE_RELATIVE.as_posix() in paths for paths in instances.values()):
        if current_path.exists():
            current_path.unlink()  # 仅本轮派生快照；不操作实际控制正本。
    progress = observe_business(run, snapshot)
    progress["container"] = {"name": container, "state": containers[0]["State"]}
    write(run / "mechanism-progress.json", progress)
    if progress["observation"]["status"] not in {"bound", "waiting_for_first_instance"}:
        raise IntegrityError("机制身份改变：" + json.dumps(progress["observation"], ensure_ascii=False))
    return progress


def compose_project(trial, role="env"):
    """与当前 Harbor Docker 后端的项目命名一致，供观察和停写核查共用。"""
    name = (trial + "__" + role).lower()
    if not re.match(r"^[a-z0-9]", name):
        name = "0" + name
    return re.sub(r"[^a-z0-9_-]", "-", name)


def observe_control_tree(run, root):
    """从终局真实副本核对集合，不从卡片数量猜实例身份。"""
    instances = {}
    for path in (root / ".pao").rglob("工作流实例-*.md"):
        item = instance_identity(path)
        instances.setdefault(item["instance_id"], []).append(path.relative_to(root).as_posix())
    bound = read(run / "mechanism-identity.json").get("bound_instance") or {}
    expected = bound.get("instance_id")
    if (len(instances) > 1 or any(paths != [INSTANCE_RELATIVE.as_posix()] for paths in instances.values())
            or (expected and set(instances) != {expected})):
        raise IntegrityError("终局控制正本被搬走、重建或出现其他实例：" + json.dumps(instances, ensure_ascii=False))
    progress = observe_business(run, root)
    if progress["observation"]["status"] not in {"bound", "waiting_for_first_instance"}:
        raise IntegrityError("终局机制身份改变：" + json.dumps(progress["observation"], ensure_ascii=False))
    return progress


def classify_result(result):
    rows = result["trial_results"]
    if len(rows) != 1 or any(row.get("exception_info") for row in rows):
        return "execution_error"
    def valid_rewards(row):
        verifier_result = row.get("verifier_result")
        rewards = verifier_result.get("rewards") if isinstance(verifier_result, dict) else None
        return (
            isinstance(rewards, dict)
            and bool(rewards)
            and all(runner_common.finite_number(value) for value in rewards.values())
        )

    if any(not valid_rewards(row) for row in rows):
        return "missing_score"
    return "finished"


async def settle_task(current, *, original_error=None, timeout=None):
    """统一取消规则：已终态不取消；否则有界等待并保留真实清理异常。"""
    if timeout is None:
        timeout = CANCEL_CONFIRM_TIMEOUT_SECONDS
    evidence = {
        "task_present": current is not None,
        "done_before_stop": False,
        "cancel_requested": False,
        "cancelled_error_observed": False,
        "wait_timed_out": False,
        "task_done_observed": False,
    }
    cleanup_errors = []
    if current is None:
        return evidence, cleanup_errors
    evidence["done_before_stop"] = current.done()
    if not current.done():
        try:
            evidence["cancel_requested"] = current.cancel() is True
        except BaseException as error:
            cleanup_errors.append(error)
    done, _ = await asyncio.wait({current}, timeout=timeout)
    if current not in done:
        evidence["wait_timed_out"] = True
        cleanup_errors.append(
            TimeoutError("取消已请求但任务未在等待上限内进入终态")
        )
    else:
        try:
            await current
        except asyncio.CancelledError:
            evidence["cancelled_error_observed"] = True
        except BaseException as error:
            if error is not original_error:
                cleanup_errors.append(error)
    evidence["task_done_observed"] = current.done()
    return evidence, cleanup_errors


async def run_sequence(run, config, execute, *, observe=None, docker="docker"):
    """execute 接收原版 JobConfig 字典；可注入离线夹具验证控制语义。"""
    # 独占启动标记不删除：崩溃或暂停后也不能自动重放。
    with (run / "control-started.json").open("x", encoding="utf-8") as stream:
        json.dump({"at": now(), "pid": os.getpid()}, stream)
    current = None
    results = []
    observer_errors = []
    phase = "initialization"

    def write_state(value, **detail):
        state(run, value, observer_errors=observer_errors, **detail)

    def observe_failure(error, stage):
        observer_errors.append(record_observer_error(run, error, stage=stage))

    def stop_error_rows(
        primary_stage,
        primary_error,
        stop_evidence,
        cleanup_errors,
    ):
        rows = []
        if primary_error is not None:
            rows.append(
                {
                    "stage": primary_stage,
                    "type": type(primary_error).__name__,
                    "error": repr(primary_error),
                }
            )
        rows.extend(
            {
                "stage": (
                    "cleanup_timeout"
                    if stop_evidence["wait_timed_out"]
                    and isinstance(error, TimeoutError)
                    else "cleanup"
                ),
                "type": type(error).__name__,
                "error": repr(error),
            }
            for error in cleanup_errors
        )
        return rows

    try:
        identity = ensure_identity(run, config)
        frozen_stats = {}
        def check_frozen(*, full=False):
            if (digest(run / "run-config.json") != identity["run_config_sha256"]
                    or digest(run / "run-freeze.json") != identity["run_freeze_sha256"]):
                raise IntegrityError("运行配置或冻结清单在运行中改变")
            for relative, expected in identity["frozen_files"].items():
                try:
                    path = inside(run, relative)
                    stat = path.stat()
                    fingerprint = (
                        stat.st_size,
                        stat.st_mtime_ns,
                        stat.st_ctime_ns,
                        stat.st_ino,
                    )
                    if full or frozen_stats.get(relative) != fingerprint:
                        if digest(path) != expected:
                            raise IntegrityError("冻结输入在运行中改变：" + relative)
                        frozen_stats[relative] = fingerprint
                except IntegrityError:
                    raise
                except (OSError, UnicodeError) as error:
                    raise IntegrityError("冻结输入无法读取：" + relative) from error
        check_frozen(full=True)
        async def supervise(config, *, full=False):
            check_frozen(full=full)
            observation = observe or (lambda run, cfg: observe_runtime(run, cfg, docker))
            return await asyncio.to_thread(observation, run, config)
        if request(run):
            phase = "pause_before_preflight"
            write_state("paused", completed=results, writers_stopped=True)
            return
        phase = "preflight"
        write_state("preflight", model_execution_started=False)
        preparation = copy.deepcopy(config)
        preparation["job_name"] += "-preflight"
        preparation["agents"][0]["import_path"] = "preparation_agent:PreparationOnlyAgent"
        preparation["verifier"]["disable"] = True
        # 预检也接受立即暂停；当前题后暂停将在模型开始前生效。
        current = asyncio.create_task(execute(preparation))
        while not current.done():
            if request(run) == "immediate":
                stop_evidence, cleanup_errors = await settle_task(current)
                if cleanup_errors:
                    grouped = BaseExceptionGroup(
                        "预检立即暂停取消未确认",
                        cleanup_errors,
                    )
                    grouped.stages = tuple(
                        row["stage"]
                        for row in stop_error_rows(
                            "pause_preflight",
                            None,
                            stop_evidence,
                            cleanup_errors,
                        )
                    )
                    grouped.stop_evidence = stop_evidence
                    raise grouped
                write_state(
                    "paused",
                    completed=results,
                    writers_stopped=stop_evidence["task_done_observed"],
                    stop_evidence=stop_evidence,
                )
                return
            await asyncio.sleep(0.2)
        prepared = await current
        check_frozen(full=True)
        write(run / "preflight-summary.json", prepared)
        if len(prepared["trial_results"]) != len(config["tasks"]) or any(
                row.get("exception_info") for row in prepared["trial_results"]):
            raise RuntimeError("环境预检失败；未启动正式模型")
        phase = "formal"
        for index, task in enumerate(config["tasks"]):
            if request(run):
                write_state("paused", completed=results, writers_stopped=True)
                return
            derived = copy.deepcopy(config)
            derived["tasks"] = [task]
            derived["job_name"] += f"-task-{index + 1}"
            # 只拆实验调度，不改变题目、模型、权限或正式评分配置。
            write(run / f"task-{index + 1}-config.json", derived)
            activate_task(run, derived)
            write_state("running", task=task["name"], completed=results)
            current = asyncio.create_task(execute(derived))
            # 先让作答协程取得一次调度，避免首次观察发生在任务真正启动前。
            await asyncio.sleep(0)
            next_observation = 0.0
            while not current.done():
                if request(run) == "immediate":
                    stop_evidence, cleanup_errors = await settle_task(current)
                    if cleanup_errors:
                        grouped = BaseExceptionGroup(
                            "立即暂停取消未确认",
                            cleanup_errors,
                        )
                        grouped.stages = tuple(
                            row["stage"]
                            for row in stop_error_rows(
                                "pause",
                                None,
                                stop_evidence,
                                cleanup_errors,
                            )
                        )
                        grouped.stop_evidence = stop_evidence
                        grouped.task = task["name"]
                        raise grouped
                    try:
                        await supervise(derived, full=True)
                    except IntegrityError as error:
                        stop_acceptance(run, str(error), task=task["name"])
                        write_state("mechanism_stopped", task=task["name"], completed=results,
                                    stop_reason=str(error),
                                    writers_stopped=stop_evidence["task_done_observed"],
                                    stop_evidence=stop_evidence)
                        return
                    except Exception as error:
                        observe_failure(error, "pause_final_observation")
                    write_state(
                        "paused",
                        task=task["name"],
                        completed=results,
                        writers_stopped=stop_evidence["task_done_observed"],
                        stop_evidence=stop_evidence,
                    )
                    return
                if asyncio.get_running_loop().time() >= next_observation:
                    try:
                        await supervise(derived)
                    except IntegrityError as error:
                        stop_acceptance(run, str(error), task=task["name"])
                        stop_evidence, cleanup_errors = (
                            await settle_task(
                                current,
                                original_error=error,
                            )
                        )
                        if cleanup_errors:
                            error_rows = stop_error_rows(
                                "supervision",
                                error,
                                stop_evidence,
                                cleanup_errors,
                            )
                            grouped = BaseExceptionGroup(
                                "机制观察与任务收尾异常",
                                [error, *cleanup_errors],
                            )
                            grouped.stages = tuple(
                                row["stage"] for row in error_rows
                            )
                            grouped.stop_evidence = stop_evidence
                            # 写入停止未确认记录，不能由外层通用异常路径覆盖首错。
                            write_state(
                                "stop_unconfirmed",
                                task=task["name"],
                                error=repr(grouped),
                                first_error_stage="supervision",
                                error_types=error_rows,
                                completed=results,
                                writers_stopped=False,
                                stop_evidence=stop_evidence,
                            )
                            raise grouped from error
                        write_state(
                            "mechanism_stopped",
                            task=task["name"],
                            completed=results,
                            stop_reason=str(error),
                            writers_stopped=stop_evidence["task_done_observed"],
                            stop_evidence=stop_evidence,
                        )
                        return
                    except Exception as error:
                        observe_failure(error, "runtime_observation")
                    next_observation = asyncio.get_running_loop().time() + 5
                await asyncio.sleep(0.2)
            result = await current
            try:
                await supervise(derived, full=True)
            except IntegrityError as error:
                stop_acceptance(run, str(error), task=task["name"])
                stop_evidence, cleanup_errors = await settle_task(
                    current,
                    original_error=error,
                )
                if cleanup_errors:
                    error_rows = stop_error_rows(
                        "final_observation",
                        error,
                        stop_evidence,
                        cleanup_errors,
                    )
                    grouped = BaseExceptionGroup(
                        "终局观察与任务收尾异常",
                        [error, *cleanup_errors],
                    )
                    grouped.stages = tuple(
                        row["stage"] for row in error_rows
                    )
                    grouped.stop_evidence = stop_evidence
                    grouped.task = task["name"]
                    raise grouped from error
                write_state(
                    "mechanism_stopped",
                    task=task["name"],
                    completed=results,
                    stop_reason=str(error),
                    writers_stopped=stop_evidence["task_done_observed"],
                    stop_evidence=stop_evidence,
                )
                return
            except Exception as error:
                observe_failure(error, "final_observation")
            write(run / f"task-{index + 1}-summary.json", result)
            outcome = classify_result(result)
            results.append({"task": task["name"], "state": outcome, "source": f"task-{index + 1}-summary.json"})
            if outcome != "finished":
                write_state(outcome, completed=results, writers_stopped=True)
                return
        write_state("finished", completed=results, writers_stopped=True)
    except IntegrityError as error:
        stop_evidence, cleanup_errors = await settle_task(
            current,
            original_error=error,
        )
        stop_acceptance(run, str(error), stage=phase)
        if not cleanup_errors:
            write_state(
                "mechanism_stopped",
                stop_reason=str(error),
                completed=results,
                writers_stopped=stop_evidence["task_done_observed"],
                stop_evidence=stop_evidence,
            )
        else:
            error_rows = stop_error_rows(
                phase,
                error,
                stop_evidence,
                cleanup_errors,
            )
            write_state(
                "stop_unconfirmed",
                error=repr(error),
                first_error_stage=phase,
                error_types=error_rows,
                completed=results,
                writers_stopped=False,
                stop_evidence=stop_evidence,
            )
            grouped = BaseExceptionGroup(
                "输入完整性停止且任务收尾失败",
                [error, *cleanup_errors],
            )
            grouped.stages = tuple(row["stage"] for row in error_rows)
            grouped.stop_evidence = stop_evidence
            raise grouped from error
    except BaseException as error:
        # 中断时不声称进程已经停止；真实 Harbor 清理失败同样暴露。
        if (
            isinstance(error, BaseExceptionGroup)
            and isinstance(getattr(error, "stages", None), tuple)
            and len(error.exceptions) == len(error.stages)
        ):
            detail = {
                "error": repr(error),
                "first_error_stage": error.stages[0],
                "error_types": [
                    {
                        "stage": stage,
                        "type": type(item).__name__,
                        "error": repr(item),
                    }
                    for stage, item in zip(error.stages, error.exceptions)
                ],
                "completed": results,
                "writers_stopped": False,
            }
            stop_evidence = getattr(error, "stop_evidence", None)
            if stop_evidence is not None:
                detail["stop_evidence"] = stop_evidence
            task = getattr(error, "task", None)
            if task is not None:
                detail["task"] = task
            write_state("stop_unconfirmed", **detail)
            raise
        errors = [("business", error)]
        stop_evidence, cleanup_errors = (
            await settle_task(current, original_error=error)
        )
        errors.extend(
            (
                "cleanup_timeout"
                if stop_evidence["wait_timed_out"]
                and isinstance(cleanup_error, TimeoutError)
                else "cleanup",
                cleanup_error,
            )
            for cleanup_error in cleanup_errors
        )
        detail = {
            "error": repr(error),
            "first_error_stage": phase,
            "error_types": [
                {"stage": stage, "type": type(item).__name__, "error": repr(item)}
                for stage, item in errors
            ],
            "completed": results,
            "writers_stopped": False,
            "stop_evidence": stop_evidence,
        }
        if len(errors) == 1:
            write_state("failed", **detail)
            raise
        grouped = BaseExceptionGroup("控制器业务与清理异常", [item for _, item in errors])
        write_state("stop_unconfirmed", **detail)
        raise grouped from error


async def harbor_execute(config, *, docker="docker"):
    from harbor.job import Job
    from harbor.models.job.config import JobConfig
    job = await Job.create(JobConfig.model_validate(config))
    result = None
    business_error = None
    try:
        result = await job.run()
    except BaseException as error:
        business_error = error
    try:
        # Harbor 的环境停止会记录并吞掉部分 Docker 异常，须另外核查本 job 的容器。
        directory = Path(config["jobs_dir"]) / config["job_name"]
        trials = [read(path)["trial_name"] for path in directory.glob("*/config.json")]
        completed = command(
            Path(config["jobs_dir"]).parent,
            "harbor_cleanup_check",
            docker,
            "ps",
            "--format",
            "{{.Label \"com.docker.compose.project\"}}",
            timeout=30,
        )
        rows = completed.stdout.splitlines()
        active = [row for row in rows if any(row == compose_project(name) or
                  row.startswith(compose_project(name, "verifier") + "__") for name in trials)]
        if active:
            raise RuntimeError("Harbor 收尾后仍有本轮活动容器；停止未确认：" + ", ".join(active))
        if business_error is not None:
            raise business_error
    except BaseException as cleanup_error:
        if business_error is not None and cleanup_error is not business_error:
            grouped = BaseExceptionGroup("Harbor 业务与清理异常", [business_error, cleanup_error])
            raise grouped from business_error
        raise
    if config["agents"][0].get("import_path") == "preparation_agent:PreparationOnlyAgent":
        directory = Path(config["jobs_dir"]) / config["job_name"]
        evidence = list(directory.glob("*/agent/preparation-complete.txt"))
        if (not any(row.get("exception_info") for row in result.model_dump(mode="json")["trial_results"])
                and len(evidence) != len(config["tasks"])):
            raise RuntimeError("预检缺少实际 preparation-complete.txt 证据，不启动模型")
    return result.model_dump(mode="json")


def score_current(run, spec_path, docker):
    status = read(run / "control-status.json")
    if status["state"] not in {"paused", "finished", "execution_error", "missing_score", "mechanism_stopped"} or not status.get("writers_stopped"):
        raise RuntimeError("先暂停并确认本轮写入已停止；不对活动现场评分")
    spec = read(spec_path)
    kind = "completed_artifact_rescore" if status["state"] == "finished" else "interrupted_artifact_score"
    def run_command(stage, *args, timeout=60):
        return command(
            run,
            stage,
            docker,
            *args,
            timeout=timeout,
        ).stdout.strip()
    source = spec["source_container"]
    if read_container_state(run_command, source):
        raise RuntimeError("成果容器仍在运行，拒绝复制活动产物")
    task = Path(spec["task_dir"]).resolve()
    # task.toml 与全部 tests 文件均须匹配预先保存的评分清单。
    expected = {item["path"]: item["sha256"] for item in spec["files"]}
    actual = {"task.toml", *(p.relative_to(task).as_posix() for p in (task / "tests").rglob("*") if p.is_file())}
    if actual != set(expected):
        raise ValueError("评分文件集合与冻结清单不同")
    for relative, sha in expected.items():
        if digest(inside(task, relative)) != sha:
            raise ValueError("原版评分素材已改变：" + relative)
    cfg = tomllib.loads((task / "task.toml").read_text(encoding="utf-8"))
    image = cfg["verifier"]["environment"]["docker_image"]
    if not re.search(r"@sha256:[0-9a-f]{64}$", image):
        raise ValueError("评分镜像必须固定 digest")
    out = run / "current-score"
    out.mkdir(exist_ok=False)
    logs = out / "verifier"
    logs.mkdir()
    name = "pao-score-" + hashlib.sha256(str(run).encode()).hexdigest()[:16]
    created = False
    business_error = None
    cleanup_errors = []
    try:
        snapshots = []
        for index, artifact in enumerate(spec["artifacts"]):
            target = PurePosixPath(artifact["target"])
            if not target.is_absolute() or ".." in target.parts or not str(target).startswith("/app/"):
                raise ValueError("评分产物只允许 /app/ 内明确文件")
            local = out / f"artifact-{index}"
            run_command("artifact_copy", "cp", f"{source}:{target}", str(local))
            snapshots.append({"target": str(target), "local": str(local), "sha256": digest(local)})
        if not snapshots:
            raise ValueError("没有待评分成果")
        if read_container_state(run_command, source):
            raise RuntimeError("复制期间成果容器重新启动；不评分")
        write(out / "scoring-inputs.json", {"at": now(), "kind": kind,
              "model_calls": 0, "source": source, "image": image, "files": spec["files"], "artifacts": snapshots})
        run_command(
            "score_create",
            "create", "--name", name, "--restart=no", "--cpus=2", "--memory=8g", "--mount",
            f"type=bind,source={logs.as_posix()},target=/logs/verifier", "--workdir", "/app",
            image, "bash", "/tests/test.sh",
        )
        created = True
        for item in snapshots:
            run_command(
                "artifact_upload",
                "cp", item["local"], f"{name}:{item['target']}",
            )
        # 合并 tests 内容，保留镜像原有数据；不以整个目录挂载遮住内置素材。
        for path in sorted((task / "tests").iterdir()):
            run_command(
                "tests_upload",
                "cp", str(path), f"{name}:/tests/{path.name}",
            )
        with (out / "test-output.log").open("xb") as log:
            completed = subprocess.run(
                [docker, "start", "-a", name],
                check=False,
                stdout=log,
                stderr=subprocess.STDOUT,
                encoding="utf-8",
                timeout=cfg["verifier"]["timeout_sec"] + 60,
                **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
            )
            evidence = runner_common.command_evidence(
                docker, "start", "-a", name, stage="verifier",
                completed=completed,
            )
            evidence["stdout"] = None
            evidence["stdout_file"] = str(out / "test-output.log")
            write(out / "command-evidence.json", evidence)
        reward = float((logs / "reward.txt").read_text().strip())
        if not math.isfinite(reward):
            raise ValueError("评分奖励不是有限数值")
        result = {"at": now(), "state": "scored", "kind": kind,
                  "reward": reward, "test_exit_code": completed.returncode, "model_calls": 0}
    except BaseException as error:
        business_error = error
    finally:
        # 只停止本次新建的评分容器，不删除历史或其他容器。
        if created:
            try:
                found = run_command(
                    "score_cleanup_query",
                    "ps", "-q", "--filter", f"name=^/{name}$",
                )
                if found:
                    run_command(
                        "score_cleanup_stop",
                        "stop", "--time", "10", name,
                        timeout=30,
                    )
            except BaseException as error:
                cleanup_errors.append(error)
    if business_error is not None or cleanup_errors:
        errors = ([business_error] if business_error is not None else []) + cleanup_errors
        write(out / "result.json", {
            "at": now(), "state": "scoring_invalid", "model_calls": 0,
            "errors": [
                {"stage": "business" if item is business_error else "cleanup", "error": repr(item)}
                for item in errors
            ],
        })
        if len(errors) == 1:
            raise errors[0]
        grouped = BaseExceptionGroup("评分业务与清理异常", errors)
        raise grouped from business_error
    write(out / "result.json", result)
    return result


def read_container_state(command, name):
    return json.loads(
        command(
            "artifact_state_check",
            "inspect", "--format", "{{json .State.Running}}", name,
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["validate", "run", "status", "pause", "score"])
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--after-current", action="store_true")
    parser.add_argument("--score-spec", type=Path)
    parser.add_argument("--docker", default="docker")
    args = parser.parse_args()
    run = args.run.resolve()
    if args.action == "pause":
        request_pause(run, args.after_current)
        print("已请求暂停；以 status 中 writers_stopped 为停止确认")
    elif args.action == "status":
        progress_path = run / "mechanism-progress.json"
        progress = read(progress_path) if progress_path.exists() else None
        container = (progress or {}).get("container")
        actual = None
        if container:
            inspected = subprocess.run([args.docker, "inspect", "--format", "{{json .State}}", container["name"]],
                                       text=True, encoding="utf-8", capture_output=True, timeout=15)
            actual = ({"at": now(), "name": container["name"], "state": json.loads(inspected.stdout)}
                      if inspected.returncode == 0 else {"at": now(), "status": "unknown", "error": inspected.stderr})
        notifications = run / "notifications.jsonl"
        print(json.dumps({"observation": "控制状态是最后落盘记录，容器观察另列；工人活动未知时不填0",
                          **read(run / "control-status.json"), "business_progress": progress,
                          "container_observation": actual,
                          "notifications": [json.loads(line) for line in notifications.read_text(encoding="utf-8").splitlines() if line]
                              if notifications.exists() else []}, ensure_ascii=False, indent=2))
    elif args.action == "score":
        if args.score_spec is None:
            parser.error("score 需要 --score-spec")
        print(json.dumps(score_current(run, args.score_spec, args.docker), ensure_ascii=False))
    else:
        config = validate(run)
        if args.action == "validate":
            # 提前验证全部真实模型适配器参数，不能等模型运行时自由换实验。
            sys.path.insert(0, str(run))
            from map_bench_pao_organized import OrganizedOptions
            from harbor.models.job.config import JobConfig
            OrganizedOptions.model_validate(config["agents"][0]["kwargs"])
            JobConfig.model_validate(config)
            print("配置与冻结输入通过；模型调用 0")
        else:
            sys.path.insert(0, str(run))
            from map_bench_pao_organized import OrganizedOptions
            OrganizedOptions.model_validate(config["agents"][0]["kwargs"])
            asyncio.run(run_sequence(run, config, lambda cfg: harbor_execute(cfg, docker=args.docker), docker=args.docker))
            status = read(run / "control-status.json")
            if status.get("state") != "finished":
                raise SystemExit(1)


if __name__ == "__main__":
    main()
