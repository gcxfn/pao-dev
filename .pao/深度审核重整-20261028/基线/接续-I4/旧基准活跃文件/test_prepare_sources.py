"""验证 prepare 唯一来源装配、派生 kit 和离线来源记录；不运行 Docker 或模型。"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import prepare_run
import runner_common


class PrepareSourcesTest(unittest.TestCase):
    def setUp(self) -> None:
        workspace = Path(__file__).resolve().parents[4]
        fixtures_root = (
            workspace
            / "临时文件夹"
            / "PAO集中修复-20261025"
        )
        fixtures_root.mkdir(parents=True, exist_ok=True)
        self.root = Path(
            tempfile.mkdtemp(
                prefix="pao-prepare-sources-",
                dir=fixtures_root,
            )
        ).resolve()
        self.addCleanup(self._cleanup)
        self.benchmark = Path(__file__).resolve().parent
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
                        "path": "map_bench_pao_organized.py",
                        "sha256": runner_common.digest(
                            self.sdk / "benchmark-organized-adapter.py"
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
            "bench_controller.py",
            "runner_common.py",
        ):
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# fixture: " + relative + "\n", encoding="utf-8")
        for name in ("setup.mjs", "activate-tools.mjs", "probe-tools.mjs"):
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

    def test_assembly_uses_sdk_activation_once_and_keeps_explicit_sources(self) -> None:
        root = self._make_benchmark()
        assembly = prepare_run.build_package_assembly(root, self.sdk)
        activation_target = "organized-post/activate-tools.mjs"

        self.assertEqual(
            [target for target in assembly if target == activation_target],
            [activation_target],
        )
        self.assertEqual(assembly[activation_target]["source_kind"], "sdk_host")
        self.assertEqual(
            assembly[activation_target]["source"],
            (self.sdk / "activate-tools.mjs").resolve(),
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
            (self.sdk / "benchmark-organized-adapter.py").resolve(),
        )
        terminal_query = assembly["organized-post/query-organized-terminal.mjs"]
        self.assertEqual(terminal_query["source_kind"], "sdk_host")
        self.assertEqual(
            terminal_query["source"],
            (self.sdk / "query-organized-terminal.mjs").resolve(),
        )

    def test_assembly_checks_root_activation_before_using_sdk_version(self) -> None:
        root = self._make_benchmark()
        activation = root / "organized-post" / "activate-tools.mjs"
        activation.write_text("# changed after manifest\n", encoding="utf-8")

        with self.assertRaisesRegex(
            ValueError,
            "组织配置来源摘要不符：organized-post/activate-tools.mjs",
        ):
            prepare_run.build_package_assembly(root, self.sdk)

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
            self.benchmark / "real-run-20261025-prepared-r18" / "run-config.json"
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
            "sdk_host_source": str(self.sdk),
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
                str(Path(prepare_run.__file__).resolve()),
                "--sources",
                str(sources_path),
            ],
            check=False,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
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
        self.assertEqual(activation["source_kind"], "sdk_host")
        self.assertEqual(
            activation["source"],
            str(self.sdk / "activate-tools.mjs"),
        )
        terminal_query = next(
            record
            for record in assembly
            if record["target"] == "organized-post/query-organized-terminal.mjs"
        )
        self.assertEqual(terminal_query["source_kind"], "sdk_host")
        self.assertEqual(
            terminal_query["source"],
            str(self.sdk / "query-organized-terminal.mjs"),
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


if __name__ == "__main__":
    unittest.main()
