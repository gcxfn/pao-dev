"""生成本轮提交范围的增量补丁；只读工作树和既有基线。"""

from __future__ import annotations

from difflib import unified_diff
import hashlib
import json
from pathlib import Path
import shutil


REPO = Path(r"D:\AI\workspace\pao-dev")
EVIDENCE = Path(__file__).resolve().parent
BASELINE = EVIDENCE / "运行器修复基线"
BASELINE_MANIFEST = BASELINE / "基线清单.json"
PER_FILE = EVIDENCE / "提交增量补丁"
FILE_MANIFEST = EVIDENCE / "提交增量文件对照.json"
SAFE_PATCH = EVIDENCE / "可安全分离.patch"
BLOCKED_PATCH = EVIDENCE / "前轮上下文阻断.patch"
INTEGRATED_PATCH = EVIDENCE / "基线完整增量预览.patch"


def ensure_output_boundary() -> None:
    resolved_evidence = EVIDENCE.resolve()
    resolved_output = PER_FILE.resolve()
    if resolved_evidence not in resolved_output.parents:
        raise RuntimeError("输出目录不在本轮证据目录内")
    if resolved_output.exists():
        shutil.rmtree(resolved_output)
    resolved_output.mkdir(parents=True)


def path(relative: str) -> Path:
    return REPO / Path(relative)


def text_increment(relative: str) -> str | None:
    source = path(relative)
    baseline = BASELINE / Path(relative)
    before = baseline.read_bytes()
    after = source.read_bytes()
    if before == after:
        return None
    before_lines = before.decode("utf-8").splitlines(keepends=True)
    after_lines = after.decode("utf-8").splitlines(keepends=True)
    body = "".join(
        unified_diff(
            before_lines,
            after_lines,
            fromfile="a/" + relative,
            tofile="b/" + relative,
            n=3,
        )
    )
    if not body:
        raise RuntimeError("字节不同但文本差异为空：" + relative)
    return f"diff --git a/{relative} b/{relative}\n{body}"


def new_file_patch(relative: str) -> str:
    data = path(relative).read_bytes()
    if not data or data.startswith(b"\x1b"):
        raise RuntimeError("拒绝生成空文件或二进制补丁：" + relative)
    text = data.decode("utf-8")
    lines = text.splitlines(keepends=True)
    marker = ""
    if text and not text.endswith(("\n", "\r")):
        lines[-1] += "\n"
        marker = "\\ No newline at end of file\n"
    additions = "".join("+" + line for line in lines)
    return (
        f"diff --git a/{relative} b/{relative}\n"
        "new file mode 100644\n"
        "--- /dev/null\n"
        f"+++ b/{relative}\n"
        f"@@ -0,0 +1,{len(lines)} @@\n"
        + additions
        + marker
    )


def main() -> None:
    ensure_output_boundary()
    baseline_data = json.loads(BASELINE_MANIFEST.read_text(encoding="utf-8"))
    if len(baseline_data["files"]) != 24:
        raise ValueError("基线文件数不是 24")

    benchmark = (
        REPO
        / ".pao"
        / "地图简报与部门协作-20261020"
        / "benchmark"
    )
    sdk = REPO / ".pao" / "协作机制重构-20261023" / "benchmark-sdk-host"
    tracked = [
        benchmark / "map_bench_pao_organized.py",
        benchmark / "map_bench_pao" / "pao_agent.py",
        benchmark / "organized-post" / "kit.json",
        benchmark / "organized-post" / "manifest.json",
        benchmark / "organized-post" / "setup.mjs",
    ]
    untracked = [
        benchmark / "bench_controller.py",
        benchmark / "prepare_run.py",
        benchmark / "launch_run.py",
        benchmark / "watch_run.py",
        benchmark / "runner_common.py",
        benchmark / "preparation_agent.py",
        benchmark / "test_bench_controller.py",
        benchmark / "test_governance_runner.py",
        sdk / "benchmark-worktree-host.mjs",
    ]

    rows = []
    patch_parts = {"safe": [], "blocked": []}
    blocked_names = {"pao_agent.py", "manifest.json", "kit.json"}
    for kind, files in (("tracked", tracked), ("new", untracked)):
        for source in files:
            relative = source.relative_to(REPO).as_posix()
            after = source.read_bytes()
            if kind == "tracked":
                baseline = BASELINE / source.relative_to(REPO)
                before = baseline.read_bytes()
                patch_text = text_increment(relative)
            else:
                before = b""
                patch_text = new_file_patch(relative)
            patch_name = None
            patch_sha = None
            status = "baseline_identical"
            if patch_text is not None:
                patch_file = PER_FILE / f"{kind}-{source.name}.patch"
                patch_file.write_text(patch_text, encoding="utf-8", newline="")
                patch_name = patch_file.name
                patch_sha = hashlib.sha256(patch_text.encode()).hexdigest()
                status = "patch_generated"
                if kind == "tracked" and source.name in blocked_names:
                    patch_parts["blocked"].append(patch_text)
                else:
                    patch_parts["safe"].append(patch_text)
            rows.append(
                {
                    "path": relative,
                    "kind": kind,
                    "baseline_sha256": hashlib.sha256(before).hexdigest(),
                    "current_sha256": hashlib.sha256(after).hexdigest(),
                    "status": status,
                    "patch": patch_name,
                    "patch_sha256": patch_sha,
                }
            )

    FILE_MANIFEST.write_text(
        json.dumps(
            {
                "head": "41e186e99bef1163608b7f85e3b59b64f5e4f80a",
                "file_count": len(rows),
                "files": rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    SAFE_PATCH.write_text(
        "".join(patch_parts["safe"]),
        encoding="utf-8",
        newline="",
    )
    BLOCKED_PATCH.write_text(
        "".join(patch_parts["blocked"]),
        encoding="utf-8",
        newline="",
    )
    INTEGRATED_PATCH.write_text(
        "".join(patch_parts["safe"] + patch_parts["blocked"]),
        encoding="utf-8",
        newline="",
    )
    for row in rows:
        print(
            row["kind"],
            row["status"],
            row["path"],
            row["patch"] or "-",
        )


if __name__ == "__main__":
    main()
