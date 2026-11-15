"""用途：串行运行冻结的 Harbor 实验、暂停和独立评分；不编排产品任务。

输入：新运行目录中的 run-config.json、run-freeze.json，以及冻结的适配器。
输出：control-status.json、control-request.json、每题原版 Harbor 结果和评分原件。
冻结运行不可复用；不自动重试、恢复或替换实验。运行需要原 Linux Harbor 环境。
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tomllib
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, data):
    path = Path(path)
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pending.replace(path)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inside(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"冻结文件越过运行目录：{relative}")
    return path


def validate(run):
    config = read(run / "run-config.json")
    freeze = read(run / "run-freeze.json")
    files = freeze["files"]
    required = {"run-config.json", "preparation_agent.py", "map_bench_pao_organized.py",
                "map_bench_pao/__init__.py", "map_bench_pao/pao_agent.py", "map_bench_pao/usage.py"}
    if not required.issubset({item["path"] for item in files}):
        raise ValueError("冻结清单必须包含 run-config.json、准备代理和完整模型适配器")
    for item in files:
        if digest(inside(run, item["path"])) != item["sha256"]:
            raise ValueError("冻结输入已改变：" + item["path"])
    if (config["n_attempts"] != 1 or config["retry"]["max_retries"] != 0
            or config["n_concurrent_trials"] != 1):
        raise ValueError("本控制器仅接受各题一次、串行、零自动重试")
    names = [task["name"] for task in config["tasks"]]
    if not names or len(set(names)) != len(names):
        raise ValueError("题目列表为空或重复")
    if len(config["agents"]) != 1 or config["agents"][0]["import_path"] != "map_bench_pao_organized:OrganizedPAOAgent":
        raise ValueError("本控制器仅运行冻结的 OrganizedPAOAgent，不替换实验方式")
    if config["verifier"].get("disable"):
        raise ValueError("正式运行不能关闭原版评分")
    environment = config["environment"]
    if environment["type"] != "docker" or not environment.get("kwargs", {}).get("keep_containers"):
        raise ValueError("暂停后评分需要 environment.type=docker 且 kwargs.keep_containers=true；冻结前显式设置")
    jobs = Path(config["jobs_dir"])
    if not jobs.is_absolute() or not jobs.resolve().is_relative_to(run):
        raise ValueError("jobs_dir 必须位于新运行目录内")
    return config


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
    write(run / "control-status.json", {"at": now(), "state": value, "pid": os.getpid(),
          "auto_resume": False, **detail})


def classify_result(result):
    rows = result["trial_results"]
    if len(rows) != 1 or any(row.get("exception_info") for row in rows):
        return "execution_error"
    if any(not (row.get("verifier_result") or {}).get("rewards") for row in rows):
        return "missing_score"
    return "finished"


async def run_sequence(run, config, execute):
    """execute 接收原版 JobConfig 字典；可注入离线夹具验证控制语义。"""
    # 独占启动标记不删除：崩溃或暂停后也不能自动重放。
    with (run / "control-started.json").open("x", encoding="utf-8") as stream:
        json.dump({"at": now(), "pid": os.getpid()}, stream)
    current = None
    results = []
    try:
        if request(run):
            state(run, "paused", completed=results, writers_stopped=True)
            return
        state(run, "preflight", model_execution_started=False)
        preparation = copy.deepcopy(config)
        preparation["job_name"] += "-preflight"
        preparation["agents"][0]["import_path"] = "preparation_agent:PreparationOnlyAgent"
        preparation["verifier"]["disable"] = True
        # 预检也接受立即暂停；当前题后暂停将在模型开始前生效。
        current = asyncio.create_task(execute(preparation))
        while not current.done():
            if request(run) == "immediate":
                current.cancel()
                try:
                    await current
                except asyncio.CancelledError:
                    pass
                state(run, "paused", completed=results, writers_stopped=True)
                return
            await asyncio.sleep(0.2)
        prepared = await current
        write(run / "preflight-summary.json", prepared)
        if len(prepared["trial_results"]) != len(config["tasks"]) or any(
                row.get("exception_info") for row in prepared["trial_results"]):
            raise RuntimeError("环境预检失败；未启动正式模型")
        for index, task in enumerate(config["tasks"]):
            if request(run):
                state(run, "paused", completed=results, writers_stopped=True)
                return
            derived = copy.deepcopy(config)
            derived["tasks"] = [task]
            derived["job_name"] += f"-task-{index + 1}"
            # 只拆实验调度，不改变题目、模型、权限或正式评分配置。
            write(run / f"task-{index + 1}-config.json", derived)
            state(run, "running", task=task["name"], completed=results)
            current = asyncio.create_task(execute(derived))
            while not current.done():
                if request(run) == "immediate":
                    current.cancel()
                    try:
                        await current  # Harbor 取消会等待 trial 的恢复、收尾与环境清理。
                    except asyncio.CancelledError:
                        pass
                    state(run, "paused", task=task["name"], completed=results, writers_stopped=True)
                    return
                await asyncio.sleep(0.2)
            result = await current
            write(run / f"task-{index + 1}-summary.json", result)
            outcome = classify_result(result)
            results.append({"task": task["name"], "state": outcome, "source": f"task-{index + 1}-summary.json"})
            if outcome != "finished":
                state(run, outcome, completed=results, writers_stopped=True)
                return
        state(run, "finished", completed=results, writers_stopped=True)
    except BaseException as error:
        # 中断时不声称进程已经停止；真实 Harbor 清理失败同样暴露。
        if current is not None and not current.done():
            current.cancel()
            try:
                await current
            except asyncio.CancelledError:
                pass
            except Exception as cleanup_error:
                state(run, "stop_unconfirmed", error=repr(error), cleanup_error=repr(cleanup_error))
                raise
        state(run, "failed", error=repr(error), completed=results, writers_stopped=False)
        raise


async def harbor_execute(config):
    from harbor.job import Job
    from harbor.models.job.config import JobConfig
    job = await Job.create(JobConfig.model_validate(config))
    try:
        result = await job.run()
    finally:
        # Harbor 的环境停止会记录并吞掉部分 Docker 异常，须另外核查本 job 的容器。
        directory = Path(config["jobs_dir"]) / config["job_name"]
        trials = [p.name.lower() for p in directory.iterdir() if p.is_dir() and (p / "config.json").exists()]
        rows = subprocess.check_output(["docker", "ps", "--format", "{{.Label \"com.docker.compose.project\"}}"], text=True, timeout=30).splitlines()
        active = [row for row in rows if any(row.startswith(name + "__env") or row.startswith(name + "__verifier") for name in trials)]
        if active:
            raise RuntimeError("Harbor 收尾后仍有本轮活动容器；停止未确认：" + ", ".join(active))
    if config["agents"][0].get("import_path") == "preparation_agent:PreparationOnlyAgent":
        directory = Path(config["jobs_dir"]) / config["job_name"]
        evidence = list(directory.glob("*/agent/preparation-complete.txt"))
        if len(evidence) != len(config["tasks"]):
            raise RuntimeError("预检缺少实际 preparation-complete.txt 证据，不启动模型")
    return result.model_dump(mode="json")


def score_current(run, spec_path, docker):
    status = read(run / "control-status.json")
    if status["state"] not in {"paused", "finished", "execution_error", "missing_score"} or not status.get("writers_stopped"):
        raise RuntimeError("先暂停并确认本轮写入已停止；不对活动现场评分")
    spec = read(spec_path)
    kind = "completed_artifact_rescore" if status["state"] == "finished" else "interrupted_artifact_score"
    def command(*args, timeout=60):
        return subprocess.check_output([docker, *args], timeout=timeout, text=True, encoding="utf-8",
              **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {})).strip()
    source = spec["source_container"]
    if read_container_state(command, source):
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
    try:
        snapshots = []
        for index, artifact in enumerate(spec["artifacts"]):
            target = PurePosixPath(artifact["target"])
            if not target.is_absolute() or ".." in target.parts or not str(target).startswith("/app/"):
                raise ValueError("评分产物只允许 /app/ 内明确文件")
            local = out / f"artifact-{index}"
            command("cp", f"{source}:{target}", str(local))
            snapshots.append({"target": str(target), "local": str(local), "sha256": digest(local)})
        if not snapshots:
            raise ValueError("没有待评分成果")
        if read_container_state(command, source):
            raise RuntimeError("复制期间成果容器重新启动；不评分")
        write(out / "scoring-inputs.json", {"at": now(), "kind": kind,
              "model_calls": 0, "source": source, "image": image, "files": spec["files"], "artifacts": snapshots})
        command("create", "--name", name, "--restart=no", "--cpus=2", "--memory=8g", "--mount",
                f"type=bind,source={logs.as_posix()},target=/logs/verifier", "--workdir", "/app", image, "bash", "/tests/test.sh")
        created = True
        for item in snapshots:
            command("cp", item["local"], f"{name}:{item['target']}")
        # 合并 tests 内容，保留镜像原有数据；不以整个目录挂载遮住内置素材。
        for path in sorted((task / "tests").iterdir()):
            command("cp", str(path), f"{name}:/tests/{path.name}")
        with (out / "test-output.log").open("xb") as log:
            completed = subprocess.run([docker, "start", "-a", name], stdout=log, stderr=subprocess.STDOUT,
                    timeout=cfg["verifier"]["timeout_sec"] + 60,
                    **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
        reward = float((logs / "reward.txt").read_text().strip())
        if not math.isfinite(reward):
            raise ValueError("评分奖励不是有限数值")
        result = {"at": now(), "state": "scored", "kind": kind,
                  "reward": reward, "test_exit_code": completed.returncode, "model_calls": 0}
        write(out / "result.json", result)
        return result
    except BaseException as error:
        write(out / "result.json", {"at": now(), "state": "scoring_invalid", "error": repr(error), "model_calls": 0})
        raise
    finally:
        # 只停止本次新建的评分容器，不删除历史或其他容器。
        if created:
            found = command("ps", "-q", "--filter", f"name=^/{name}$")
            if found:
                command("stop", "--time", "10", name, timeout=30)


def read_container_state(command, name):
    return json.loads(command("inspect", "--format", "{{json .State.Running}}", name))


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
        print(json.dumps({"observation": "最后落盘状态；不是进程存活探测，活动状态陈旧时须人工核查",
                          **read(run / "control-status.json")}, ensure_ascii=False, indent=2))
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
            asyncio.run(run_sequence(run, config, harbor_execute))


if __name__ == "__main__":
    main()
