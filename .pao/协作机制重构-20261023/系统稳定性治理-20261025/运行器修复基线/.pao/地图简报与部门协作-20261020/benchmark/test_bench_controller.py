"""明确离线控制夹具：不导入 Harbor、不运行 Docker、不调用模型。"""
import asyncio
import copy
import json
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import bench_controller as controller


class ControllerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pao-bench-control-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = {"job_name": "offline", "jobs_dir": str(self.root / "jobs"),
            "tasks": [{"name": "first"}, {"name": "second"}, {"name": "third"}],
            "agents": [{"import_path": "map_bench_pao_organized:OrganizedPAOAgent", "kwargs": {"fixed": True}}],
            "verifier": {"disable": False}, "n_attempts": 1,
            "retry": {"max_retries": 0}, "n_concurrent_trials": 1}
        self.config["environment"] = {"type": "docker", "kwargs": {"keep_containers": True}}
        self.config["agents"][0]["kwargs"] = {
            key: ("post-pao" if key == "profile" else "/fixture/node.tar.xz" if key == "node_archive" else "f" * 64)
            for key in controller.CONFIG_IDENTITY_KEYS}
        files = ["run-config.json", "preparation_agent.py", "map_bench_pao_organized.py",
                 "map_bench_pao/__init__.py", "map_bench_pao/pao_agent.py", "map_bench_pao/usage.py"]
        controller.write(self.root / "run-config.json", self.config)
        for relative in files[1:]:
            path = self.root / relative
            path.parent.mkdir(exist_ok=True)
            path.write_text("# 离线冻结夹具\n", encoding="utf-8")
        controller.write(self.root / "run-freeze.json", {"files": [
            {"path": relative, "sha256": controller.digest(self.root / relative)} for relative in files]})
        self.calls = []

    async def sequence(self, execute):
        return await controller.run_sequence(self.root, self.config, execute,
                                             observe=lambda run, config: None)

    def control(self, **updates):
        fields = {"版本": 2, "实例": "instance-one", "owner": "owner-one", "工作流": "基准开发流水线",
                  "状态": "运行中", "冻结配方": {"名字": "基准开发流水线", "节点": [{"名字": "实施"}]},
                  "记录": [{"时间": "2026-10-24T00:00:00Z", "事件": "启动", "理由": "离线夹具"}]}
        fields.update(updates)
        path = self.root / controller.INSTANCE_RELATIVE
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("---\n" + controller.yaml.safe_dump(fields, allow_unicode=True) + "---\n", encoding="utf-8")
        return path

    async def execute(self, config):
        self.calls.append(copy.deepcopy(config))
        return {"trial_results": [{"verifier_result": {"rewards": {"reward": 0.0}}}
                                   for _ in config["tasks"]]}

    async def test_serial_preserves_agent_and_zero_reward_is_valid(self):
        await self.sequence(self.execute)
        self.assertEqual(len(self.calls), 4)
        self.assertEqual([c["tasks"] for c in self.calls[1:]], [[task] for task in self.config["tasks"]])
        self.assertTrue(all(c["agents"] == self.config["agents"] for c in self.calls[1:]))
        self.assertEqual(controller.read(self.root / "control-status.json")["state"], "finished")
        with self.assertRaises(FileExistsError):
            await self.sequence(self.execute)

    async def test_after_current_does_not_start_remaining(self):
        async def execute(config):
            result = await self.execute(config)
            if config["job_name"].endswith("task-1"):
                controller.request_pause(self.root, after_current=True)
            return result
        await self.sequence(execute)
        self.assertEqual(len(self.calls), 2)
        status = controller.read(self.root / "control-status.json")
        self.assertEqual(status["state"], "paused")
        self.assertTrue(status["writers_stopped"])
        self.assertEqual(len(status["completed"]), 1)

    async def test_immediate_waits_for_cleanup(self):
        started = asyncio.Event()
        cleaned = False
        async def execute(config):
            nonlocal cleaned
            if config["job_name"].endswith("preflight"):
                return await self.execute(config)
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0.02)
                cleaned = True
        running = asyncio.create_task(self.sequence(execute))
        await started.wait()
        controller.request_pause(self.root)
        controller.request_pause(self.root, after_current=True)
        self.assertEqual(controller.request(self.root), "immediate")
        await running
        self.assertTrue(cleaned)
        self.assertTrue(controller.read(self.root / "control-status.json")["writers_stopped"])

    async def test_preflight_failure_calls_no_formal_agent(self):
        async def execute(config):
            self.calls.append(config)
            return {"trial_results": [{"exception_info": {"error": "fixture setup failure"}}]}
        with self.assertRaisesRegex(RuntimeError, "预检"):
            await self.sequence(execute)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(controller.read(self.root / "control-status.json")["state"], "failed")

    async def test_pause_rechecks_terminal_after_writers_cleanup(self):
        started = asyncio.Event()
        cleaned = False
        terminal_observed = False
        async def execute(config):
            nonlocal cleaned
            if config["job_name"].endswith("preflight"):
                return await self.execute(config)
            try:
                started.set()
                await asyncio.Event().wait()
            finally:
                cleaned = True
        def observe(run, config):
            nonlocal terminal_observed
            if cleaned:
                terminal_observed = True
                raise ValueError("模拟终局正本已搬走")
        running = asyncio.create_task(controller.run_sequence(self.root, self.config, execute, observe=observe))
        await started.wait()
        controller.request_pause(self.root)
        await running
        self.assertTrue(terminal_observed)
        status = controller.read(self.root / "control-status.json")
        self.assertEqual(status["state"], "mechanism_stopped")
        self.assertTrue(status["writers_stopped"])

    async def test_environment_failure_is_not_zero_score(self):
        self.assertEqual(controller.classify_result({"trial_results": [{"exception_info": {"error": "env"}}]}), "execution_error")
        self.assertEqual(controller.classify_result({"trial_results": [{"verifier_result": None}]}), "missing_score")

    async def test_frozen_config_tamper_and_path_escape_rejected(self):
        controller.write(self.root / "run-config.json", self.config)
        files = ["run-config.json", "preparation_agent.py", "map_bench_pao_organized.py",
                 "map_bench_pao/__init__.py", "map_bench_pao/pao_agent.py", "map_bench_pao/usage.py"]
        for relative in files[1:]:
            path = self.root / relative
            path.parent.mkdir(exist_ok=True)
            path.write_text("# 明确离线夹具\n", encoding="utf-8")
        controller.write(self.root / "run-freeze.json", {"files": [
            {"path": relative, "sha256": controller.digest(self.root / relative)} for relative in files]})
        self.assertEqual(controller.validate(self.root), self.config)
        (self.root / "run-config.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "冻结输入"):
            controller.validate(self.root)
        with self.assertRaisesRegex(ValueError, "越过"):
            controller.inside(self.root, "../outside")

    async def test_missing_adapter_freeze_is_rejected(self):
        controller.write(self.root / "run-config.json", self.config)
        controller.write(self.root / "run-freeze.json", {"files": [
            {"path": "run-config.json", "sha256": controller.digest(self.root / "run-config.json")}]})
        with self.assertRaisesRegex(ValueError, "适配器"):
            controller.validate(self.root)

    async def test_formal_single_task_missing_or_extra_result_is_error(self):
        self.assertEqual(controller.classify_result({"trial_results": []}), "execution_error")
        self.assertEqual(controller.classify_result({"trial_results": [{}, {}]}), "execution_error")

    async def test_score_refuses_live_or_unconfirmed_writers_before_docker(self):
        controller.state(self.root, "running", writers_stopped=False)
        with self.assertRaisesRegex(RuntimeError, "停止"):
            controller.score_current(self.root, self.root / "missing.json", "no-docker-called")

    async def test_binding_recipe_change_and_missing_original_are_rejected(self):
        controller.ensure_identity(self.root, self.config)
        path = self.control()
        first = controller.observe_control_tree(self.root, self.root)
        self.assertEqual(first["observation"]["status"], "bound")
        self.assertIsNone(first["active_execution"])
        self.assertEqual(first["active_execution_status"], "unknown")
        self.control(冻结配方={"名字": "被改配方"})
        with self.assertRaisesRegex(ValueError, "recipe_changed"):
            controller.observe_control_tree(self.root, self.root)
        self.control()
        archived = self.root / ".pao/archive/工作流实例-基准开发流水线.md"
        archived.parent.mkdir(parents=True)
        path.rename(archived)
        with self.assertRaisesRegex(ValueError, "搬走"):
            controller.observe_control_tree(self.root, self.root)

    async def test_unquoted_yaml_time_remains_json_safe_in_real_control_shape(self):
        controller.ensure_identity(self.root, self.config)
        stamp = "2026-10-24T04:12:28.080Z"
        path = self.control(记录=[{"时间": stamp, "事件": "启动", "轮次": 1}],
                            裁定={"时间": stamp, "通道": "人工", "理由": "待处理"})
        text = path.read_text(encoding="utf-8").replace("'" + stamp + "'", stamp)
        path.write_text(text, encoding="utf-8")
        self.assertIn("时间: " + stamp, text)
        first = controller.observe_control_tree(self.root, self.root)
        second = controller.observe_control_tree(self.root, self.root)
        self.assertEqual(first["latest_business_event"]["时间"], stamp)
        self.assertEqual(first["latest_business_event"]["轮次"], 1)
        self.assertEqual(second["business_event_key"], first["business_event_key"])
        self.assertEqual(len((self.root / "notifications.jsonl").read_text(encoding="utf-8").splitlines()), 1)
        self.assertEqual(controller.read(self.root / "mechanism-progress.json")["latest_business_event"]["时间"], stamp)

    async def test_only_outer_new_task_can_bind_a_new_instance(self):
        controller.ensure_identity(self.root, self.config)
        first = {**self.config, "job_name": "offline-task-1"}
        second = {**self.config, "job_name": "offline-task-2"}
        controller.activate_task(self.root, first)
        self.control()
        controller.observe_control_tree(self.root, self.root)
        controller.activate_task(self.root, second)
        self.control(实例="instance-two")
        controller.observe_control_tree(self.root, self.root)
        identity = controller.read(self.root / "mechanism-identity.json")
        self.assertEqual(identity["task_bindings"][first["job_name"]]["instance_id"], "instance-one")
        self.assertEqual(identity["task_bindings"][second["job_name"]]["instance_id"], "instance-two")
        with self.assertRaisesRegex(ValueError, "重复启动"):
            controller.activate_task(self.root, first)

    async def test_instance_swap_and_duplicate_are_rejected(self):
        controller.ensure_identity(self.root, self.config)
        original = self.control()
        controller.observe_control_tree(self.root, self.root)
        self.control(实例="instance-two")
        with self.assertRaisesRegex(ValueError, "重建"):
            controller.observe_control_tree(self.root, self.root)
        self.control()
        another = self.root / ".pao/工作流实例-其他.md"
        another.write_text(original.read_text(encoding="utf-8"), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "其他实例"):
            controller.observe_control_tree(self.root, self.root)

    async def test_blocker_notifications_deduplicate_and_quiet_does_not_stop(self):
        controller.ensure_identity(self.root, self.config)
        self.control(裁定={"节点": "实施", "通道": "人工", "理由": "需要用户"})
        controller.observe_business(self.root, self.root)
        controller.observe_business(self.root, self.root)
        self.assertTrue(controller.read(self.root / "mechanism-progress.json")["needs_manual_check"])
        notifications = (self.root / "notifications.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(notifications), 1)
        self.control()
        controller.observe_business(self.root, self.root)
        progress = controller.read(self.root / "mechanism-progress.json")
        self.assertFalse(progress["needs_manual_check"])
        progress["progress_observed_at"] = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat()
        controller.write(self.root / "mechanism-progress.json", progress)
        quiet = controller.observe_business(self.root, self.root)
        self.assertTrue(quiet["needs_manual_check"])
        self.assertFalse((self.root / "mechanism-acceptance-stopped.json").exists())

    async def test_supervision_violation_waits_for_writers_and_does_not_run_next_task(self):
        cleaned = False
        started = asyncio.Event()
        async def execute(config):
            nonlocal cleaned
            if config["job_name"].endswith("preflight"):
                return await self.execute(config)
            try:
                started.set()
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0.02)
                cleaned = True
        def observe(run, config):
            if started.is_set():
                raise ValueError("离线配方篡改")
        await controller.run_sequence(self.root, self.config, execute, observe=observe)
        self.assertTrue(cleaned)
        status = controller.read(self.root / "control-status.json")
        self.assertEqual(status["state"], "mechanism_stopped")
        self.assertTrue(status["writers_stopped"])
        self.assertEqual(status["completed"], [])


if __name__ == "__main__":
    unittest.main()
