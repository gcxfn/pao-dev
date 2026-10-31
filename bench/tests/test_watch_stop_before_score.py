"""模拟 Docker：评分前取消与真实停写观察分开，不冒充业务成功。"""
import json
import os
from pathlib import Path
import tempfile
import unittest

from bench import controller, runner_common, watch
from bench.tests import test_runner


CONTROLLER_ID = "a" * 64


class StopBeforeScoreTest(unittest.TestCase):
    def setUp(self):
        parent = Path(os.environ.get("BENCH_TEST_TEMP_ROOT") or (
            Path(__file__).resolve().parents[3] / "临时文件夹" / "接续核验-20261030" / "I4-6-main"
        ))
        parent.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(temporary.cleanup)
        self.helper = test_runner.GovernanceRunnerTest()
        self.helper.root = Path(temporary.name).resolve()
        self.run_dir = self.helper.make_run()
        self.result_path = self.run_dir / "jobs" / "formal-job" / "trial-one" / "result.json"
        runner_common.write_json(self.result_path.parent / "config.json", {"trial_name": "trial-one"})
        runner_common.write_json(self.result_path, {
            "exception_info": {"exception_type": "TrialCancelledError"},
            "finished_at": "2026-10-30T01:36:52Z", "verifier_result": None, "verifier": None,
        })
        runner_common.write_json(self.run_dir / "control-status.json", {
            "state": "stop_unconfirmed", "writers_stopped": False, "error": "cancel confirmation deadline",
        })
        (self.run_dir / "approved-controller-id.txt").write_text(CONTROLLER_ID, encoding="utf-8")
        runner_common.write_json(self.run_dir / "runtime-launch.json", {
            "container_id": CONTROLLER_ID, "container_name": "controller-test",
        })
        self.controller_running = False
        self.verifier_state = None
        self.actual_id = CONTROLLER_ID
        self.fail_enumeration = False
        self.env_project = controller.compose_project("trial-one", "env")

    def runner(self, docker, *args, **kwargs):
        if args[0] == "ps":
            if self.fail_enumeration:
                raise RuntimeError("Docker enumeration unavailable")
            rows = [self.helper.docker_row("controller-test", "", self.controller_running),
                    self.helper.docker_row("trial-one-env-1", self.env_project, False)]
            if self.verifier_state is not None:
                rows.append(self.helper.docker_row("trial-one-verifier-1", controller.compose_project("trial-one", "verifier") + "__trial", False))
            return "\n".join(rows)
        if args[:3] == ("inspect", "--format", "{{.Id}}"):
            return self.actual_id
        if args[-1] == "controller-test":
            return self.helper.state(True) if self.controller_running else self.helper.crashed_state(1)
        if args[-1] == "trial-one-verifier-1":
            return json.dumps(self.verifier_state)
        return self.helper.state(False)

    def observe(self):
        return watch.observe_once(self.run_dir, "controller-test", runner=self.runner)

    def test_crash_before_score_can_confirm_stop_without_rewriting_failure(self):
        before = (self.run_dir / "control-status.json").read_bytes()
        result = self.observe()
        self.assertTrue(result["terminal"])
        self.assertTrue(result["actual_stop_observed"])
        self.assertFalse(result["writers_stopped"])
        self.assertEqual((self.run_dir / "control-status.json").read_bytes(), before)
        receipt = runner_common.read_json(self.run_dir / "terminal-receipt.json")
        self.assertEqual(receipt["official_rewards"], [])
        self.assertFalse(receipt["business_terminal"]["business_finished"])
        self.assertEqual(len(receipt["scope"]["retired_uncreated_stages"]), 1)

    def test_live_creator_or_missing_trial_failure_cannot_retire_verifier(self):
        self.controller_running = True
        self.assertFalse(self.observe()["terminal"])
        self.controller_running = False
        self.result_path.unlink()
        self.assertFalse(self.observe()["terminal"])

    def test_created_verifier_must_be_explicitly_stopped(self):
        self.verifier_state = json.loads(self.helper.state(True))
        self.assertFalse(self.observe()["terminal"])
        self.verifier_state = {}
        with self.assertRaisesRegex(ValueError, "状态字段不完整"):
            self.observe()
        self.assertFalse((self.run_dir / "terminal-receipt.json").exists())

    def test_identity_mismatch_or_incomplete_enumeration_is_not_stop_proof(self):
        self.actual_id = "b" * 64
        with self.assertRaisesRegex(ValueError, "完整 ID"):
            self.observe()
        self.fail_enumeration = True
        with self.assertRaisesRegex(RuntimeError, "enumeration"):
            self.observe()

    def test_missing_environment_or_started_verifier_remains_unknown(self):
        self.env_project = "foreign-project"
        self.assertFalse(self.observe()["terminal"])
        self.env_project = controller.compose_project("trial-one", "env")
        trial = runner_common.read_json(self.result_path)
        trial["verifier"] = {"started_at": "2026-10-30T01:36:00Z"}
        runner_common.write_json(self.result_path, trial)
        self.assertFalse(self.observe()["terminal"])
