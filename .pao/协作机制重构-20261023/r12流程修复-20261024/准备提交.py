# 用途：生成本轮内核提交的明确文件清单；不暂存、不提交、不修改源码。
# 输入：PAO Git 差异及已审核模块；输出：同目录内核提交清单.json。
import json
import difflib
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[3]
repo = root / "PAO"
base = "packages/coding-agent/"
source_dirs = ("cards/", "dept/", "dispatch-brief/", "fanout/", "host/", "intake/", "worker/", "workflow/")
source_files = {
    "src/core/agent-session-runtime.ts", "src/core/agent-session.ts", "src/modes/print-mode.ts",
    "src/pao/index.ts", "src/pao/shared/python-cache.ts", "src/pao/worktrees/types.ts",
}
test_names = {
    "agent-session-runtime-events.test.ts", "print-mode.test.ts",
    "cards-receipts", "delivery-commit", "dept-recipe", "dept-tools",
    "dispatch-brief-artifacts", "dispatch-brief-prepare", "fanout-baseline", "host-tools", "index-wiring",
    "intake-accept", "intake-tool", "s5p4-roles-supervision", "verifier-run", "worker-dispatch",
    "worker-notify", "worker-session-bridge", "workflow-auto-chain", "workflow-control",
    "workflow-host-bridge", "workflow-node-map-merge", "workflow-plan-tools", "workflow-plan",
    "workflow-recipe", "workflow-templates", "workflow-tools", "card-process-start",
    "delivery-retry-cumulative", "fanout-receipt-declarations", "intake-completion-real",
    "runtime-shutdown-window", "verifier-attempt-baseline", "worker-receipt-retry",
    "workflow-direct-real", "workflow-independent-review", "workflow-migration-compat", "workflow-review-version",
}

def git(*args):
    return subprocess.check_output(["git", "-C", str(repo), *args]).decode("utf-8").split("\0")

paths = set(git("diff", "HEAD", "--name-only", "-z")) | set(git("ls-files", "--others", "--exclude-standard", "-z"))
selected = []
for path in sorted(paths):
    if not path.startswith(base):
        continue
    local = path[len(base):]
    source = local in source_files or any(local.startswith("src/pao/" + directory) for directory in source_dirs)
    test = local.startswith("test/pao/") and local.removeprefix("test/pao/").removesuffix(".test.ts") in test_names
    if source or test or local in {"test/agent-session-runtime-events.test.ts", "test/print-mode.test.ts"}:
        selected.append(path)
output = Path(__file__).with_name("内核提交清单.json")
output.write_text(json.dumps(selected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"count": len(selected), "output": str(output)}, ensure_ascii=False))

# 保存本次相对代理开工基线的增量，避免把此前同批修复误称为 r12 新增。
for baseline, patch in [("修改前基线", "返修衔接.patch"), ("基线-20261024", "通知配方.patch")]:
    baseline_root = Path(__file__).with_name(baseline)
    chunks = []
    for old in sorted((baseline_root / "PAO").rglob("*.ts")):
        relative = old.relative_to(baseline_root / "PAO")
        current = repo / relative
        chunks.extend(difflib.unified_diff(
            old.read_text(encoding="utf-8").splitlines(keepends=True),
            current.read_text(encoding="utf-8").splitlines(keepends=True),
            fromfile="a/" + relative.as_posix(), tofile="b/" + relative.as_posix(),
        ))
    Path(__file__).with_name(patch).write_text("".join(chunks), encoding="utf-8", newline="\n")
