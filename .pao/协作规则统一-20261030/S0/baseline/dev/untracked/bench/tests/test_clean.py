"""只使用 fake runner 验证精确归属清理；不查询或修改真实 Docker。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from bench import clean as clean_module
from bench import runner_common


RECEIPT_AT = "2026-10-30T12:00:00+00:00"
CREATED_AT = "2026-10-30T10:00:00Z"
CONTROLLER_ID = "a" * 64
CONTROLLER_NAME = "controller-test"
TRIAL = "trial-one"
ENV_PROJECT = TRIAL + "__env"


def container_record(
    identifier: str,
    name: str,
    *,
    project: str | None = None,
    running: bool = False,
    state_known: bool = True,
    created: str = CREATED_AT,
) -> dict:
    labels = {}
    if project is not None:
        labels["com.docker.compose.project"] = project
    state = {
        "Running": running,
        "Paused": False,
        "Restarting": False,
        "Status": "running" if running else "exited",
        "ExitCode": 0,
    }
    if not state_known:
        state = {"Status": "unknown"}
    return {
        "Id": identifier,
        "Name": "/" + name,
        "Created": created,
        "Config": {"Labels": labels},
        "State": state,
    }


def network_record(
    identifier: str,
    name: str,
    *,
    project: str,
    endpoints: dict | None = None,
    created: str = CREATED_AT,
) -> dict:
    return {
        "Id": identifier,
        "Name": name,
        "Created": created,
        "Labels": {
            "com.docker.compose.project": project,
            "com.docker.compose.network": "default",
        },
        "Containers": {} if endpoints is None else endpoints,
    }


class FakeDocker:
    """命令级假 Docker；所有删除都按传入的精确 ID 作用于内存对象。"""

    def __init__(
        self,
        containers: dict[str, dict] | None = None,
        networks: dict[str, dict] | None = None,
    ) -> None:
        self.containers = dict(containers or {})
        self.networks = dict(networks or {})
        self.calls: list[list[str]] = []
        self.fail_ps = False
        self.fail_stop = False
        self.stop_without_state_change = False
        self.fail_rm_ids: set[str] = set()
        self.network_inspect_count = 0
        self.network_endpoint_after: int | None = None

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
            if self.fail_ps:
                return self._completed(
                    command,
                    returncode=1,
                    stderr="fixture ps query failed",
                )
            rows = []
            for value in self.containers.values():
                labels = value.get("Config", {}).get("Labels", {})
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
            self.network_inspect_count += 1
            identifier = self._match(self.networks, args[-1])
            if identifier is None:
                return self._completed(
                    command,
                    returncode=1,
                    stderr="No such network: " + args[-1],
                )
            value = self.networks[identifier]
            if (
                self.network_endpoint_after is not None
                and self.network_inspect_count >= self.network_endpoint_after
                and not value.get("Containers")
            ):
                value = dict(value)
                value["Containers"] = {
                    "foreign-container": {"Name": "foreign-container"}
                }
            return self._completed(
                command,
                stdout=json.dumps([value], ensure_ascii=False),
            )
        if args[:2] == ["stop", "--time"]:
            if self.fail_stop:
                return self._completed(
                    command,
                    returncode=1,
                    stderr="fixture stop failed",
                )
            identifier = self._match(self.containers, args[-1])
            if identifier is None:
                return self._completed(command, returncode=1, stderr="not found")
            if not self.stop_without_state_change:
                self.containers[identifier]["State"].update(
                    {"Running": False, "Paused": False, "Restarting": False}
                )
            return self._completed(command, stdout=args[-1] + "\n")
        if args[:1] == ["rm"]:
            identifier = self._match(self.containers, args[-1])
            if identifier is None:
                return self._completed(command, returncode=1, stderr="not found")
            if identifier in self.fail_rm_ids:
                return self._completed(
                    command,
                    returncode=1,
                    stderr="fixture container remove failed",
                )
            del self.containers[identifier]
            return self._completed(command, stdout=args[-1] + "\n")
        if args[:2] == ["network", "rm"]:
            identifier = self._match(self.networks, args[-1])
            if identifier is None:
                return self._completed(command, returncode=1, stderr="not found")
            value = self.networks[identifier]
            if value.get("Containers"):
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


class CleanTest(unittest.TestCase):
    def setUp(self) -> None:
        configured = os.environ.get("BENCH_TEST_TEMP_ROOT")
        parent = (
            Path(configured)
            if configured
            else Path(__file__).resolve().parents[3]
            / "临时文件夹"
            / "I4-1收口-20261030"
            / "I4-3b-clean-20261030"
            / "cases"
        )
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="clean-", dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def make_run(
        self,
        *,
        names: list[str],
        projects: list[str],
        terminal: bool = True,
    ) -> Path:
        run = self.root / "run-clean"
        run.mkdir()
        runner_common.write_json(run / "run-config.json", {"job_name": "controller-test"})
        runner_common.write_json(run / "run-freeze.json", {"files": []})
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
                "containers": names,
                "scope": {
                    "scope_complete": True,
                    "discovered_container_names": names,
                    "discovered_projects": projects,
                },
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
        runner_common.write_json(run / "run-sources.json", {})
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
                        "discovered_container_names": names,
                        "discovered_projects": projects,
                    },
                },
            )
        return run

    @staticmethod
    def standard_objects() -> tuple[dict[str, dict], dict[str, dict]]:
        containers = {
            CONTROLLER_ID: container_record(CONTROLLER_ID, CONTROLLER_NAME),
            "b" * 64: container_record(
                "b" * 64,
                "trial-one-env-1",
                project=ENV_PROJECT,
            ),
        }
        networks = {
            "c" * 64: network_record(
                "c" * 64,
                "trial-one-env_default",
                project=ENV_PROJECT,
            )
        }
        return containers, networks

    def standard_case(self) -> tuple[Path, FakeDocker, list[str], list[str]]:
        containers, networks = self.standard_objects()
        names = [
            value["Name"].lstrip("/")
            for value in containers.values()
        ]
        projects = [ENV_PROJECT]
        run = self.make_run(names=names, projects=projects)
        return run, FakeDocker(containers, networks), names, projects

    def test_preview_lists_exact_ids_and_execute_removes_owned_stopped_resources(self):
        run, fake, terminal_names, terminal_projects = self.standard_case()

        preview = clean_module.clean(run, runner=fake)

        self.assertTrue(preview["mode"] == "preview")
        self.assertTrue(preview["safe_to_execute"])
        self.assertEqual(
            {item["id"] for item in preview["containers"]},
            {CONTROLLER_ID, "b" * 64},
        )
        self.assertEqual({item["id"] for item in preview["networks"]}, {"c" * 64})
        self.assertIn(
            "approved-controller-id=" + CONTROLLER_ID,
            next(
                item for item in preview["containers"]
                if item["role"] == "controller"
            )["ownership"]["evidence"],
        )
        self.assertIn(
            "terminal-receipt-project",
            preview["networks"][0]["ownership"]["evidence"],
        )
        self.assertEqual(fake.mutations(), [])

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
            {CONTROLLER_ID, "b" * 64},
        )
        self.assertEqual(
            {item["id"] for item in result["deleted_networks"]},
            {"c" * 64},
        )
        self.assertFalse(fake.containers)
        self.assertFalse(fake.networks)
        self.assertTrue(
            any(call[1:2] == ["rm"] and call[-1] == "b" * 64 for call in fake.calls)
        )
        self.assertTrue(
            any(call[1:4] == ["network", "rm", "c" * 64] for call in fake.calls)
        )
        self.assertFalse(any(call[1:2] == ["prune"] for call in fake.calls))
        self.assertEqual(terminal_names, [item["name"] for item in preview["containers"]])
        self.assertEqual(terminal_projects, [ENV_PROJECT])

    def test_active_writer_is_preserved(self):
        containers, networks = self.standard_objects()
        containers["b" * 64]["State"]["Running"] = True
        names = [value["Name"].lstrip("/") for value in containers.values()]
        run = self.make_run(names=names, projects=[ENV_PROJECT])
        fake = FakeDocker(containers, networks)

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["safe_to_execute"])
        self.assertIn("active_writer", {item["stage"] for item in result["blockers"]})
        self.assertFalse(fake.mutations())
        self.assertIn("b" * 64, fake.containers)
        self.assertIn("c" * 64, fake.networks)

    def test_unknown_state_and_foreign_project_are_not_removed(self):
        containers = {
            CONTROLLER_ID: container_record(CONTROLLER_ID, CONTROLLER_NAME),
            "b" * 64: container_record(
                "b" * 64,
                "trial-one-env-1",
                project=ENV_PROJECT,
                state_known=False,
            ),
            "d" * 64: container_record(
                "d" * 64,
                "foreign-container",
                project="foreign-run__env",
            ),
        }
        names = [value["Name"].lstrip("/") for value in containers.values()]
        run = self.make_run(names=names, projects=[ENV_PROJECT])
        fake = FakeDocker(containers, {})

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertIn("unknown_writer", {item["stage"] for item in result["blockers"]})
        self.assertFalse(fake.mutations())
        self.assertIn("d" * 64, fake.containers)

    def test_network_with_foreign_endpoint_is_retained(self):
        containers = {
            CONTROLLER_ID: container_record(CONTROLLER_ID, CONTROLLER_NAME),
        }
        networks = {
            "c" * 64: network_record(
                "c" * 64,
                "trial-one-env_default",
                project=ENV_PROJECT,
                endpoints={"foreign": {"Name": "foreign-container"}},
            )
        }
        run = self.make_run(
            names=[CONTROLLER_NAME],
            projects=[ENV_PROJECT],
        )
        fake = FakeDocker(containers, networks)

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertTrue(result["ok"])
        self.assertFalse(result["completed"])
        self.assertTrue(any(call[1:2] == ["rm"] for call in fake.calls))
        self.assertFalse(any(call[1:3] == ["network", "rm"] for call in fake.calls))
        self.assertIn("c" * 64, fake.networks)
        self.assertEqual(result["networks"][0]["endpoint_count"], 1)

    def test_stop_failure_is_recorded_and_prevents_all_removal(self):
        containers = {
            CONTROLLER_ID: container_record(
                CONTROLLER_ID,
                CONTROLLER_NAME,
                running=True,
            ),
        }
        run = self.make_run(names=[CONTROLLER_NAME], projects=[ENV_PROJECT])
        fake = FakeDocker(containers, {})
        fake.fail_stop = True

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["completed"])
        self.assertIn("stop_controller", {item["stage"] for item in result["blockers"]})
        self.assertTrue(any(call[1:2] == ["stop"] for call in fake.calls))
        self.assertFalse(any(call[1:2] == ["rm"] for call in fake.calls))
        self.assertIn(CONTROLLER_ID, fake.containers)
        receipt = runner_common.read_json(run / "clean-receipt.json")
        self.assertFalse(receipt["attempts"][-1]["completed"])
        self.assertTrue(receipt["attempts"][-1]["blockers"])

    def test_partial_success_and_failure_are_preserved_in_receipt(self):
        run, fake, _, _ = self.standard_case()
        fake.fail_rm_ids.add("b" * 64)

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["completed"])
        self.assertEqual(
            {item["id"] for item in result["deleted_containers"]},
            {CONTROLLER_ID},
        )
        self.assertFalse(any(call[1:3] == ["network", "rm"] for call in fake.calls))
        self.assertIn("b" * 64, fake.containers)
        self.assertIn("c" * 64, fake.networks)
        receipt = runner_common.read_json(run / "clean-receipt.json")
        attempt = receipt["attempts"][-1]
        self.assertEqual(
            {item["id"] for item in attempt["deleted_containers"]},
            {CONTROLLER_ID},
        )
        self.assertTrue(attempt["errors"])
        self.assertTrue(attempt["actions"])
        self.assertFalse(attempt["completed"])

    def test_controller_still_running_after_stop_prevents_all_removal(self):
        containers = {
            CONTROLLER_ID: container_record(
                CONTROLLER_ID,
                CONTROLLER_NAME,
                running=True,
            ),
        }
        run = self.make_run(names=[CONTROLLER_NAME], projects=[ENV_PROJECT])
        fake = FakeDocker(containers, {})
        fake.stop_without_state_change = True

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["completed"])
        self.assertIn(
            "controller_still_active",
            {item["stage"] for item in result["blockers"]},
        )
        self.assertTrue(any(call[1:2] == ["stop"] for call in fake.calls))
        self.assertFalse(any(call[1:2] == ["rm"] for call in fake.calls))
        self.assertIn(CONTROLLER_ID, fake.containers)

    def test_live_controller_can_stop_then_reinspect_and_remove(self):
        containers = {
            CONTROLLER_ID: container_record(
                CONTROLLER_ID,
                CONTROLLER_NAME,
                running=True,
            ),
        }
        run = self.make_run(names=[CONTROLLER_NAME], projects=[ENV_PROJECT])
        fake = FakeDocker(containers, {})

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertTrue(result["ok"])
        self.assertTrue(result["completed"])
        self.assertEqual(result["actions"][0]["action"], "stop_controller")
        self.assertEqual(result["actions"][-1]["action"], "remove_container")
        self.assertFalse(fake.containers)

    def test_second_execute_has_no_duplicate_mutations(self):
        run, fake, _, _ = self.standard_case()
        first = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )
        self.assertTrue(first["completed"])
        first_mutations = fake.mutations()
        self.assertEqual(len(first_mutations), 3)
        fake.calls.clear()

        second = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertTrue(second["ok"])
        self.assertTrue(second["completed"])
        self.assertFalse(fake.mutations())
        self.assertEqual(
            {item["id"] for item in second["already_deleted_containers"]},
            {CONTROLLER_ID, "b" * 64},
        )
        self.assertEqual(
            {item["id"] for item in second["already_deleted_networks"]},
            {"c" * 64},
        )

    def test_reused_controller_name_with_new_id_is_rejected(self):
        replacements = {
            "e" * 64: container_record(
                "e" * 64,
                CONTROLLER_NAME,
                running=True,
            ),
        }
        run = self.make_run(names=[CONTROLLER_NAME], projects=[ENV_PROJECT])
        fake = FakeDocker(replacements, {})

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertIn("container_identity", {item["stage"] for item in result["blockers"]})
        self.assertFalse(fake.mutations())
        self.assertIn("e" * 64, fake.containers)

    def test_query_failure_is_exposed_and_is_not_absence(self):
        run = self.make_run(names=[CONTROLLER_NAME], projects=[ENV_PROJECT])
        fake = FakeDocker({}, {})
        fake.fail_ps = True

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["safe_to_execute"])
        self.assertTrue(result["errors"])
        self.assertEqual(result["already_deleted_containers"], [])
        self.assertFalse(fake.mutations())
        receipt = runner_common.read_json(run / "clean-receipt.json")
        self.assertTrue(receipt["attempts"][-1]["errors"])

    def test_unreceipted_disappearance_is_not_treated_as_completed(self):
        missing_name = "trial-one-env-missing"
        containers = {
            CONTROLLER_ID: container_record(CONTROLLER_ID, CONTROLLER_NAME),
        }
        run = self.make_run(
            names=[CONTROLLER_NAME, missing_name],
            projects=[ENV_PROJECT],
        )
        fake = FakeDocker(containers, {})

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["completed"])
        self.assertIn(
            missing_name,
            result["missing_terminal_containers"],
        )
        self.assertIn(
            "missing_container_resource",
            {item["stage"] for item in result["blockers"]},
        )
        self.assertFalse(fake.mutations())
        self.assertIn(CONTROLLER_ID, fake.containers)

    def test_missing_terminal_receipt_blocks_deletion(self):
        containers = {
            CONTROLLER_ID: container_record(CONTROLLER_ID, CONTROLLER_NAME),
        }
        run = self.make_run(
            names=[CONTROLLER_NAME],
            projects=[ENV_PROJECT],
            terminal=False,
        )
        fake = FakeDocker(containers, {})

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["completed"])
        self.assertIn("evidence", {item["stage"] for item in result["blockers"]})
        self.assertFalse(fake.mutations())
        self.assertIn(CONTROLLER_ID, fake.containers)

    def test_network_endpoint_race_preserves_network(self):
        containers = {
            CONTROLLER_ID: container_record(CONTROLLER_ID, CONTROLLER_NAME),
        }
        networks = {
            "c" * 64: network_record(
                "c" * 64,
                "trial-one-env_default",
                project=ENV_PROJECT,
                endpoints={},
            )
        }
        run = self.make_run(names=[CONTROLLER_NAME], projects=[ENV_PROJECT])
        fake = FakeDocker(containers, networks)
        fake.network_endpoint_after = 3

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            runner=fake,
        )

        self.assertTrue(result["ok"])
        self.assertFalse(result["completed"])
        self.assertFalse(any(call[1:3] == ["network", "rm"] for call in fake.calls))
        self.assertIn("c" * 64, fake.networks)
        retained = next(
            item for item in result["actions"]
            if item["action"] == "remove_network"
        )
        self.assertTrue(retained["retained"])
        self.assertTrue(
            any("endpoint" in reason for reason in retained["reason"])
        )


if __name__ == "__main__":
    unittest.main()
