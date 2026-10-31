"""验证单一命令入口、网络选择与清理授权的无模型测试。"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from bench import clean as clean_module
from bench import cli
from bench import controller
from bench import network
from bench import report as report_module
from bench import runner_common
from bench.tests.test_clean import (
    FakeDocker,
    container_record,
    network_record,
)


CONTROLLER_ID = "a" * 64
TRIAL_CONTAINER_ID = "b" * 64
NETWORK_ID = "c" * 64
CONTROLLER_NAME = "controller-test"
TRIAL_CONTAINER_NAME = "trial-one-env-1"
ENV_PROJECT = "trial-one__env"
CREATED_AT = "2026-10-30T10:00:00Z"
RECEIPT_AT = "2026-10-30T12:00:00+00:00"


class CliTest(unittest.TestCase):
    def setUp(self) -> None:
        configured = os.environ.get("BENCH_TEST_TEMP_ROOT")
        parent = (
            Path(configured)
            if configured
            else Path(__file__).resolve().parents[3]
            / "临时文件夹"
            / "I4-1收口-20261030"
            / "I4-4a-product-cli-20261030"
            / "cli-tests"
        )
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="pao-bench-cli-", dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def test_parser_exposes_the_eight_supported_commands(self) -> None:
        parser = cli._build_parser()
        samples = {
            "doctor": [],
            "prepare": ["--sources", "sources.json"],
            "run": [
                "--run",
                "run",
                "--authorize-real-model-calls",
                "--authorize-docker",
            ],
            "status": ["--run", "run"],
            "collect": ["--run", "run"],
            "score": [
                "--run",
                "run",
                "--score-spec",
                "score.json",
                "--authorize-docker",
            ],
            "report": ["--run", "run"],
            "clean": ["--run", "run"],
        }
        for command, arguments in samples.items():
            with self.subTest(command=command):
                self.assertEqual(parser.parse_args([command, *arguments]).command, command)

    def test_run_rejects_missing_authorization_before_prepare(self) -> None:
        with (
            mock.patch.object(cli.prepare_module, "prepare") as prepare,
            mock.patch("sys.stderr", new=io.StringIO()),
            mock.patch("sys.stdout", new=io.StringIO()),
        ):
            exit_code = cli.main(["run", "--sources", "sources.json"])
        self.assertEqual(exit_code, 1)
        prepare.assert_not_called()

    def test_rehearsal_rejects_real_run_input_without_preparing_or_launching(self) -> None:
        with (
            mock.patch.object(cli.prepare_module, "prepare") as prepare,
            mock.patch.object(cli.launch, "launch") as launch,
            mock.patch("sys.stderr", new=io.StringIO()),
            mock.patch("sys.stdout", new=io.StringIO()),
        ):
            exit_code = cli.main(
                [
                    "run",
                    "--run",
                    "prepared-run",
                    "--rehearsal",
                ]
            )
        self.assertEqual(exit_code, 1)
        prepare.assert_not_called()
        launch.assert_not_called()

    def test_real_run_passes_network_observation_to_prepare(self) -> None:
        observation = {"ok": True, "candidate_subnet": "10.243.0.0/24"}
        run = self.root / "prepared"
        with (
            mock.patch.object(network, "observe_live_networks", return_value=observation) as observe,
            mock.patch.object(cli.prepare_module, "prepare", return_value={"run": str(run)}) as prepare,
            mock.patch.object(cli.launch, "write_launch_authorization"),
            mock.patch.object(cli.launch, "launch", return_value={}) as launch,
            mock.patch("sys.stdout", new=io.StringIO()),
        ):
            result = cli.main(["run", "--sources", "sources.json", "--docker", "fixture-docker",
                               "--authorize-real-model-calls", "--authorize-docker"])
        self.assertEqual(result, 0)
        observe.assert_called_once_with("fixture-docker")
        prepare.assert_called_once_with(Path("sources.json"), network_observation=observation)
        launch.assert_called_once()

    def test_failed_network_observation_prevents_prepare_and_launch(self) -> None:
        with (
            mock.patch.object(network, "observe_live_networks", return_value={"ok": False, "error": "route unreadable"}),
            mock.patch.object(cli.prepare_module, "prepare") as prepare,
            mock.patch.object(cli.launch, "launch") as launch,
            mock.patch("sys.stdout", new=io.StringIO()),
            mock.patch("sys.stderr", new=io.StringIO()),
        ):
            result = cli.main(["run", "--sources", "sources.json",
                               "--authorize-real-model-calls", "--authorize-docker"])
        self.assertEqual(result, 1)
        prepare.assert_not_called()
        launch.assert_not_called()

    def test_network_failure_keeps_created_resource_evidence(self) -> None:
        error = cli.launch.network_runtime.NetworkRuntimeError(
            "receipt write failed", stage="write_receipt", evidence={"network_id": NETWORK_ID}
        )
        output = io.StringIO()
        with (
            mock.patch.object(cli.launch, "write_launch_authorization"),
            mock.patch.object(cli.launch, "launch", side_effect=error),
            mock.patch("sys.stdout", new=output),
            mock.patch("sys.stderr", new=io.StringIO()),
        ):
            result = cli.main(["run", "--run", str(self.root),
                               "--authorize-real-model-calls", "--authorize-docker"])
        self.assertEqual(result, 1)
        recorded = json.loads(output.getvalue())
        self.assertEqual(recorded["stage"], "write_receipt")
        self.assertEqual(recorded["evidence"]["network_id"], NETWORK_ID)

    def test_doctor_reports_network_check_failure_without_traceback_escape(self) -> None:
        failure = RuntimeError("fixture network check failed")
        with mock.patch.object(
            network,
            "observe_live_networks",
            side_effect=failure,
        ):
            result, exit_code = cli.doctor()
        self.assertEqual(exit_code, 1)
        self.assertFalse(result["ok"])
        self.assertEqual(
            result["checks"]["network"]["error_type"],
            "RuntimeError",
        )
        self.assertFalse(result["checks"]["network"]["writes_performed"])

    def test_status_observation_failure_only_records_evidence(self) -> None:
        run = self.root / "run"
        run.mkdir()
        control_path = run / "control-status.json"
        runner_common.write_json(
            control_path,
            {"state": "running", "writers_stopped": False},
        )
        before = control_path.read_bytes()
        failure = subprocess.TimeoutExpired(["docker", "ps"], 15)

        with mock.patch.object(cli.watch, "observe_once", side_effect=failure):
            result = cli._status_payload(run, "controller-test", "fixture-docker")

        self.assertFalse(result["ok"])
        self.assertEqual(result["control_status"]["state"], "running")
        self.assertEqual(control_path.read_bytes(), before)
        self.assertTrue((run / "observations.jsonl").is_file())
        recorded = runner_common.read_json(run / "observer-errors.json")
        self.assertEqual(recorded["errors"][0]["stage"], "status_observation")
        self.assertFalse((run / "mechanism-acceptance-stopped.json").exists())

    def test_report_keeps_incomplete_business_as_nonzero(self) -> None:
        run = self.root / "run"
        run.mkdir()
        runner_common.write_json(
            run / "control-status.json",
            {"state": "paused", "writers_stopped": True},
        )
        with mock.patch("sys.stdout", new=io.StringIO()):
            exit_code = cli.main(["report", "--run", str(run)])
        self.assertEqual(exit_code, 1)
        generated = runner_common.read_json(run / "report.json")
        self.assertFalse(generated["business_complete"])
        self.assertIn("未完成或失败", (run / "report.md").read_text(encoding="utf-8"))

    def test_network_selection_uses_ip_network_overlap(self) -> None:
        selected = network.select_free_subnet(
            {"networks": [{"IPAM": {"Config": [{"Subnet": "10.243.1.0/24"}]}}]},
            {"routes": [{"destination": "10.243.2.128/25"}]},
        )
        self.assertEqual(str(selected), "10.243.0.0/24")

        selected = network.select_free_subnet(
            {"networks": [{"IPAM": {"Config": [{"Subnet": "10.243.2.0/24"}]}}]},
            {"routes": [{"destination": "10.243.0.0/23"}]},
        )
        self.assertEqual(str(selected), "10.243.3.0/24")

    def test_network_pool_exhaustion_is_reported_not_raised(self) -> None:
        docker_state = {
            "ok": True,
            "networks": [{"IPAM": {"Config": [{"Subnet": "10.0.0.0/8"}]}}],
            "source": "fixture-docker",
        }
        route_state = {"ok": True, "networks": [], "source": "fixture-route"}
        with (
            mock.patch.object(network, "docker_network_inputs", return_value=docker_state),
            mock.patch.object(network, "host_route_inputs", return_value=route_state),
        ):
            result = network.observe_live_networks("fixture-docker")
        self.assertFalse(result["ok"])
        self.assertIsNone(result["candidate_subnet"])
        self.assertFalse(result["writes_performed"])

    def make_clean_run(self) -> tuple[Path, FakeDocker]:
        run = self.root / "run-identity"
        run.mkdir()
        config = {"job_name": "controller-test"}
        runner_common.write_json(run / "run-config.json", config)
        runner_common.write_json(run / "run-freeze.json", {"files": []})
        launch = {
            "at": CREATED_AT,
            "container_name": CONTROLLER_NAME,
            "container_id": CONTROLLER_ID,
            "image_id": "sha256:" + "a" * 64,
        }
        runner_common.write_json(run / "runtime-launch.json", launch)
        names = [CONTROLLER_NAME, TRIAL_CONTAINER_NAME]
        projects = [ENV_PROJECT]
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
        trial_dir = run / "jobs" / "job-one" / "trial-one"
        trial_dir.mkdir(parents=True)
        runner_common.write_json(
            run / "jobs" / "job-one" / "config.json",
            {"job_name": "formal"},
        )
        runner_common.write_json(
            trial_dir / "config.json",
            {"trial_name": "trial-one"},
        )
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
        containers = {
            CONTROLLER_ID: container_record(
                CONTROLLER_ID,
                CONTROLLER_NAME,
            ),
            TRIAL_CONTAINER_ID: container_record(
                TRIAL_CONTAINER_ID,
                TRIAL_CONTAINER_NAME,
                project=ENV_PROJECT,
            ),
        }
        networks = {
            NETWORK_ID: network_record(
                NETWORK_ID,
                "trial-one-env_default",
                project=ENV_PROJECT,
            )
        }
        return run, FakeDocker(containers, networks)

    def test_clean_preview_lists_exact_ids_without_mutation(self) -> None:
        run, fake = self.make_clean_run()

        result = clean_module.clean(run, execute=False, runner=fake)

        self.assertEqual(result["mode"], "preview")
        self.assertTrue(result["safe_to_execute"])
        self.assertEqual(
            {item["id"] for item in result["containers"]},
            {CONTROLLER_ID, TRIAL_CONTAINER_ID},
        )
        self.assertEqual(
            {item["id"] for item in result["networks"]},
            {NETWORK_ID},
        )
        self.assertEqual(fake.mutations(), [])

    def test_clean_execute_requires_exact_run_confirmation(self) -> None:
        run, _fake = self.make_clean_run()
        with self.assertRaisesRegex(ValueError, "confirm-run"):
            clean_module.clean(run, execute=True, confirm_run=None)

    def test_clean_execute_removes_only_exact_owned_stopped_ids(self) -> None:
        run, fake = self.make_clean_run()

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
        self.assertEqual(
            {tuple(call) for call in fake.mutations()},
            {
                ("fixture-docker", "rm", CONTROLLER_ID),
                ("fixture-docker", "rm", TRIAL_CONTAINER_ID),
                ("fixture-docker", "network", "rm", NETWORK_ID),
            },
        )
        self.assertFalse(any(call[1:2] == ["prune"] for call in fake.calls))
        self.assertFalse(fake.containers)
        self.assertFalse(fake.networks)

    def test_clean_execute_preserves_active_owned_container(self) -> None:
        run, fake = self.make_clean_run()
        fake.containers[TRIAL_CONTAINER_ID]["State"]["Running"] = True

        result = clean_module.clean(
            run,
            execute=True,
            confirm_run=run.name,
            docker="fixture-docker",
            runner=fake,
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["completed"])
        self.assertIn(TRIAL_CONTAINER_ID, fake.containers)
        self.assertFalse(
            any(
                call[1:2] == ["rm"] and call[-1] == TRIAL_CONTAINER_ID
                for call in fake.calls
            )
        )

    def test_clean_execute_rejects_identity_drift(self) -> None:
        run, _fake = self.make_clean_run()
        approval = runner_common.read_json(run / "launch-authorization.json")
        approval["run_config_sha256"] = "0" * 64
        runner_common.write_json(run / "launch-authorization.json", approval)
        with self.assertRaisesRegex(ValueError, "运行配置已经改变"):
            clean_module.clean(
                run,
                execute=True,
                confirm_run=run.name,
            )

    def test_clean_execute_requires_cli_authorization(self) -> None:
        run, _fake = self.make_clean_run()
        with (
            mock.patch("sys.stderr", new=io.StringIO()),
            mock.patch("sys.stdout", new=io.StringIO()),
            mock.patch.object(clean_module, "clean") as clean,
        ):
            exit_code = cli.main(
                [
                    "clean",
                    "--run",
                    str(run),
                    "--execute",
                    "--confirm-run",
                    run.name,
                ]
            )
        self.assertEqual(exit_code, 1)
        clean.assert_not_called()

    def test_clean_cli_returns_nonzero_for_blocked_preview(self) -> None:
        run, _fake = self.make_clean_run()
        blocked = {
            "ok": False,
            "completed": False,
            "blockers": [{"stage": "fixture", "reason": "blocked"}],
        }
        with (
            mock.patch("sys.stderr", new=io.StringIO()),
            mock.patch("sys.stdout", new=io.StringIO()),
            mock.patch.object(clean_module, "clean", return_value=blocked),
        ):
            exit_code = cli.main(["clean", "--run", str(run)])
        self.assertEqual(exit_code, 1)

    def test_clean_cli_execute_requires_completed_result(self) -> None:
        run, _fake = self.make_clean_run()
        incomplete = {"ok": True, "completed": False}
        with (
            mock.patch("sys.stderr", new=io.StringIO()),
            mock.patch("sys.stdout", new=io.StringIO()),
            mock.patch.object(clean_module, "clean", return_value=incomplete),
        ):
            exit_code = cli.main(
                [
                    "clean",
                    "--run",
                    str(run),
                    "--execute",
                    "--confirm-run",
                    run.name,
                    "--authorize-docker",
                ]
            )
        self.assertEqual(exit_code, 1)

    def test_report_module_does_not_fill_missing_reward(self) -> None:
        run = self.root / "report-run"
        run.mkdir()
        runner_common.write_json(
            run / "control-status.json",
            {"state": "execution_error", "writers_stopped": True},
        )
        result = report_module.generate(run)
        self.assertEqual(result["business"]["missing_reward_count"], 0)
        self.assertEqual(result["official_rewards"], [])
        self.assertFalse(result["business_complete"])
        self.assertNotIn('"reward": 0', (run / "report.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
