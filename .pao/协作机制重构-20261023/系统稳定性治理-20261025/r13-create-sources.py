"""用途：为r13离线准备生成显式来源清单与只读摘要台账。

输入：当前PAO源码、benchmark开发入口、SDK宿主、r12配置及冻结件。
输出：r13-sources.json、r13-source-ledger.json。
边界：不启动Docker、模型或评分；不读取原题测试内容。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path("D:/AI/workspace/pao-dev")
BENCH = ROOT / ".pao/地图简报与部门协作-20261020/benchmark"
SDK = ROOT / ".pao/协作机制重构-20261023/benchmark-sdk-host"
EVIDENCE = ROOT / ".pao/协作机制重构-20261023/系统稳定性治理-20261025"
RUN = BENCH / "real-run-20261025-prepared-r13"
TASK = (
    ROOT
    / ".pao/协作机制重构-20261023/安装预检缓存/tasks/"
    "packages/terminal-bench/html-js-filter/"
    "f211960f1f7c66ace91c3d079db073ed0f841d458db4cad1f2f943cba6cc79f3"
)
TASK_MANIFEST = ROOT / ".pao/协作机制重构-20261023/安装预检缓存来源.json"
R12 = BENCH / "real-run-20261024-prepared-r12"
HARBOR_CACHE = Path(
    "D:/AI/workspace/临时文件夹/地图简报基准-20261020/"
    "controller-home/.cache/harbor"
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def record(path: Path) -> dict:
    path = path.resolve()
    return {
        "path": str(path),
        "sha256": digest(path),
        "bytes": path.stat().st_size,
    }


def main() -> None:
    required = (ROOT / "PAO", BENCH, SDK, TASK, TASK_MANIFEST, R12, HARBOR_CACHE)
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError("来源不存在：" + ", ".join(missing))
    if RUN.exists():
        raise FileExistsError("r13目标已存在，禁止覆盖")

    config_source = R12 / "run-config.json"
    metadata = BENCH / "model-metadata.json"
    model_data = BENCH / "build-data-freeze-20261021/model-data.zip"
    node = R12 / "node-v24.18.0-linux-x64.tar.xz"
    dependencies = R12 / "git-system-dependencies.zip"
    for path in (config_source, metadata, model_data, node, dependencies):
        if not path.is_file():
            raise FileNotFoundError(path)

    task_files = {
        path.relative_to(TASK).as_posix(): digest(path)
        for path in TASK.rglob("*")
        if path.is_file()
    }
    task_manifest = json.loads(TASK_MANIFEST.read_text(encoding="utf-8"))
    listed_files = {
        item["path"]: item["sha256"] for item in task_manifest["files"]
    }
    if task_files != listed_files:
        raise ValueError("原题文件集合或摘要与只读来源清单不一致")

    pao_head = subprocess.check_output(
        ["git", "-C", str(ROOT / "PAO"), "rev-parse", "HEAD"],
        text=True,
        encoding="utf-8",
    ).strip()
    sdk_names = (
        "benchmark-child-entry.mjs",
        "benchmark-host-factories.mjs",
        "benchmark-organized-entry.mjs",
        "benchmark-worktree-host.mjs",
        "probe-child-rpc.mjs",
        "benchmark-organized-adapter.py",
        "activate-tools.mjs",
    )
    sources = {
        "run_parent": str(BENCH.resolve()),
        "run_dir": str(RUN.resolve()),
        "pao_source": str((ROOT / "PAO").resolve()),
        "benchmark_source": str(BENCH.resolve()),
        "sdk_host_source": str(SDK.resolve()),
        "task_source": str(TASK.resolve()),
        "task_source_manifest": str(TASK_MANIFEST.resolve()),
        "model_data_archive": str(model_data.resolve()),
        "model_data_sha256": digest(model_data),
        "node_archive": str(node.resolve()),
        "node_sha256": digest(node),
        "system_dependencies_archive": str(dependencies.resolve()),
        "system_dependencies_sha256": digest(dependencies),
        "model_metadata_path": str(metadata.resolve()),
        "model_metadata_sha256": digest(metadata),
        "config_source": str(config_source.resolve()),
        "config_source_sha256": digest(config_source),
        "container_mounts": {
            "local_root": str(ROOT.resolve()),
            "container_root": "/run/desktop/mnt/host/d/AI/workspace/pao-dev",
        },
        "harbor_cache": str(HARBOR_CACHE.resolve()),
        "job_name": "pao-refactor-first-approved-20261025-r13",
        "task_name": "terminal-bench/html-js-filter",
        "model_name": "openai/minimax-code/MiniMax-M3.1-Flash",
        "model_base_url": "http://host.docker.internal:3425",
        "thinking": "high",
        "controller_name": "pao-refactor-first-approved-20261025-r13",
        "authorization": (
            "主控已批准集中治理运行器工作包H；仅新建r13离线准备目录，"
            "不启动Docker、模型或评分"
        ),
    }
    ledger = {
        "at": "2026-10-25",
        "run_dir": str(RUN.resolve()),
        "run_was_absent_before_prepare": True,
        "pao_git_head": pao_head,
        "pao_source": str((ROOT / "PAO").resolve()),
        "benchmark_source": str(BENCH.resolve()),
        "sdk_host_source": str(SDK.resolve()),
        "sdk_files": [
            {"name": name, **record(SDK / name)} for name in sdk_names
        ],
        "task_source": str(TASK.resolve()),
        "task_files": [
            {"path": path, "sha256": task_files[path]}
            for path in sorted(task_files)
        ],
        "task_source_manifest_sha256": digest(TASK_MANIFEST),
        "sources": {
            "config_source": record(config_source),
            "task_source_manifest": record(TASK_MANIFEST),
            "model_metadata_path": record(metadata),
            "model_data_archive": record(model_data),
            "node_archive": record(node),
            "system_dependencies_archive": record(dependencies),
            "harbor_cache": {
                "path": str(HARBOR_CACHE.resolve()),
                "kind": "directory",
            },
        },
        "model_name": sources["model_name"],
        "runtime_model_name": "harbor-endpoint/minimax-code/MiniMax-M3.1-Flash",
        "thinking": sources["thinking"],
        "job_name": sources["job_name"],
        "controller_name": sources["controller_name"],
        "automatic_retries": 0,
        "docker_calls": 0,
        "model_calls": 0,
        "notes": [
            "r12 run-config 仅作为明确配置来源，不是隐式载入历史运行",
            "原题只枚举文件名并计算摘要，未读取测试内容",
        ],
    }

    EVIDENCE.mkdir(parents=True, exist_ok=True)
    source_path = EVIDENCE / "r13-sources.json"
    ledger_path = EVIDENCE / "r13-source-ledger.json"
    for path in (source_path, ledger_path):
        if path.exists():
            raise FileExistsError("证据文件已存在，禁止覆盖：" + str(path))
    source_path.write_text(
        json.dumps(sources, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    ledger_path.write_text(
        json.dumps(ledger, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "source_manifest": str(source_path),
                "source_manifest_sha256": digest(source_path),
                "ledger": str(ledger_path),
                "ledger_sha256": digest(ledger_path),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
