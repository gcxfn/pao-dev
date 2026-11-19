"""从现有运行证据生成 JSON 与 Markdown 报告；不推断缺失分数，也不改写控制状态。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

if __package__:
    from . import runner_common
    from . import watch
else:
    import runner_common
    import watch


def _read_optional(path: Path) -> dict | None:
    return runner_common.read_json(path) if path.is_file() else None


def _observation_errors(run: Path) -> list[dict]:
    rows = []
    path = run / "observer-errors.json"
    if path.is_file():
        value = runner_common.read_json(path)
        errors = value.get("errors")
        if isinstance(errors, list):
            rows.extend(item for item in errors if isinstance(item, dict))
    path = run / "observations.jsonl"
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line:
                continue
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
    # 同一错误可能同时进入追加日志与最近错误文件。
    unique = {}
    for item in rows:
        unique[(item.get("at"), item.get("stage"), item.get("error"))] = item
    return list(unique.values())


def collect_report(run: Path) -> dict:
    run = run.resolve()
    control = _read_optional(run / "control-status.json")
    runtime = _read_optional(run / "runtime-launch.json")
    terminal = _read_optional(run / "terminal-receipt.json")
    watch_state = _read_optional(run / "watch-state.json")
    score = _read_optional(run / "current-score" / "result.json")
    rewards = watch.reward_rows(run)
    facts = watch.terminal_facts(run, control, rewards)
    observations = _observation_errors(run)
    business_complete = (
        facts["business_status"] == "finished"
        and facts["valid_reward_count"] > 0
        and facts["missing_reward_count"] == 0
        and facts["malformed_reward_count"] == 0
    )
    evidence_complete = (
        business_complete
        and not observations
        and (
            terminal is not None
            or (
                watch_state is not None
                and watch_state.get("actual_stop_observed") is True
            )
        )
    )
    return {
        "at": runner_common.now(),
        "run": str(run),
        "business_complete": business_complete,
        "evidence_complete": evidence_complete,
        "business": facts,
        "control_status": control,
        "runtime": runtime,
        "process_observation": watch_state,
        "terminal_receipt": terminal,
        "official_rewards": [
            {"result": row["result"], "reward": row["reward"]}
            for row in rewards
            if row["status"] == "valid"
        ],
        "reward_rows": rewards,
        "independent_score": score,
        "observation_errors": observations,
    }


def render_markdown(report: dict) -> str:
    facts = report["business"]
    status = facts["business_status"]
    verdict = (
        "完成"
        if report["evidence_complete"]
        else "业务已完成，证据不完整"
        if report["business_complete"]
        else "未完成或失败"
    )
    rows = [
        ("结论", verdict),
        ("控制器状态", status),
        ("正式结果数", facts["official_verifier_result_count"]),
        ("有效奖励数", facts["valid_reward_count"]),
        ("缺失奖励数", facts["missing_reward_count"]),
        ("观察错误数", len(report["observation_errors"])),
    ]
    runtime = report.get("runtime") or {}
    if runtime:
        rows.extend(
            [
                ("控制器名", runtime.get("container_name")),
                ("容器 ID", runtime.get("container_id")),
            ]
        )
    lines = [
        "# PAO 基准运行报告",
        "",
        "| 项目 | 值 |",
        "|---|---|",
        *[
            "| {} | {} |".format(name, str(value).replace("|", "\\|"))
            for name, value in rows
        ],
        "",
        "## 官方结果",
        "",
    ]
    if report["reward_rows"]:
        lines.extend(
            [
                "| 文件 | 状态 | reward | 错误 |",
                "|---|---|---|---|",
                *[
                    "| "
                    + " | ".join(
                        [
                            str(row["result"]).replace("|", "\\|"),
                            str(row["status"]),
                            "缺失" if row["reward"] is None else str(row["reward"]),
                            str(row["error"] or "").replace("|", "\\|"),
                        ]
                    )
                    + " |"
                    for row in report["reward_rows"]
                ],
            ]
        )
    else:
        lines.append("没有试次结果；不把缺失 reward 写成 0。")
    lines.extend(["", "## 观察错误", ""])
    if report["observation_errors"]:
        lines.extend(
            f"- `{item.get('stage', 'observation')}`：`{item.get('type', '')}` "
            f"{item.get('error', '')}"
            for item in report["observation_errors"]
        )
    else:
        lines.append("没有已记录的观察错误。")
    lines.extend(
        [
            "",
            "## 说明",
            "",
            "报告只汇总已有证据。缺失 reward、进程状态未知和普通观察失败都保留原状。",
            "",
        ]
    )
    return "\n".join(lines)


def generate(run: Path) -> dict:
    report = collect_report(run)
    report_path = run.resolve() / "report.json"
    markdown_path = run.resolve() / "report.md"
    runner_common.write_json(report_path, report)
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return {
        **report,
        "report_json": str(report_path),
        "report_markdown": str(markdown_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(generate(args.run), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
