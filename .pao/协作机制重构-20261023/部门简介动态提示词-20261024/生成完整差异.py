"""用途：从已保存的修改前 baseline 与当前工作区生成四个受控文件的完整差异。

输入：同目录下 before/ 中的四个文件，以及 PAO/ 中的当前文件。
输出：同目录下 final-increment.patch，便于主对话审核本次任务的全部代码改动。
"""

import difflib
import hashlib
from pathlib import Path


TASK_ROOT = Path(__file__).resolve().parent
WORKSPACE_ROOT = TASK_ROOT.parents[2]
REPO_ROOT = WORKSPACE_ROOT / "PAO"
FILES = (
    "packages/coding-agent/src/pao/dept/catalog.ts",
    "packages/coding-agent/src/pao/dept/render.ts",
    "packages/coding-agent/src/pao/dept/index.ts",
    "packages/coding-agent/test/pao/dept-tools.test.ts",
)
BASELINE_ROOT = TASK_ROOT / "before"
OUTPUT = TASK_ROOT / "final-increment.patch"
HASH_OUTPUT = TASK_ROOT / "final-sha256.txt"


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines(keepends=True)


def main() -> None:
    output: list[str] = []
    hashes: list[str] = []
    for relative in FILES:
        before = BASELINE_ROOT / relative
        after = REPO_ROOT / relative
        if not before.is_file():
            raise FileNotFoundError(f"缺少修改前 baseline：{before}")
        if not after.is_file():
            raise FileNotFoundError(f"缺少当前文件：{after}")
        output.extend(
            difflib.unified_diff(
                read_lines(before),
                read_lines(after),
                fromfile=f"a/{relative}",
                tofile=f"b/{relative}",
            )
        )
        digest = hashlib.sha256(after.read_bytes()).hexdigest().upper()
        hashes.append(f"{digest}  {relative}")

    OUTPUT.write_text("".join(output), encoding="utf-8", newline="\n")
    HASH_OUTPUT.write_text("\n".join(hashes) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
