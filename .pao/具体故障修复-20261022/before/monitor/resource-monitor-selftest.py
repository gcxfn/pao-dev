#!/usr/bin/env python3
"""离线假 Docker 自测；不启动 Docker、不调用模型、不访问真实运行目录。"""
from __future__ import annotations

import importlib.util
import datetime as dt
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("monitor", HERE / "resource-monitor.py")
assert spec and spec.loader
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def main() -> int:
    with tempfile.TemporaryDirectory(dir=HERE) as temp:
        run = Path(temp)
        (run / monitor.RUNTIME).write_text(json.dumps({"containers": [
            "controller-test", "trial__env-main-1", "trial__env-verifier-1"]}))
        calls = {"stats": 0, "precheck": 0, "probe": 0}
        exec_containers: set[str] = set()
        process = {"ticks": 100, "processes": [{
            "pid": 10, "ppid": 1, "start_ticks": 20, "cpu_ticks": 30,
            "rss": 1000, "role": "worker", "dept": "内核", "kind": "pao-runtime"}],
            "errors": []}

        def fake(args, timeout):
            if args[0] != monitor.DOCKER:
                raise AssertionError(args)
            if args[1] == "ps":
                return SimpleNamespace(returncode=0, stdout="\n".join(
                    json.loads((run / monitor.RUNTIME).read_text())["containers"]), stderr="")
            if args[1:3] == ["stats", "--no-stream"]:
                calls["stats"] += 1
                rows = [{"Name": name, "ID": f"00000000000{calls['stats']}",
                         "CPUPerc": "1.5%", "MemUsage": "10MiB / 1GiB",
                         "PIDs": "2", "NetIO": "1kB / 2kB", "BlockIO": "3kB / 4kB"}
                        for name in json.loads((run / monitor.RUNTIME).read_text())["containers"]]
                return SimpleNamespace(returncode=0, stdout="\n".join(map(json.dumps, rows)), stderr="")
            if args[1] == "exec":
                exec_containers.add(args[2])
                if args[2] != "trial__env-main-1":
                    raise AssertionError(f"sidecar 不应执行 probe: {args}")
                if args[3:] == ["sh", "-c", monitor.PRECHECK]:
                    calls["precheck"] += 1
                    if calls["precheck"] == 1:
                        stdout = "marker=absent\npython3=absent\n"
                    elif calls["precheck"] == 2:
                        stdout = "marker=present\npython3=absent\n"
                    else:
                        stdout = "marker=present\npython3=present\n"
                    return SimpleNamespace(returncode=0, stdout=stdout, stderr="")
                if args[3:5] != ["python3", "-c"]:
                    raise AssertionError(args)
                calls["probe"] += 1
                stdout = json.dumps({**process, "processes": [
                    {"pid": 10, "ppid": 1, "start_ticks": 20, "cpu_ticks": 30 + calls["probe"] * 10,
                     "rss": 1000 + calls["probe"] * 100, "role": "worker", "dept": "内核",
                     "kind": "pao-runtime"},
                    {"pid": 11, "ppid": 1, "start_ticks": 21, "cpu_ticks": 5,
                     "rss": 500, "role": "worker", "dept": "内核", "kind": "task-node"}]})
                if args[2].endswith("__env-main-1"):
                    stdout += '\n__PAO_LOG__{"type":"message","text":"agent_start"}\n{"type":"agent_settled"}\n{"type":"background_work","counts":0}'
                return SimpleNamespace(returncode=0, stdout=stdout, stderr="")
            raise AssertionError(args)

        original_run, original_sleep = monitor.run, monitor.time.sleep
        monitor.run = fake
        monitor.time.sleep = lambda _seconds: None
        exit_path = run / monitor.EXIT
        def token(delta=0):
            return None
        try:
            # 四次采样后写终止文件，测试不依赖真实时钟。
            old_stats = monitor.stats
            real_datetime = monitor.dt.datetime
            clock = [0.0]

            class FakeDatetime(dt.datetime):
                @classmethod
                def now(cls, timezone=None):
                    value = real_datetime(2026, 10, 22, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=clock[0])
                    return value.astimezone(timezone) if timezone else value

            def stats(names, timeout):
                result = old_stats(names, timeout)
                clock[0] += 2.0
                if calls["stats"] == 4: exit_path.write_text("{\"exitCode\":0}")
                return result
            monitor.stats = stats
            monitor.dt.datetime = FakeDatetime
            monitor.main_value = None
            import sys
            sys.argv = ["resource-monitor.py", "--run-dir", str(run),
                        "--controller-name", "controller-test", "--interval", "0.01"]
            assert monitor.main() == 0
            samples = [json.loads(x) for x in
                       (run / monitor.SAMPLES).read_text(encoding="utf-8").splitlines()]
            sample_records = [x for x in samples if x["record"] == "sample"]
            pending, missing, _, sample = sample_records
            pending_main = next(
                row for row in pending["containers"] if row["name"] == "trial__env-main-1")
            assert pending_main["process_read"]["probe_status"] == "setup_pending"
            assert pending_main["process_read"]["ticks"] is None
            assert pending_main["process_read"]["processes"] == []
            assert pending_main["process_read"]["phase"]["phase"] == "unknown"
            assert pending["errors"] == []

            missing_main = next(
                row for row in missing["containers"] if row["name"] == "trial__env-main-1")
            assert missing_main["process_read"]["probe_status"] == "failed"
            assert any(x["kind"] == "python3_unavailable" for x in missing["errors"])

            roles = {(x["kind"], x["role"]): x for x in sample["roles"]}
            assert roles[("pao-runtime", "worker")]["cpu_percent"] > 0
            main_container = next(
                row for row in sample["containers"] if row["name"] == "trial__env-main-1"
            )
            sidecar = next(
                row for row in sample["containers"] if row["name"] == "trial__env-verifier-1")
            assert main_container["process_read"]["phase"]["phase"] == "model_idle"
            assert main_container["process_read"]["probe_status"] == "collected"
            assert "process_read" not in sidecar
            assert exec_containers == {"trial__env-main-1"}
            assert (run / monitor.SUMMARY).exists() and (run / monitor.REPORT).exists()
            assert "agent_start" not in json.dumps(monitor.phase('{"type":"message","text":"agent_start"}'))
        finally:
            monitor.run, monitor.time.sleep = original_run, original_sleep
            monitor.dt.datetime = real_datetime
        print(json.dumps({"ok": True, "docker_calls": calls, "exec_containers": sorted(exec_containers),
                          "deliverables": [monitor.SAMPLES, monitor.SUMMARY, monitor.REPORT]},
                         ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
