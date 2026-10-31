"""最小离线测试；只验证配置解析、入口与边界，不启动容器或模型。"""

from __future__ import annotations

import importlib
import json  # 在模块替换前固定 C JSON 解码器的异常类型，避免重复导入造成类型失配。
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

# 本机未安装 Harbor；测试只装配配置类所需的抽象接口，不加载真实 Harbor 或模型。
class PiOptions(__import__("pydantic").BaseModel):
    profile: str = "single"


class Pi:
    options_model = PiOptions
    _SESSIONS_DIRECTORY = Path("sessions")

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
        self.options = self.options_model(**kwargs)

    def build_cli_flags(self):
        return "--thinking off"

    def populate_context_post_run(self, context):
        return None


modules = {
    "harbor": {},
    "harbor.agents": {},
    "harbor.agents.installed": {},
    "harbor.agents.installed.base": {"with_prompt_template": lambda function: function},
    "harbor.agents.installed.pi": {"Pi": Pi, "PiOptions": PiOptions},
    "harbor.environments": {},
    "harbor.environments.base": {"BaseEnvironment": object},
    "harbor.models": {},
    "harbor.models.agent": {},
    "harbor.models.agent.context": {
        "AgentContext": type("AgentContext", (), {}),
        "ModelUsage": type("ModelUsage", (), {"__init__": lambda self, **kwargs: self.__dict__.update(kwargs)}),
    },
}
stub_modules = {}
for name, attrs in modules.items():
    module = types.ModuleType(name)
    for attribute, value in attrs.items():
        setattr(module, attribute, value)
    stub_modules[name] = module
# 单独加载测试副本；模拟 Harbor 不能污染后续需要真实 Harbor 的测试。
fixture_name = "bench.map_bench_pao._agent_unit_fixture"
spec = importlib.util.spec_from_file_location(
    fixture_name, Path(__file__).resolve().parents[1] / "map_bench_pao" / "pao_agent.py"
)
fixture_module = importlib.util.module_from_spec(spec)
with mock.patch.dict(sys.modules, {**stub_modules, fixture_name: fixture_module}):
    spec.loader.exec_module(fixture_module)
PAOAgent, PAOOptions = fixture_module.PAOAgent, fixture_module.PAOOptions


class PAOOptionsTest(unittest.TestCase):
    def base_kwargs(self) -> dict:
        return {
            "source_archive": "source.tar.gz",
            "source_sha256": "0" * 64,
            "node_archive": "node.tar.xz",
            "node_sha256": "1" * 64,
            "thinking": "off",
            "tools": "read,bash,edit,write",
        }

    def test_single_rejects_no_extensions_shortcut(self) -> None:
        with self.assertRaises(ValueError):
            PAOOptions(profile="single", no_extensions=True, **self.base_kwargs())

    def test_single_preserves_normal_resources(self) -> None:
        options = PAOOptions(profile="single", **self.base_kwargs())
        self.assertFalse(options.no_extensions)

    def test_pending_is_preparation_only(self) -> None:
        kwargs = self.base_kwargs()
        kwargs["source_sha256"] = "pending"
        self.assertEqual(PAOOptions(profile="single", **kwargs).source_sha256, "pending")

    def test_pao_profile_rejects_no_extensions(self) -> None:
        with self.assertRaises(ValueError):
            PAOOptions(profile="post-pao", no_extensions=True, **self.base_kwargs())

    def test_allowlist_is_required(self) -> None:
        kwargs = self.base_kwargs()
        kwargs.pop("tools")
        with self.assertRaises(ValueError):
            PAOOptions(profile="post-pao", **kwargs)

    def test_node_path_and_digest_are_both_required(self) -> None:
        kwargs = self.base_kwargs()
        kwargs.pop("node_archive")
        with self.assertRaises(ValueError):
            PAOOptions(profile="post-pao", **kwargs)
        kwargs = self.base_kwargs()
        kwargs.pop("node_sha256")
        with self.assertRaises(ValueError):
            PAOOptions(profile="post-pao", **kwargs)

    def test_framework_fields_do_not_become_cli_flags(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            agent = PAOAgent(
                logs_dir=Path(temp),
                model_name="dummy/model",
                skip_model_parsing=True,
                version="local",
                source_archive="source.tar.gz",
                source_sha256="0" * 64,
                node_archive="node.tar.xz",
                node_sha256="1" * 64,
                thinking="off",
                tools="read,bash,edit,write",
                profile="post-pao",
            )
            flags = agent.build_cli_flags()
            self.assertIn("--thinking off", flags)
            self.assertNotIn("--tools", flags)  # 不误关 PAO 扩展工具。
            self.assertNotIn("profile", flags)
            self.assertNotIn("source_archive", flags)
            self.assertNotIn("--no-extensions", flags)

    def test_single_builds_explicit_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            agent = PAOAgent(
                logs_dir=Path(temp),
                model_name="dummy/model",
                skip_model_parsing=True,
                version="local",
                source_archive="source.tar.gz",
                source_sha256="0" * 64,
                node_archive="node.tar.xz",
                node_sha256="1" * 64,
                thinking="off",
                tools="read,bash,edit,write",
                profile="single",
                no_extensions=False,
            )
            flags = agent.build_cli_flags()
            self.assertNotIn("--no-extensions", flags)
            self.assertNotIn("--exclude-tools", flags)
            self.assertIn("--tools read,bash,edit,write", flags)

    def test_node_install_has_no_download_or_implicit_retry(self) -> None:
        command = PAOAgent._node_install_command("2" * 64)
        self.assertNotIn("curl", command)
        self.assertNotIn("wget", command)
        self.assertNotIn("http://", command)
        self.assertNotIn("https://", command)
        self.assertIn("2" * 64, command)
        self.assertIn("/tmp/pao-node.tar.xz", command)

    def test_session_candidates_ignore_execution_maps_and_dispatch_logs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            logs = Path(temp)
            worker = logs / "pao/worker-sessions"
            native = worker / "project-state/worker会话/session.jsonl"
            native.parent.mkdir(parents=True)
            native.write_text('{"type":"session","id":"session"}\n', encoding="utf-8")
            for path in (
                worker / "project-state/执行映射/one.jsonl",
                worker / "project-state/派发日志.jsonl",
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{bad mapping data\n', encoding="utf-8")
            agent = PAOAgent(
                logs_dir=logs,
                model_name="dummy/model",
                skip_model_parsing=True,
                version="local",
                **self.base_kwargs(),
                profile="post-pao",
            )
            files, ignored, errors = agent._usage_candidates()
            self.assertEqual(files, [native])
            self.assertEqual(
                {Path(item) for item in ignored},
                {
                    Path("pao/worker-sessions/project-state/派发日志.jsonl"),
                    Path("pao/worker-sessions/project-state/执行映射/one.jsonl"),
                },
            )
            self.assertEqual(errors, [])

    def test_usage_report_separates_roles_instances_attempts_and_keeps_coverage_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            logs = Path(temp)
            state = logs / "pao/worker-sessions/project-state"

            def write(relative: str, lines: list[dict]) -> Path:
                path = logs / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("".join(f"{__import__('json').dumps(line)}\n" for line in lines),
                                encoding="utf-8")
                return path

            session = lambda identity: {"type": "session", "id": identity}
            assistant = lambda identity: {
                "type": "message", "id": identity,
                "message": {
                    "role": "assistant", "provider": "fake", "model": "simulated",
                    "usage": {"input": 10, "output": 3, "cacheRead": 2, "cacheWrite": 1},
                },
            }
            write("sessions/main.jsonl", [session("main"), assistant("main-event")])
            write("pao/worker-sessions/project-state/benchmark/部长会话/one/minister.jsonl",
                  [session("minister"), assistant("minister-event")])
            write("pao/worker-sessions/project-state/worker会话/worker.jsonl",
                  [session("worker"), assistant("worker-event")])
            write("pao/worker-sessions/worker.jsonl",
                  [session("worker"), assistant("worker-event")])
            manifest_a = """---
版本: 2
实例: "instance-a"
正文: 无关字段
---
实例: body-only
"""
            manifest_b = """---
版本: 2
实例: instance-b
---
"""
            context = {
                "key": {"cardsDir": "/app/.pao/benchmark/卡", "cardNo": 1, "attempt": 1},
                "bindingDigest": "sha256:a",
            }
            context_copy = {**context, "bindingDigest": "sha256:copy"}
            for relative, content in {
                "pao/worker-sessions/project-state/benchmark/工作流实例-a.md": manifest_a,
                "pao/worker-sessions/project-state/archive/run1/工作流实例-a.md": manifest_a,
                "pao/worker-sessions/project-state/archive/run2/工作流实例-b.md": manifest_b,
                "pao/worker-sessions/project-state/benchmark/execution-contexts/card-0001-attempt-1.json":
                    __import__("json").dumps(context),
                "pao/worker-sessions/project-state/archive/run1/execution-contexts/card-0001-attempt-1.json":
                    __import__("json").dumps(context_copy),
                "pao/worker-sessions/project-state/archive/run2/execution-contexts/card-0001-attempt-1.json":
                    __import__("json").dumps(context),
            }.items():
                path = logs / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            write("pao/worker-sessions/project-state/执行映射/one.jsonl", [{"状态": "启动"}])
            write("pao/worker-sessions/project-state/派发日志.jsonl", [{"type": "pao_dispatch_lock"}])

            agent = PAOAgent(
                logs_dir=logs,
                model_name="dummy/model",
                skip_model_parsing=True,
                version="local",
                **self.base_kwargs(),
                profile="post-pao",
            )
            context = types.SimpleNamespace(metadata={"existing": "kept"})
            agent.populate_context_post_run(context)

            self.assertIsNone(context.n_input_tokens)
            self.assertIsNone(context.n_output_tokens)
            self.assertIsNone(context.n_cache_tokens)
            self.assertIsNone(context.model_usage)
            self.assertIsNone(context.cost_usd)
            self.assertEqual(context.metadata["existing"], "kept")
            self.assertEqual(context.metadata["pao_role_session_counts"],
                             {"main": 1, "minister": 1, "worker": 1, "other": 0})
            self.assertEqual(context.metadata["pao_role_coverage_status"]["worker"], "observed")
            self.assertEqual(context.metadata["pao_harbor_trials_observed"], 1)
            self.assertEqual(context.metadata["pao_internal_instance_count"], 2)
            self.assertEqual(context.metadata["pao_internal_instance_count_status"], "observed")
            self.assertEqual(context.metadata["pao_internal_instance_evidence_file_count"], 3)
            self.assertEqual(context.metadata["pao_worker_attempt_count"], 2)
            self.assertEqual(context.metadata["pao_worker_attempt_count_status"], "observed")
            self.assertEqual(context.metadata["pao_worker_attempt_evidence_file_count"], 3)
            self.assertEqual(context.metadata["pao_observed_usage_event_count"], 3)
            self.assertIsNone(context.metadata["pao_model_request_count"])
            self.assertEqual(context.metadata["pao_model_requests_status"], "unknown")
            self.assertEqual(context.metadata["pao_known_input_tokens_lower_bound"], 39)
            self.assertEqual(context.metadata["pao_usage_coverage_status"], "unknown")
            self.assertEqual(context.metadata["pao_cost_status"], "unknown")
            self.assertEqual(len(context.metadata["pao_usage_ignored_non_session"]), 2)

    def test_accuracy_is_unknown_when_attempt_cannot_bind_to_instance(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            logs = Path(temp)
            state = logs / "pao/worker-sessions/project-state"
            manifest = state / "benchmark/工作流实例-a.md"
            manifest.parent.mkdir(parents=True)
            manifest.write_text("---\n版本: 2\n实例: instance-a\n---\n", encoding="utf-8")
            broken = state / "archive/run1/execution-contexts/card-0001-attempt-1.json"
            broken.parent.mkdir(parents=True)
            broken.write_text("{bad", encoding="utf-8")
            agent = PAOAgent(
                logs_dir=logs,
                model_name="dummy/model",
                skip_model_parsing=True,
                version="local",
                **self.base_kwargs(),
                profile="post-pao",
            )
            instance_count, attempt_count, instance_files, attempt_files, errors = (
                agent._usage_evidence_counts()
            )
            self.assertIsNone(instance_count)
            self.assertIsNone(attempt_count)
            self.assertEqual(instance_files, 1)
            self.assertEqual(attempt_files, 1)
            self.assertIn("执行上下文身份不可读", errors[0])

    def test_single_profile_keeps_observed_tokens_and_unknown_cost(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            logs = Path(temp)
            session = logs / "sessions/main.jsonl"
            session.parent.mkdir(parents=True)
            session.write_text(
                '{"type":"session","id":"main"}\n'
                '{"type":"message","id":"event","message":{"role":"assistant",'
                '"provider":"fake","model":"simulated","usage":'
                '{"input":10,"output":3,"cacheRead":2,"cacheWrite":1}}}\n',
                encoding="utf-8",
            )
            agent = PAOAgent(
                logs_dir=logs,
                model_name="dummy/model",
                skip_model_parsing=True,
                version="local",
                **self.base_kwargs(),
                profile="single",
            )
            context = types.SimpleNamespace(metadata={})
            agent.populate_context_post_run(context)
            self.assertEqual(context.n_input_tokens, 13)
            self.assertEqual(context.n_output_tokens, 3)
            self.assertEqual(context.n_cache_tokens, 2)
            self.assertIsNone(context.cost_usd)
            self.assertIsNone(context.model_usage["fake/simulated"].cost_usd)

    def test_corrupt_native_candidate_stays_visible(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            logs = Path(temp)
            corrupt = logs / "pao/worker-sessions/project-state/worker会话/broken.jsonl"
            corrupt.parent.mkdir(parents=True)
            corrupt.write_text("{bad\n", encoding="utf-8")
            agent = PAOAgent(
                logs_dir=logs,
                model_name="dummy/model",
                skip_model_parsing=True,
                version="local",
                **self.base_kwargs(),
                profile="post-pao",
            )
            files, ignored, errors = agent._usage_candidates()
            self.assertEqual(files, [])
            self.assertEqual(ignored, [])
            self.assertIn(str(corrupt), errors[0])
            self.assertIn("无法解析", errors[0])


if __name__ == "__main__":
    unittest.main()
