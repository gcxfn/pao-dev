"""验证 prepare 唯一来源装配、派生 kit 和离线来源记录；不运行 Docker 或模型。"""

from __future__ import annotations

import copy
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from bench import map_bench_pao_organized
from bench.map_bench_pao.pao_agent import PAOAgent
from bench import prepare as prepare_run
from bench import runner_common


class PrepareSourcesTest(unittest.TestCase):
    def setUp(self) -> None:
        workspace = Path(__file__).resolve().parents[3]
        fixtures_root = (
            Path("D:/AI/workspace/临时文件夹")
            / "I4-1收口-20261030"
            / "I4-4a-product-cli-20261030"
            / "tests-tmp"
        )
        fixtures_root.mkdir(parents=True, exist_ok=True)
        self.root = Path(
            tempfile.mkdtemp(
                prefix="pao-prepare-sources-",
                dir=fixtures_root,
            )
        ).resolve()
        self.addCleanup(self._cleanup)
        self.benchmark = Path(__file__).resolve().parents[1]
        self.sdk = (
            workspace
            / "pao-dev"
            / ".pao"
            / "协作机制重构-20261023"
            / "benchmark-sdk-host"
        )

    def _cleanup(self) -> None:
        if os.environ.get("PAO_KEEP_TEST_FIXTURE") == "1":
            print("保留测试现场：" + str(self.root))
            return

        def retry_readonly(function, path, _error):
            os.chmod(path, 0o600)
            function(path)

        options = (
            {"onexc": retry_readonly}
            if "onexc" in shutil.rmtree.__code__.co_varnames
            else {"onerror": retry_readonly}
        )
        shutil.rmtree(self.root, **options)

    def _write_manifest(self, root: Path) -> None:
        runner_common.write_json(
            root / "organized-post" / "manifest.json",
            {
                "files": [
                    {
                        "path": "organized-post/kit.json",
                        "sha256": runner_common.digest(
                            root / "organized-post" / "kit.json"
                        ),
                    },
                    {
                        "path": "organized-post/setup.mjs",
                        "sha256": runner_common.digest(
                            root / "organized-post" / "setup.mjs"
                        ),
                    },
                    {
                        "path": "organized-post/activate-tools.mjs",
                        "sha256": runner_common.digest(
                            root / "organized-post" / "activate-tools.mjs"
                        ),
                    },
                    {
                        "path": "organized-post/probe-tools.mjs",
                        "sha256": runner_common.digest(
                            root / "organized-post" / "probe-tools.mjs"
                        ),
                    },
                    {
                        "path": "organized-post/query-organized-terminal.mjs",
                        "sha256": runner_common.digest(
                            root
                            / "organized-post"
                            / "query-organized-terminal.mjs"
                        ),
                    },
                    {
                        "path": "map_bench_pao_organized.py",
                        "sha256": runner_common.digest(
                            root / "map_bench_pao_organized.py"
                        ),
                    },
                ]
            },
        )

    def _make_benchmark(self, name: str = "benchmark") -> Path:
        root = self.root / name
        for relative in (
            "map_bench_pao/__init__.py",
            "map_bench_pao/pao_agent.py",
            "scripts/offline_validate.py",
            "preparation_agent.py",
            "controller.py",
            "runner_common.py",
        ):
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# fixture: " + relative + "\n", encoding="utf-8")
        for name in (
            "setup.mjs",
            "activate-tools.mjs",
            "probe-tools.mjs",
            "query-organized-terminal.mjs",
        ):
            path = root / "organized-post" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# root " + name + "\n", encoding="utf-8")
        kit = {
            "departments": [
                {
                    "name": name,
                    "recipe": "# fixture\n- 默认档位:primary\n",
                }
                for name in ("侦察", "规划", "实施", "审核")
            ],
            "workflow": {
                "节点": [
                    {
                        "档位": "primary",
                        "模型": "stale/provider",
                        "思考强度": "low",
                    }
                ]
            },
        }
        runner_common.write_json(root / "organized-post" / "kit.json", kit)
        (root / "map_bench_pao_organized.py").write_text(
            "# source inventory sentinel\n",
            encoding="utf-8",
        )
        self._write_manifest(root)
        return root

    def test_assembly_rejects_duplicate_target_before_source_overwrite(self) -> None:
        root = self._make_benchmark()
        manifest = runner_common.read_json(root / "organized-post" / "manifest.json")
        manifest["files"].append(copy.deepcopy(manifest["files"][0]))
        runner_common.write_json(root / "organized-post" / "manifest.json", manifest)

        with self.assertRaisesRegex(ValueError, "重复目标"):
            prepare_run.build_package_assembly(root, self.sdk)
        self.assertEqual(
            runner_common.read_json(root / "organized-post" / "kit.json")["workflow"][
                "节点"
            ][0]["模型"],
            "stale/provider",
        )

    def test_assembly_uses_formal_bench_sources_once(self) -> None:
        root = self._make_benchmark()
        assembly = prepare_run.build_package_assembly(root, self.sdk)
        activation_target = "organized-post/activate-tools.mjs"

        self.assertEqual(
            [target for target in assembly if target == activation_target],
            [activation_target],
        )
        self.assertEqual(assembly[activation_target]["source_kind"], "benchmark")
        self.assertEqual(
            assembly[activation_target]["source"],
            (root / "organized-post" / "activate-tools.mjs").resolve(),
        )
        self.assertEqual(
            assembly["organized-post/setup.mjs"]["source_kind"],
            "benchmark",
        )
        self.assertEqual(
            assembly["organized-post/kit.json"]["operation"],
            "derive",
        )
        self.assertEqual(
            assembly["map_bench_pao_organized.py"]["source"],
            (root / "map_bench_pao_organized.py").resolve(),
        )
        terminal_query = assembly["organized-post/query-organized-terminal.mjs"]
        self.assertEqual(terminal_query["source_kind"], "benchmark")
        self.assertEqual(
            terminal_query["source"],
            (root / "organized-post" / "query-organized-terminal.mjs").resolve(),
        )
        product_probe = assembly["organized-post/probe-tools.mjs"]
        self.assertEqual(product_probe["source_kind"], "benchmark")
        self.assertEqual(
            product_probe["source"],
            (root / "organized-post" / "probe-tools.mjs").resolve(),
        )
        self.assertFalse(
            any(cell["source_kind"] == "sdk_host" for cell in assembly.values())
        )

    def test_assembly_ignores_missing_legacy_sdk_host_input(self) -> None:
        root = self._make_benchmark()
        missing = self.root / "legacy-sdk-host-does-not-exist"

        assembly = prepare_run.build_package_assembly(root, missing)

        self.assertTrue(assembly)
        self.assertFalse(
            any(cell["source_kind"] == "sdk_host" for cell in assembly.values())
        )

    def test_assembly_checks_formal_activation_digest(self) -> None:
        root = self._make_benchmark()
        activation = root / "organized-post" / "activate-tools.mjs"
        activation.write_text("# changed after manifest\n", encoding="utf-8")

        with self.assertRaisesRegex(
            ValueError,
            "组织配置来源摘要不符：organized-post/activate-tools.mjs",
        ):
            prepare_run.build_package_assembly(root, self.sdk)

    def _run_product_cli_assembly(
        self,
        agent_class,
        *,
        organized: bool,
    ) -> tuple[list[dict], AgentContext]:
        events: list[dict] = []

        class FakeEnvironment:
            default_user = None

            async def upload_file(self, source, target):
                events.append(
                    {
                        "kind": "upload",
                        "source": Path(source),
                        "target": target,
                    }
                )

            async def exec(
                self,
                *,
                command,
                user=None,
                env=None,
                cwd=None,
                timeout_sec=None,
            ):
                events.append(
                    {
                        "kind": "exec",
                        "command": command,
                        "user": user,
                        "env": dict(env or {}),
                        "cwd": cwd,
                        "timeout_sec": timeout_sec,
                    }
                )
                return ExecResult(return_code=0, stdout="", stderr="")

        options = {
            "logs_dir": self.root / "logs",
            "model_name": "fixture/simulated",
            "skip_model_parsing": True,
            "version": "fixture",
            "source_archive": "unused-source.tar.gz",
            "source_sha256": "0" * 64,
            "node_archive": "unused-node.tar.xz",
            "node_sha256": "1" * 64,
            "thinking": "off",
            "tools": "read,bash,edit,write",
            "profile": "post-pao",
        }
        if organized:
            options["organization_manifest_sha256"] = "a" * 64
        agent = agent_class(**options)
        context = AgentContext(metadata={"seed": "kept"})

        with (
            mock.patch(
                "socket.create_connection",
                side_effect=AssertionError("离线装配不得建立网络连接"),
            ),
            mock.patch(
                "urllib.request.urlopen",
                side_effect=AssertionError("离线装配不得发出 HTTP 请求"),
            ),
        ):
            asyncio.run(
                super(agent_class, agent).run(
                    "fixture instruction",
                    FakeEnvironment(),
                    context,
                )
                if organized
                else agent.run(
                    "fixture instruction",
                    FakeEnvironment(),
                    context,
                )
            )
        return events, context

    def test_real_harbor_parent_run_signature_and_base_environment(self) -> None:
        events, _context = self._run_product_cli_assembly(
            PAOAgent,
            organized=False,
        )
        executions = [
            event
            for event in events
            if event["kind"] == "exec"
            and "fixture instruction" in event["command"]
        ]
        self.assertEqual(len(executions), 1)
        launch = executions[0]
        self.assertEqual(launch["env"]["PAO_HOME"], "/tmp/harbor-pao-home")
        self.assertEqual(
            launch["env"]["PI_CODING_AGENT_DIR"],
            "/tmp/harbor-pi-agent",
        )
        self.assertEqual(
            launch["env"]["PAO_CODING_AGENT_DIR"],
            "/tmp/harbor-pi-agent",
        )
        self.assertNotIn("PAO_RUN_MODE", launch["env"])
        self.assertNotIn("PAO_WORKTREE_STATE_ROOT", launch["env"])

    def test_real_harbor_organized_super_run_sets_trusted_environment(self) -> None:
        events, _context = self._run_product_cli_assembly(
            map_bench_pao_organized.OrganizedPAOAgent,
            organized=True,
        )
        executions = [
            event
            for event in events
            if event["kind"] == "exec"
            and "fixture instruction" in event["command"]
        ]
        self.assertEqual(len(executions), 1)
        launch = executions[0]
        self.assertEqual(launch["env"]["PAO_RUN_MODE"], "unattended")
        self.assertEqual(
            launch["env"]["PAO_WORKTREE_STATE_ROOT"],
            "/tmp/harbor-pao-home/worktree-host",
        )
        self.assertEqual(launch["env"]["PAO_HOME"], "/tmp/harbor-pao-home")

    async def _run_organized_adapter(
        self,
        terminal_payload: dict,
        *,
        business_error: BaseException | None = None,
        evidence_error: BaseException | None = None,
    ) -> tuple[SimpleNamespace, list[str]]:
        agent = object.__new__(map_bench_pao_organized.OrganizedPAOAgent)
        agent.options = SimpleNamespace(organization_manifest_sha256="a" * 64)
        commands: list[str] = []

        async def exec_as_agent(_environment, *, command):
            commands.append(command)
            if evidence_error is not None and "保温.json" in command:
                raise evidence_error
            if "query-organized-terminal.mjs" in command:
                return SimpleNamespace(
                    return_code=0,
                    stdout=json.dumps(terminal_payload, ensure_ascii=False),
                    stderr="",
                )
            return SimpleNamespace(return_code=0, stdout="", stderr="")

        async def base_run(*_args):
            if business_error is not None:
                raise business_error

        agent.exec_as_agent = exec_as_agent
        context = SimpleNamespace(metadata={"seed": "kept"})
        with mock.patch.object(
            map_bench_pao_organized.PAOAgent,
            "run",
            new=base_run,
        ):
            await map_bench_pao_organized.OrganizedPAOAgent.run(
                agent,
                "fixture",
                object(),
                context,
            )
        return context, commands

    def test_organized_adapter_accepts_only_completed_terminal_report(self) -> None:
        payload = {
            "ok": True,
            "control": {
                "instance": "instance-1",
                "owner": "owner-1",
                "workflow": "基准开发流水线",
            },
            "report": {
                "workflow": "基准开发流水线",
                "status": "completed",
            },
        }
        context, commands = asyncio.run(
            self._run_organized_adapter(payload)
        )
        self.assertEqual(context.metadata["seed"], "kept")
        self.assertTrue(context.metadata["pao_organization_completed"])
        self.assertEqual(
            context.metadata["pao_organization_workflow_status"],
            "completed",
        )
        self.assertEqual(
            context.metadata["pao_organization_control_workflow"],
            "基准开发流水线",
        )
        self.assertEqual(
            sum("query-organized-terminal.mjs" in item for item in commands),
            1,
        )

    def test_organized_adapter_hold_is_not_success(self) -> None:
        payload = {
            "ok": True,
            "control": {
                "instance": "instance-1",
                "owner": "owner-1",
                "workflow": "基准开发流水线",
            },
            "report": {
                "workflow": "基准开发流水线",
                "status": "hold",
            },
        }
        with self.assertRaisesRegex(RuntimeError, "status=hold"):
            asyncio.run(self._run_organized_adapter(payload))

    def test_organized_adapter_rejects_workflow_identity_conflict(self) -> None:
        payload = {
            "ok": True,
            "control": {
                "instance": "instance-1",
                "owner": "owner-1",
                "workflow": "另一个流水线",
            },
            "report": {
                "workflow": "另一个流水线",
                "status": "completed",
            },
        }
        with self.assertRaisesRegex(RuntimeError, "终态查询结果不完整"):
            asyncio.run(self._run_organized_adapter(payload))

    def test_organized_adapter_preserves_business_error_over_evidence_error(
        self,
    ) -> None:
        business_error = RuntimeError("模型业务失败")
        evidence_error = RuntimeError("留证失败")
        with self.assertRaises(RuntimeError) as raised:
            asyncio.run(
                self._run_organized_adapter(
                    {},
                    business_error=business_error,
                    evidence_error=evidence_error,
                )
            )
        self.assertIs(raised.exception, business_error)
        self.assertIn(
            "组织配置留证同时失败：RuntimeError: 留证失败",
            "\n".join(getattr(raised.exception, "__notes__", [])),
        )

    def test_assembly_uses_formal_bench_modules_and_imports_in_isolation(
        self,
    ) -> None:
        assembly = prepare_run.build_package_assembly(self.benchmark, self.sdk)
        expected = {
            "preparation_agent.py": self.benchmark / "preparation_agent.py",
            "bench_controller.py": self.benchmark / "controller.py",
            "runner_common.py": self.benchmark / "runner_common.py",
        }
        for target, source in expected.items():
            with self.subTest(target=target):
                self.assertEqual(assembly[target]["source"], source.resolve())
                self.assertEqual(assembly[target]["source_kind"], "bench")

        copied = self.root / "independent-bench"
        copied.mkdir()
        prepare_run.copy_assembly(assembly, copied)
        probe = """
import json
from pathlib import Path

root = Path.cwd().resolve()
import bench_controller
import map_bench_pao_organized
import preparation_agent
import runner_common

modules = {
    "bench_controller": Path(bench_controller.__file__).resolve(),
    "map_bench_pao_organized": Path(map_bench_pao_organized.__file__).resolve(),
    "preparation_agent": Path(preparation_agent.__file__).resolve(),
    "runner_common": Path(runner_common.__file__).resolve(),
}
assert all(path.parent == root for path in modules.values()), modules
print(json.dumps({name: str(path) for name, path in modules.items()},
                 ensure_ascii=False))
"""
        completed = subprocess.run(
            [sys.executable, "-c", probe],
            check=False,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
            cwd=copied,
            env={
                **os.environ,
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
                "PYTHONPATH": str(copied),
            },
            shell=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            (completed.stdout or "") + "\n" + (completed.stderr or ""),
        )
        imported = json.loads(completed.stdout)
        self.assertEqual(
            imported,
            {
                "bench_controller": str(copied / "bench_controller.py"),
                "map_bench_pao_organized": str(
                    copied / "map_bench_pao_organized.py"
                ),
                "preparation_agent": str(copied / "preparation_agent.py"),
                "runner_common": str(copied / "runner_common.py"),
            },
        )

    def test_product_cli_probe_reports_three_roles_without_model(self) -> None:
        source = Path(__file__).resolve().parents[2] / "PAO"
        node = shutil.which("node")
        if node is None:
            self.fail("缺少绝对 Node 可执行文件，不能运行产品 CLI 预检")
        agent_dir = self.root / "product-cli-agent"
        pao_home = self.root / "product-cli-home"
        evidence = self.root / "product-cli-evidence"
        project = self.root / "product-cli-project"
        (agent_dir / "extensions").mkdir(parents=True)
        (pao_home / "pao配置").mkdir(parents=True)
        project.mkdir()
        shutil.copyfile(
            self.benchmark / "organized-post" / "activate-tools.mjs",
            agent_dir / "extensions" / "benchmark-organization.js",
        )
        completed = subprocess.run(
            [
                str(Path(node).resolve()),
                str(self.benchmark / "organized-post" / "probe-tools.mjs"),
                str(source),
                str(agent_dir),
                str(pao_home),
                str(evidence),
                str(project),
            ],
            check=False,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
            timeout=60,
            shell=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            (completed.stdout or "") + "\n" + (completed.stderr or ""),
        )
        result = runner_common.read_json(evidence / "role-cli-preflight.json")
        self.assertIs(result["ok"], True)
        self.assertEqual(result["model_calls"], 0)
        self.assertEqual(
            [proof["role"] for proof in result["roles"]],
            ["main", "minister", "worker"],
        )
        state_roots = set()
        sessions = set()
        for proof in result["roles"]:
            role = proof["role"]
            with self.subTest(role=role):
                self.assertGreater(proof["pid"], 0)
                self.assertTrue(proof["session_id"])
                self.assertEqual(proof["rpc_get_state"], "passed")
                self.assertIs(proof["parent_ipc"], True)
                self.assertEqual(proof["model_calls"], 0)
                self.assertEqual(proof["pao_run_mode"], "unattended")
                self.assertEqual(proof["pao_home"], str(pao_home.resolve()))
                self.assertEqual(proof["agent_dir"], str(agent_dir.resolve()))
                self.assertEqual(
                    proof["pao_worktree_list"],
                    role != "worker",
                )
                state_roots.add(proof["worktree_state_root"])
                sessions.add(proof["session_id"])
                stdout = (
                    evidence
                    / "role-cli"
                    / role
                    / "stdout.log"
                ).read_text(encoding="utf-8")
                self.assertNotIn('"command":"prompt"', stdout)
                self.assertIn('"command":"get_state"', stdout)
        self.assertEqual(
            state_roots,
            {str((pao_home / "worktree-host").resolve())},
        )
        self.assertEqual(len(sessions), 3)

    def test_kit_derivation_records_template_transform_and_final_digest(self) -> None:
        root = self._make_benchmark()
        assembly = prepare_run.build_package_assembly(root, self.sdk)
        destination = self.root / "derive-destination"
        destination.mkdir()
        cell = assembly["organized-post/kit.json"]
        record = prepare_run.derive_kit(
            cell,
            destination,
            "minimax-code/MiniMax-Test",
            "high",
        )
        final_path = destination / "organized-post" / "kit.json"
        final_kit = runner_common.read_json(final_path)

        self.assertEqual(record["template_sha256"], cell["sha256"])
        self.assertEqual(record["transform"]["selected_model_name"], "minimax-code/MiniMax-Test")
        self.assertEqual(
            record["transform"]["model_name"],
            "harbor-endpoint/minimax-code/MiniMax-Test",
        )
        self.assertEqual(record["transform"]["thinking"], "high")
        self.assertEqual(record["sha256"], runner_common.digest(final_path))
        self.assertEqual(record["final_sha256"], record["sha256"])
        self.assertNotEqual(record["template_sha256"], record["final_sha256"])
        self.assertEqual(
            final_kit["workflow"]["节点"][0]["模型"],
            "harbor-endpoint/minimax-code/MiniMax-Test",
        )

    def test_offline_sources_keep_origin_unknown_and_record_final_copy(self) -> None:
        source = self.root / "declared.bin"
        destination = self.root / "copied.bin"
        source.write_bytes(b"declared\n")
        destination.write_bytes(b"actual-copy\n")
        record = prepare_run.offline_source_record(
            source,
            destination,
            runner_common.digest(source),
        )

        self.assertEqual(record["origin"], "unknown")
        self.assertEqual(record["origin_status"], "unknown")
        self.assertEqual(record["declared_sha256"], runner_common.digest(source))
        self.assertEqual(record["sha256"], runner_common.digest(destination))
        self.assertEqual(record["final_sha256"], record["sha256"])
        self.assertNotEqual(record["declared_sha256"], record["sha256"])

    def test_prepare_failure_keeps_primary_and_cleanup_errors(self) -> None:
        run = self.root / "failed-run"
        primary_error = RuntimeError("准备主错")
        cleanup_error = PermissionError("清理失败")
        files = {
            "task.toml": b"fixture\n",
            "model-data.zip": b"model\n",
            "node.tar.xz": b"node\n",
            "system.zip": b"system\n",
            "model-metadata.json": b"{}\n",
            "config.json": b"{}\n",
        }
        for name, content in files.items():
            (self.root / name).write_bytes(content)
        task_manifest = self.root / "task-manifest.json"
        runner_common.write_json(task_manifest, {"ref": "sha256:" + "a" * 64})
        sources = {
            "run_parent": str(self.root),
            "run_dir": str(run),
            "pao_source": str(self.root),
            "benchmark_source": str(self.root),
            "sdk_host_source": str(self.root),
            "task_source": str(self.root / "task"),
            "task_source_manifest": str(task_manifest),
            "model_data_archive": str(self.root / "model-data.zip"),
            "model_data_sha256": runner_common.digest(self.root / "model-data.zip"),
            "node_archive": str(self.root / "node.tar.xz"),
            "node_sha256": runner_common.digest(self.root / "node.tar.xz"),
            "system_dependencies_archive": str(self.root / "system.zip"),
            "system_dependencies_sha256": runner_common.digest(self.root / "system.zip"),
            "model_metadata_path": str(self.root / "model-metadata.json"),
            "model_metadata_sha256": runner_common.digest(
                self.root / "model-metadata.json"
            ),
            "config_source": str(self.root / "config.json"),
            "config_source_sha256": runner_common.digest(self.root / "config.json"),
            "container_mounts": {
                "local_root": str(self.root),
                "container_root": "/mnt/integration",
            },
            "harbor_cache": str(self.root / "harbor-cache"),
            "job_name": "failed-prepare",
            "task_name": "fixture",
            "model_name": "fixture/model",
            "model_base_url": "http://host.docker.internal:3425",
            "thinking": "high",
            "controller_name": "fixture",
            "authorization": "fixture",
        }
        sources_path = self.root / "sources.json"
        runner_common.write_json(sources_path, sources)
        cleanup_calls: list[Path] = []

        def fail_cleanup(path: Path) -> None:
            cleanup_calls.append(Path(path))
            raise cleanup_error

        with (
            mock.patch.object(
                runner_common, "load_model_metadata", return_value={}
            ),
            mock.patch.object(
                prepare_run, "build_package_assembly", return_value={}
            ),
            mock.patch.object(
                prepare_run,
                "copy_frozen_task",
                side_effect=primary_error,
            ),
            mock.patch.object(
                prepare_run.shutil,
                "rmtree",
                side_effect=fail_cleanup,
            ),
        ):
            with self.assertRaises(BaseExceptionGroup) as raised:
                prepare_run.prepare(sources_path)

        self.assertEqual(
            raised.exception.exceptions,
            (primary_error, cleanup_error),
        )
        self.assertIs(raised.exception.__cause__, primary_error)
        self.assertFalse(run.exists())
        self.assertEqual(len(cleanup_calls), 1)
        self.assertTrue(cleanup_calls[0].is_dir())

    def test_formal_prepare_records_unique_sources_and_offline_copies(self) -> None:
        root = self.root / "formal"
        root.mkdir()
        repository = root / "repo"
        repository.mkdir()
        subprocess.run(
            ["git", "init", str(repository)],
            check=True,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
        )
        (repository / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(repository), "add", "tracked.txt"],
            check=True,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "-c",
                "user.name=Offline Test",
                "-c",
                "user.email=offline@example.invalid",
                "commit",
                "-m",
                "fixture",
            ],
            check=True,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
        )
        benchmark = root / "benchmark"
        shutil.copytree(
            self.benchmark,
            benchmark,
            ignore=shutil.ignore_patterns(
                "real-run-*",
                "__pycache__",
                "test_*.py",
                "*.zip",
                "*.tar.xz",
                "*.log",
            ),
        )
        task = root / "task"
        task.mkdir()
        (task / "task.toml").write_text("fixture = true\n", encoding="utf-8")
        task_ref = "sha256:" + "a" * 64
        task_manifest = root / "task-manifest.json"
        runner_common.write_json(
            task_manifest,
            {
                "ref": task_ref,
                "files": [
                    {
                        "path": "task.toml",
                        "sha256": runner_common.digest(task / "task.toml"),
                    }
                ],
            },
        )
        model_name = "openai/minimax-code/MiniMax-M3.1-Flash"
        metadata = root / "selected-model-metadata.json"
        shutil.copyfile(self.benchmark / "model-metadata.json", metadata)
        config = runner_common.read_json(
            self.benchmark / "tests" / "run-config-fixture.json"
        )
        config["tasks"] = [{"name": "terminal-bench/html-js-filter", "ref": task_ref}]
        config["environment"]["kwargs"].pop("extra_docker_compose", None)
        config_path = root / "config.json"
        runner_common.write_json(config_path, config)
        offline = {
            "model_data.zip": b"model-data\n",
            "node.tar.xz": b"node\n",
            "system.zip": b"system\n",
        }
        for name, content in offline.items():
            (root / name).write_bytes(content)
        harbor_cache = root / "harbor-cache"
        harbor_cache.mkdir()
        run = root / "prepared-run"
        mounts = {
            "local_root": str(root),
            "container_root": "/mnt/integration",
        }
        sources = {
            "run_parent": str(root),
            "run_dir": str(run),
            "pao_source": str(repository),
            "benchmark_source": str(benchmark),
            "task_source": str(task),
            "task_source_manifest": str(task_manifest),
            "model_data_archive": str(root / "model_data.zip"),
            "model_data_sha256": runner_common.digest(root / "model_data.zip"),
            "node_archive": str(root / "node.tar.xz"),
            "node_sha256": runner_common.digest(root / "node.tar.xz"),
            "system_dependencies_archive": str(root / "system.zip"),
            "system_dependencies_sha256": runner_common.digest(root / "system.zip"),
            "model_metadata_path": str(metadata),
            "model_metadata_sha256": runner_common.digest(metadata),
            "config_source": str(config_path),
            "config_source_sha256": runner_common.digest(config_path),
            "container_mounts": mounts,
            "harbor_cache": str(harbor_cache),
            "job_name": "offline-final-assembly",
            "task_name": "terminal-bench/html-js-filter",
            "model_name": model_name,
            "model_base_url": "http://host.docker.internal:3425",
            "thinking": "high",
            "controller_name": "offline-controller",
            "authorization": "offline source test",
        }
        sources_path = root / "sources.json"
        runner_common.write_json(sources_path, sources)

        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "bench",
                "prepare",
                "--sources",
                str(sources_path),
            ],
            check=False,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            cwd=Path(prepare_run.__file__).resolve().parents[1],
            shell=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            (completed.stdout or "") + "\n" + (completed.stderr or ""),
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["model_calls"], 0)
        self.assertEqual(result["docker_calls"], 0)
        source_manifest = runner_common.read_json(run / "source-manifest.json")
        assembly = source_manifest["package_assembly"]
        targets = [record["target"] for record in assembly]
        self.assertEqual(targets, sorted(set(targets)))
        activation = next(
            record
            for record in assembly
            if record["target"] == "organized-post/activate-tools.mjs"
        )
        self.assertEqual(activation["source_kind"], "benchmark")
        self.assertEqual(
            activation["source"],
            str(benchmark / "organized-post" / "activate-tools.mjs"),
        )
        terminal_query = next(
            record
            for record in assembly
            if record["target"] == "organized-post/query-organized-terminal.mjs"
        )
        self.assertEqual(terminal_query["source_kind"], "benchmark")
        self.assertEqual(
            terminal_query["source"],
            str(benchmark / "organized-post" / "query-organized-terminal.mjs"),
        )
        self.assertEqual(
            terminal_query["sha256"],
            runner_common.digest(run / "organized-post" / "query-organized-terminal.mjs"),
        )
        derived = source_manifest["derived"][0]
        self.assertEqual(
            derived["sha256"],
            runner_common.digest(run / "organized-post" / "kit.json"),
        )
        self.assertNotEqual(derived["template_sha256"], derived["sha256"])
        for key, name in (
            ("model_data", "model-data.zip"),
            ("node", "node.tar.xz"),
            ("system_dependencies", "git-system-dependencies.zip"),
        ):
            record = source_manifest["offline"][key]
            self.assertEqual(record["origin"], "unknown")
            self.assertEqual(record["origin_status"], "unknown")
            self.assertEqual(
                record["final_sha256"],
                runner_common.digest(run / name),
            )
        metadata_record = source_manifest["model_metadata"]
        self.assertEqual(metadata_record["origin"], "unknown")
        self.assertEqual(
            metadata_record["final_sha256"],
            runner_common.digest(run / "model-metadata.json"),
        )
        final_config = runner_common.read_json(run / "run-config.json")
        self.assertEqual(
            final_config["agents"][0]["kwargs"]["organization_manifest_sha256"],
            runner_common.digest(run / "organized-post" / "manifest.json"),
        )
        self.assertEqual(
            final_config["agents"][0]["kwargs"]["model_metadata_sha256"],
            runner_common.digest(run / "model-metadata.json"),
        )
        self.assertEqual(
            final_config["agents"][0]["source_metadata"]["model"],
            "minimax-code/MiniMax-M3.1-Flash",
        )
        current_sources = runner_common.read_json(run / "run-sources.json")[
            "current_sources"
        ]
        self.assertIsNone(current_sources["sdk_host"])
        self.assertFalse(current_sources["sdk_host_active_source"])


if __name__ == "__main__":
    unittest.main()
