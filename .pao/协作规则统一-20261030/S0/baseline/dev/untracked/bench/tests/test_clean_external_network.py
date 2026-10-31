"""只使用 fake Docker 验证自动 external 网络按运行收据精确清理。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from bench import clean as clean_module
from bench import network
from bench import network_runtime
from bench import runner_common


CREATED_AT = "2026-10-30T10:00:00Z"
RECEIPT_AT = "2026-10-30T12:00:00+00:00"
CONTROLLER_ID = "a" * 64
CONTROLLER_NAME = "external-clean-controller"
TRIAL_CONTAINER_ID = "b" * 64
TRIAL_CONTAINER_NAME = "trial-one-env-1"
NETWORK_ID = "c" * 64
TRIAL = "trial-one"
ENV_PROJECT = TRIAL + "__env"
SUBNET = "10.243.21.0/24"


def container_record(
    identifier: str,
    name: str,
    *,
    project: str | None = None,
    running: bool = False,
) -> dict:
    labels = {}
    if project is not None:
        labels["com.docker.compose.project"] = project
    return {
        "Id": identifier,
        "Name": "/" + name,
        "Created": CREATED_AT,
        "Config": {"Labels": labels},
        "State": {
            "Running": running,
            "Paused": False,
            "Restarting": False,
            "Status": "running" if running else "exited",
            "ExitCode": 0,
        },
    }


def external_network_record(labels: dict[str, str]) -> dict:
    return {
        "Id": NETWORK_ID,
        "Name": network.stable_network_name(
            {
                "run": "fixture",
                "job_name": "fixture",
                "controller_name": "fixture",
                "source_manifest_sha256": "0" * 64,
            }
        ),
        "Created": CREATED_AT,
        "IPAM": {"Config": [{"Subnet": SUBNET}]},
        "Labels": dict(labels),
        "Containers": {},
    }


class FakeDocker:
    """命令级假 Docker；所有删除只作用于传入的精确完整 ID。"""

    def __init__(
        self,
        containers: dict[str, dict],
        networks: dict[str, dict],
    ) -> None:
        self.containers = dict(containers)
        self.networks = dict(networks)
        self.calls: list[list[str]] = []
        self.inject_endpoint_on_container_remove = False
        self.missing_network_error = "No such network: {identifier}"

    @staticmethod
    def _match(mapping: dict[str, dict], value: str) -> str | None:
        for identifier in mapping:
            if identifier == value or (
                len(value) >= 12 and identifier.startswith(value)
            ):
                return identifier
        return None

    @staticmethod
    def _completed(
        command: list[str],
        *,
        returncode: int = 0,
        stdout: str = "",
        stderr: str = "",
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            command,
            returncode,
            stdout=stdout,
            stderr=stderr,
        )

    def __call__(self, command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        self.calls.append(list(command))
        args = command[1:]
        if args[:4] == ["ps", "-a", "--size=false", "--format"]:
            rows = []
            for value in self.containers.values():
                labels = value["Config"]["Labels"]
                rows.append(
                    json.dumps(
                        {
                            "ID": value["Id"][:12],
                            "Names": clean_module._name(value["Name"]),
                            "Labels": ",".join(
                                f"{key}={item}" for key, item in labels.items()
                            ),
                        },
                        ensure_ascii=False,
                    )
                )
            return self._completed(command, stdout="\n".join(rows))
        if args[:2] == ["inspect", "--type"]:
            identifier = self._match(self.containers, args[-1])
            if identifier is None:
                return self._completed(
                    command,
                    returncode=1,
                    stderr="No such object: " + args[-1],
                )
            return self._completed(
                command,
                stdout=json.dumps([self.containers[identifier]], ensure_ascii=False),
            )
        if args[:3] == ["network", "ls", "--format"]:
            rows = [
                json.dumps(
                    {
                        "ID": value["Id"][:12],
                        "Name": value["Name"],
                        "Labels": ",".join(
                            f"{key}={item}"
                            for key, item in value.get("Labels", {}).items()
                        ),
                    },
                    ensure_ascii=False,
                )
                for value in self.networks.values()
            ]
            return self._completed(command, stdout="\n".join(rows))
        if args[:2] == ["network", "inspect"]:
            identifier = self._match(self.networks, args[-1])
            if identifier is None:
                return self._completed(
                    command,
                    returncode=1,
                    stderr=self.missing_network_error.format(
                        identifier=args[-1]
                    ),
                )
            return self._completed(
                command,
                stdout=json.dumps([self.networks[identifier]], ensure_ascii=False),
            )
        if args[:2] == ["stop", "--time"]:
            identifier = self._match(self.containers, args[-1])
            if identifier is None:
                return self._completed(command, returncode=1, stderr="not found")
            self.containers[identifier]["State"].update(
                {"Running": False, "Paused": False, "Restarting": False}
            )
            return self._completed(command, stdout=args[-1] + "\n")
        if args[:1] == ["rm"]:
            identifier = self._match(self.containers, args[-1])
            if identifier is None:
                return self._completed(command, returncode=1, stderr="not found")
            del self.containers[identifier]
            if self.inject_endpoint_on_container_remove:
                for value in self.networks.values():
                    value["Containers"] = {
                        "foreign-container": {"Name": "foreign-container"}
                    }
            return self._completed(command, stdout=args[-1] + "\n")
        if args[:2] == ["network", "rm"]:
            identifier = self._match(self.networks, args[-1])
            if identifier is None:
                return self._completed(command, returncode=1, stderr="not found")
            if self.networks[identifier]["Containers"]:
                return self._completed(
                    command,
                    returncode=1,
                    stderr="network has active endpoints",
                )
            del self.networks[identifier]
            return self._completed(command, stdout=args[-1] + "\n")
        return self._completed(
            command,
            returncode=1,
            stderr="unexpected fake Docker command: " + " ".join(args),
        )

    def mutations(self) -> list[list[str]]:
        return [
            call
            for call in self.calls
            if call[1:2] in (["stop"], ["rm"])
            or call[1:3] == ["network", "rm"]
        ]


class CleanExternalNetworkTest(unittest.TestCase):
    def setUp(self) -> None:
        configured = os.environ.get("BENCH_TEST_TEMP_ROOT")
        parent = (
            Path(configured)
            if configured
            else Path("D:/AI/workspace/临时文件夹")
            / "I4-5c-clean-external-20261030"
            / "本任务"
            / "test-temp"
        )
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="clean-external-",
            dir=parent,
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self._case_number = 0

    @staticmethod
    def _observation(candidate: str) -> dict:
        return {
            "ok": True,
            "candidate_subnet": candidate,
            "error": None,
            "docker": {
                "ok": True,
                "source": "docker",
                "networks": [],
            },
            "host_route": {
                "ok": True,
                "source": "host_route",
                "networks": [],
            },
            "writes_performed": False,
        }

    def make_run(
        self,
        *,
        network_mode: str = "auto",
        terminal: bool = True,
    ) -> tuple[Path, dict]:
        self._case_number += 1
        case = self.root / f"case-{self._case_number}"
        run = case / "run"
        run.mkdir(parents=True)
        source_manifest = case / "sources.json"
        runner_common.write_json(source_manifest, {"fixture": True})
        identity = {
            "run": str(run.resolve()),
            "job_name": f"external-clean-{self._case_number}",
            "controller_name": CONTROLLER_NAME,
            "source_manifest_sha256": runner_common.digest(source_manifest),
        }
        override_path = run / "network-override.yaml"
        override_path.write_text(
            network.render_external_network_override(
                network.stable_network_name(identity)
            ),
            encoding="utf-8",
        )
        plan = network.build_external_network_plan(
            identity,
            self._observation(SUBNET),
        )
        plan.update(
            {
                "at": CREATED_AT,
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
            {"controller": CONTROLLER_NAME},
        )
        runner_common.write_json(
            run / "run-sources.json",
            {
                "source_manifest": str(source_manifest),
                "source_manifest_sha256": identity["source_manifest_sha256"],
                "network": {
                    "mode": network_mode,
                    "observation_used": network_mode == "auto",
                    "network_scope": (
                        "shared_external"
                        if network_mode == "auto"
                        else "source_config"
                    ),
                    "network_name": (
                        plan["network_name"] if network_mode == "auto" else None
                    ),
                    "subnet": plan["subnet"] if network_mode == "auto" else None,
                    "plan": str(plan_path) if network_mode == "auto" else None,
                    "plan_sha256": (
                        runner_common.digest(plan_path)
                        if network_mode == "auto"
                        else None
                    ),
                    "override": (
                        str(override_path) if network_mode == "auto" else None
                    ),
                    "override_sha256": (
                        runner_common.digest(override_path)
                        if network_mode == "auto"
                        else None
                    ),
                },
            },
        )
        runner_common.write_json(
            run / "run-freeze.json",
            {
                "files": runner_common.file_records(
                    run,
                    exclude={"run-freeze.json"},
                )
            },
        )

        launch = {
            "at": CREATED_AT,
            "container_name": CONTROLLER_NAME,
            "container_id": CONTROLLER_ID,
            "image_id": "sha256:" + "f" * 64,
        }
        runner_common.write_json(run / "runtime-launch.json", launch)
        runner_common.write_json(
            run / "runtime-containers.json",
            {
                "at": RECEIPT_AT,
                "containers": [CONTROLLER_NAME, TRIAL_CONTAINER_NAME],
                "launch": launch,
            },
        )
        (run / "approved-controller-id.txt").write_text(
            CONTROLLER_ID + "\n",
            encoding="utf-8",
        )
        runner_common.write_json(
            run / "launch-authorization.json",
            {
                "at": CREATED_AT,
                "run": str(run),
                "controller": CONTROLLER_NAME,
                "container_id": CONTROLLER_ID,
                "run_config_sha256": runner_common.digest(run / "run-config.json"),
                "run_freeze_sha256": runner_common.digest(run / "run-freeze.json"),
                "docker_authorized": True,
            },
        )
        runner_common.write_json(
            run / "control-status.json",
            {"state": "finished", "writers_stopped": True},
        )
        trial_dir = run / "jobs" / "job-one" / TRIAL
        trial_dir.mkdir(parents=True)
        runner_common.write_json(
            run / "jobs" / "job-one" / "config.json",
            {"job_name": "formal"},
        )
        runner_common.write_json(
            trial_dir / "config.json",
            {"trial_name": TRIAL},
        )
        if terminal:
            runner_common.write_json(
                run / "terminal-receipt.json",
                {
                    "at": RECEIPT_AT,
                    "writers_stopped_observed": True,
                    "business_terminal": {"business_status": "finished"},
                    "reward_rows": [],
                    "scope": {
                        "scope_complete": True,
                        "missing_identities": [],
                        "discovered_container_names": [
                            CONTROLLER_NAME,
                            TRIAL_CONTAINER_NAME,
                        ],
                        "discovered_projects": [ENV_PROJECT],
                    },
                },
            )
        if network_mode == "auto":
            identity_sha256 = network_runtime._identity_sha256(identity)
            freeze_sha256 = runner_common.digest(run / "run-freeze.json")
            runner_common.write_json(
                run / network_runtime.RECEIPT_PATH,
                {
                    "at": RECEIPT_AT,
                    "run": str(run),
                    "mode": "auto",
                    "network_scope": "shared_external",
                    "plan_path": str(plan_path),
                    "plan_sha256": runner_common.digest(plan_path),
                    "run_freeze_path": str(run / "run-freeze.json"),
                    "run_freeze_sha256": freeze_sha256,
                    "run_identity": identity,
                    "run_identity_sha256": identity_sha256,
                    "network_id": NETWORK_ID,
                    "network_name": plan["network_name"],
                    "subnet": plan["subnet"],
                    "created_at": CREATED_AT,
                    "labels": {
                        network_runtime.IDENTITY_LABEL: identity_sha256,
                        network_runtime.FREEZE_LABEL: freeze_sha256,
                    },
                    "endpoints": {},
                },
            )
        return run, plan

    @staticmethod
    def fake_objects(plan: dict) -> tuple[dict[str, dict], dict[str, dict]]:
        labels = {
            network_runtime.IDENTITY_LABEL: network_runtime._identity_sha256(
                plan["run_identity"]
            ),
            network_runtime.FREEZE_LABEL: "fixture-freeze-hash",
        }
        return (
            {
                CONTROLLER_ID: container_record(
                    CONTROLLER_ID,
                    CONTROLLER_NAME,
                    running=True,
                ),
                TRIAL_CONTAINER_ID: container_record(
                    TRIAL_CONTAINER_ID,
                    TRIAL_CONTAINER_NAME,
                    project=ENV_PROJECT,
                ),
            },
            {
                NETWORK_ID: external_network_record(labels),
            },
        )

    def standard_case(self) -> tuple[Path, dict, FakeDocker]:
        run, plan = self.make_run()
        containers, networks = self.fake_objects(plan)
        networks[NETWORK_ID]["Name"] = plan["network_name"]
        networks[NETWORK_ID]["Labels"] = {
            network_runtime.IDENTITY_LABEL: network_runtime._identity_sha256(
                plan["run_identity"]
            ),
            network_runtime.FREEZE_LABEL: runner_common.digest(
                run / "run-freeze.json"
            ),
        }
        return run, plan, FakeDocker(containers, networks)

    def test_preview_and_execute_remove_only_exact_external_network(self) -> None:
        run, plan, fake = self.standard_case()

        preview = clean_module.clean(run, runner=fake)

        self.assertTrue(preview["safe_to_execute"])
        external = next(
            item
            for item in preview["networks"]
            if item.get("ownership_kind") == clean_module.EXTERNAL_NETWORK_SOURCE
        )
        self.assertEqual(external["id"], NETWORK_ID)
        self.assertEqual(external["name"], plan["network_name"])
        self.assertEqual(external["subnet"], SUBNET)
        self.assertEqual(fake.mutations(), [])
        self.assertFalse((run / "clean-receipt.json").exists())

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            docker="fixture-docker",
            runner=fake,
        )

        self.assertTrue(result["ok"])
        self.assertTrue(result["completed"])
        self.assertEqual(
            {item["id"] for item in result["deleted_containers"]},
            {CONTROLLER_ID, TRIAL_CONTAINER_ID},
        )
        self.assertEqual(
            {item["id"] for item in result["deleted_networks"]},
            {NETWORK_ID},
        )
        self.assertFalse(fake.containers)
        self.assertFalse(fake.networks)
        self.assertTrue(
            any(
                call[1:4] == ["network", "rm", NETWORK_ID]
                for call in fake.calls
            )
        )
        self.assertFalse(any(call[1:2] == ["prune"] for call in fake.calls))
        receipt = runner_common.read_json(run / "clean-receipt.json")
        deleted = receipt["deleted_networks"][0]
        self.assertEqual(deleted["source"], clean_module.EXTERNAL_NETWORK_SOURCE)
        self.assertEqual(deleted["id"], NETWORK_ID)
        self.assertEqual(
            deleted["receipt_sha256"],
            runner_common.digest(run / network_runtime.RECEIPT_PATH),
        )

    def test_dry_run_never_writes_or_mutates(self) -> None:
        run, _, fake = self.standard_case()

        result = clean_module.clean(run, runner=fake)

        self.assertEqual(result["mode"], "preview")
        self.assertTrue(result["safe_to_execute"])
        self.assertFalse((run / "clean-receipt.json").exists())
        self.assertEqual(fake.mutations(), [])
        self.assertIn(NETWORK_ID, fake.networks)

    def test_missing_receipt_or_terminal_gate_blocks_external_delete(self) -> None:
        run, _, fake = self.standard_case()
        (run / network_runtime.RECEIPT_PATH).unlink()
        missing = clean_module.clean(run, runner=fake)
        self.assertFalse(missing["ok"])
        self.assertFalse(missing["safe_to_execute"])
        self.assertEqual(fake.mutations(), [])
        self.assertIn(NETWORK_ID, fake.networks)

        terminal_run, terminal_plan = self.make_run(terminal=False)
        containers, networks = self.fake_objects(terminal_plan)
        networks[NETWORK_ID]["Name"] = terminal_plan["network_name"]
        networks[NETWORK_ID]["Labels"] = {
            network_runtime.IDENTITY_LABEL: network_runtime._identity_sha256(
                terminal_plan["run_identity"]
            ),
            network_runtime.FREEZE_LABEL: runner_common.digest(
                terminal_run / "run-freeze.json"
            ),
        }
        terminal_fake = FakeDocker(containers, networks)

        blocked = clean_module.clean(terminal_run, runner=terminal_fake)

        self.assertFalse(blocked["ok"])
        self.assertFalse(blocked["safe_to_execute"])
        self.assertIn("evidence", {item["stage"] for item in blocked["blockers"]})
        self.assertEqual(terminal_fake.mutations(), [])
        self.assertIn(NETWORK_ID, terminal_fake.networks)

    def test_receipt_hash_id_labels_and_foreign_conflicts_block(self) -> None:
        for conflict in (
            "plan-hash",
            "freeze-hash",
            "network-id",
            "actual-id",
            "labels",
            "receipt-endpoints",
        ):
            with self.subTest(conflict=conflict):
                run, plan, fake = self.standard_case()
                receipt_path = run / network_runtime.RECEIPT_PATH
                receipt = runner_common.read_json(receipt_path)
                if conflict == "plan-hash":
                    receipt["plan_sha256"] = "0" * 64
                    runner_common.write_json(receipt_path, receipt)
                elif conflict == "freeze-hash":
                    receipt["run_freeze_sha256"] = "0" * 64
                    runner_common.write_json(receipt_path, receipt)
                elif conflict == "network-id":
                    receipt["network_id"] = "d" * 64
                    runner_common.write_json(receipt_path, receipt)
                elif conflict == "actual-id":
                    fake.networks[NETWORK_ID]["Id"] = "e" * 64
                elif conflict == "labels":
                    fake.networks[NETWORK_ID]["Labels"][
                        network_runtime.IDENTITY_LABEL
                    ] = "0" * 64
                else:
                    receipt["endpoints"] = {"foreign": {"Name": "foreign"}}
                    runner_common.write_json(receipt_path, receipt)

                result = clean_module.clean(run, runner=fake)

                self.assertFalse(result["ok"], conflict)
                self.assertFalse(result["safe_to_execute"], conflict)
                self.assertEqual(fake.mutations(), [], conflict)
                self.assertIn(NETWORK_ID, fake.networks, conflict)
                self.assertEqual(plan["network_name"], receipt.get("network_name"))

    def test_endpoint_after_container_remove_is_retained_then_retry(self) -> None:
        run, _, fake = self.standard_case()
        fake.inject_endpoint_on_container_remove = True

        first = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            docker="fixture-docker",
            runner=fake,
        )

        self.assertFalse(first["ok"])
        self.assertFalse(first["completed"])
        self.assertEqual(
            {item["id"] for item in first["deleted_containers"]},
            {CONTROLLER_ID, TRIAL_CONTAINER_ID},
        )
        self.assertEqual(first["deleted_networks"], [])
        self.assertFalse(any(call[1:3] == ["network", "rm"] for call in fake.calls))
        self.assertIn(NETWORK_ID, fake.networks)
        receipt = runner_common.read_json(run / "clean-receipt.json")
        attempt = receipt["attempts"][-1]
        self.assertTrue(attempt["errors"])
        self.assertEqual(
            {item["id"] for item in attempt["deleted_containers"]},
            {CONTROLLER_ID, TRIAL_CONTAINER_ID},
        )

        fake.inject_endpoint_on_container_remove = False
        fake.networks[NETWORK_ID]["Containers"] = {}
        fake.calls.clear()
        second = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            docker="fixture-docker",
            runner=fake,
        )

        self.assertTrue(second["ok"])
        self.assertTrue(second["completed"])
        self.assertFalse(any(call[1:2] == ["rm"] for call in fake.calls))
        self.assertTrue(
            any(
                call[1:4] == ["network", "rm", NETWORK_ID]
                for call in fake.calls
            )
        )
        self.assertFalse(fake.networks)

    def test_already_deleted_external_network_is_idempotent_reentry(self) -> None:
        run, _, fake = self.standard_case()
        first = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            docker="fixture-docker",
            runner=fake,
        )
        self.assertTrue(first["completed"])
        fake.calls.clear()
        fake.missing_network_error = (
            "Error response from daemon: network {identifier} not found"
        )

        second = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            docker="fixture-docker",
            runner=fake,
        )

        self.assertTrue(second["ok"])
        self.assertTrue(second["completed"])
        self.assertEqual(fake.mutations(), [])
        self.assertEqual(
            {item["id"] for item in second["already_deleted_networks"]},
            {NETWORK_ID},
        )

    def test_missing_error_for_another_identifier_is_not_absence(self) -> None:
        run, _, fake = self.standard_case()
        first = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            docker="fixture-docker",
            runner=fake,
        )
        self.assertTrue(first["completed"])
        fake.calls.clear()
        fake.missing_network_error = (
            "Error response from daemon: network other-network not found"
        )

        second = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            docker="fixture-docker",
            runner=fake,
        )

        self.assertFalse(second["ok"])
        self.assertFalse(second["safe_to_execute"])
        self.assertFalse(second["completed"])
        self.assertEqual(second["already_deleted_networks"], [])
        self.assertEqual(fake.mutations(), [])
        self.assertTrue(
            any(
                "network other-network not found"
                in json.dumps(error, ensure_ascii=False)
                for error in second["errors"]
                if isinstance(error, (str, dict))
            )
        )

    def test_custom_network_is_not_claimed_by_name_or_auto_labels(self) -> None:
        run, plan = self.make_run(network_mode="custom")
        containers, networks = self.fake_objects(plan)
        networks[NETWORK_ID]["Name"] = plan["network_name"]
        networks[NETWORK_ID]["Labels"] = {
            network_runtime.IDENTITY_LABEL: network_runtime._identity_sha256(
                plan["run_identity"]
            ),
            network_runtime.FREEZE_LABEL: runner_common.digest(
                run / "run-freeze.json"
            ),
        }
        fake = FakeDocker(containers, networks)

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            docker="fixture-docker",
            runner=fake,
        )

        self.assertTrue(result["ok"])
        self.assertFalse(any(call[1:3] == ["network", "rm"] for call in fake.calls))
        self.assertIn(NETWORK_ID, fake.networks)


if __name__ == "__main__":
    unittest.main()
