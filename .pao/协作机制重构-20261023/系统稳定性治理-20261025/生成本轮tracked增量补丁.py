"""从运行器修复基线生成既有 tracked 文件的本轮增量补丁；只读工作树。"""

from __future__ import annotations

from difflib import unified_diff
from pathlib import Path


REPO = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
BASE = EVIDENCE / "运行器修复基线"
OUTPUT = EVIDENCE / "既有tracked本轮增量.patch"
PER_FILE = EVIDENCE / "既有tracked本轮增量-分文件"
FILES = (
    ".pao/地图简报与部门协作-20261020/benchmark/map_bench_pao_organized.py",
    ".pao/地图简报与部门协作-20261020/benchmark/map_bench_pao/pao_agent.py",
    ".pao/地图简报与部门协作-20261020/benchmark/organized-post/kit.json",
    ".pao/地图简报与部门协作-20261020/benchmark/organized-post/manifest.json",
    ".pao/地图简报与部门协作-20261020/benchmark/organized-post/setup.mjs",
)


def one_patch(relative: str) -> str:
    before = (BASE / relative).read_text(encoding="utf-8")
    after = (REPO / relative).read_text(encoding="utf-8")
    changes = list(
        unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile="a/" + relative,
            tofile="b/" + relative,
            n=3,
        )
    )
    if not changes:
        raise ValueError("基线到当前没有差异：" + relative)
    return f"diff --git a/{relative} b/{relative}\n" + "".join(changes)


def main() -> None:
    PER_FILE.mkdir(exist_ok=True)
    patches = []
    for index, relative in enumerate(FILES, start=1):
        patch = one_patch(relative)
        patches.append(patch)
        (PER_FILE / f"{index:02d}.patch").write_text(
            patch,
            encoding="utf-8",
            newline="\n",
        )
        print(f"{index:02d} {relative} {len(patch)} bytes")
    OUTPUT.write_text("".join(patches), encoding="utf-8", newline="\n")
    print(f"combined {OUTPUT} {OUTPUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
