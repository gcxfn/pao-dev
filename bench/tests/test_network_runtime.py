"""验证启动前外部网络创建与归属；Docker 全部使用内存假实现。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from bench import network
from bench import network_runtime
from bench import runner_common


class FakeDocker:
    """只模拟 network inspect/create，记录所有 argv，绝不访问真实 Docker。"""

    def __init__(self) -> None:
        self.networks_by_id: dict[str, dict] = {}
        self.calls: list[tuple[str, ...]] = []
        self.create_calls = 0
        self.fail_create = False
        self.fail_created_inspect = False
        self._next_id = 1

    def add_network(
        self,
        *,
        network_id: str,
        name: str,
        subnet: str,
        labels: dict[str, str] | None = None,
        endpoints: dict | None = None,
        created: str = "2026-10-30T01:02:03Z",
    ) -> dict:
        value = {
            "Id": network_id,
            "Name": name,
            "Created": created,
            "IPAM": {"Config": [{"Subnet": subnet}]},
            "Labels": labels,
            "Containers": {} if endpoints is None else endpoints,
        }
        self.networks_by_id[network_id] = value
        return value

    def _find(self, identifier: str) -> dict | None:
        if identifier in self.networks_by_id:
            return self.networks_by_id[identifier]
        for value in self.networks_by_id.values():
            if value["Name"] == identifier:
                return value
        return None

    @staticmethod
    def _result(
        args: tuple[str, ...],
        *,
        returncode: int,
        stdout: str = "",
        stderr: str = "",
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=list(args),
            returncode=returncode,
            stdout=stdout,
            stderr=stderr,
        )

    def __call__(self, docker: str, *args: str, **_kwargs) -> subprocess.CompletedProcess[str]:
        self.calls.append((docker, *args))
        if args[:2] == ("network", "inspect"):
            identifier = args[2]
            value = self._find(identifier)
            if value is None:
                return self._result(
                    args,
                    returncode=1,
                    stderr=f"Error: No such network: {identifier}",
                )
            if self.fail_created_inspect and identifier == value["Id"]:
                return self._result(
                    args,
                    returncode=18,
                    stdout="inspect-stdout",
                    stderr="inspect-stderr",
                )
            return self._result(
                args,
                returncode=0,
                stdout=json.dumps([value], ensure_ascii=False),
            )
        if args[:2] == ("network", "create"):
            self.create_calls += 1
            if self.fail_create:
                return self._result(
                    args,
                    returncode=17,
                    stdout="create-stdout",
                    stderr="create-stderr",
                )
            labels = {}
            for index, item in enumerate(args):
                if item == "--label":
                    key, value = args[index + 1].split("=", 1)
                    labels[key] = value
            subnet = args[args.index("--subnet") + 1]
            network_id = f"{self._next_id:064x}"
            self._next_id += 1
            self.add_network(
                network_id=network_id,
                name=args[-1],
                subnet=subnet,
                labels=labels,
            )
            return self._result(
                args,
                returncode=0,
                stdout=network_id + "\n",
            )
        raise AssertionError("测试假 Docker 收到未预期命令：" + repr(args))


class NetworkRuntimeTest(unittest.TestCase):
    def test_docker_29_missing_network_is_distinct_from_other_inspect_failures(self) -> None:
        def inspect(identifier, error):
            return network_runtime._inspect_network(
                "fixture-docker", identifier, allow_missing=True, stage="test",
                runner=lambda *args, **kwargs: subprocess.CompletedProcess(args, 1, "", error),
            )
        self.assertIsNone(inspect("owned-network", "Error response from daemon: network owned-network not found\n"))
        for error in ("daemon unavailable", "network other-network not found"):
            with self.subTest(error=error), self.assertRaises(network_runtime.NetworkRuntimeError):
                inspect("owned-network", error)

    def setUp(self) -> None:
        configured = os.environ.get("BENCH_TEST_TEMP_ROOT")
        parent = (
            Path(configured)
            if configured
            else Path("D:/AI/workspace/临时文件夹")
            / "接续核验-20261030"
            / "网络创建"
            / "unit-cases"
        )
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="network-runtime-",
            dir=parent,
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self._case_number = 0

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

    def _make_run(self) -> tuple[Path, dict]:
        self._case_number += 1
        case = self.root / f"case-{self._case_number}"
        run = case / "run"
        run.mkdir(parents=True)
        source_manifest = case / "sources.json"
        runner_common.write_json(source_manifest, {"fixture": True})
        identity = {
            "run": str(run.resolve()),
            "job_name": f"network-runtime-{self._case_number}",
            "controller_name": f"network-controller-{self._case_number}",
            "source_manifest_sha256": runner_common.digest(source_manifest),
        }
        planned_subnet = "10.243.8.0/24"
        override_path = run / "network-override.yaml"
        override_path.write_text(
            network.render_external_network_override(
                network.stable_network_name(identity)
            ),
            encoding="utf-8",
        )
        plan = network.build_external_network_plan(
            identity,
            self._observation(planned_subnet),
        )
        plan.update(
            {
                "at": "2026-10-30T00:00:00+00:00",
                "override": {
                    "path": str(override_path),
                    "sha256": runner_common.digest(override_path),
                    "external": True,
                    "compose_network_key": "default",
                },
            }
        )
        plan_path = run / "network-plan.json"
        runner_common.write_json(plan_path, plan)
        runner_common.write_json(
            run / "run-config.json",
            {"job_name": identity["job_name"]},
        )
        runner_common.write_json(
            run / "approved-launch.json",
            {"controller": identity["controller_name"]},
        )
        run_sources = {
            "source_manifest": str(source_manifest),
            "source_manifest_sha256": identity["source_manifest_sha256"],
            "network": {
                "mode": "auto",
                "observation_used": True,
                "network_scope": "shared_external",
                "network_name": plan["network_name"],
                "subnet": plan["subnet"],
                "plan": str(plan_path),
                "plan_sha256": runner_common.digest(plan_path),
                "override": str(override_path),
                "override_sha256": runner_common.digest(override_path),
            },
        }
        runner_common.write_json(run / "run-sources.json", run_sources)
        runner_common.write_json(
            run / "run-freeze.json",
            {"files": runner_common.file_records(run, exclude={"run-freeze.json"})},
        )
        return run, plan

    @staticmethod
    def _observation_patch(value: dict):
        return mock.patch.object(
            network_runtime.network,
            "observe_live_networks",
            return_value=value,
        )

    def test_auto_network_created_and_receipt_proves_ownership(self) -> None:
        run, plan = self._make_run()
        fake = FakeDocker()

        with self._observation_patch(self._observation(plan["subnet"])):
            result = network_runtime.ensure_external_network(
                run,
                "fixture-docker",
                runner=fake,
            )

        receipt = runner_common.read_json(run / "runtime-network.json")
        self.assertTrue(result["created"])
        self.assertFalse(result["reused"])
        self.assertEqual(fake.create_calls, 1)
        self.assertEqual(
            receipt["plan_sha256"],
            runner_common.digest(run / "network-plan.json"),
        )
        self.assertEqual(
            receipt["run_freeze_sha256"],
            runner_common.digest(run / "run-freeze.json"),
        )
        self.assertEqual(receipt["network_name"], plan["network_name"])
        self.assertEqual(receipt["subnet"], plan["subnet"])
        self.assertRegex(receipt["network_id"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            receipt["labels"][network_runtime.IDENTITY_LABEL],
            network_runtime._identity_sha256(plan["run_identity"]),
        )
        self.assertEqual(
            receipt["labels"][network_runtime.FREEZE_LABEL],
            receipt["run_freeze_sha256"],
        )
        inspected_calls = [
            call for call in fake.calls if call[1:3] == ("network", "inspect")
        ]
        self.assertEqual(inspected_calls[-1][3], receipt["network_id"])
        self.assertFalse(
            any(call[1] in {"prune", "rm"} for call in fake.calls)
        )

    def test_existing_own_empty_network_is_reused_idempotently(self) -> None:
        run, plan = self._make_run()
        fake = FakeDocker()
        with self._observation_patch(self._observation(plan["subnet"])):
            first = network_runtime.ensure_external_network(
                run,
                "fixture-docker",
                runner=fake,
            )
        receipt_before = (run / "runtime-network.json").read_bytes()
        create_calls = fake.create_calls
        fake.calls.clear()

        with mock.patch.object(
            network_runtime.network,
            "observe_live_networks",
            side_effect=AssertionError("复用不应重新规划网络"),
        ):
            second = network_runtime.ensure_external_network(
                run,
                "fixture-docker",
                runner=fake,
            )

        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertTrue(second["reused"])
        self.assertEqual(fake.create_calls, create_calls)
        self.assertEqual(
            (run / "runtime-network.json").read_bytes(),
            receipt_before,
        )
        self.assertEqual(len(fake.calls), 1)

    def test_foreign_same_name_is_rejected_without_create(self) -> None:
        run, plan = self._make_run()
        fake = FakeDocker()
        fake.add_network(
            network_id="f" * 64,
            name=plan["network_name"],
            subnet="10.243.99.0/24",
            labels={"foreign": "true"},
        )

        with mock.patch.object(
            network_runtime.network,
            "observe_live_networks",
            side_effect=AssertionError("发现同名外来网络后不得继续创建"),
        ):
            with self.assertRaisesRegex(
                network_runtime.NetworkRuntimeError,
                "拒绝接管",
            ):
                network_runtime.ensure_external_network(
                    run,
                    "fixture-docker",
                    runner=fake,
                )

        self.assertEqual(fake.create_calls, 0)
        self.assertFalse((run / "runtime-network.json").exists())

    def test_source_read_failures_happen_before_docker(self) -> None:
        for missing in ("run-sources.json", "network-plan.json"):
            with self.subTest(missing=missing):
                run, _plan = self._make_run()
                (run / missing).unlink()
                fake = FakeDocker()
                with self.assertRaises(network_runtime.NetworkRuntimeError):
                    network_runtime.ensure_external_network(
                        run,
                        "fixture-docker",
                        runner=fake,
                    )
                self.assertEqual(fake.calls, [])
                self.assertFalse((run / "runtime-network.json").exists())

    def test_new_conflict_after_prepare_is_rejected_without_create(self) -> None:
        run, plan = self._make_run()
        fake = FakeDocker()
        conflict = self._observation(
            plan["subnet"],
            docker_networks=[
                {
                    "Name": "new-conflict",
                    "IPAM": {
                        "Config": [{"Subnet": "10.243.8.0/25"}],
                    },
                }
            ],
        )

        with self._observation_patch(conflict):
            with self.assertRaisesRegex(
                network_runtime.NetworkRuntimeError,
                "启动前网络复查失败",
            ):
                network_runtime.ensure_external_network(
                    run,
                    "fixture-docker",
                    runner=fake,
                )

        self.assertEqual(fake.create_calls, 0)
        self.assertFalse((run / "runtime-network.json").exists())

    def test_plan_freeze_hash_and_identity_mismatches_are_rejected_before_docker(self) -> None:
        for mismatch in ("plan_hash", "identity"):
            with self.subTest(mismatch=mismatch):
                run, plan = self._make_run()
                fake = FakeDocker()
                freeze_path = run / "run-freeze.json"
                if mismatch == "plan_hash":
                    freeze = runner_common.read_json(freeze_path)
                    plan_record = next(
                        item
                        for item in freeze["files"]
                        if item["path"] == "network-plan.json"
                    )
                    plan_record["sha256"] = "0" * 64
                    runner_common.write_json(freeze_path, freeze)
                else:
                    plan["run_identity"]["job_name"] = "wrong-job"
                    plan["network_name"] = network.stable_network_name(
                        plan["run_identity"]
                    )
                    runner_common.write_json(run / "network-plan.json", plan)
                    run_sources = runner_common.read_json(
                        run / "run-sources.json"
                    )
                    run_sources["network"]["plan_sha256"] = runner_common.digest(
                        run / "network-plan.json"
                    )
                    runner_common.write_json(
                        run / "run-sources.json",
                        run_sources,
                    )
                    freeze = runner_common.read_json(freeze_path)
                    for relative in ("network-plan.json", "run-sources.json"):
                        record = next(
                            item
                            for item in freeze["files"]
                            if item["path"] == relative
                        )
                        record["sha256"] = runner_common.digest(run / relative)
                    runner_common.write_json(freeze_path, freeze)

                with self.assertRaises(network_runtime.NetworkRuntimeError):
                    network_runtime.ensure_external_network(
                        run,
                        "fixture-docker",
                        runner=fake,
                    )
                self.assertEqual(fake.calls, [])

    def test_receipt_id_labels_hash_and_endpoints_mismatches_are_rejected(self) -> None:
        for mismatch in ("id", "labels", "hash", "endpoint", "endpoint_unknown"):
            with self.subTest(mismatch=mismatch):
                run, plan = self._make_run()
                fake = FakeDocker()
                with self._observation_patch(self._observation(plan["subnet"])):
                    network_runtime.ensure_external_network(
                        run,
                        "fixture-docker",
                        runner=fake,
                    )
                receipt_path = run / "runtime-network.json"
                receipt = runner_common.read_json(receipt_path)
                actual = fake.networks_by_id[receipt["network_id"]]
                if mismatch == "id":
                    receipt["network_id"] = "e" * 64
                    runner_common.write_json(receipt_path, receipt)
                elif mismatch == "labels":
                    actual["Labels"] = {
                        **actual["Labels"],
                        network_runtime.IDENTITY_LABEL: "0" * 64,
                    }
                elif mismatch == "hash":
                    receipt["plan_sha256"] = "0" * 64
                    runner_common.write_json(receipt_path, receipt)
                elif mismatch == "endpoint":
                    actual["Containers"] = {
                        "unknown-endpoint": {"Name": "foreign"}
                    }
                else:
                    actual["Containers"] = None
                create_calls = fake.create_calls

                with self.assertRaises(network_runtime.NetworkRuntimeError):
                    network_runtime.ensure_external_network(
                        run,
                        "fixture-docker",
                        runner=fake,
                    )
                self.assertEqual(fake.create_calls, create_calls)

    def test_create_inspect_and_receipt_failures_never_claim_success(self) -> None:
        for failure in ("create", "inspect", "receipt"):
            with self.subTest(failure=failure):
                run, plan = self._make_run()
                fake = FakeDocker()
                if failure == "create":
                    fake.fail_create = True
                elif failure == "inspect":
                    fake.fail_created_inspect = True

                patch = (
                    mock.patch.object(
                        network_runtime.runner_common,
                        "write_json",
                        side_effect=PermissionError("receipt-write-failed"),
                    )
                    if failure == "receipt"
                    else mock.patch.object(
                        network_runtime.runner_common,
                        "write_json",
                        wraps=runner_common.write_json,
                    )
                )
                with patch, self._observation_patch(
                    self._observation(plan["subnet"])
                ):
                    with self.assertRaises(
                        network_runtime.NetworkRuntimeError
                    ) as raised:
                        network_runtime.ensure_external_network(
                            run,
                            "fixture-docker",
                            runner=fake,
                        )

                expected_stage = {
                    "create": "create",
                    "inspect": "post_create_inspect",
                    "receipt": "write_receipt",
                }[failure]
                self.assertEqual(raised.exception.stage, expected_stage)
                self.assertFalse((run / "runtime-network.json").exists())
                self.assertFalse(
                    any(call[1:3] in {("network", "rm"), ("network", "prune")} for call in fake.calls)
                )
                if failure == "create":
                    self.assertEqual(
                        raised.exception.evidence["returncode"],
                        17,
                    )
                    self.assertIn("create-stderr", raised.exception.evidence["stderr"])
                else:
                    self.assertIn("network_id", raised.exception.evidence)

    def test_legacy_custom_and_offline_modes_keep_old_behavior(self) -> None:
        for mode in ("custom", "offline-unobserved", "legacy"):
            with self.subTest(mode=mode):
                run, _plan = self._make_run()
                run_sources = runner_common.read_json(run / "run-sources.json")
                if mode == "legacy":
                    run_sources.pop("network")
                else:
                    run_sources["network"] = {"mode": mode}
                runner_common.write_json(run / "run-sources.json", run_sources)
                fake = FakeDocker()
                result = network_runtime.ensure_external_network(
                    run,
                    "fixture-docker",
                    runner=fake,
                )
                self.assertFalse(result["created"])
                self.assertFalse(result["reused"])
                self.assertEqual(fake.calls, [])
                self.assertFalse((run / "runtime-network.json").exists())


if __name__ == "__main__":
    unittest.main()
