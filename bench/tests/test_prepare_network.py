"""验证自动网络计划与冻结；只使用模拟只读观察，不访问真实 Docker。"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from bench import network
from bench import prepare as prepare_run
from bench import runner_common


class PrepareNetworkTest(unittest.TestCase):
    def setUp(self) -> None:
        configured = os.environ.get("BENCH_TEST_TEMP_ROOT")
        parent = (
            Path(configured)
            if configured
            else Path("D:/AI/workspace/临时文件夹")
            / "I4-1收口-20261030"
            / "I4-5a-network-planning-20261030"
            / "cases"
        )
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="prepare-network-",
            dir=parent,
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.benchmark = Path(__file__).resolve().parents[1]

    @staticmethod
    def _observation(
        candidate: str,
        *,
        docker_networks: list[dict] | None = None,
        route_networks: list[str] | None = None,
    ) -> dict:
        return {
            "ok": True,
            "candidate_subnet": candidate,
            "error": None,
            "docker": {
                "ok": True,
                "source": "docker",
                "networks": docker_networks or [],
            },
            "host_route": {
                "ok": True,
                "source": "host_route",
                "networks": route_networks or [],
            },
            "writes_performed": False,
        }

    def _make_case(
        self,
        name: str,
        *,
        custom_compose: bool = False,
    ) -> tuple[Path, Path, Path, Path | None]:
        root = self.root / name
        root.mkdir()
        repository = root / "repo"
        repository.mkdir()
        subprocess.run(
            ["git", "init", "-q", str(repository)],
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
                "user.name=Offline Network Test",
                "-c",
                "user.email=offline@example.invalid",
                "commit",
                "-q",
                "-m",
                "fixture",
            ],
            check=True,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
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

        metadata = root / "selected-model-metadata.json"
        shutil.copyfile(self.benchmark / "model-metadata.json", metadata)
        model_name = "openai/minimax-code/MiniMax-M3.1-Flash"
        config = runner_common.read_json(
            self.benchmark / "tests" / "run-config-fixture.json"
        )
        config["tasks"] = [{"name": "terminal-bench/html-js-filter", "ref": task_ref}]
        config["environment"]["kwargs"].pop("extra_docker_compose", None)
        config_path = root / "config.json"
        runner_common.write_json(config_path, config)

        custom_source = None
        if custom_compose:
            custom_source = root / "custom-network.yaml"
            custom_source.write_text(
                "networks:\n"
                "  default:\n"
                "    external: true\n"
                "    name: custom-fixed-network\n",
                encoding="utf-8",
            )

        for filename, content in {
            "model-data.zip": b"model-data\n",
            "node.tar.xz": b"node\n",
            "system.zip": b"system\n",
        }.items():
            (root / filename).write_bytes(content)
        harbor_cache = root / "harbor-cache"
        harbor_cache.mkdir()
        run = root / "run"
        sources = {
            "run_parent": str(root),
            "run_dir": str(run),
            "pao_source": str(repository),
            "benchmark_source": str(self.benchmark),
            "task_source": str(task),
            "task_source_manifest": str(task_manifest),
            "model_data_archive": str(root / "model-data.zip"),
            "model_data_sha256": runner_common.digest(root / "model-data.zip"),
            "node_archive": str(root / "node.tar.xz"),
            "node_sha256": runner_common.digest(root / "node.tar.xz"),
            "system_dependencies_archive": str(root / "system.zip"),
            "system_dependencies_sha256": runner_common.digest(root / "system.zip"),
            "model_metadata_path": str(metadata),
            "model_metadata_sha256": runner_common.digest(metadata),
            "config_source": str(config_path),
            "config_source_sha256": runner_common.digest(config_path),
            "container_mounts": {
                "local_root": str(root),
                "container_root": "/mnt/i4-5a",
            },
            "harbor_cache": str(harbor_cache),
            "job_name": "i4-5a-" + name,
            "task_name": "terminal-bench/html-js-filter",
            "model_name": model_name,
            "model_base_url": "http://host.docker.internal:3425",
            "thinking": "high",
            "controller_name": "i4-5a-controller-" + name,
            "authorization": "I4-5a 零模型离线网络计划测试",
        }
        if custom_source is not None:
            sources["extra_docker_compose_source"] = str(custom_source)
            sources["extra_docker_compose_sha256"] = runner_common.digest(
                custom_source
            )
        sources_path = root / "sources.json"
        runner_common.write_json(sources_path, sources)
        return root, run, sources_path, custom_source

    def test_auto_plan_skips_conflicts_and_freezes_shared_override(self) -> None:
        root, run, sources_path, _ = self._make_case("auto")
        observation = self._observation(
            "10.243.2.0/24",
            docker_networks=[
                {
                    "Name": "first-half",
                    "IPAM": {"Config": [{"Subnet": "10.243.0.0/25"}]},
                },
                {
                    "Name": "second-half",
                    "IPAM": {"Config": [{"Subnet": "10.243.0.128/25"}]},
                },
                {
                    "Name": "next",
                    "IPAM": {"Config": [{"Subnet": "10.243.1.0/24"}]},
                },
            ],
            route_networks=["10.243.0.0/24"],
        )

        result = prepare_run.prepare(
            sources_path,
            network_observation=observation,
        )

        plan = runner_common.read_json(run / "network-plan.json")
        self.assertEqual(plan["mode"], "auto")
        self.assertEqual(plan["network_scope"], "shared_external")
        self.assertEqual(plan["subnet"], "10.243.2.0/24")
        self.assertTrue(plan["observation_used"])
        self.assertEqual(plan["run_identity"]["run"], str(run))
        self.assertEqual(plan["run_identity"]["job_name"], "i4-5a-auto")
        self.assertEqual(
            plan["run_identity"]["controller_name"],
            "i4-5a-controller-auto",
        )
        self.assertEqual(
            plan["network_name"],
            network.stable_network_name(plan["run_identity"]),
        )
        self.assertEqual(
            plan["observation"]["docker"]["networks"],
            observation["docker"]["networks"],
        )
        self.assertEqual(
            plan["observation"]["host_route"]["networks"],
            observation["host_route"]["networks"],
        )
        self.assertFalse(plan["observation"]["writes_performed"])

        override = run / "network-override.yaml"
        self.assertEqual(
            override.read_text(encoding="utf-8"),
            network.render_external_network_override(plan["network_name"]),
        )
        config = runner_common.read_json(run / "run-config.json")
        sources = runner_common.read_json(sources_path)
        self.assertEqual(
            config["environment"]["kwargs"]["extra_docker_compose"],
            [
                runner_common.container_path(
                    run / "network-override.yaml",
                    sources["container_mounts"],
                )
            ],
        )

        freeze = {
            item["path"]: item["sha256"]
            for item in runner_common.read_json(run / "run-freeze.json")["files"]
        }
        self.assertEqual(
            freeze["network-plan.json"],
            runner_common.digest(run / "network-plan.json"),
        )
        self.assertEqual(
            freeze["network-override.yaml"],
            runner_common.digest(override),
        )
        for record_path in ("source-manifest.json", "run-sources.json"):
            network_record = runner_common.read_json(run / record_path)["network"]
            self.assertEqual(
                network_record["plan_sha256"],
                runner_common.digest(run / "network-plan.json"),
            )
            self.assertEqual(
                network_record["override_sha256"],
                runner_common.digest(override),
            )
        self.assertEqual(result["network"]["mode"], "auto")
        self.assertEqual(result["docker_calls"], 0)

    def test_default_prepare_never_queries_docker_and_remains_unobserved(self) -> None:
        _root, run, sources_path, _ = self._make_case("offline")
        with (
            mock.patch.object(
                network,
                "docker_network_inputs",
                side_effect=AssertionError("不得查询 Docker"),
            ),
            mock.patch.object(
                network,
                "host_route_inputs",
                side_effect=AssertionError("不得查询宿主路由"),
            ),
        ):
            result = prepare_run.prepare(sources_path)

        plan = runner_common.read_json(run / "network-plan.json")
        self.assertEqual(plan["mode"], "offline-unobserved")
        self.assertFalse(plan["observation_used"])
        self.assertIsNone(plan["observation"])
        self.assertIsNone(plan["override"])
        self.assertFalse((run / "network-override.yaml").exists())
        config = runner_common.read_json(run / "run-config.json")
        self.assertNotIn(
            "extra_docker_compose",
            config["environment"]["kwargs"],
        )
        self.assertEqual(result["network"]["mode"], "offline-unobserved")

    def test_any_observation_source_failure_leaves_no_run(self) -> None:
        for failed_source, label in (("docker", "Docker 网络"), ("host_route", "宿主路由")):
            with self.subTest(source=failed_source):
                _root, run, sources_path, _ = self._make_case(
                    "failed-" + failed_source
                )
                observation = self._observation("10.243.0.0/24")
                observation[failed_source] = {
                    "ok": False,
                    "source": (
                        "docker"
                        if failed_source == "docker"
                        else "host_route"
                    ),
                    "networks": [],
                    "error": "模拟读取失败",
                }
                with self.assertRaisesRegex(ValueError, label + "读取失败"):
                    prepare_run.prepare(
                        sources_path,
                        network_observation=observation,
                    )
                self.assertFalse(run.exists())
                self.assertEqual(list(run.parent.glob(".run.preparing-*")), [])

    def test_invalid_docker_ipam_or_non_read_only_observation_leaves_no_run(self) -> None:
        cases = [
            (
                "invalid-ip-range",
                self._observation(
                    "10.243.2.0/24",
                    docker_networks=[
                        {
                            "Name": "invalid-ipam",
                            "IPAM": {
                                "Config": [
                                    {
                                        "Subnet": "10.243.0.0/24",
                                        "IPRange": "not-an-address",
                                    }
                                ]
                            },
                        }
                    ],
                ),
                "Docker 网络 IPRange 无效",
            ),
            (
                "source-error",
                {
                    **self._observation("10.243.2.0/24"),
                    "docker": {
                        "ok": True,
                        "source": "docker",
                        "networks": [],
                        "error": "模拟部分读取失败",
                    },
                },
                "Docker 网络读取结果包含错误",
            ),
        ]
        non_read_only = self._observation("10.243.2.0/24")
        non_read_only["writes_performed"] = True
        cases.append(("writes", non_read_only, "必须明确为只读"))

        for name, observation, reason in cases:
            with self.subTest(case=name):
                _root, run, sources_path, _ = self._make_case("invalid-observation-" + name)
                with self.assertRaisesRegex(ValueError, reason):
                    prepare_run.prepare(
                        sources_path,
                        network_observation=observation,
                    )
                self.assertFalse(run.exists())
                self.assertEqual(list(run.parent.glob(".run.preparing-*")), [])

    def test_explicit_custom_override_is_preserved_and_reported_as_custom(self) -> None:
        _root, run, sources_path, custom_source = self._make_case(
            "custom",
            custom_compose=True,
        )
        assert custom_source is not None
        before = custom_source.read_bytes()
        ignored_failure = {
            "ok": False,
            "error": "自定义覆写存在时不应读取自动观察",
            "writes_performed": False,
        }

        result = prepare_run.prepare(
            sources_path,
            network_observation=ignored_failure,
        )

        self.assertEqual((run / "network-override.yaml").read_bytes(), before)
        plan = runner_common.read_json(run / "network-plan.json")
        self.assertEqual(plan["mode"], "custom")
        self.assertFalse(plan["observation_used"])
        self.assertIsNone(plan["network_name"])
        self.assertIsNone(plan["observation"])
        self.assertEqual(plan["override"]["source"], str(custom_source.resolve()))
        config = runner_common.read_json(run / "run-config.json")
        sources = runner_common.read_json(sources_path)
        self.assertEqual(
            config["environment"]["kwargs"]["extra_docker_compose"],
            [
                runner_common.container_path(
                    run / "network-override.yaml",
                    sources["container_mounts"],
                )
            ],
        )
        self.assertEqual(result["network"]["mode"], "custom")
        freeze = {
            item["path"]: item["sha256"]
            for item in runner_common.read_json(run / "run-freeze.json")["files"]
        }
        self.assertEqual(
            freeze["network-plan.json"],
            runner_common.digest(run / "network-plan.json"),
        )
        self.assertEqual(
            freeze["network-override.yaml"],
            runner_common.digest(run / "network-override.yaml"),
        )

    def test_conflicting_or_outside_pool_candidate_is_rejected_before_run(self) -> None:
        cases = [
            (
                "conflict",
                self._observation(
                    "10.243.0.0/24",
                    docker_networks=[
                        {
                            "Name": "conflict",
                            "IPAM": {
                                "Config": [{"Subnet": "10.243.0.0/25"}]
                            },
                        }
                    ],
                ),
                "重叠",
            ),
            (
                "outside",
                self._observation("10.244.0.0/24"),
                "既定 /24 池",
            ),
            (
                "malformed",
                self._observation("not-a-subnet"),
                "候选 subnet 无效",
            ),
            (
                "not-slash-24",
                self._observation("10.243.0.0/23"),
                "既定 /24 池",
            ),
            (
                "host-bits",
                self._observation("10.243.2.1/24"),
                "候选 subnet 无效",
            ),
        ]
        for name, observation, reason in cases:
            with self.subTest(case=name):
                _root, run, sources_path, _ = self._make_case("invalid-" + name)
                with self.assertRaisesRegex(ValueError, reason):
                    prepare_run.prepare(
                        sources_path,
                        network_observation=observation,
                    )
                self.assertFalse(run.exists())

    def test_network_name_is_stable_for_run_identity(self) -> None:
        identity = {
            "run": "D:/fixture/run",
            "job_name": "fixture-job",
            "controller_name": "fixture-controller",
            "source_manifest_sha256": "a" * 64,
        }
        first = network.stable_network_name(identity)
        second = network.stable_network_name(dict(reversed(list(identity.items()))))
        changed = network.stable_network_name(
            {**identity, "run": "D:/fixture/other-run"}
        )
        self.assertRegex(first, r"^pao-bench-[0-9a-f]{16}$")
        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)


if __name__ == "__main__":
    unittest.main()
