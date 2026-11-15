#!/usr/bin/env python3
"""用途：用本地现有 Docker 镜像真实验证资源监控的 Node 身份识别。
输入：同目录 resource-monitor.py、本地镜像 harborframework/terminal-bench:<none>。
输出：.pao/具体故障修复-20261022/F-real-probe.json；临时容器和目录结束后删除。
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
PROJECT = Path(r"D:\AI\workspace\pao-dev")
OUTPUT = PROJECT / ".pao" / "具体故障修复-20261022" / "F-real-probe.json"
DOCKER = Path(r"D:\Docker\resources\bin\docker.exe")
IMAGE_ID = "9779ef143cc8"


def docker(*args: str, timeout: float = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(DOCKER), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def main() -> int:
    spec = importlib.util.spec_from_file_location("monitor", HERE / "resource-monitor.py")
    assert spec and spec.loader
    monitor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(monitor)

    container = f"pao-f-monitor-{uuid.uuid4().hex[:10]}__env-main-1"
    result: dict[str, object] = {
        "status": "failed",
        "image_id": IMAGE_ID,
        "container": container,
        "commands": [],
        "assertions": {},
        "cleanup": {},
    }
    with tempfile.TemporaryDirectory(dir=HERE) as raw:
        temp = Path(raw)
        bundle = temp / "packages" / "coding-agent" / "dist" / "bundle"
        bundle.mkdir(parents=True)
        rpc = bundle / "rpc-entry.js"
        cli = bundle / "cli.js"
        task = temp / "task.js"
        title_only = temp / "title-only.js"
        rpc.write_text(
            'setInterval(() => {}, 1000);\n',
            encoding="utf-8",
        )
        cli.write_text(
            'setInterval(() => {}, 1000);\n',
            encoding="utf-8",
        )
        task.write_text(
            'setInterval(() => {}, 1000);\n',
            encoding="utf-8",
        )
        title_only.write_text(
            'setTimeout(() => { process.title = "pao"; }, 0);\n'
            'setInterval(() => {}, 1000);\n',
            encoding="utf-8",
        )
        (temp / "process-title.cjs").write_text(
            'const entry = (process.argv[1] || "").replaceAll("\\\\", "/");\n'
            'const base = "/tmp/harbor-pao-source/packages/coding-agent/dist/bundle/";\n'
            'if (entry === `${base}rpc-entry.js`) setTimeout(() => { process.title = "pao-rpc"; }, 0);\n'
            'else if (entry === `${base}cli.js`) setTimeout(() => { process.title = "pao"; }, 0);\n',
            encoding="utf-8",
        )
        (temp / "benchmark-prerequisites.json").write_text("{}\n", encoding="utf-8")

        created = False
        failure: Exception | None = None
        try:
            command = [
                "run", "--detach", "--name", container,
                "--volume", f"{bundle}:/tmp/harbor-pao-source/packages/coding-agent/dist/bundle:ro",
                "--volume", f"{temp}:/tmp/f-monitor:ro",
                "--env", "NODE_OPTIONS=--require=/tmp/f-monitor/process-title.cjs",
                "--env", "PAO_ROLE=部长",
                "--env", "PAO_DEPT=实施",
                "--env", "PI_CODING_AGENT=true",
                "--entrypoint", "sh",
                IMAGE_ID,
                "-lc",
                "cp /tmp/f-monitor/benchmark-prerequisites.json /tmp/benchmark-prerequisites.json; "
                "mkdir -p /tmp/harbor-pao-source/packages/coding-agent/dist/bundle; "
                "PAO_ROLE=worker node /tmp/f-monitor/task.js & "
                "env -u PI_CODING_AGENT node /tmp/f-monitor/title-only.js & "
                "PAO_ROLE=worker PAO_DEPT=内核 "
                "node /tmp/harbor-pao-source/packages/coding-agent/dist/bundle/cli.js & "
                "exec node /tmp/harbor-pao-source/packages/coding-agent/dist/bundle/rpc-entry.js",
            ]
            result["commands"].append(["docker", *command])
            run = docker(*command)
            if run.returncode:
                raise RuntimeError(run.stderr or run.stdout or "docker run 失败")
            created = True

            read, errors = monitor.probe(container, 15, True)
            result["probe"] = read
            result["errors"] = errors
            processes = read.get("processes", [])
            pao = [x for x in processes if x.get("kind") == "pao-runtime"]
            nodes = [x for x in processes if x.get("kind") == "task-node"]
            rpc_processes = [x for x in pao if x.get("identity") == "pao-rpc"]
            cli_processes = [x for x in pao if x.get("identity") == "pao-cli"]
            task_processes = [x for x in nodes if x.get("title") == "node"]
            title_only_processes = [x for x in nodes if x.get("title") == "pao"]
            assertions = {
                "probe_collected": read.get("probe_status") == "collected",
                "pao_runtime_count": len(pao) == 2,
                "rpc_identified": len(rpc_processes) == 1,
                "rpc_role": bool(
                    rpc_processes and rpc_processes[0].get("role") == "部长"
                    and rpc_processes[0].get("dept") == "实施"
                ),
                "cli_identified": len(cli_processes) == 1,
                "cli_role": bool(
                    cli_processes and cli_processes[0].get("role") == "worker"
                    and cli_processes[0].get("dept") == "内核"
                ),
                "task_node_count": len(nodes) == 2,
                "ordinary_task_kept_argv0": len(task_processes) == 1,
                "ordinary_task_role_ignored": bool(
                    task_processes
                    and task_processes[0].get("role") is None
                    and task_processes[0].get("inherited_role_ignored") is True
                    and task_processes[0].get("agent_env") is True
                ),
                "title_only_not_pao": len(title_only_processes) == 1,
                "title_only_no_agent_marker": bool(
                    title_only_processes
                    and title_only_processes[0].get("role") is None
                    and title_only_processes[0].get("inherited_role_ignored") is True
                    and title_only_processes[0].get("agent_env") is False
                ),
                "phase_unknown": read.get("phase", {}).get("category") == "unknown",
                "no_probe_errors": not errors,
            }
            result["assertions"] = assertions
            if not all(assertions.values()):
                raise AssertionError(f"真实探针断言失败：{assertions}")
            result["status"] = "passed"
        except Exception as exc:
            failure = exc
            result["failure"] = f"{type(exc).__name__}: {exc}"
        finally:
            if created:
                removed = docker("rm", "-f", container)
                result["cleanup"]["container_remove_returncode"] = removed.returncode
                result["cleanup"]["container_remove_stderr"] = removed.stderr.strip()
            leftover = docker(
                "ps", "-a", "--filter", f"name={container}", "--format", "{{.Names}}"
            )
            result["cleanup"]["container_left"] = [
                x for x in leftover.stdout.splitlines() if x
            ]
            result["cleanup"]["temp_dir_removed_by_context"] = True

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(json.dumps({
        "status": result["status"],
        "assertions": result["assertions"],
        "cleanup": result["cleanup"],
        "output": str(OUTPUT),
    }, ensure_ascii=False))
    if failure:
        print(f"失败：{failure}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
