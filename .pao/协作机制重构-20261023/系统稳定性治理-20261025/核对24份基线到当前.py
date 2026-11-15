"""核对运行器修复基线的 24 个文件与 HEAD、当前工作树；不写 Git 索引。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess


REPO = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
BASELINE = EVIDENCE / "运行器修复基线" / "基线清单.json"
OUTPUT = EVIDENCE / "基线到当前文件对照.json"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    rows = []
    for item in baseline["files"]:
        source = Path(item["source"])
        relative = source.relative_to(REPO).as_posix()
        tracked = (
            subprocess.run(
                ["git", "-C", str(REPO), "ls-files", "--error-unmatch", "--", relative],
                capture_output=True,
            ).returncode
            == 0
        )
        head = subprocess.run(
            ["git", "-C", str(REPO), "cat-file", "blob", "HEAD:" + relative],
            capture_output=True,
        )
        head_sha = sha256(head.stdout) if tracked and head.returncode == 0 else None
        current_sha = sha256(source.read_bytes()) if source.is_file() else None
        rows.append(
            {
                "path": relative,
                "tracked": tracked,
                "exists": current_sha is not None,
                "baseline_sha256": item["sha256"],
                "head_sha256": head_sha,
                "current_sha256": current_sha,
                "baseline_to_current_changed": current_sha != item["sha256"],
                "head_to_current_changed": current_sha != head_sha,
            }
        )
    output = {
        "head": subprocess.check_output(
            ["git", "-C", str(REPO), "rev-parse", "HEAD"],
            text=True,
            encoding="utf-8",
        ).strip(),
        "baseline_manifest": str(BASELINE),
        "file_count": len(rows),
        "files": rows,
    }
    OUTPUT.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    for row in rows:
        print(
            row["path"],
            "tracked=" + str(row["tracked"]),
            "changed=" + str(row["baseline_to_current_changed"]),
        )


if __name__ == "__main__":
    main()
