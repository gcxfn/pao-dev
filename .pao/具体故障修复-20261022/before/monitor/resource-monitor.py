#!/usr/bin/env python3
"""用途：低频记录一轮 PAO Docker 运行的资源；输入 runtime-containers.json。
输出 resources.jsonl、resource-summary.json、性能摘要.md；不改题、不重启、不调用模型。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import signal
import statistics
import subprocess
import time
from pathlib import Path
from typing import Any

DOCKER = r"D:\Docker\resources\bin\docker.exe"
RUNTIME = "runtime-containers.json"
SAMPLES = "resources.jsonl"
SUMMARY = "resource-summary.json"
REPORT = "性能摘要.md"
EXIT = "controller-exit.json"
INTERVAL = 30.0
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

PROBE = r'''
import glob,json,os
def b(path):
    with open(path,"rb") as f: return f.read()
tick=int(os.sysconf("SC_CLK_TCK")); page=int(os.sysconf("SC_PAGE_SIZE"))
out=[]; errors=[]
for path in glob.glob("/proc/[0-9]*/stat"):
    pid=path.split("/")[-2]
    try:
        text=b(path).decode("utf-8","replace")
        close=text.rfind(")"); f=text[close+2:].split()
        argv=b("/proc/"+pid+"/cmdline").split(b"\0")
        arg0=argv[0].decode("utf-8","replace") if argv else ""
        if os.path.basename(arg0).lower() not in ("node","nodejs","node.exe"): continue
        env=b("/proc/"+pid+"/environ").split(b"\0")
        vals={}
        for item in env:
            if item.startswith(b"PAO_ROLE="): vals["role"]=item[9:].decode("utf-8","replace").strip() or None
            elif item.startswith(b"PAO_DEPT="): vals["dept"]=item[9:].decode("utf-8","replace").strip() or None
        pao=False
        for item in argv[1:]:
            script=item.decode("utf-8","replace").replace("\\","/").lower()
            if (script.startswith("/tmp/harbor-pao-source/") and
                    script.endswith(("/dist/cli.js","/dist/bundle/cli.js","/rpc-entry.js"))):
                pao=True
        kind="pao-runtime" if pao else ("task-node" if vals.get("role") else "unknown")
        if pao and vals.get("role") is None: vals["role"]="主控"
        out.append({"pid":int(pid),"ppid":int(f[1]),"start_ticks":int(f[19]),
                    "cpu_ticks":int(f[11])+int(f[12]),"rss":int(f[21])*page,
                    "role":vals.get("role"),"dept":vals.get("dept"),"kind":kind})
    except (FileNotFoundError,ProcessLookupError): pass
    except PermissionError: errors.append({"pid":pid,"error":"permission_denied"})
    except Exception as e: errors.append({"pid":pid,"error":type(e).__name__})
print(json.dumps({"ticks":tick,"processes":out,"errors":errors},separators=(",",":")))
'''

PRECHECK = r'''
marker=absent
if [ -e /tmp/benchmark-prerequisites.json ]; then
    if [ -f /tmp/benchmark-prerequisites.json ] &&
            [ -r /tmp/benchmark-prerequisites.json ] &&
            [ -s /tmp/benchmark-prerequisites.json ]; then
        marker=present
    else
        marker=invalid
    fi
fi
printf 'marker=%s\n' "$marker"
if command -v python3 >/dev/null 2>&1; then
    printf 'python3=present\n'
else
    printf 'python3=absent\n'
fi
'''

MAIN_CONTAINER_SUFFIX = "__env-main-1"
SIZES = re.compile(r"^\s*([\d.]+)\s*([kmgt]?i?b)?\s*/\s*([\d.]+)\s*([kmgt]?i?b)?\s*$", re.I)
UNITS = {"b": 1, "kb": 1000, "mb": 1000**2, "gb": 1000**3, "tb": 1000**4,
         "kib": 1024, "mib": 1024**2, "gib": 1024**3, "tib": 1024**4}


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def run(args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, check=False, creationflags=CREATE_NO_WINDOW)


def error(kind: str, message: str, container: str | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {"kind": kind, "message": " ".join(message.split())[:240]}
    if container:
        item["container"] = container
    return item


def pair(raw: Any) -> tuple[int | None, int | None]:
    if not isinstance(raw, str):
        return None, None
    match = SIZES.fullmatch(raw)
    if not match:
        return None, None
    left, right = float(match.group(1)), float(match.group(3))
    lu = (match.group(2) or "B").lower()
    ru = (match.group(4) or "B").lower()
    if lu not in UNITS or ru not in UNITS:
        return None, None
    return round(left * UNITS[lu]), round(right * UNITS[ru])


def number(raw: Any, suffix: str = "") -> float | None:
    if not isinstance(raw, str) or (suffix and not raw.endswith(suffix)):
        return None
    try:
        value = float(raw[:-len(suffix)] if suffix else raw)
        return value if math.isfinite(value) and value >= 0 else None
    except ValueError:
        return None


def load_scope(run_dir: Path, controller: str) -> list[str]:
    data = json.loads((run_dir / RUNTIME).read_text(encoding="utf-8-sig"))
    names = data.get("containers") if isinstance(data, dict) else None
    if not isinstance(names, list) or not all(isinstance(x, str) and x for x in names):
        raise ValueError("runtime-containers.json 必须包含字符串数组 containers")
    names = sorted(set(names))
    if controller not in names:
        names.insert(0, controller)
    return names


def phase(log: str) -> dict[str, Any]:
    found = None
    for line in log.splitlines():
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(event, dict) and event.get("type") in ("agent_start", "agent_settled"):
            found = event["type"]
    return {"phase": {"agent_start": "model_running", "agent_settled": "model_idle"}.get(found, "unknown"),
            "marker": found}


def is_main_container(container: str) -> bool:
    return container.endswith(MAIN_CONTAINER_SUFFIX)


def check_prerequisites(container: str, timeout: float) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        result = run([DOCKER, "exec", container, "sh", "-c", PRECHECK], timeout)
    except subprocess.TimeoutExpired:
        return ({"probe_status": "failed"},
                [error("prerequisite_check_timeout", f"超过 {timeout:.0f} 秒", container)])
    except OSError as exc:
        return {"probe_status": "failed"}, [error("prerequisite_check_start_failed", str(exc), container)]
    if result.returncode:
        return ({"probe_status": "failed"},
                [error("prerequisite_check_failed", result.stderr or "无错误输出", container)])

    values: dict[str, str] = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"marker", "python3"}:
            values[key] = value.strip()
    if set(values) != {"marker", "python3"}:
        return ({"probe_status": "failed"},
                [error("prerequisite_parse_failed", result.stdout or "无输出", container)])

    info = {"marker": values["marker"], "python3": values["python3"]}
    if values["marker"] not in {"absent", "present"}:
        return ({"probe_status": "failed", "prerequisites": info},
                [error("prerequisite_marker_invalid", "依赖就绪标记为空、不可读或格式无效", container)])
    if values["python3"] not in {"absent", "present"}:
        return ({"probe_status": "failed", "prerequisites": info},
                [error("prerequisite_parse_failed", result.stdout, container)])
    if values["marker"] == "present" and values["python3"] == "absent":
        return ({"probe_status": "failed", "prerequisites": info},
                [error("python3_unavailable", "依赖就绪标记已存在，但容器内找不到 python3", container)])
    if values["marker"] == "absent" and values["python3"] == "absent":
        return {"probe_status": "setup_pending", "prerequisites": info}, []
    return {"probe_status": "ready", "prerequisites": info}, []


def probe(container: str, timeout: float, main: bool) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not main:
        raise ValueError("只有主容器允许进行 Node 进程 probe")
    prerequisite, errors = check_prerequisites(container, timeout)
    if errors or prerequisite.get("probe_status") == "setup_pending":
        return ({"ticks": None, "processes": [], "scan_errors": [], **prerequisite,
                 "phase": {"phase": "unknown", "marker": None}}, errors)

    code = PROBE
    code += r'''
try:
    with open("/logs/agent/pao.txt","rb") as f:
        f.seek(0,2); n=min(f.tell(),65536); f.seek(-n,2) if n else f.seek(0)
        print("__PAO_LOG__"+f.read().decode("utf-8","replace"))
except FileNotFoundError: pass
'''
    try:
        result = run([DOCKER, "exec", container, "python3", "-c", code], timeout)
    except subprocess.TimeoutExpired:
        return {}, [error("exec_timeout", f"超过 {timeout:.0f} 秒", container)]
    except OSError as exc:
        return {}, [error("exec_start_failed", str(exc), container)]
    if result.returncode:
        detail = result.stderr.lower()
        missing = result.returncode in (126, 127) or "python3: not found" in detail or "executable file not found" in detail
        return {}, [error("python3_unavailable" if missing else "exec_failed", result.stderr or "无错误输出", container)]
    stdout, marker, log = result.stdout, "\n__PAO_LOG__", ""
    if marker in stdout:
        stdout, log = stdout.split(marker, 1)
    try:
        data = json.loads(stdout)
        if not isinstance(data, dict) or not isinstance(data.get("processes"), list):
            raise ValueError("进程结果缺少 processes 数组")
    except (json.JSONDecodeError, ValueError) as exc:
        return {}, [error("proc_parse_failed", str(exc), container)]
    procs = []
    process_errors = []
    allowed = {"pid", "ppid", "start_ticks", "cpu_ticks", "rss", "role", "dept", "kind"}
    for item in data["processes"]:
        try:
            clean = {key: item.get(key) for key in allowed}
            for key in ("pid", "ppid", "start_ticks", "cpu_ticks", "rss"):
                clean[key] = int(clean[key])
            if clean["kind"] not in {"pao-runtime", "task-node", "unknown"}:
                raise ValueError("kind 无效")
            procs.append(clean)
        except (TypeError, ValueError) as exc:
            process_errors.append({"pid": item.get("pid") if isinstance(item, dict) else None,
                                   "error": f"invalid_process_record: {exc}"})
    return ({"ticks": int(data.get("ticks")) if data.get("ticks") else None, "processes": procs,
             "scan_errors": [*data.get("errors", []), *process_errors],
             "prerequisites": prerequisite.get("prerequisites"),
             "probe_status": "collected", "phase": phase(log)},
            [])


def stats(names: list[str], timeout: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        result = run([DOCKER, "stats", "--no-stream", "--format", "{{json .}}", *names], timeout)
    except subprocess.TimeoutExpired:
        return [], [error("stats_timeout", f"超过 {timeout:.0f} 秒")]
    except OSError as exc:
        return [], [error("stats_start_failed", str(exc))]
    rows, errors = [], [error("stats_failed", result.stderr)] if result.returncode else []
    for line in result.stdout.splitlines():
        try:
            raw = json.loads(line)
            name = str(raw.get("Name") or "")
            if name not in names:
                continue
            mem, limit = pair(raw.get("MemUsage"))
            rx, tx = pair(raw.get("NetIO"))
            rd, wr = pair(raw.get("BlockIO"))
            pids = int(raw["PIDs"]) if str(raw.get("PIDs", "")).isdigit() else None
            rows.append({"name": name, "id": raw.get("ID") or None,
                         "cpu_percent": number(raw.get("CPUPerc"), "%"), "memory": mem,
                         "memory_limit": limit, "pids": pids, "network_rx": rx,
                         "network_tx": tx, "block_read": rd, "block_write": wr})
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            errors.append(error("stats_parse_failed", str(exc)))
    seen = {row["name"] for row in rows}
    for name in names:
        if name not in seen:
            errors.append(error("container_missing", "本轮没有返回该允许容器", name))
    return rows, errors


def running(timeout: float) -> tuple[set[str], list[dict[str, Any]]]:
    try:
        result = run([DOCKER, "ps", "--format", "{{.Names}}"], timeout)
    except subprocess.TimeoutExpired:
        return set(), [error("ps_timeout", f"超过 {timeout:.0f} 秒")]
    except OSError as exc:
        return set(), [error("ps_start_failed", str(exc))]
    if result.returncode:
        return set(), [error("ps_failed", result.stderr)]
    return set(result.stdout.splitlines()), []


def aggregate(rows: list[dict[str, Any]], prior: dict[str, dict[str, int]],
              elapsed: float | None) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]], list[dict[str, Any]]]:
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    current: dict[str, dict[str, int]] = {}
    errors = []
    for row in rows:
        name = row["name"]; read = row.get("process_read") or {}
        tick = read.get("ticks")
        for proc in read.get("processes", []):
            key = f'{name}:{proc["pid"]}:{proc["start_ticks"]}'
            group_key = (proc.get("kind") or "unknown", proc.get("role") or "未标注角色",
                         proc.get("dept") or "未标注部门")
            groups.setdefault(group_key, []).append(proc)
            current[key] = {"cpu_ticks": proc["cpu_ticks"], "rss": proc["rss"]}
        for issue in read.get("scan_errors", []):
            errors.append(error("proc_scan_failed", str(issue), name))
    result = []
    for key, procs in groups.items():
        matched = []
        for proc in procs:
            name = proc["_container"]
            old = prior.get(f'{name}:{proc["pid"]}:{proc["start_ticks"]}')
            tick = next((x.get("process_read", {}).get("ticks") for x in rows if x["name"] == name), None)
            if old is not None:
                matched.append((proc, old, tick))
        cpu = None
        if matched and elapsed and matched[0][2]:
            cpu = sum((p["cpu_ticks"] - old["cpu_ticks"]) / matched[0][2] / elapsed * 100
                      for p, old, _ in matched)
        result.append({"kind": key[0], "role": key[1], "dept": key[2],
                       "process_count": len(procs), "matched_process_count": len(matched),
                       "rss": sum(p["rss"] for p in procs),
                       "rss_delta": sum(p["rss"] - old["rss"] for p, old, _ in matched) if matched else None,
                       "cpu_percent": cpu})
    return result, current, errors


def summarize(run_dir: Path, controller: str, stop: dict[str, Any]) -> dict[str, Any]:
    records = []
    with (run_dir / SAMPLES).open(encoding="utf-8") as handle:
        for line in handle:
            try:
                item = json.loads(line)
                if isinstance(item, dict): records.append(item)
            except json.JSONDecodeError:
                pass
    samples = [x for x in records if x.get("record") == "sample"]
    containers: dict[str, list[dict[str, Any]]] = {}
    roles: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    errors = []
    for sample in samples:
        errors.extend(sample.get("errors", []))
        for row in sample.get("containers", []): containers.setdefault(row["name"], []).append(row)
        for row in sample.get("roles", []): roles.setdefault((row["kind"], row["role"], row["dept"]), []).append(row)
    def metrics(rows: list[dict[str, Any]], field: str) -> tuple[Any, Any, Any]:
        values = [x[field] for x in rows if x.get(field) is not None]
        return (values[0], values[-1], max(values)) if values else (None, None, None)
    container_list = []
    for name, rows in sorted(containers.items()):
        first, last, peak = metrics(rows, "memory")
        cpu = [x["cpu_percent"] for x in rows if x.get("cpu_percent") is not None]
        probe_statuses: dict[str, int] = {}
        for row in rows:
            status = (row.get("process_read") or {}).get("probe_status")
            if status:
                probe_statuses[status] = probe_statuses.get(status, 0) + 1
        container_list.append({"name": name, "id": next((x.get("id") for x in rows if x.get("id")), None),
            "sample_count": len(rows), "cpu_median_percent": statistics.median(cpu) if cpu else None,
            "cpu_peak_percent": max(cpu) if cpu else None, "memory_first": first,
            "memory_last": last, "memory_peak": peak,
            "probe_status_counts": probe_statuses})
    role_list = []
    for (kind, role, dept), rows in sorted(roles.items()):
        first, last, peak = metrics(rows, "rss")
        cpu = [x["cpu_percent"] for x in rows if x.get("cpu_percent") is not None]
        role_list.append({"kind": kind, "role": role, "dept": dept, "sample_count": len(rows),
            "process_peak": max(x["process_count"] for x in rows),
            "cpu_median_percent": statistics.median(cpu) if cpu else None,
            "cpu_peak_percent": max(cpu) if cpu else None, "rss_first": first, "rss_last": last,
            "rss_peak": peak})
    summary = {"controller": controller, "samples": len(samples), "stop": stop,
               "containers": container_list, "roles": role_list,
               "error_count": len(errors), "errors": errors,
               "limits": "少数 CPU 采样不能证明空闲或“屎山”；PAO 与题目 node 分开归因。"}
    (run_dir / SUMMARY).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# PAO 运行性能摘要", "", f"- 控制器：`{controller}`", f"- 有效样本：{len(samples)}",
             f"- 停止原因：{stop.get('reason')}", "", "## 容器"]
    for x in container_list:
        lines.append(f"- `{x['name']}`：样本 {x['sample_count']}，CPU 峰值 {fmt(x['cpu_peak_percent'], '%')}，内存峰值 {fmt_bytes(x['memory_peak'])}")
        if x["probe_status_counts"]:
            statuses = "，".join(f"{key} {value} 次" for key, value in sorted(x["probe_status_counts"].items()))
            lines.append(f"  - 进程探测：{statuses}")
    lines += ["", "## 按 Node 类型、角色和部门"]
    for x in role_list:
        lines.append(f"- {x['kind']} / {x['role']} / {x['dept']}：CPU 峰值 {fmt(x['cpu_peak_percent'], '%')}，RSS 首末峰 {fmt_bytes(x['rss_first'])} / {fmt_bytes(x['rss_last'])} / {fmt_bytes(x['rss_peak'])}")
    lines += ["", "## 缺失与限制", f"- 错误记录：{len(errors)} 条。",
              "- 首次 CPU 差值和缺权限读取保持不可用，不填 0。",
              "- 题目构建器、任务服务的 node 与 PAO runtime 分开列示。",
              "- 少数 CPU 采样不能据此断言角色空闲，更不能单独判定“屎山”。", ""]
    (run_dir / REPORT).write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return summary


def fmt(value: Any, suffix: str = "") -> str:
    return "不可用" if value is None else f"{value:.2f}{suffix}"


def fmt_bytes(value: Any) -> str:
    return "不可用" if value is None else f"{value} B"


def main() -> int:
    parser = argparse.ArgumentParser(description="低频采样本轮 PAO 与任务容器资源")
    parser.add_argument("--run-dir", required=True); parser.add_argument("--controller-name", required=True)
    parser.add_argument("--interval", type=float, default=INTERVAL)
    args = parser.parse_args()
    run_dir = Path(args.run_dir).resolve()
    if not Path(args.run_dir).is_absolute() or not run_dir.is_dir(): parser.error("--run-dir 必须是已存在的绝对目录")
    if not math.isfinite(args.interval) or args.interval <= 0: parser.error("--interval 必须大于 0")
    ticking = {"stop": False}
    def stop_handler(*_: Any) -> None: ticking["stop"] = True
    try: signal.signal(signal.SIGTERM, stop_handler)
    except (AttributeError, ValueError): pass
    prior: dict[str, dict[str, int]] = {}; before: dt.datetime | None = None; seq = 0
    with (run_dir / SAMPLES).open("a", encoding="utf-8", newline="\n") as out:
        while not (run_dir / EXIT).exists() and not (run_dir / 'monitor-stop.json').exists() and not ticking["stop"]:
            started = time.monotonic()
            errors = []
            try: names = load_scope(run_dir, args.controller_name)
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                errors.append(error("scope_failed", str(exc))); names = []
            active, errs = running(min(20, args.interval)) if names else (set(), [])
            errors += errs
            rows, errs = stats([x for x in names if x in active], min(20, args.interval)) if active else ([], [])
            errors += errs
            byte_rows = []
            for row in rows:
                current = dict(row)
                if row["name"] != args.controller_name and is_main_container(row["name"]):
                    read, errs = probe(row["name"], min(10, args.interval / 3), True)
                    current["process_read"] = read; errors += errs
                    for proc in read.get("processes", []): proc["_container"] = row["name"]
                byte_rows.append(current)
            sampled = dt.datetime.now(dt.timezone.utc)
            elapsed = (sampled - before).total_seconds() if before else None
            roles, current, role_errors = aggregate(byte_rows, prior, elapsed)
            errors += role_errors
            for role in roles:
                role["phase"] = next((r["process_read"]["phase"] for r in byte_rows
                                      if is_main_container(r["name"]) and r.get("process_read")),
                                     {"phase": "unknown", "marker": None})
            prior = current; before = sampled; seq += 1
            record = {"record": "sample", "seq": seq, "at_utc": sampled.isoformat(timespec="seconds").replace("+00:00", "Z"),
                      "elapsed_seconds": elapsed, "containers": byte_rows, "roles": roles, "errors": errors}
            out.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"); out.flush()
            if any(errs for errs in errors):
                for item in errors:
                    out.write(json.dumps({"record": "error", "at_utc": now(), **item}, ensure_ascii=False) + "\n")
                out.flush()
            time.sleep(max(0, args.interval - (time.monotonic() - started)))
        stop = {"reason": "controller_exit" if (run_dir / EXIT).exists() else "monitoring_interrupted" if (run_dir / 'monitor-stop.json').exists() else "external_signal"}
    summarize(run_dir, args.controller_name, stop)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
