"""明确离线控制夹具：不导入 Harbor、不运行 Docker、不调用模型。"""
import asyncio
import copy
import ctypes
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
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
        files = [
            "run-config.json",
            "preparation_agent.py",
            "map_bench_pao_organized.py",
            "map_bench_pao/__init__.py",
            "map_bench_pao/pao_agent.py",
            "map_bench_pao/usage.py",
            "model-metadata.json",
        ]
        controller.write(self.root / "run-config.json", self.config)
        for relative in files[1:]:
            path = self.root / relative
            path.parent.mkdir(exist_ok=True)
            path.write_text("# 离线冻结夹具\n", encoding="utf-8")
        controller.write(self.root / "run-freeze.json", {"files": [
            {"path": relative, "sha256": controller.digest(self.root / relative)} for relative in files]})
        self.calls = []

    def docker_fixture(self, name, script):
        helper = self.root / f"{name}.py"
        helper.write_text(script, encoding="utf-8")
        if os.name == "nt":
            launcher = self.root / f"{name}.cmd"
            launcher.write_bytes(
                (
                    "@echo off\r\n"
                    f"\"{sys.executable}\" \"{helper}\" %*\r\n"
                    "exit /b %errorlevel%\r\n"
                ).encode("ascii")
            )
            return launcher
        launcher = self.root / name
        launcher.write_text(f"#!{sys.executable}\n{script}", encoding="utf-8")
        launcher.chmod(0o755)
        return launcher

    def assert_process_exited(self, pid, timeout=4):
        def alive():
            if os.name != "nt":
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    return False
                return True
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            handle = kernel32.OpenProcess(0x1000, False, pid)
            if not handle:
                return False
            try:
                exit_code = ctypes.c_ulong()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    raise ctypes.WinError(ctypes.get_last_error())
                return exit_code.value == 259
            finally:
                kernel32.CloseHandle(handle)

        deadline = time.monotonic() + timeout
        while alive() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(alive(), f"夹具子进程没有退出：{pid}")

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
        for reward in ("0.5", True, None, float("nan"), float("inf")):
            with self.subTest(reward=reward):
                self.assertEqual(
                    controller.classify_result(
                        {
                            "trial_results": [
                                {"verifier_result": {"rewards": {"reward": reward}}}
                            ]
                        }
                    ),
                    "missing_score",
                )
        self.assertEqual(
            controller.classify_result(
                {"trial_results": [{"verifier_result": {"rewards": {"reward": 0.0}}}]}
            ),
            "finished",
        )

    async def test_frozen_config_tamper_and_path_escape_rejected(self):
        config = copy.deepcopy(self.config)
        config["tasks"] = [{"name": "terminal-bench/html-js-filter"}]
        config["agents"][0].update({
            "model_name": "harbor-endpoint/minimax-code/MiniMax-Test",
            "model_api_key_name": "PAO_BENCH_API_KEY",
            "source_metadata": {
                "model_name": "harbor-endpoint/minimax-code/MiniMax-Test",
                "selected_model_name": "openai/minimax-code/MiniMax-Test",
                "provider": "harbor-endpoint",
                "model": "minimax-code/MiniMax-Test",
                "thinking": "high",
            },
        })
        config["agents"][0]["kwargs"].update({
            "profile": "post-pao",
            "thinking": "high",
            "no_extensions": False,
            "tools": "read,bash,edit,write",
        })
        controller.write(self.root / "run-config.json", config)
        files = ["run-config.json", "preparation_agent.py", "map_bench_pao_organized.py",
                 "map_bench_pao/__init__.py", "map_bench_pao/pao_agent.py", "map_bench_pao/usage.py"]
        for relative in files[1:]:
            path = self.root / relative
            path.parent.mkdir(exist_ok=True)
            path.write_text("# 明确离线夹具\n", encoding="utf-8")
        (self.root / "model-metadata.json").write_text(
            "# 明确离线冻结夹具\n",
            encoding="utf-8",
        )
        controller.write(self.root / "run-freeze.json", {"files": [
            {"path": relative, "sha256": controller.digest(self.root / relative)}
            for relative in [*files, "model-metadata.json"]
        ]})
        self.assertEqual(controller.validate(self.root), config)
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

    async def test_harbor_business_and_cleanup_errors_are_both_preserved(self):
        import types

        class Job:
            @classmethod
            async def create(cls, config):
                return cls()

            async def run(self):
                raise RuntimeError("business failed")

        class JobConfig:
            @classmethod
            def model_validate(cls, value):
                return value

        modules = {
            "harbor": types.ModuleType("harbor"),
            "harbor.job": types.ModuleType("harbor.job"),
            "harbor.models": types.ModuleType("harbor.models"),
            "harbor.models.job": types.ModuleType("harbor.models.job"),
            "harbor.models.job.config": types.ModuleType(
                "harbor.models.job.config"
            ),
        }
        modules["harbor.job"].Job = Job
        modules["harbor.models.job.config"].JobConfig = JobConfig
        originals = {name: sys.modules.get(name) for name in modules}
        sys.modules.update(modules)
        original_command = controller.command

        def command(*args, **kwargs):
            raise RuntimeError("cleanup query failed")

        controller.command = command
        config = copy.deepcopy(self.config)
        config["jobs_dir"] = str(self.root / "jobs")
        try:
            with self.assertRaises(BaseExceptionGroup) as raised:
                await controller.harbor_execute(config, docker="mock-docker")
        finally:
            controller.command = original_command
            for name, value in originals.items():
                if value is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = value

        errors = [repr(item) for item in raised.exception.exceptions]
        self.assertTrue(any("business failed" in item for item in errors))
        self.assertTrue(any("cleanup query failed" in item for item in errors))

    def test_failed_command_keeps_raw_stdout_stderr_and_stage(self):
        script = (
            "import sys; "
            "sys.stderr.write('cleanup-stderr'); "
            "sys.exit(17)"
        )
        with self.assertRaises(controller.subprocess.CalledProcessError) as raised:
            controller.command(
                self.root,
                "cleanup-query",
                sys.executable,
                "-c",
                script,
            )
        self.assertEqual(raised.exception.returncode, 17)
        self.assertEqual(raised.exception.stderr, "cleanup-stderr")
        evidence = json.loads(
            (self.root / "command-evidence.jsonl")
            .read_text(encoding="utf-8")
            .strip()
        )
        self.assertEqual(evidence["stage"], "cleanup-query")
        self.assertEqual(evidence["returncode"], 17)
        self.assertEqual(evidence["stdout"], "")
        self.assertEqual(evidence["stderr"], "cleanup-stderr")

    def test_observe_runtime_ps_reuses_command_and_preserves_timeout(self):
        job = self.root / "jobs" / self.config["job_name"]
        trial = job / "trial-one"
        trial.mkdir(parents=True)
        controller.write(trial / "config.json", {"trial_name": "trial-one"})
        pid_path = self.root / "timeout-child.pid"
        docker = self.docker_fixture(
            "fake-docker-timeout",
            (
                "import os,pathlib,sys,time\n"
                f"pathlib.Path({str(pid_path)!r}).write_text(str(os.getpid()), encoding='utf-8')\n"
                "sys.stdout.write('ps-stdout')\n"
                "sys.stdout.flush()\n"
                "sys.stderr.write('ps-stderr')\n"
                "sys.stderr.flush()\n"
                "time.sleep(2)\n"
            ),
        )

        original_command = controller.command

        def short_timeout(*args, **kwargs):
            if args[1] == "runtime_ps":
                kwargs["timeout"] = 0.2
            return original_command(*args, **kwargs)

        controller.command = short_timeout
        try:
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                controller.observe_runtime(
                    self.root,
                    self.config,
                    str(docker),
                )
        finally:
            controller.command = original_command

        evidence = raised.exception.evidence
        self.assertEqual(evidence["stage"], "runtime_ps")
        self.assertIsNone(evidence["returncode"])
        self.assertIn("ps-stdout", evidence["stdout"])
        self.assertIn("ps-stderr", evidence["stderr"])
        self.assert_process_exited(int(pid_path.read_text(encoding="utf-8")))

        docker = self.docker_fixture(
            "fake-docker-nonzero",
            (
                "import sys\n"
                "sys.stdout.write('simulator-stdout\\n')\n"
                "sys.stderr.write('simulator-stderr\\n')\n"
                "raise SystemExit(17)\n"
            ),
        )
        with self.assertRaises(subprocess.CalledProcessError) as failed:
            controller.observe_runtime(self.root, self.config, str(docker))
        evidence = failed.exception.evidence
        self.assertEqual(evidence["stage"], "runtime_ps")
        self.assertEqual(evidence["returncode"], 17)
        self.assertIn("simulator-stdout", evidence["stdout"])
        self.assertIn("simulator-stderr", evidence["stderr"])

    def test_observe_runtime_exec_failure_keeps_binary_evidence_and_stop_race(self):
        job = self.root / "jobs" / self.config["job_name"]
        trial = job / "trial-one"
        trial.mkdir(parents=True)
        controller.write(trial / "config.json", {"trial_name": "trial-one"})
        docker = self.docker_fixture(
            "fake-docker-exec",
            "import json,pathlib,sys\n"
            "project='trial-one__env'\n"
            "row=json.dumps({'Names':'fixture-main','State':'running',\n"
            "  'Labels':'com.docker.compose.project='+project+',com.docker.compose.service=main'})\n"
            "marker=pathlib.Path(__file__).with_name('exec-failed.marker')\n"
            "operation=sys.argv[1]\n"
            "if operation == 'ps':\n"
            "  if not marker.exists(): print(row)\n"
            "elif operation == 'exec':\n"
            "  sys.stdout.buffer.write(b'exact-tar-bytes\\x00\\xff')\n"
            "  sys.stderr.write('exec-stderr')\n"
            "  sys.stderr.flush()\n"
            "  marker.write_text('failed', encoding='utf-8')\n"
            "  raise SystemExit(23)\n"
            "elif operation == 'inspect':\n"
            "  sys.stdout.write('false')\n"
            "else:\n"
            "  raise SystemExit(2)\n",
        )

        self.assertIsNone(
            controller.observe_runtime(
                self.root,
                self.config,
                str(docker),
            )
        )

        rows = [
            json.loads(line)
            for line in (self.root / "command-evidence.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        exec_evidence = next(row for row in rows if row["stage"] == "runtime_exec")
        self.assertEqual(exec_evidence["returncode"], 23)
        self.assertEqual(
            exec_evidence["stdout"],
            {"encoding": "base64", "data": "ZXhhY3QtdGFyLWJ5dGVzAP8="},
        )
        self.assertEqual(
            exec_evidence["stderr"],
            {"encoding": "base64", "data": "ZXhlYy1zdGRlcnI="},
        )
        inspect_evidence = next(
            row for row in rows if row["stage"] == "runtime_stop_check"
        )
        self.assertEqual(inspect_evidence["returncode"], 0)

    def test_observe_runtime_timeout_expired_keeps_original_exception(self):
        job = self.root / "jobs" / self.config["job_name"]
        trial = job / "trial-one"
        trial.mkdir(parents=True)
        controller.write(trial / "config.json", {"trial_name": "trial-one"})

        original_run = controller.subprocess.run
        captured = {}

        def timeout(command, **kwargs):
            captured["command"] = command
            raise subprocess.TimeoutExpired(
                command,
                kwargs["timeout"],
                output="runtime-timeout-stdout",
                stderr="runtime-timeout-stderr",
            )

        controller.subprocess.run = timeout
        try:
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                controller.observe_runtime(
                    self.root,
                    self.config,
                    "fixture-docker",
                )
        finally:
            controller.subprocess.run = original_run

        self.assertEqual(
            captured["command"],
            ["fixture-docker", "ps", "-a", "--format", "{{json .}}"],
        )
        evidence = raised.exception.evidence
        self.assertEqual(evidence["stage"], "runtime_ps")
        self.assertIsNone(evidence["returncode"])
        self.assertEqual(evidence["stdout"], "runtime-timeout-stdout")
        self.assertEqual(evidence["stderr"], "runtime-timeout-stderr")

    def test_observe_runtime_spawn_oserror_keeps_original_exception(self):
        job = self.root / "jobs" / self.config["job_name"]
        trial = job / "trial-one"
        trial.mkdir(parents=True)
        controller.write(trial / "config.json", {"trial_name": "trial-one"})

        original_run = controller.subprocess.run
        failure = FileNotFoundError("fixture docker missing")

        def missing(command, **_kwargs):
            raise failure

        controller.subprocess.run = missing
        try:
            with self.assertRaises(FileNotFoundError) as raised:
                controller.observe_runtime(
                    self.root,
                    self.config,
                    "fixture-docker",
                )
        finally:
            controller.subprocess.run = original_run

        self.assertIs(raised.exception, failure)
        evidence = failure.evidence
        self.assertEqual(evidence["stage"], "runtime_ps")
        self.assertEqual(
            evidence["argv"],
            ["fixture-docker", "ps", "-a", "--format", "{{json .}}"],
        )
        self.assertIsNone(evidence["returncode"])
        self.assertEqual(evidence["stdout"], "")
        self.assertEqual(evidence["stderr"], "")

    async def test_supervision_error_and_cleanup_error_keep_first_evidence(self):
        started = asyncio.Event()
        observation_error = subprocess.TimeoutExpired(
            ["mock-docker", "ps"],
            15,
        )

        async def execute(config):
            if config["job_name"].endswith("preflight"):
                return await self.execute(config)
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                raise RuntimeError("fixture cleanup failed")

        def observe(_run, _config):
            if started.is_set():
                raise observation_error

        running = asyncio.create_task(
            controller.run_sequence(
                self.root,
                self.config,
                execute,
                observe=observe,
            )
        )
        await started.wait()
        for _ in range(250):
            status = controller.read(self.root / "control-status.json")
            if status["state"] in {"stop_unconfirmed", "failed"}:
                break
            await asyncio.sleep(0.02)

        status = controller.read(self.root / "control-status.json")
        self.assertEqual(status["state"], "stop_unconfirmed")
        self.assertFalse(status["writers_stopped"])
        self.assertEqual(status["first_error_stage"], "supervision")
        error_types = status["error_types"]
        self.assertEqual(error_types[0]["stage"], "supervision")
        self.assertEqual(error_types[0]["type"], type(observation_error).__name__)
        self.assertEqual(error_types[1]["stage"], "cleanup")

        with self.assertRaises(BaseException):
            await asyncio.wait_for(running, timeout=2)

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
