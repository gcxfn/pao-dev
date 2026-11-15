"""治理运行器离线夹具；不运行 Docker、Harbor 或模型。"""

from __future__ import annotations

import errno
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest import mock

import bench_controller
import launch_run
import prepare_run
import runner_common
import watch_run


class GovernanceRunnerTest(unittest.TestCase):
    def setUp(self) -> None:
        fixtures_root = (
            Path(__file__).resolve().parents[3]
            / "临时文件夹"
            / "PAO集中修复-20261025"
        )
        fixtures_root.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(
            prefix="pao-governance-runner-",
            dir=fixtures_root,
        )).resolve()
        self.addCleanup(self._cleanup_temp)

    def _cleanup_temp(self) -> None:
        if os.environ.get("PAO_KEEP_TEST_FIXTURE") == "1":
            print("保留测试现场：" + str(self.root))
            return
        def retry_readonly(function, path, _error):
            os.chmod(path, 0o600)
            function(path)

        remove = shutil.rmtree
        options = (
            {"onexc": retry_readonly}
            if "onexc" in remove.__code__.co_varnames
            else {"onerror": retry_readonly}
        )
        remove(self.root, **options)

    def load_sdk_adapter_with_stub_parent(
        self,
        adapter_path: Path,
    ) -> dict:
        """隔离 load 的父包接口，只执行真实 SDK 适配器文件。"""
        benchmark = Path(__file__).resolve().parent
        sdk = adapter_path.parent
        probe = self.root / "sdk-adapter-install-probe.py"
        probe.write_text(
            textwrap.dedent(
                """
                import importlib.util
                import json
                from pathlib import Path
                import shlex
                import sys
                import types
                from unittest.mock import patch

                adapter_path = Path(sys.argv[1]).resolve()
                benchmark = Path(sys.argv[2]).resolve()
                sdk = Path(sys.argv[3]).resolve()
                events = []
                uploads = {}
                result = types.SimpleNamespace(return_code=0)

                class FakeField:
                    def __init__(self, **_kwargs):
                        pass

                class FakePAOOptions:
                    def __init__(self, **values):
                        self.__dict__.update(values)

                class FakePAOAgent:
                    options_model = FakePAOOptions
                    _REMOTE_SOURCE_DIR = "/app"
                    _REMOTE_LAUNCHER = "/tmp/pao-benchmark/agent.sh"

                    def __init__(self, options):
                        self.options = options

                    async def install(self, environment):
                        events.append(("parent-install", environment, ""))

                    async def exec_as_agent(self, environment, command):
                        events.append(("exec", environment, command))
                        return result

                    async def _upload_config_text(
                        self, environment, *, content, remote_path, filename
                    ):
                        uploads[remote_path] = content
                        events.append(("upload", environment, remote_path + "|" + filename))

                pydantic = types.ModuleType("pydantic")
                pydantic.Field = FakeField
                map_package = types.ModuleType("map_bench_pao")
                map_package.__path__ = [str(sdk / "map_bench_pao")]
                pao_agent = types.ModuleType("map_bench_pao.pao_agent")
                pao_agent.PAOAgent = FakePAOAgent
                pao_agent.PAOOptions = FakePAOOptions
                map_package.pao_agent = pao_agent

                spec = importlib.util.spec_from_file_location("sdk_adapter_under_test", adapter_path)
                adapter = importlib.util.module_from_spec(spec)
                with patch.dict(sys.modules, {
                    "pydantic": pydantic,
                    "map_bench_pao": map_package,
                    "map_bench_pao.pao_agent": pao_agent,
                }):
                    spec.loader.exec_module(adapter)
                adapter.OrganizedOptions.model_fields = {"organization_manifest_sha256": object()}

                print(json.dumps({
                    "events": events,
                    "uploads": uploads,
                    "adapter_file": str(adapter_path),
                    "adapter_sha256": __import__("hashlib").sha256(adapter_path.read_bytes()).hexdigest(),
                }))
                """
            ),
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(probe),
                str(adapter_path),
                str(benchmark),
                str(sdk),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["adapter_file"], str(adapter_path.resolve()))
        self.assertEqual(
            payload["adapter_sha256"],
            runner_common.digest(adapter_path),
        )
        return payload

    def run_sdk_adapter_with_stub_parent(
        self,
        adapter_path: Path,
        *,
        parent_error: bool = False,
        parent_cancel: bool = False,
        evidence_return_code: int = 0,
        proof_return_code: int = 0,
        terminal_return_code: int = 0,
        terminal_stdout: str | None = None,
        terminal_stderr: str = "",
        terminal_raise: bool = False,
    ) -> dict:
        """只执行真实 SDK 适配器；父类、模型和远端执行均使用内存桩。"""
        if terminal_stdout is None:
            terminal_stdout = json.dumps(
                {
                    "ok": True,
                    "control": {
                        "instance": "fixture-instance",
                        "owner": "fixture-owner",
                        "workflow": "基准开发流水线",
                        "cards_dir": "/app/.pao/benchmark/卡",
                    },
                    "report": {
                        "workflow": "基准开发流水线",
                        "status": "completed",
                    },
                },
                ensure_ascii=False,
            )
        config_path = self.root / "sdk-adapter-run-config.json"
        config_path.write_text(
            json.dumps(
                {
                    "adapter_path": str(adapter_path),
                    "parent_error": parent_error,
                    "parent_cancel": parent_cancel,
                    "evidence_return_code": evidence_return_code,
                    "proof_return_code": proof_return_code,
                    "terminal_return_code": terminal_return_code,
                    "terminal_stdout": terminal_stdout,
                    "terminal_stderr": terminal_stderr,
                    "terminal_raise": terminal_raise,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        probe = self.root / "sdk-adapter-run-probe.py"
        probe.write_text(
            textwrap.dedent(
                """
                import asyncio
                import importlib.util
                import json
                from pathlib import Path
                import sys
                import types
                from unittest.mock import patch

                config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
                adapter_path = Path(config["adapter_path"]).resolve()
                events = []

                class ParentRunError(Exception):
                    pass

                class FakeField:
                    def __init__(self, **_kwargs):
                        pass

                class FakePAOOptions:
                    def __init__(self, **values):
                        self.__dict__.update(values)

                parent_sentinel = ParentRunError("model-stream-sentinel")
                cancel_sentinel = asyncio.CancelledError("fixture-cancelled")

                class FakePAOAgent:
                    options_model = FakePAOOptions
                    _REMOTE_SOURCE_DIR = "/app"
                    _REMOTE_LAUNCHER = "/tmp/pao-benchmark/agent.sh"

                    def __init__(self, options):
                        self.options = options

                    async def run(self, instruction, environment, context):
                        events.append(("run", instruction, context.metadata))
                        if config["parent_cancel"]:
                            raise cancel_sentinel
                        if config["parent_error"]:
                            raise parent_sentinel

                    async def exec_as_agent(self, environment, command):
                        events.append(("exec", environment, command))
                        if command.startswith("if [ -d /tmp/harbor-pao-home/部门 ]"):
                            return types.SimpleNamespace(
                                return_code=config["evidence_return_code"],
                                stdout="",
                                stderr="fixture evidence copy",
                            )
                        if "final-flow.md" in command:
                            return types.SimpleNamespace(
                                return_code=config["proof_return_code"],
                                stdout="",
                                stderr="fixture final flow",
                            )
                        if "query-organized-terminal.mjs" in command:
                            if config["terminal_raise"]:
                                raise OSError("query-spawn-sentinel")
                            return types.SimpleNamespace(
                                return_code=config["terminal_return_code"],
                                stdout=config["terminal_stdout"],
                                stderr=config["terminal_stderr"],
                            )
                        return types.SimpleNamespace(
                            return_code=0,
                            stdout="",
                            stderr="",
                        )

                pydantic = types.ModuleType("pydantic")
                pydantic.Field = FakeField
                map_package = types.ModuleType("map_bench_pao")
                pao_agent = types.ModuleType("map_bench_pao.pao_agent")
                pao_agent.PAOAgent = FakePAOAgent
                pao_agent.PAOOptions = FakePAOOptions
                map_package.pao_agent = pao_agent
                with patch.dict(sys.modules, {
                    "pydantic": pydantic,
                    "map_bench_pao": map_package,
                    "map_bench_pao.pao_agent": pao_agent,
                }):
                    spec = importlib.util.spec_from_file_location(
                        "sdk_adapter_under_test", adapter_path
                    )
                    adapter = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(adapter)
                adapter.OrganizedOptions.model_fields = {
                    "organization_manifest_sha256": object()
                }
                options = adapter.OrganizedOptions(
                    organization_manifest_sha256="a" * 64
                )
                agent = adapter.OrganizedPAOAgent(options)
                context = types.SimpleNamespace(metadata={"preexisting": "kept"})
                payload = {
                    "outcome": "returned",
                    "metadata": context.metadata,
                    "query_calls": 0,
                }
                try:
                    asyncio.run(
                        agent.run("fixture instruction", "fixture-environment", context)
                    )
                except BaseException as error:
                    payload = {
                        "outcome": "raised",
                        "error_type": type(error).__name__,
                        "error_message": str(error),
                        "error_notes": list(getattr(error, "__notes__", [])),
                        "same_parent_sentinel": (
                            error is parent_sentinel or error is cancel_sentinel
                        ),
                        "metadata": context.metadata,
                    }
                else:
                    payload["metadata"] = context.metadata
                payload["query_calls"] = sum(
                    "query-organized-terminal.mjs" in event[2]
                    for event in events
                    if event[0] == "exec"
                )
                print(json.dumps(payload, ensure_ascii=False))
                """
            ),
            encoding="utf-8",
        )
        completed = subprocess.run(
            [sys.executable, str(probe), str(config_path)],
            cwd=self.root,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def make_terminal_query_fixture(self, name: str) -> tuple[Path, Path]:
        """用当前 dist 的公开写面建立隔离配方；状态构造不依赖展示文本。"""
        root = self.root / ("terminal-query-" + name)
        project = root / "project"
        pao_home = root / "pao-home"
        project.mkdir(parents=True)
        (pao_home / "工作流").mkdir(parents=True)
        (project / "input.txt").write_text("fixture\n", encoding="utf-8")
        subprocess.run(
            ["git", "init", str(project)],
            check=True,
            capture_output=True,
            encoding="utf-8",
        )
        subprocess.run(
            ["git", "-C", str(project), "add", "input.txt"],
            check=True,
            capture_output=True,
            encoding="utf-8",
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(project),
                "-c",
                "user.name=Terminal Query Test",
                "-c",
                "user.email=terminal-query@example.invalid",
                "commit",
                "-m",
                "fixture",
            ],
            check=True,
            capture_output=True,
            encoding="utf-8",
        )
        (pao_home / "工作流" / "基准开发流水线.md").write_text(
            """---
版本: 2
名字: 基准开发流水线
自动执行: true
参数:
  - 任务
节点:
  - 名字: 完成节点
    部门: 测试
    目标: "{任务}"
    验收: 夹具
    输入: []
    约束: 夹具
    执行方式: 拆解
    只读: true
    工人数量: 1
    人工确认: false
    档位: primary
    模型: harbor-endpoint/test/model
    思考强度: high
    depends_on: []
---
查询夹具。
""",
            encoding="utf-8",
        )
        return project, pao_home

    def start_terminal_query_fixture(
        self,
        mode: str,
        project: Path,
        pao_home: Path,
    ) -> None:
        source = Path(__file__).resolve().parents[3] / "PAO"
        setup_script = self.root / "terminal-query-fixture.mjs"
        setup_script.write_text(
            """
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [source, paoHome, projectRoot, mode] = process.argv.slice(2);
const load = (file) =>
  import(pathToFileURL(join(source, "packages/coding-agent/dist/pao", file)).href);
const { loadRecipe } = await load("workflow/recipe.js");
const {
  bindMinister,
  endDecomposition,
  pauseControl,
  readControl,
  startControl,
} = await load("workflow/control.js");
const cardsDir = join(projectRoot, ".pao", "benchmark", "卡");
const options = {
  cardsDir,
  workspaceDir: join(projectRoot, ".pao", "benchmark"),
  ownerSessionId: "fixture-owner",
};
const recipe = loadRecipe(paoHome, "基准开发流水线");
await startControl(recipe, { 任务: "查询夹具" }, options);
if (mode === "hold") {
  await pauseControl(recipe, options, "夹具人工挂起");
}
if (mode === "completed") {
  await bindMinister(recipe, options, "完成节点", "fixture-minister");
  const flow = readControl(recipe, options);
  await endDecomposition(
    recipe,
    options,
    {
      实例: flow.实例,
      节点: "完成节点",
      轮次: 1,
      部长会话: "fixture-minister",
    },
    "无卡夹具完成",
  );
}
console.log(JSON.stringify({ ok: true, mode }));
""",
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                "C:/Program Files/nodejs/node.exe",
                str(setup_script),
                str(source),
                str(pao_home),
                str(project),
                mode,
            ],
            cwd=self.root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def make_run(self, *, started: bool = False) -> Path:
        run = self.root / "run"
        run.mkdir()
        (run / "map_bench_pao").mkdir()
        (run / "jobs").mkdir()
        config = {
            "job_name": "controller-test",
            "jobs_dir": "/mnt/test/run/jobs",
            "n_attempts": 1,
            "n_concurrent_trials": 1,
            "retry": {"max_retries": 0},
            "environment": {
                "type": "docker",
                "kwargs": {"keep_containers": True},
            },
            "verifier": {"disable": False},
            "tasks": [{"name": "terminal-bench/html-js-filter", "ref": "sha256:" + "a" * 64}],
            "agents": [
                {
                    "import_path": "map_bench_pao_organized:OrganizedPAOAgent",
                    "model_name": "harbor-endpoint/minimax-code/MiniMax-M3.1-Flash",
                    "model_api_key_name": "PAO_BENCH_API_KEY",
                    "source_metadata": {
                        "model_name": "harbor-endpoint/minimax-code/MiniMax-M3.1-Flash",
                        "selected_model_name": "openai/minimax-code/MiniMax-M3.1-Flash",
                        "provider": "harbor-endpoint",
                        "model": "minimax-code/MiniMax-M3.1-Flash",
                        "thinking": "high",
                    },
                    "kwargs": {
                        "profile": "post-pao",
                        "configuration_root": "/mnt/test/run",
                        "source_sha256": "a" * 64,
                        "model_data_sha256": "b" * 64,
                        "node_sha256": "c" * 64,
                        "node_archive": "/fixture/node.tar.xz",
                        "organization_manifest_sha256": "d" * 64,
                        "model_metadata_path": "/fixture/model-metadata.json",
                        "model_metadata_sha256": "e" * 64,
                        "thinking": "high",
                        "tools": "read,bash,edit,write",
                        "no_extensions": False,
                    },
                }
            ],
        }
        runner_common.write_json(run / "run-config.json", config)
        runner_common.write_json(
            run / "role-model-binding.json",
            config["agents"][0]["source_metadata"],
        )
        runner_common.write_json(
            run / "organized-post" / "kit.json",
            {
                "workflow": {
                    "节点": [
                        {
                            "模型": config["agents"][0]["model_name"],
                            "思考强度": "high",
                            "档位": "primary",
                        }
                    ]
                },
                "departments": [{"recipe": "默认档位:primary"}],
            },
        )
        for relative in (
            "preparation_agent.py",
            "map_bench_pao_organized.py",
            "map_bench_pao/__init__.py",
            "map_bench_pao/pao_agent.py",
            "map_bench_pao/usage.py",
            "model-metadata.json",
        ):
            path = run / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# offline fixture\n", encoding="utf-8")
        runner_common.write_json(
            run / "run-freeze.json",
            {"files": runner_common.file_records(run, exclude={"run-freeze.json"})},
        )
        runner_common.write_json(
            run / "approved-launch.json",
            {
                "model": "minimax-code/MiniMax-M3.1-Flash",
                "thinking": "high",
                "tasks": ["terminal-bench/html-js-filter"],
                "attempts": 1,
                "automatic_retries": 0,
                "controller": "controller-test",
            },
        )
        runner_common.write_json(
            run / "run-sources.json",
            {
                "container_mounts": {
                    "local_root": str(self.root),
                    "container_root": "/mnt/test",
                },
                "harbor_cache": str(self.root / "cache"),
            },
        )
        # run-sources 加入冻结后必须重新冻结，保持 validate 可运行。
        runner_common.write_json(
            run / "run-freeze.json",
            {"files": runner_common.file_records(run, exclude={"run-freeze.json"})},
        )
        if started:
            (run / "control-started.json").write_text("{}", encoding="utf-8")
        return run

    def git(self, repo: Path, *args: str) -> None:
        completed = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def git_output(self, repo: Path, *args: str) -> str:
        completed = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed.stdout

    def commit_git_fixture(self, repo: Path, message: str) -> None:
        self.git(
            repo,
            "-c",
            "user.name=Offline Test",
            "-c",
            "user.email=offline@example.invalid",
            "commit",
            "--allow-empty",
            "--no-gpg-sign",
            "-qm",
            message,
        )

    def make_prepare_sources(self) -> tuple[Path, Path, dict]:
        """构造只含真实本地文件的准备来源；不触达网络、Docker 或模型。"""
        source_root = self.root / "sources"
        source_root.mkdir()
        repo = source_root / "repo"
        repo.mkdir()
        self.git(repo, "init")
        (repo / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        self.git(repo, "add", "tracked.txt")
        self.git(
            repo,
            "-c",
            "user.name=Offline Test",
            "-c",
            "user.email=offline@example.invalid",
            "commit",
            "-m",
            "fixture",
        )
        (repo / "untracked.txt").write_text("untracked\n", encoding="utf-8")
        (repo / ".env").write_text("SHOULD_NOT_ENTER_ARCHIVE\n", encoding="utf-8")

        task = source_root / "task"
        task.mkdir()
        (task / "task.toml").write_text("fixture = true\n", encoding="utf-8")
        (task / "tests").mkdir()
        (task / "tests" / "test.sh").write_text("true\n", encoding="utf-8")
        task_manifest = source_root / "task-manifest.json"
        task_ref = "sha256:f211960f1f7c66ace91c3d079db073ed0f841d458db4cad1f2f943cba6cc79f3"
        runner_common.write_json(
            task_manifest,
            {
                "ref": task_ref,
                "files": [
                    {
                        "path": path.relative_to(task).as_posix(),
                        "sha256": runner_common.digest(path),
                    }
                    for path in sorted(task.rglob("*"))
                    if path.is_file()
                ],
            },
        )

        benchmark = source_root / "benchmark"
        for relative in (
            "map_bench_pao/__init__.py",
            "map_bench_pao/pao_agent.py",
            "map_bench_pao/usage.py",
            "scripts/offline_validate.py",
            "organized-post/activate-tools.mjs",
            "organized-post/probe-tools.mjs",
            "organized-post/setup.mjs",
        ):
            path = benchmark / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# current benchmark\n", encoding="utf-8")
        (benchmark / "preparation_agent.py").write_text(
            "class PreparationOnlyAgent: pass\n", encoding="utf-8"
        )
        (benchmark / "bench_controller.py").write_text(
            "# current controller\n", encoding="utf-8"
        )
        (benchmark / "runner_common.py").write_text(
            "# current shared runner\n", encoding="utf-8"
        )
        (benchmark / "map_bench_pao_organized.py").write_text(
            "# root adapter is recorded only; SDK adapter replaces it\n",
            encoding="utf-8",
        )
        setup_source = Path(__file__).with_name("organized-post") / "setup.mjs"
        (benchmark / "organized-post" / "setup.mjs").write_bytes(
            setup_source.read_bytes()
        )
        history_adapter = benchmark / "historical-adapter.py"
        history_adapter.write_text("# historical adapter\n", encoding="utf-8")
        sdk = (
            Path(__file__).resolve().parents[2]
            / "协作机制重构-20261023"
            / "benchmark-sdk-host"
        )
        kit = {
            "departments": [
                {
                    "name": name,
                    "tags": ["fixture"],
                    "recipe": "# 配方\n- 默认档位:primary\n",
                }
                for name in ("侦察", "规划", "实施", "审核")
            ],
            "workflow": {
                "版本": 2,
                "名字": "基准开发流水线",
                "自动执行": True,
                "参数": ["任务"],
                "节点": [
                    {
                        "名字": name,
                        "档位": "primary",
                        "模型": "stale/provider",
                        "思考强度": "low",
                        "部门": name,
                        "目标": "{任务}",
                        "验收": "离线夹具",
                        "输入": [],
                        "约束": "离线夹具",
                        "只读": True,
                        "工人数量": 1,
                        "人工确认": False,
                        "depends_on": [],
                    }
                    for name in ("侦察", "规划", "实施", "审核")
                ],
            },
            "description": "离线准备集成夹具",
        }
        runner_common.write_json(benchmark / "organized-post" / "kit.json", kit)
        runner_common.write_json(
            benchmark / "organized-post" / "manifest.json",
            {
                "files": [
                    {
                        "path": "organized-post/" + record["path"],
                        "sha256": record["sha256"],
                    }
                    for record in runner_common.file_records(
                        benchmark / "organized-post",
                        exclude={"manifest.json"},
                    )
                ] + [
                    {
                        "path": "map_bench_pao_organized.py",
                        "sha256": runner_common.digest(
                            sdk / "benchmark-organized-adapter.py"
                        ),
                    }
                ]
            },
        )

        model_metadata = source_root / "selected-model-metadata.json"
        runner_common.write_json(
            model_metadata,
            {
                "models": {
                    "trusted/minimax/MiniMax-Test": {
                        "id": "minimax/MiniMax-Test",
                        "provider": "trusted",
                        "contextWindow": 8192,
                        "maxTokens": 1024,
                        "input": ["text"],
                        "thinkingLevelMap": {"high": "high"},
                    }
                }
            },
        )
        config = runner_common.read_json(
            Path(__file__).with_name("real-run-20261024-prepared-r12")
            / "run-config.json"
        )
        config["agents"][0]["model_name"] = "trusted/minimax/MiniMax-Test"
        config_path = source_root / "config.json"
        runner_common.write_json(config_path, config)

        for name in ("model-data.zip", "node.tar.xz", "system.zip"):
            (source_root / name).write_bytes((name + "\n").encode("utf-8"))
        compose = source_root / "network.yaml"
        compose.write_text(
            "networks:\n"
            "  default:\n"
            "    external: true\n"
            "    name: pao-r14-private\n",
            encoding="utf-8",
        )
        harbor_cache = source_root / "harbor-cache"
        harbor_cache.mkdir()
        run = self.root / "integration-run"
        sources = {
            "run_parent": str(self.root),
            "run_dir": str(run),
            "pao_source": str(repo),
            "benchmark_source": str(benchmark),
            "sdk_host_source": str(sdk),
            "task_source": str(task),
            "task_source_manifest": str(task_manifest),
            "model_data_archive": str(source_root / "model-data.zip"),
            "model_data_sha256": runner_common.digest(source_root / "model-data.zip"),
            "node_archive": str(source_root / "node.tar.xz"),
            "node_sha256": runner_common.digest(source_root / "node.tar.xz"),
            "system_dependencies_archive": str(source_root / "system.zip"),
            "system_dependencies_sha256": runner_common.digest(
                source_root / "system.zip"
            ),
            "model_metadata_path": str(model_metadata),
            "model_metadata_sha256": runner_common.digest(model_metadata),
            "config_source": str(config_path),
            "config_source_sha256": runner_common.digest(config_path),
            "extra_docker_compose_source": str(compose),
            "extra_docker_compose_sha256": runner_common.digest(compose),
            "container_mounts": {
                "local_root": str(self.root),
                "container_root": "/mnt/integration",
            },
            "harbor_cache": str(harbor_cache),
            "job_name": "offline-integration",
            "task_name": "terminal-bench/html-js-filter",
            "model_name": "trusted/minimax/MiniMax-Test",
            "model_base_url": "http://host.docker.internal:3425",
            "thinking": "high",
            "controller_name": "offline-controller",
            "authorization": "offline prepare integration",
        }
        sources_path = source_root / "sources.json"
        runner_common.write_json(sources_path, sources)
        return sources_path, run, sources

    def docker_row(self, name: str, project: str, running: bool) -> str:
        return json.dumps(
            {
                "Names": name,
                "Labels": f"com.docker.compose.project={project}",
            }
        )

    def state(self, running: bool) -> str:
        return json.dumps(
            {
                "Running": running,
                "Paused": False,
                "Restarting": False,
                "Pid": 123 if running else 0,
                "ExitCode": None if running else 1,
            }
        )

    def crashed_state(self, exit_code: int = 255) -> str:
        return json.dumps(
            {
                "Running": False,
                "Paused": False,
                "Restarting": False,
                "Pid": 0,
                "ExitCode": exit_code,
            }
        )

    def test_model_metadata_requires_exact_selected_model(self) -> None:
        path = Path(__file__).with_name("model-metadata.json").resolve()
        sha = runner_common.digest(path)
        entry = runner_common.load_model_metadata(
            path,
            sha,
            "openai/minimax-code/MiniMax-M3.1-Flash",
            "high",
        )
        self.assertEqual(entry["maxTokens"], 524288)
        with self.assertRaisesRegex(ValueError, "完整选定模型"):
            runner_common.load_model_metadata(
                path,
                sha,
                "openai/group/deepseek",
                "high",
            )

    def test_write_json_preserves_unicode_and_rejects_non_finite_values(self) -> None:
        """真实文件行为：中文和 Emoji 原样落盘，NaN/Infinity 不发布。"""
        target = self.root / "unicode-state.json"
        original = {"版本": "旧", "说明": "旧文件仍需完整"}
        runner_common.write_json(target, original)
        value = {
            "名称": "实施状态",
            "说明": "中文保持原样",
            "标记": "🙂",
            "列表": ["第一项", "第二项"],
        }

        runner_common.write_json(target, value)

        text = target.read_text(encoding="utf-8")
        self.assertIn("实施状态", text)
        self.assertIn("🙂", text)
        self.assertEqual(json.loads(text), value)
        for invalid in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    runner_common.write_json(target, {"值": invalid})
                self.assertEqual(json.loads(target.read_text(encoding="utf-8")), value)
                self.assertEqual(
                    list(target.parent.glob(f".{target.name}.*.pending")),
                    [],
                )

    def test_write_json_retries_simulated_transient_replace_error(self) -> None:
        """模拟短暂占用：同一唯一临时文件在第二次替换时成功发布。"""
        target = self.root / "transient-state.json"
        original = {"版本": "旧"}
        replacement = {"版本": "新", "说明": "中文完整"}
        runner_common.write_json(target, original)
        real_replace = runner_common.os.replace
        attempts = []

        def replace_after_one_failure(source, destination):
            attempts.append(Path(source))
            if len(attempts) == 1:
                error = PermissionError(
                    errno.EACCES,
                    "模拟短暂目标占用",
                    str(source),
                    str(destination),
                )
                error.winerror = 5
                raise error
            return real_replace(source, destination)

        with (
            mock.patch.object(
                runner_common.os,
                "replace",
                side_effect=replace_after_one_failure,
            ),
            mock.patch.object(runner_common.time, "sleep", return_value=None),
        ):
            runner_common.write_json(target, replacement)

        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], attempts[1])
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), replacement)
        self.assertFalse(attempts[0].exists())

    def test_write_json_bounded_permission_failure_keeps_old_and_cleans_own_file(
        self,
    ) -> None:
        """模拟持续占用：有界失败，旧目标不变，只清理本调用的临时文件。"""
        target = self.root / "blocked-state.json"
        old_text = '{"版本": "旧", "说明": "完整旧文件"}\n'
        target.write_text(old_text, encoding="utf-8")
        decoy = target.with_name(f".{target.name}.other.pending")
        decoy_text = "其他调用仍在使用的临时文件\n"
        decoy.write_text(decoy_text, encoding="utf-8")
        errors = []
        temporary_paths = []

        def always_blocked(source, destination):
            temporary_paths.append(Path(source))
            error = PermissionError(
                errno.EACCES,
                "模拟持续目标占用",
                str(source),
                str(destination),
            )
            error.winerror = 5
            errors.append(error)
            raise error

        started = time.monotonic()
        with (
            mock.patch.object(runner_common, "_REPLACE_TIMEOUT_SECONDS", 0.15),
            mock.patch.object(runner_common, "_REPLACE_INTERVAL_SECONDS", 0.02),
            mock.patch.object(
                runner_common.os,
                "replace",
                side_effect=always_blocked,
            ),
        ):
            with self.assertRaises(PermissionError) as raised:
                runner_common.write_json(target, {"版本": "新"})
        elapsed = time.monotonic() - started

        failure = raised.exception
        self.assertGreaterEqual(len(errors), 2)
        self.assertGreaterEqual(elapsed, 0.1)
        self.assertLess(elapsed, 1.0)
        self.assertIs(failure.first_error, errors[0])
        self.assertIs(failure.__cause__, errors[0])
        self.assertEqual(failure.target, str(target))
        self.assertEqual(failure.attempts, len(errors))
        self.assertIn(str(target), str(failure))
        self.assertIn(f"{len(errors)} 次尝试", str(failure))
        self.assertEqual(target.read_text(encoding="utf-8"), old_text)
        self.assertFalse(temporary_paths[0].exists())
        self.assertTrue(decoy.exists())
        self.assertEqual(decoy.read_text(encoding="utf-8"), decoy_text)

    def test_write_json_does_not_retry_unrelated_replace_errors(self) -> None:
        """模拟非占用错误：EPERM、ENOSPC 及 Windows 非共享冲突 EACCES 均不重试。"""
        cases = (
            PermissionError(errno.EPERM, "模拟永久权限错误"),
            OSError(errno.ENOSPC, "模拟磁盘空间不足"),
        )
        if os.name == "nt":
            cases += (
                PermissionError(
                    errno.EACCES,
                    "模拟非共享冲突的权限错误",
                    "source",
                    "target",
                ),
            )
        for injected in cases:
            if os.name == "nt" and injected.errno == errno.EACCES:
                injected.winerror = 32
            with self.subTest(error=type(injected).__name__, errno=injected.errno):
                target = self.root / f"no-retry-{injected.errno}.json"
                old_text = '{"版本": "旧"}\n'
                target.write_text(old_text, encoding="utf-8")
                temporary_paths = []

                def fail_once(source, destination):
                    temporary_paths.append(Path(source))
                    raise injected

                with (
                    mock.patch.object(
                        runner_common.os,
                        "replace",
                        side_effect=fail_once,
                    ),
                    mock.patch.object(runner_common.time, "sleep") as sleep,
                ):
                    with self.assertRaises(type(injected)) as raised:
                        runner_common.write_json(target, {"版本": "新"})

                self.assertIs(raised.exception, injected)
                self.assertEqual(len(temporary_paths), 1)
                self.assertFalse(temporary_paths[0].exists())
                sleep.assert_not_called()
                self.assertEqual(target.read_text(encoding="utf-8"), old_text)

    def test_concurrent_write_json_publishes_only_complete_old_or_new_documents(
        self,
    ) -> None:
        """真实多线程写入：两个唯一临时文件并存，读者不见半截 JSON。"""
        target = self.root / "concurrent-state.json"
        old = {"版本": "旧", "内容": "旧" * 4000}
        first = {"版本": "甲", "内容": "甲" * 4000}
        second = {"版本": "乙", "内容": "乙" * 4000}
        runner_common.write_json(target, old)
        allowed = {"旧": old, "甲": first, "乙": second}
        replacements_arrived = threading.Barrier(3)
        release_replacements = threading.Event()
        stop_reader = threading.Event()
        lock = threading.Lock()
        temporary_paths = []
        temporary_values = []
        writer_errors = []
        reader_errors = []
        reader_values = []
        real_replace = runner_common.os.replace
        real_read_text = Path.read_text
        coordinated_paths = set()

        def coordinated_replace(source, destination):
            path = Path(source)
            with lock:
                if path in coordinated_paths:
                    # 读者短占目标造成的重试不再等待屏障。
                    return real_replace(source, destination)
                coordinated_paths.add(path)
                # replace 前先自行读取，避免线程测试把 Windows 共享冲突混入写入断言。
                replacement = json.loads(path.read_text(encoding="utf-8"))
                temporary_paths.append(path)
                temporary_values.append(replacement)
            # 两个写者都已完成临时文件后，再同时放行替换。
            replacements_arrived.wait(timeout=5)
            release_replacements.wait(timeout=5)
            return real_replace(source, destination)

        def retrying_read_text(path, *args, **kwargs):
            deadline = time.monotonic() + 1.5
            while True:
                try:
                    return real_read_text(path, *args, **kwargs)
                except PermissionError as error:
                    if path != target or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.005)

        def write_value(value):
            try:
                runner_common.write_json(target, value)
            except BaseException as error:
                with lock:
                    writer_errors.append(error)

        def read_values():
            while not stop_reader.is_set():
                try:
                    text = retrying_read_text(target, encoding="utf-8")
                    value = json.loads(text)
                except BaseException as error:
                    with lock:
                        reader_errors.append(error)
                else:
                    with lock:
                        reader_values.append((value["版本"], value))
                        # 每次成功读取后让出时间片，避免持续读柄挡住发布替换。
                        time.sleep(0.002)
                time.sleep(0.001)

        reader = threading.Thread(target=read_values)
        writers = [
            threading.Thread(target=write_value, args=(value,))
            for value in (first, second)
        ]
        with (
            mock.patch.object(
                runner_common.os,
                "replace",
                side_effect=coordinated_replace,
            ),
            mock.patch.object(Path, "read_text", retrying_read_text),
        ):
            reader.start()
            try:
                for writer in writers:
                    writer.start()
                replacements_arrived.wait(timeout=5)
                release_replacements.set()
            finally:
                for writer in writers:
                    writer.join(timeout=10)
                stop_reader.set()
                reader.join(timeout=10)

        self.assertFalse(reader.is_alive())
        self.assertTrue(all(not writer.is_alive() for writer in writers))
        self.assertEqual(writer_errors, [])
        self.assertEqual(reader_errors, [])
        self.assertEqual(len(set(temporary_paths)), 2)
        self.assertCountEqual(temporary_values, [first, second])
        self.assertIn(json.loads(target.read_text(encoding="utf-8")), [first, second])
        self.assertTrue(reader_values)
        self.assertTrue(
            all(allowed.get(name) == value for name, value in reader_values)
        )
        self.assertTrue(all(not path.exists() for path in temporary_paths))

    def test_copied_controller_uses_copied_shared_publisher(self) -> None:
        """复制后的控制器真实导入同目录共享入口，不只验证 helper。"""
        _sources_path, _run, sources = self.make_prepare_sources()
        benchmark = Path(sources["benchmark_source"])
        source_controller = Path(__file__).with_name("bench_controller.py")
        source_common = Path(__file__).with_name("runner_common.py")
        (benchmark / "bench_controller.py").write_bytes(
            source_controller.read_bytes()
        )
        (benchmark / "runner_common.py").write_bytes(source_common.read_bytes())
        assembly = prepare_run.build_package_assembly(
            benchmark,
            Path(sources["sdk_host_source"]),
        )
        copied = self.root / "copied-package"
        copied.mkdir()
        prepare_run.copy_assembly(assembly, copied)

        probe = textwrap.dedent(
            """
            import json
            from pathlib import Path
            import sys

            root = Path(sys.argv[1]).resolve()
            sys.path.insert(0, str(root))
            import bench_controller
            import runner_common

            assert Path(bench_controller.__file__).resolve() == root / "bench_controller.py"
            assert Path(runner_common.__file__).resolve() == root / "runner_common.py"
            calls = []

            def capture(path, value):
                calls.append([str(path), value])

            runner_common.write_json = capture
            payload = {"名称": "复制后的控制器", "值": 1}
            bench_controller.write(root / "controller-probe.json", payload)
            print(json.dumps({
                "controller": str(Path(bench_controller.__file__).resolve()),
                "runner_common": str(Path(runner_common.__file__).resolve()),
                "calls": calls,
            }, ensure_ascii=False))
            """
        )
        completed = subprocess.run(
            [sys.executable, "-c", probe, str(copied)],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=copied,
            env={
                **os.environ,
                "PYTHONIOENCODING": "utf-8",
                "PYTHONPATH": str(copied),
            },
        )
        self.assertEqual(
            completed.returncode,
            0,
            (completed.stdout or "") + "\n" + (completed.stderr or ""),
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["calls"], [[str(copied / "controller-probe.json"), {
            "名称": "复制后的控制器",
            "值": 1,
        }]])
        self.assertEqual(
            runner_common.digest(copied / "bench_controller.py"),
            runner_common.digest(source_controller),
        )
        self.assertEqual(
            runner_common.digest(copied / "runner_common.py"),
            runner_common.digest(source_common),
        )
        self.assertFalse((copied / "controller-probe.json").exists())

    def test_historical_inputs_remain_unchanged(self) -> None:
        sources_path, run, sources = self.make_prepare_sources()
        task = Path(sources["task_source"])
        benchmark = Path(sources["benchmark_source"])
        task_before = {
            path.relative_to(task).as_posix(): runner_common.digest(path)
            for path in task.rglob("*")
            if path.is_file()
        }
        benchmark_before = runner_common.file_records(benchmark)

        completed = subprocess.run(
            [
                sys.executable,
                str(Path(prepare_run.__file__).resolve()),
                "--sources",
                str(sources_path),
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        if completed.returncode != 0:
            self.fail((completed.stdout or "") + "\n" + (completed.stderr or ""))
        result = json.loads(completed.stdout)

        self.assertEqual(result["docker_calls"], 0)
        self.assertEqual(result["model_calls"], 0)
        self.assertEqual(
            task_before,
            {
                path.relative_to(task).as_posix(): runner_common.digest(path)
                for path in task.rglob("*")
                if path.is_file()
            },
        )
        self.assertEqual(runner_common.file_records(benchmark), benchmark_before)

        config = runner_common.read_json(run / "run-config.json")
        mounts = runner_common.read_json(run / "run-sources.json")["container_mounts"]
        compose = run / "network-override.yaml"
        self.assertEqual(
            config["environment"]["kwargs"]["extra_docker_compose"],
            [runner_common.container_path(compose, mounts)],
        )
        self.assertIsInstance(
            config["environment"]["kwargs"]["extra_docker_compose"],
            list,
        )
        self.assertEqual(
            runner_common.digest(compose),
            sources["extra_docker_compose_sha256"],
        )
        self.assertEqual(
            runner_common.read_json(run / "run-sources.json")[
                "extra_docker_compose"
            ]["path"],
            str(compose),
        )
        self.assertEqual(
            runner_common.read_json(run / "source-manifest.json")[
                "extra_docker_compose"
            ]["sha256"],
            sources["extra_docker_compose_sha256"],
        )
        runner_common.validate_run_references(config, run, run, mounts)
        bench_controller.validate(
            run,
            final_run=run,
            container_mounts=mounts,
        )

        metadata_path = (
            run
            / "model-metadata.json"
        )
        self.assertEqual(
            runner_common.digest(metadata_path),
            sources["model_metadata_sha256"],
        )

        source_manifest = runner_common.read_json(run / "source-manifest.json")
        final_adapter = run / "map_bench_pao_organized.py"
        adapter_record = next(
            record
            for record in source_manifest["adapters"]
            if Path(record["destination"]) == final_adapter
        )
        self.assertEqual(
            adapter_record["source"],
            str(Path(sources["sdk_host_source"]) / "benchmark-organized-adapter.py"),
        )
        self.assertEqual(
            adapter_record["sha256"],
            runner_common.digest(final_adapter),
        )
        self.assertNotEqual(
            runner_common.digest(final_adapter),
            runner_common.digest(Path(sources["benchmark_source"]) / "historical-adapter.py"),
        )

        activation_path = run / "organized-post" / "activate-tools.mjs"
        activation_record = next(
            record
            for record in source_manifest["adapters"]
            if Path(record["destination"]) == activation_path
        )
        self.assertEqual(
            activation_record["source"],
            str(Path(sources["sdk_host_source"]) / "activate-tools.mjs"),
        )
        self.assertEqual(
            activation_record["sha256"],
            runner_common.digest(activation_path),
        )
        self.assertEqual(
            activation_path.read_text(encoding="utf-8"),
            (
                Path(sources["sdk_host_source"]) / "activate-tools.mjs"
            ).read_text(encoding="utf-8"),
        )
        organized_manifest = runner_common.read_json(
            run / "organized-post" / "manifest.json"
        )
        activation_manifest_record = next(
            record
            for record in organized_manifest["files"]
            if record["path"] == "organized-post/activate-tools.mjs"
        )
        self.assertEqual(
            activation_manifest_record["sha256"],
            runner_common.digest(activation_path),
        )
        self.assertNotEqual(
            activation_manifest_record["sha256"],
            runner_common.digest(
                Path(sources["benchmark_source"])
                / "organized-post"
                / "activate-tools.mjs"
            ),
        )

        kit = runner_common.read_json(run / "organized-post" / "kit.json")
        expected_model = "harbor-endpoint/" + runner_common.model_id(
            sources["model_name"]
        )
        for node in kit["workflow"]["节点"]:
            self.assertEqual(node["模型"], expected_model)
            self.assertEqual(node["思考强度"], "high")
            self.assertEqual(node["档位"], "primary")
        for department in kit["departments"]:
            self.assertIn("默认档位:primary", department["recipe"])
            self.assertIn("模型名:" + expected_model, department["recipe"])

        binding = runner_common.read_json(run / "role-model-binding.json")
        config_agent = config["agents"][0]
        self.assertEqual(config_agent["model_name"], expected_model)
        self.assertEqual(config_agent["source_metadata"], binding)
        self.assertEqual(binding["selected_model_name"], sources["model_name"])
        self.assertEqual(binding["provider"], "harbor-endpoint")
        self.assertEqual(binding["model"], runner_common.model_id(sources["model_name"]))
        self.assertEqual(binding["model_name"], expected_model)
        self.assertEqual(
            binding["selected_model_name"].split("/", 1)[1],
            binding["model"],
        )
        # setup.mjs 从同一 binding 派生主控、部长、工人档位；这里按它的输入契约
        # 核对外部选定模型与已注册运行别名，防止只替换模型字段形成不可用配置。
        self.assertTrue(
            all(
                node["模型"]
                == binding["provider"] + "/" + binding["model"]
                == config_agent["model_name"]
                for node in kit["workflow"]["节点"]
            )
        )
        self.assertEqual(
            runner_common.read_json(run / "source-manifest.json")["model_metadata"][
                "model_name"
            ],
            sources["model_name"],
        )
        setup_text = (run / "organized-post" / "setup.mjs").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "explicitBindingPath || '/tmp/benchmark-model-binding.json'",
            setup_text,
        )
        self.assertIn("主控、部长和工人必须使用同一已注册 Harbor 运行别名", setup_text)
        self.assertIn("外部选定模型与运行 model id 不一致", setup_text)
        self.assertIn("git(project, 'init')", setup_text)
        self.assertIn("git-baseline.json", setup_text)
        self.assertIn("工人监督分钟: 15, 部门监督分钟: 30", setup_text)
        self.assertIn("checkPreflight({ project, paoHome", setup_text)

        import zipfile

        with zipfile.ZipFile(run / "source.zip") as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"tracked.txt", "untracked.txt"},
            )

        # 不手换激活器：直接用 prepare 发布后的目录，跑真实 setup 与 r17 失败入口。
        pao_source = (
            Path(__file__).resolve().parents[3] / "PAO"
        ).resolve()
        fixture_root = self.root / "prepared-real-chain"
        fixture_root.mkdir()
        project = fixture_root / "project"
        project.mkdir()
        (project / "input.txt").write_text("offline\n", encoding="utf-8")
        pao_home = fixture_root / "pao-home"
        agent_dir = fixture_root / "agent-dir"
        setup_evidence = fixture_root / "setup-evidence"
        setup = subprocess.run(
            [
                "C:/Program Files/nodejs/node.exe",
                str(run / "organized-post" / "setup.mjs"),
                str(pao_source),
                str(run / "organized-post" / "kit.json"),
                str(pao_home),
                str(agent_dir),
                str(setup_evidence),
                str(project),
                str(run / "role-model-binding.json"),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
        self.assertEqual(setup.returncode, 0, setup.stderr)
        installed_activation = (
            agent_dir / "extensions" / "benchmark-organization.js"
        )
        self.assertEqual(
            runner_common.digest(installed_activation),
            runner_common.digest(activation_path),
        )
        setup_report = runner_common.read_json(
            setup_evidence / "organization-setup.json"
        )
        self.assertTrue(setup_report["role_model_check"]["consistent"])
        self.assertEqual(
            {
                setup_report["role_model_check"]["主控"],
                setup_report["role_model_check"]["部长"],
                setup_report["role_model_check"]["工人"],
            },
            {expected_model},
        )

        rpc_evidence = fixture_root / "rpc-evidence"
        rpc = subprocess.run(
            [
                "C:/Program Files/nodejs/node.exe",
                str(run / "organized-post" / "probe-child-rpc.mjs"),
                str(rpc_evidence),
            ],
            cwd=project,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=90,
            env={
                **os.environ,
                "PAO_BENCH_SOURCE": str(pao_source),
                "PAO_HOME": str(pao_home),
                "PI_CODING_AGENT_DIR": str(agent_dir),
                "PAO_CODING_AGENT_DIR": str(agent_dir),
                "PI_OFFLINE": "1",
            },
        )
        (fixture_root / "child-rpc.stdout.log").write_text(
            rpc.stdout, encoding="utf-8"
        )
        (fixture_root / "child-rpc.stderr.log").write_text(
            rpc.stderr, encoding="utf-8"
        )
        self.assertEqual(rpc.returncode, 0, rpc.stderr)
        rpc_report = runner_common.read_json(
            rpc_evidence / "child-rpc-probe.json"
        )
        self.assertEqual(rpc_report["model_calls"], 0)
        self.assertEqual(
            {proof["role"] for proof in rpc_report["proofs"]},
            {"main", "minister", "worker"},
        )
        self.assertTrue(
            all(proof["parent_ipc"] for proof in rpc_report["proofs"])
        )

    def test_structured_terminal_query_distinguishes_real_workflow_states(self) -> None:
        benchmark = Path(__file__).resolve().parent
        source = Path(__file__).resolve().parents[3] / "PAO"
        query = (
            benchmark.parents[1]
            / "协作机制重构-20261023"
            / "benchmark-sdk-host"
            / "query-organized-terminal.mjs"
        )
        observed = {}
        for mode in ("completed", "hold", "running"):
            project, pao_home = self.make_terminal_query_fixture(mode)
            self.start_terminal_query_fixture(mode, project, pao_home)
            completed = subprocess.run(
                [
                    "C:/Program Files/nodejs/node.exe",
                    str(query),
                    str(source),
                    str(pao_home),
                    str(project),
                    "基准开发流水线",
                ],
                cwd=self.root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(completed.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["report"]["status"], mode)
            self.assertEqual(payload["control"]["workflow"], "基准开发流水线")
            self.assertEqual(payload["control"]["owner"], "fixture-owner")
            self.assertTrue(payload["control"]["instance"])
            observed[mode] = payload["report"]["status"]

        project, pao_home = self.make_terminal_query_fixture("unstarted")
        completed = subprocess.run(
            [
                "C:/Program Files/nodejs/node.exe",
                str(query),
                str(source),
                str(pao_home),
                str(project),
                "基准开发流水线",
            ],
            cwd=self.root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertNotEqual(completed.returncode, 0)
        payload = json.loads(completed.stdout)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["name"], "Error")
        observed["unstarted"] = payload["ok"]
        self.assertEqual(
            observed,
            {
                "completed": "completed",
                "hold": "hold",
                "running": "running",
                "unstarted": False,
            },
        )

    def test_sdk_adapter_requires_completed_structured_terminal(self) -> None:
        benchmark = Path(__file__).resolve().parent
        adapter_path = (
            benchmark.parents[1]
            / "协作机制重构-20261023"
            / "benchmark-sdk-host"
            / "benchmark-organized-adapter.py"
        )
        completed = self.run_sdk_adapter_with_stub_parent(adapter_path)
        self.assertEqual(completed["outcome"], "returned")
        self.assertEqual(completed["query_calls"], 1)
        self.assertEqual(completed["metadata"]["preexisting"], "kept")
        self.assertTrue(completed["metadata"]["pao_organization_started"])
        self.assertTrue(completed["metadata"]["pao_organization_completed"])
        self.assertEqual(
            completed["metadata"]["pao_organization_workflow_status"],
            "completed",
        )

        for status in ("hold", "running"):
            with self.subTest(status=status):
                payload = self.run_sdk_adapter_with_stub_parent(
                    adapter_path,
                    terminal_stdout=json.dumps(
                        {
                            "ok": True,
                            "control": {
                                "instance": "fixture-instance",
                                "owner": "fixture-owner",
                                "workflow": "基准开发流水线",
                                "cards_dir": "/app/.pao/benchmark/卡",
                            },
                            "report": {
                                "workflow": "基准开发流水线",
                                "status": status,
                            },
                        },
                        ensure_ascii=False,
                    ),
                )
                self.assertEqual(payload["outcome"], "raised")
                self.assertEqual(payload["error_type"], "RuntimeError")
                self.assertIn("status=" + status, payload["error_message"])
                self.assertTrue(payload["metadata"]["pao_organization_started"])
                self.assertFalse(payload["metadata"]["pao_organization_completed"])
                self.assertEqual(
                    payload["metadata"]["pao_organization_workflow_status"],
                    status,
                )

    def test_sdk_adapter_terminal_query_failures_are_fatal(self) -> None:
        benchmark = Path(__file__).resolve().parent
        adapter_path = (
            benchmark.parents[1]
            / "协作机制重构-20261023"
            / "benchmark-sdk-host"
            / "benchmark-organized-adapter.py"
        )
        cases = {
            "control_missing": {
                "terminal_return_code": 1,
                "terminal_stdout": json.dumps(
                    {
                        "ok": False,
                        "error": {
                            "name": "Error",
                            "message": "缺少控制清单",
                        },
                    },
                    ensure_ascii=False,
                ),
            },
            "spawn_error": {"terminal_raise": True},
            "bad_json": {"terminal_stdout": "{not-json"},
            "incomplete": {
                "terminal_stdout": json.dumps(
                    {
                        "ok": True,
                        "control": {},
                        "report": {"status": "completed"},
                    }
                )
            },
        }
        for name, options in cases.items():
            with self.subTest(name=name):
                payload = self.run_sdk_adapter_with_stub_parent(
                    adapter_path,
                    **options,
                )
                self.assertEqual(payload["outcome"], "raised")
                self.assertEqual(payload["error_type"], "RuntimeError")
                self.assertTrue(
                    payload["metadata"]["pao_organization_terminal_query_error"]
                )
                self.assertFalse(payload["metadata"]["pao_organization_completed"])

    def test_sdk_adapter_preserves_parent_error_when_evidence_copy_fails(self) -> None:
        benchmark = Path(__file__).resolve().parent
        adapter_path = (
            benchmark.parents[1]
            / "协作机制重构-20261023"
            / "benchmark-sdk-host"
            / "benchmark-organized-adapter.py"
        )
        for name, options, error_type, message in (
            (
                "model_error",
                {"parent_error": True},
                "ParentRunError",
                "model-stream-sentinel",
            ),
            (
                "cancelled",
                {"parent_cancel": True},
                "CancelledError",
                "fixture-cancelled",
            ),
        ):
            with self.subTest(name=name):
                payload = self.run_sdk_adapter_with_stub_parent(
                    adapter_path,
                    evidence_return_code=9,
                    **options,
                )
                self.assertEqual(payload["outcome"], "raised")
                self.assertEqual(payload["error_type"], error_type)
                self.assertEqual(payload["error_message"], message)
                self.assertTrue(payload["same_parent_sentinel"])
                self.assertTrue(
                    any("留证同时失败" in note for note in payload["error_notes"])
                )
                self.assertEqual(payload["query_calls"], 0)
                self.assertTrue(
                    payload["metadata"]["pao_organization_evidence_error"]
                )

        no_parent_error = self.run_sdk_adapter_with_stub_parent(
            adapter_path,
            evidence_return_code=9,
        )
        self.assertEqual(no_parent_error["outcome"], "raised")
        self.assertEqual(no_parent_error["error_type"], "RuntimeError")
        self.assertTrue(
            no_parent_error["metadata"]["pao_organization_evidence_error"]
        )

    def test_sdk_adapter_setup_contract_and_install_arguments(self) -> None:
        benchmark = Path(__file__).resolve().parent
        adapter_path = (
            benchmark.parents[1]
            / "协作机制重构-20261023"
            / "benchmark-sdk-host"
            / "benchmark-organized-adapter.py"
        )
        self.assertTrue(adapter_path.is_file())
        self.assertNotEqual(
            adapter_path.resolve(),
            (benchmark / "map_bench_pao_organized.py").resolve(),
        )

        sdk_text = adapter_path.read_text(encoding="utf-8")
        self.assertIn(
            "/tmp/benchmark-organization/kit.json",
            sdk_text,
        )
        self.assertIn(
            "/tmp/benchmark-model-binding.json",
            sdk_text,
        )

        root = self.root / "sdk-contract"
        root.mkdir()
        source = root / "source"
        module_dir = source / "packages" / "coding-agent" / "dist" / "pao"
        (module_dir / "dept").mkdir(parents=True)
        (module_dir / "workflow").mkdir()
        (module_dir / "preflight").mkdir()
        (source / "package.json").write_text(
            json.dumps({"type": "module"}),
            encoding="utf-8",
        )
        (module_dir / "dept" / "scaffold.js").write_text(
            "import { mkdirSync } from 'node:fs';"
            "import { join } from 'node:path';"
            "export async function createDept({paoHome, 名字}) {"
            "mkdirSync(join(paoHome, '部门', 名字), { recursive: true });"
            "return {paoHome, 注册表: 'created', 名字}; }",
            encoding="utf-8",
        )
        (module_dir / "dept" / "catalog.js").write_text(
            "export function readDeptCatalog(paoHome) {"
            "return {部门: [{名字: '侦察'}]}; }"
            "export function validateDeptCatalog(_catalog) { return []; }",
            encoding="utf-8",
        )
        (module_dir / "workflow" / "distill.js").write_text(
            "export function saveRecipe(_paoHome, _name, _text, _options) {}",
            encoding="utf-8",
        )
        (module_dir / "workflow" / "recipe.js").write_text(
            "export function loadRecipe(_paoHome, name) {"
            "return {名字: name, 版本: 2, 自动执行: true,"
            "拓扑序: ['侦察', '规划', '实施', '审核']}; }",
            encoding="utf-8",
        )
        (module_dir / "preflight" / "index.js").write_text(
            "export function checkPreflight(input) {"
            "if (!input.project) throw new Error('missing project');"
            "return {canStart: true, project: input.project}; }",
            encoding="utf-8",
        )
        (source / "package.json").write_text(
            json.dumps({"type": "module"}),
            encoding="utf-8",
        )
        node_modules = source / "node_modules" / "yaml"
        node_modules.mkdir(parents=True)
        (node_modules / "package.json").write_text(
            json.dumps({
                "name": "yaml",
                "version": "1.0.0",
                "type": "module",
                "exports": "./index.js",
            }),
            encoding="utf-8",
        )
        (node_modules / "index.js").write_text(
            "export function stringify(value) {"
            "return JSON.stringify(value); }",
            encoding="utf-8",
        )

        binding = {
            "model_name": "harbor-endpoint/minimax-code/MiniMax-M3.1-Flash",
            "selected_model_name": "openai/minimax-code/MiniMax-M3.1-Flash",
            "provider": "harbor-endpoint",
            "model": "minimax-code/MiniMax-M3.1-Flash",
            "thinking": "high",
        }
        binding_path = root / "binding.json"
        binding_path.write_text(json.dumps(binding), encoding="utf-8")
        model = binding["model_name"]
        kit = {
            "departments": [
                {
                    "name": name,
                    "tags": ["测试"],
                    "recipe": "默认档位:primary\n模型名:" + model + "\n思考强度:high\n",
                }
                for name in ("侦察", "规划", "实施", "审核")
            ],
            "workflow": {
                "版本": 2,
                "名字": "契约验证",
                "自动执行": True,
                "参数": ["任务"],
                "节点": [
                    {
                        "名字": "侦察",
                        "部门": "侦察",
                        "目标": "{任务}",
                        "验收": "测试",
                        "输入": [],
                        "约束": "测试",
                        "只读": True,
                        "工人数量": 1,
                        "人工确认": False,
                        "档位": "primary",
                        "模型": model,
                        "思考强度": "high",
                        "depends_on": [],
                    }
                ],
            },
            "description": "离线契约验证",
        }
        kit_path = root / "kit.json"
        kit_path.write_text(json.dumps(kit), encoding="utf-8")
        (root / "activate-tools.mjs").write_text(
            "export {};",
            encoding="utf-8",
        )
        pao_home = root / "pao-home"
        agent_dir = root / "agent-dir"
        evidence = root / "evidence"
        setup = benchmark / "organized-post" / "setup.mjs"
        result = subprocess.run(
            [
                "C:/Program Files/nodejs/node.exe",
                str(setup),
                str(source),
                str(kit_path),
                str(pao_home),
                str(agent_dir),
                str(evidence),
                str(source),
                str(binding_path),
            ],
            cwd=source,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (evidence / "organization-setup.json").read_text(encoding="utf-8")
        )
        self.assertEqual(report["model_binding"], binding)
        self.assertTrue(report["ok"])
        self.assertTrue(report["baseline"]["baseline_created"])
        self.assertEqual(report["supervision"], {
            "工人监督分钟": 15,
            "部门监督分钟": 30,
        })
        self.assertEqual(
            runner_common.read_json(pao_home / "pao配置" / "保温.json"),
            report["supervision"],
        )
        source_head = self.git_output(source, "rev-parse", "HEAD").strip()

        adapter_run = root / "adapter-run"
        adapter_copy = adapter_run / "map_bench_pao_organized.py"
        adapter_copy.parent.mkdir()
        adapter_copy.write_bytes(adapter_path.read_bytes())
        adapter_kit = adapter_run / "organized-post"
        adapter_kit.mkdir()
        upload_names = (
            "setup.mjs",
            "kit.json",
            "activate-tools.mjs",
            "probe-tools.mjs",
            "benchmark-organized-entry.mjs",
            "benchmark-worktree-host.mjs",
            "benchmark-host-factories.mjs",
            "benchmark-child-entry.mjs",
            "probe-child-rpc.mjs",
            "query-organized-terminal.mjs",
        )
        for name in upload_names:
            content = (
                json.dumps(kit)
                if name == "kit.json"
                else "contract fixture: " + name + "\n"
            )
            (adapter_kit / name).write_text(content, encoding="utf-8")
        manifest = {
            "files": [
                {
                    "path": "organized-post/" + name,
                    "sha256": runner_common.digest(adapter_kit / name),
                }
                for name in upload_names
            ]
        }
        manifest_path = adapter_kit / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        adapter_probe = self.load_sdk_adapter_with_stub_parent(adapter_copy)
        self.assertEqual(adapter_probe["adapter_sha256"], runner_common.digest(adapter_path))
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                textwrap.dedent(
                    """
                    import asyncio
                    import importlib.util
                    import json
                    from pathlib import Path
                    import sys
                    import types
                    from unittest.mock import patch

                    adapter_path, benchmark, sdk, events_path, manifest_digest = sys.argv[1:]
                    adapter_path, benchmark, sdk, events_path = map(
                        Path, (adapter_path, benchmark, sdk, events_path)
                    )
                    events = []
                    uploads = {}
                    result = types.SimpleNamespace(return_code=0)

                    class FakeField:
                        def __init__(self, **_kwargs):
                            pass

                    class FakePAOOptions:
                        def __init__(self, **values):
                            self.__dict__.update(values)

                    class FakePAOAgent:
                        options_model = FakePAOOptions
                        _REMOTE_SOURCE_DIR = "/app"
                        _REMOTE_LAUNCHER = "/tmp/pao-benchmark/agent.sh"

                        def __init__(self, options):
                            self.options = options

                        async def install(self, environment):
                            events.append({"kind": "parent-install", "environment": environment, "argument": ""})

                        async def exec_as_agent(self, environment, command):
                            events.append({"kind": "exec", "environment": environment, "argument": command})
                            return result

                        async def _upload_config_text(self, environment, *, content, remote_path, filename):
                            uploads[remote_path] = content
                            events.append({"kind": "upload", "environment": environment, "argument": remote_path + "|" + filename})

                    pydantic = types.ModuleType("pydantic")
                    pydantic.Field = FakeField
                    map_package = types.ModuleType("map_bench_pao")
                    pao_agent = types.ModuleType("map_bench_pao.pao_agent")
                    pao_agent.PAOAgent = FakePAOAgent
                    pao_agent.PAOOptions = FakePAOOptions
                    map_package.pao_agent = pao_agent
                    with patch.dict(sys.modules, {
                        "pydantic": pydantic,
                        "map_bench_pao": map_package,
                        "map_bench_pao.pao_agent": pao_agent,
                    }):
                        spec = importlib.util.spec_from_file_location("sdk_adapter_under_test", adapter_path)
                        adapter = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(adapter)
                    adapter.OrganizedOptions.model_fields = {
                        "organization_manifest_sha256": object()
                    }
                    options = adapter.OrganizedOptions(
                        organization_manifest_sha256=manifest_digest
                    )
                    agent = adapter.OrganizedPAOAgent(options)
                    environment = "fixture-environment"
                    asyncio.run(agent.install(environment))
                    events_path.write_text(json.dumps(events), encoding="utf-8")
                    """
                ),
                str(adapter_copy),
                str(benchmark),
                str(adapter_path.parent),
                str(root / "events.json"),
                runner_common.digest(manifest_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload_events = json.loads(
            (root / "events.json").read_text(encoding="utf-8")
        )
        signed_history = [
            (event["kind"], event["environment"], event["argument"])
            for event in payload_events
        ]
        self.assertIn(
            (
                "upload",
                "fixture-environment",
                "/tmp/benchmark-organization/query-organized-terminal.mjs"
                "|organization-query-organized-terminal.mjs",
            ),
            signed_history,
        )
        self.assertEqual(
            [kind for kind, _environment, _argument in signed_history],
            [
                "parent-install",
                "exec",
                *[
                    "upload"
                    for _ in range(10)
                ],
                "exec",
                "exec",
                *[
                    "exec"
                    for _ in range(3)
                ],
                "exec",
            ],
        )
        install_command = next(
            event["argument"]
            for event in payload_events
            if event["kind"] == "exec"
            and "benchmark-organization/setup.mjs" in event["argument"]
        )
        command = shlex.split(install_command)
        self.assertEqual(
            command,
            [
                "$HOME/.local/pao-node/bin/node",
                "/tmp/benchmark-organization/setup.mjs",
                "/app",
                "/tmp/benchmark-organization/kit.json",
                "/tmp/harbor-pao-home",
                "/tmp/harbor-pi-agent",
                "/logs/agent/organization",
                "/app",
                "/tmp/benchmark-model-binding.json",
            ],
        )
        actual_setup = subprocess.run(
            [
                "C:/Program Files/nodejs/node.exe",
                str(setup),
                str(source),
                str(adapter_kit / "kit.json"),
                str(root / "actual-pao-home"),
                str(root / "actual-agent-dir"),
                str(root / "actual-evidence"),
                str(source),
                str(binding_path),
            ],
            cwd=source,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertEqual(actual_setup.returncode, 0, actual_setup.stderr)
        actual_report = json.loads(
            (root / "actual-evidence" / "organization-setup.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertFalse(actual_report["baseline"]["baseline_created"])
        self.assertEqual(actual_report["baseline"]["head"], source_head)
        self.assertEqual(actual_report["supervision"], report["supervision"])

    def test_setup_git_baseline_create_preserve_and_reject_dirty(self) -> None:
        benchmark = Path(__file__).resolve().parent
        setup = benchmark / "organized-post" / "setup.mjs"
        kit_full = runner_common.read_json(benchmark / "organized-post" / "kit.json")
        root = self.root / "git-baseline"
        root.mkdir()
        kit = {
            "departments": kit_full["departments"],
            "workflow": {
                **kit_full["workflow"],
                "节点": [
                    {
                        **node,
                        "模型": "harbor-endpoint/minimax-code/MiniMax-M3.1-Flash",
                        "思考强度": "high",
                        "档位": "primary",
                    }
                    for node in kit_full["workflow"]["节点"]
                ],
            },
            "description": kit_full.get("description", ""),
        }
        kit_path = root / "kit.json"
        kit_path.write_text(json.dumps(kit), encoding="utf-8")
        source = root / "source"
        module_dir = source / "packages" / "coding-agent" / "dist" / "pao"
        (module_dir / "dept").mkdir(parents=True)
        (module_dir / "workflow").mkdir()
        (module_dir / "preflight").mkdir()
        (source / "package.json").write_text(
            json.dumps({"type": "module"}),
            encoding="utf-8",
        )
        (module_dir / "dept" / "scaffold.js").write_text(
            "import { mkdirSync } from 'node:fs';"
            "import { join } from 'node:path';"
            "export async function createDept({paoHome, 名字}) {"
            "mkdirSync(join(paoHome, '部门', 名字), { recursive: true });"
            "return {注册表: 'created'}; }",
            encoding="utf-8",
        )
        (module_dir / "dept" / "catalog.js").write_text(
            "export function readDeptCatalog() { return {部门: []}; }"
            "export function validateDeptCatalog() { return []; }",
            encoding="utf-8",
        )
        (module_dir / "workflow" / "distill.js").write_text(
            "export function saveRecipe() {}",
            encoding="utf-8",
        )
        (module_dir / "workflow" / "recipe.js").write_text(
            "export function loadRecipe(_paoHome, name, _options) {"
            "return {名字: name, 版本: 2, 自动执行: true,"
            "拓扑序: ['侦察', '规划', '实施', '审核'], 参数: ['任务']}; }",
            encoding="utf-8",
        )
        (module_dir / "preflight" / "index.js").write_text(
            "export function checkPreflight(input) {"
            "if (!input.project) throw new Error('missing project');"
            "return {canStart: true}; }",
            encoding="utf-8",
        )
        yaml = source / "node_modules" / "yaml"
        yaml.mkdir(parents=True)
        (yaml / "package.json").write_text(
            json.dumps({
                "name": "yaml",
                "version": "1.0.0",
                "type": "module",
                "exports": "./index.js",
            }),
            encoding="utf-8",
        )
        (yaml / "index.js").write_text(
            "export function stringify(value) { return JSON.stringify(value); }",
            encoding="utf-8",
        )
        (root / "activate-tools.mjs").write_text(
            "",
            encoding="utf-8",
        )
        binding_path = root / "binding.json"
        binding_path.write_text(
            json.dumps({
                "model_name": "harbor-endpoint/minimax-code/MiniMax-M3.1-Flash",
                "selected_model_name": "openai/minimax-code/MiniMax-M3.1-Flash",
                "provider": "harbor-endpoint",
                "model": "minimax-code/MiniMax-M3.1-Flash",
                "thinking": "high",
            }),
            encoding="utf-8",
        )

        def run_setup(name: str) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
            project = root / name
            project.mkdir()
            (project / "input.txt").write_text(name + "\n", encoding="utf-8")
            pao_home = root / (name + "-home")
            agent_dir = root / (name + "-agent")
            evidence = root / (name + "-evidence")
            completed = subprocess.run(
                [
                    "C:/Program Files/nodejs/node.exe",
                    str(setup),
                    str(source),
                    str(kit_path),
                    str(pao_home),
                    str(agent_dir),
                    str(evidence),
                    str(project),
                    str(binding_path),
                ],
                cwd=source,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
            return completed, project, evidence

        created, created_root, created_evidence = run_setup("created")
        self.assertEqual(created.returncode, 0, created.stderr)
        created_report = runner_common.read_json(
            created_evidence / "git-baseline.json"
        )
        self.assertTrue(created_report["baseline_created"])
        self.assertEqual(
            created_report["head"],
            self.git_output(created_root, "rev-parse", "HEAD").strip(),
        )

        already_clean = root / "already-clean"
        already_clean.mkdir()
        (already_clean / "input.txt").write_text("clean\n", encoding="utf-8")
        self.git(already_clean, "init")
        self.git(already_clean, "add", "-A")
        self.commit_git_fixture(already_clean, "existing baseline")
        existing_head = self.git_output(already_clean, "rev-parse", "HEAD").strip()
        clean_home = root / "already-clean-home"
        clean_agent = root / "already-clean-agent"
        clean_evidence = root / "already-clean-evidence"
        clean = subprocess.run(
            [
                "C:/Program Files/nodejs/node.exe",
                str(setup),
                str(source),
                str(kit_path),
                str(clean_home),
                str(clean_agent),
                str(clean_evidence),
                str(already_clean),
                str(binding_path),
            ],
            cwd=source,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertEqual(clean.returncode, 0, clean.stderr)
        clean_report = runner_common.read_json(clean_evidence / "git-baseline.json")
        self.assertFalse(clean_report["baseline_created"])
        self.assertEqual(clean_report["head"], existing_head)

        dirty = root / "dirty"
        dirty.mkdir()
        (dirty / "input.txt").write_text("tracked\n", encoding="utf-8")
        self.git(dirty, "init")
        self.git(dirty, "add", "-A")
        self.commit_git_fixture(dirty, "existing baseline")
        (dirty / "input.txt").write_text("dirty\n", encoding="utf-8")
        dirty_home = root / "dirty-home"
        dirty_agent = root / "dirty-agent"
        dirty_evidence = root / "dirty-evidence"
        rejected = subprocess.run(
            [
                "C:/Program Files/nodejs/node.exe",
                str(setup),
                str(source),
                str(kit_path),
                str(dirty_home),
                str(dirty_agent),
                str(dirty_evidence),
                str(dirty),
                str(binding_path),
            ],
            cwd=source,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn(
            "Git 输入基线建立后工作区必须干净",
            rejected.stderr,
        )

    def test_scope_rejects_wrong_model_and_retry(self) -> None:
        run = self.make_run()
        config = runner_common.read_json(run / "run-config.json")
        config["agents"][0]["kwargs"]["thinking"] = "low"
        with self.assertRaisesRegex(ValueError, "high"):
            runner_common.validate_run_config(config)
        config = runner_common.read_json(run / "run-config.json")
        config["retry"]["max_retries"] = 1
        with self.assertRaisesRegex(ValueError, "重试"):
            runner_common.validate_run_config(config)

    def test_launch_rejects_replay_before_docker(self) -> None:
        run = self.make_run(started=True)
        calls = []
        with self.assertRaises(FileExistsError):
            launch_run.launch(
                run,
                environ={"PAO_BENCH_API_KEY": "fixture"},
                runner=lambda *args, **kwargs: calls.append(args),
            )
        self.assertEqual(calls, [])

    def test_launch_mounts_host_workspace_and_configured_run_separately(self) -> None:
        run = self.make_run()
        calls = []
        fixture_python = (
            self.root
            / "临时文件夹/地图简报基准-20261020/"
            "f-harbor-linux/.venv/bin/python"
        )
        fixture_python.parent.mkdir(parents=True)
        fixture_python.write_text("fixture\n", encoding="utf-8")
        original = (
            launch_run.HOST_WORKSPACE,
            launch_run.HOST_WORKSPACE_CONTAINER_ROOT,
            launch_run.LINUX_PYTHON,
        )
        launch_run.HOST_WORKSPACE = self.root
        launch_run.HOST_WORKSPACE_CONTAINER_ROOT = "/mnt/integration"
        launch_run.LINUX_PYTHON = (
            "/mnt/integration/临时文件夹/地图简报基准-20261020/"
            "f-harbor-linux/.venv/bin/python"
        )
        self.addCleanup(
            lambda: (
                setattr(launch_run, "HOST_WORKSPACE", original[0]),
                setattr(
                    launch_run,
                    "HOST_WORKSPACE_CONTAINER_ROOT",
                    original[1],
                ),
                setattr(launch_run, "LINUX_PYTHON", original[2]),
            )
        )

        def runner(docker, *args, **kwargs):
            calls.append((docker, *args))
            return subprocess.CompletedProcess(
                args=[docker, *args],
                returncode=0,
                stdout="controller-id\n",
                stderr="",
            )

        image_id = "sha256:" + "a" * 64

        def query(docker, name):
            return {
                "Running": True,
                "Paused": False,
                "Restarting": False,
                "Pid": 123,
                "ExitCode": None,
            }

        launch_run.launch(
            run,
            environ={"PAO_BENCH_API_KEY": "fixture"},
            runner=runner,
            query=query,
            image_query=lambda docker, name: image_id,
        )
        command = calls[0]
        mounts = [
            command[index + 1]
            for index, value in enumerate(command[:-1])
            if value == "-v"
        ]
        self.assertIn(str(self.root) + ":/mnt/integration", mounts)
        self.assertIn(
            str(self.root)
            + ":"
            + runner_common.read_json(run / "run-sources.json")[
                "container_mounts"
            ]["container_root"],
            mounts,
        )
        self.assertEqual(
            command[command.index(launch_run.LINUX_PYTHON) - 0],
            launch_run.LINUX_PYTHON,
        )
        relative_python = launch_run.LINUX_PYTHON.removeprefix(
            launch_run.HOST_WORKSPACE_CONTAINER_ROOT + "/"
        )
        python_host_path = launch_run.HOST_WORKSPACE / Path(relative_python)
        self.assertEqual(python_host_path, fixture_python)
        self.assertTrue(python_host_path.is_file())
        self.assertEqual(
            python_host_path.relative_to(launch_run.HOST_WORKSPACE),
            Path(
                "临时文件夹/地图简报基准-20261020/"
                "f-harbor-linux/.venv/bin/python"
            ),
        )
        launch = runner_common.read_json(run / "runtime-launch.json")
        self.assertEqual(launch["image_name"], launch_run.CONTROLLER_IMAGE)
        self.assertEqual(launch["image_id"], image_id)
        self.assertNotEqual(launch["image_name"], launch["image_id"])
        self.assertEqual(
            launch["interpreter"]["container_path"],
            launch_run.LINUX_PYTHON,
        )
        self.assertEqual(
            launch["interpreter"]["host_source_sha256"],
            runner_common.digest(fixture_python),
        )

    @unittest.skipUnless(os.name == "nt", "Windows 子进程环境传递夹具")
    def test_launch_passes_environment_to_real_child_process(self) -> None:
        run = self.make_run()
        fake_docker = self.root / "fake-docker.cmd"
        fake_docker.write_bytes(
            b"@echo off\r\n"
            b"if not defined PAO_BENCH_API_KEY exit /b 23\r\n"
            b"echo controller-id-from-child\r\n"
        )

        def fake_query(docker, name):
            return {"Running": True}

        original_linux_python = launch_run.LINUX_PYTHON
        fixture_python = (
            self.root
            / "临时文件夹/地图简报基准-20261020/"
            "f-harbor-linux/.venv/bin/python"
        )
        fixture_python.parent.mkdir(parents=True)
        fixture_python.write_text("fixture\n", encoding="utf-8")
        original_workspace = launch_run.HOST_WORKSPACE
        original_container_root = launch_run.HOST_WORKSPACE_CONTAINER_ROOT
        launch_run.HOST_WORKSPACE = self.root
        launch_run.HOST_WORKSPACE_CONTAINER_ROOT = "/mnt/integration"
        launch_run.LINUX_PYTHON = (
            "/mnt/integration/临时文件夹/地图简报基准-20261020/"
            "f-harbor-linux/.venv/bin/python"
        )
        self.addCleanup(
            lambda: (
                setattr(launch_run, "LINUX_PYTHON", original_linux_python),
                setattr(launch_run, "HOST_WORKSPACE", original_workspace),
                setattr(
                    launch_run,
                    "HOST_WORKSPACE_CONTAINER_ROOT",
                    original_container_root,
                ),
            )
        )

        result = launch_run.launch(
            run,
            docker=str(fake_docker),
            environ={"PAO_BENCH_API_KEY": "fixture-only"},
            query=fake_query,
            image_query=lambda docker, name: "sha256:" + "b" * 64,
        )

        self.assertEqual(result["container_id"], "controller-id-from-child")
        self.assertEqual(
            (run / "approved-controller-id.txt").read_text(encoding="utf-8"),
            "controller-id-from-child\n",
        )
        self.assertNotIn("fixture-only", json.dumps(result))

    def test_controller_exit_does_not_stop_observation_while_child_lives(self) -> None:
        run = self.make_run()
        job_config = run / "jobs" / "job" / "config.json"
        job_config.parent.mkdir(parents=True)
        runner_common.write_json(job_config, {"job_name": "controller-test"})
        trial_config = run / "jobs" / "task" / "trial" / "config.json"
        trial_config.parent.mkdir(parents=True)
        runner_common.write_json(trial_config, {"trial_name": "trial-one"})
        child_project = "trial-one__env"
        runner_common.write_json(
            run / "control-status.json",
            {"state": "running", "writers_stopped": False},
        )

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row("trial-one__abc-env-main-1", child_project, True),
                    ]
                )
            name = args[-1]
            self.assertIn(name, ("controller-test", "trial-one__abc-env-main-1"))
            return self.state(name == "trial-one__abc-env-main-1")

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )
        self.assertTrue(result["controller_stopped"])
        self.assertFalse(result["containers_stopped"])
        self.assertFalse(result["terminal"])
        self.assertFalse((run / "controller-exit.json").exists())
        self.assertFalse((run / "terminal-receipt.json").exists())

    def test_formal_phase_keeps_live_preflight_container_in_scope(self) -> None:
        run = self.make_run()
        preflight_job = run / "jobs" / "controller-preflight"
        preflight_trial = preflight_job / "preflight-trial"
        preflight_trial.mkdir(parents=True)
        runner_common.write_json(
            preflight_job / "config.json",
            {"job_name": "controller-preflight"},
        )
        runner_common.write_json(
            preflight_trial / "config.json",
            {"trial_name": "preflight-trial"},
        )
        formal_job = run / "jobs" / "controller-task-1"
        formal_trial = formal_job / "formal-trial"
        formal_trial.mkdir(parents=True)
        runner_common.write_json(
            formal_job / "config.json",
            {"job_name": "controller-task-1"},
        )
        runner_common.write_json(
            formal_trial / "config.json",
            {"trial_name": "formal-trial"},
        )
        runner_common.write_json(
            run / "control-status.json",
            {"state": "finished", "writers_stopped": True},
        )
        preflight_container = "preflight-trial__abc-env-main-1"

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(
                            preflight_container,
                            "preflight-trial__env",
                            True,
                        ),
                        self.docker_row(
                            "formal-trial__abc-env-main-1",
                            "formal-trial__env",
                            False,
                        ),
                        self.docker_row(
                            "formal-trial__abc-verifier-1",
                            "formal-trial__verifier__trial",
                            False,
                        ),
                    ]
                )
            return self.state(args[-1] == preflight_container)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )
        self.assertFalse(result["terminal"])
        self.assertFalse(result["actual_stop_observed"])
        self.assertIn(
            preflight_container,
            result["scope"]["discovered_container_names"],
        )
        self.assertIn(
            "preflight-trial__env",
            result["scope"]["discovered_projects"],
        )
        self.assertNotIn(
            "preflight-trial__env",
            [
                item.get("project")
                for item in result["scope"]["missing_identities"]
            ],
        )
        self.assertFalse((run / "terminal-receipt.json").exists())

    def test_trial_discovery_ignores_job_config_and_rejects_invalid_trial(self) -> None:
        run = self.make_run()
        job_config = run / "jobs" / "job" / "config.json"
        job_config.parent.mkdir(parents=True)
        runner_common.write_json(job_config, {"job_name": "controller-test"})
        trial_config = run / "jobs" / "job" / "trial-one" / "config.json"
        trial_config.parent.mkdir(parents=True)
        runner_common.write_json(trial_config, {"trial_name": "trial-one"})

        self.assertEqual(
            watch_run.expected_projects(run),
            {"trial-one__env", "trial-one__verifier__trial"},
        )

        runner_common.write_json(trial_config, {"trial_name": None})
        with self.assertRaisesRegex(ValueError, "缺少 trial_name"):
            watch_run.expected_projects(run)

        trial_config.write_text("{", encoding="utf-8")
        with self.assertRaises(json.JSONDecodeError):
            watch_run.expected_projects(run)

    def test_preflight_trial_uses_same_job_trial_depth(self) -> None:
        run = self.make_run()
        preflight_job_config = (
            run / "jobs" / "controller-preflight" / "config.json"
        )
        preflight_job_config.parent.mkdir(parents=True)
        runner_common.write_json(
            preflight_job_config,
            {"job_name": "controller-preflight"},
        )
        trial_config = (
            run
            / "jobs"
            / "controller-preflight"
            / "preflight-trial"
            / "config.json"
        )
        trial_config.parent.mkdir(parents=True)
        runner_common.write_json(
            trial_config,
            {"trial_name": "preflight-trial"},
        )

        self.assertEqual(
            watch_run.expected_projects(run),
            {"preflight-trial__env"},
        )

    def test_discover_includes_real_verifier_project_with_trial_config(self) -> None:
        run = self.make_run()
        job_config = run / "jobs" / "job" / "config.json"
        job_config.parent.mkdir(parents=True)
        runner_common.write_json(job_config, {"job_name": "controller-test"})
        trial_config = run / "jobs" / "job" / "trial-one" / "config.json"
        trial_config.parent.mkdir(parents=True)
        runner_common.write_json(trial_config, {"trial_name": "trial-one"})

        trial_project = "trial-one__env"
        verifier_project = "trial-one__verifier__trial"

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(
                            "trial-one__abc-env-main-1",
                            trial_project + "__env",
                            False,
                        ),
                        self.docker_row(
                            "trial-one__abc-verifier-1",
                            verifier_project,
                            False,
                        ),
                    ]
                )
            return self.state(False)

        containers = watch_run.discover(
            run,
            "controller-test",
            runner=runner,
        )
        self.assertEqual(
            [(item["name"], item["role"]) for item in containers],
            [
                ("controller-test", "controller"),
                ("trial-one__abc-env-main-1", "env"),
                ("trial-one__abc-verifier-1", "verifier"),
            ],
        )
        scope = runner_common.read_json(run / "container-scope.json")
        self.assertIn("trial-one__verifier__trial", scope["discovered_projects"])
        self.assertNotIn(
            "trial-one__env__verifier__trial",
            scope["discovered_projects"],
        )
        self.assertTrue(scope["scope_complete"])

    def test_missing_verifier_is_not_treated_as_stopped(self) -> None:
        run = self.make_run()
        trial = run / "jobs" / "job" / "trial-one"
        trial.mkdir(parents=True)
        runner_common.write_json(
            trial / "config.json",
            {"trial_name": "trial-one"},
        )
        runner_common.write_json(
            run / "control-status.json",
            {"state": "running", "writers_stopped": False},
        )

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(
                            "trial-one__abc-env-main-1",
                            "trial-one__env",
                            False,
                        ),
                    ]
                )
            return self.state(False)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )
        self.assertFalse(result["terminal"])
        self.assertFalse(result["container_identities_verified"])
        self.assertFalse(result["actual_stop_observed"])
        self.assertEqual(
            result["scope"]["missing_identities"],
            [
                {
                    "kind": "project",
                    "project": "trial-one__verifier__trial",
                    "role": "verifier",
                },
            ],
        )
        self.assertFalse((run / "terminal-receipt.json").exists())

    def test_cancelled_trial_can_stop_before_verifier_but_observes_created_verifier(self) -> None:
        run = self.make_run()
        trial = run / "jobs" / "controller-task-1" / "trial-one"
        trial.mkdir(parents=True)
        runner_common.write_json(trial / "config.json", {"trial_name": "trial-one"})
        runner_common.write_json(trial / "result.json", {
            "verifier_result": None,
            "exception_info": {"exception_type": "CancelledError"},
        })
        runner_common.write_json(run / "control-status.json", {
            "state": "mechanism_stopped", "writers_stopped": True,
        })

        for verifier_running in (None, True, False):
            with self.subTest(verifier_running=verifier_running):
                def runner(docker, *args, **kwargs):
                    if args[0] == "ps":
                        rows = [
                            self.docker_row("controller-test", "", False),
                            self.docker_row("trial-one__abc-env-main-1", "trial-one__env", False),
                        ]
                        if verifier_running is not None:
                            rows.append(self.docker_row("trial-one__abc-verifier-1", "trial-one__verifier__trial", verifier_running))
                        return "\n".join(rows)
                    return self.state(bool(verifier_running) if "verifier" in args[-1] else False)

                result = watch_run.observe_once(run, "controller-test", runner=runner)
                self.assertEqual(result["terminal"], verifier_running is not True)
                self.assertTrue(result["scope"]["scope_complete"])
                if result["terminal"]:
                    receipt = runner_common.read_json(run / "terminal-receipt.json")
                    self.assertEqual(receipt["official_rewards"], [])
                    self.assertEqual(receipt["exceptions"], [{"exception_type": "CancelledError"}])
                    facts = receipt["business_terminal"]
                    self.assertEqual(facts["business_status"], "mechanism_stopped")
                    self.assertFalse(facts["business_finished"])
                    self.assertTrue(facts["business_failed"])
                    self.assertTrue(facts["trial_result_exists"])
                    self.assertEqual(facts["official_verifier_result_count"], 0)
                    self.assertFalse(facts["formal_result_exists"])
                    self.assertEqual(facts["missing_reward_count"], 1)
                    self.assertEqual(facts["malformed_reward_count"], 0)
                    self.assertEqual(facts["scoring"], "verifier_not_run")
                    self.assertIn("mechanism_stopped", receipt["reward_note"])
                    self.assertIn("reward 缺失", receipt["reward_note"])

    def test_docker_state_query_failure_aborts_without_stop_receipt(self) -> None:
        run = self.make_run()

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return self.docker_row("controller-test", "", False)
            raise RuntimeError("mock inspect failure")

        with self.assertRaisesRegex(RuntimeError, "mock inspect failure"):
            watch_run.watch(
                run,
                "controller-test",
                runner=runner,
                interval=0,
                max_seconds=1,
            )
        self.assertFalse((run / "terminal-receipt.json").exists())
        self.assertIn(
            "mock inspect failure",
            runner_common.read_json(run / "watch-error.json")["error"],
        )

    def test_extra_current_round_container_prevents_terminal(self) -> None:
        run = self.make_run()
        trial = run / "jobs" / "job" / "trial-one"
        trial.mkdir(parents=True)
        runner_common.write_json(
            trial / "config.json",
            {"trial_name": "trial-one"},
        )
        runner_common.write_json(
            run / "control-status.json",
            {"state": "running", "writers_stopped": True},
        )

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(
                            "trial-one__abc-env-child-1",
                            "trial-one__env__child",
                            True,
                        ),
                    ]
                )
            return self.state(args[-1] != "controller-test")

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )
        self.assertFalse(result["terminal"])
        self.assertFalse(result["containers_stopped"])
        self.assertFalse((run / "terminal-receipt.json").exists())

    def test_preflight_failure_without_formal_result_has_actual_stop_receipt(self) -> None:
        run = self.make_run()
        runner_common.write_json(
            run / "control-status.json",
            {
                "state": "failed",
                "error": "RuntimeError('环境预检失败；未启动正式模型')",
                "model_execution_started": False,
                "writers_stopped": False,
            },
        )
        runner_common.write_json(
            run / "preflight-summary.json",
            {
                "trial_results": [
                    {
                        "exception_info": {
                            "exception_type": "RuntimeError",
                            "exception_message": "model unavailable",
                        }
                    }
                ]
            },
        )

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return self.docker_row("controller-test", "", False)
            return self.crashed_state(0)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )
        self.assertTrue(result["terminal"])
        self.assertTrue(result["actual_stop_observed"])
        self.assertFalse(result["writers_stopped"])
        control = runner_common.read_json(run / "control-status.json")
        self.assertEqual(control["state"], "failed")
        self.assertFalse(control["writers_stopped"])
        receipt = runner_common.read_json(run / "terminal-receipt.json")
        self.assertEqual(receipt["official_rewards"], [])
        facts = receipt["business_terminal"]
        self.assertFalse(facts["business_finished"])
        self.assertTrue(facts["business_failed"])
        self.assertFalse(facts["trial_result_exists"])
        self.assertFalse(facts["formal_result_exists"])
        self.assertEqual(facts["scoring"], "not_run")
        self.assertIn("failed", receipt["reward_note"])
        self.assertIn("官方评分未运行", receipt["reward_note"])
        self.assertEqual(
            facts["error"],
            "RuntimeError('环境预检失败；未启动正式模型')",
        )
        controller_exit = runner_common.read_json(run / "controller-exit.json")
        self.assertTrue(controller_exit["actors_stopped_observed"])
        self.assertFalse(controller_exit["writers_stopped"])
        self.assertEqual(
            controller_exit["terminal_basis"],
            "failed_before_formal_result",
        )

    def test_preflight_failure_does_not_terminalize_while_container_lives(self) -> None:
        run = self.make_run()
        job_config = run / "jobs" / "controller-preflight" / "config.json"
        job_config.parent.mkdir(parents=True)
        runner_common.write_json(job_config, {"job_name": "controller-preflight"})
        trial_config = (
            run
            / "jobs"
            / "controller-preflight"
            / "preflight-trial"
            / "config.json"
        )
        trial_config.parent.mkdir()
        runner_common.write_json(trial_config, {"trial_name": "preflight-trial"})
        runner_common.write_json(
            run / "control-status.json",
            {
                "state": "failed",
                "error": "RuntimeError('环境预检失败；未启动正式模型')",
                "model_execution_started": False,
                "writers_stopped": False,
            },
        )
        runner_common.write_json(
            run / "preflight-summary.json",
            {
                "trial_results": [
                    {
                        "exception_info": {
                            "exception_type": "RuntimeError",
                            "exception_message": "model unavailable",
                        }
                    }
                ]
            },
        )
        child = "preflight-trial__abc-env-main-1"

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(child, "preflight-trial__env", True),
                    ]
                )
            return self.state(args[-1] == child)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )
        self.assertFalse(result["terminal"])
        self.assertFalse(result["actual_stop_observed"])
        self.assertFalse(result["containers_stopped"])
        self.assertFalse((run / "terminal-receipt.json").exists())
        self.assertFalse((run / "controller-exit.json").exists())
        control = runner_common.read_json(run / "control-status.json")
        self.assertEqual(control["state"], "failed")
        self.assertFalse(control["writers_stopped"])

    def test_stale_preflight_controller_crash_without_result_is_terminal(self) -> None:
        run = self.make_run()
        job_config = run / "jobs" / "controller-preflight" / "config.json"
        job_config.parent.mkdir(parents=True)
        runner_common.write_json(job_config, {"job_name": "controller-preflight"})
        trial_config = (
            run
            / "jobs"
            / "controller-preflight"
            / "preflight-trial"
            / "config.json"
        )
        trial_config.parent.mkdir(parents=True)
        runner_common.write_json(trial_config, {"trial_name": "preflight-trial"})
        runner_common.write_json(
            run / "control-status.json",
            {"state": "preflight", "writers_stopped": False},
        )
        control_before = (run / "control-status.json").read_bytes()

        child = "preflight-trial__abc-env-main-1"
        child_project = bench_controller.compose_project("preflight-trial") + "__env"

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(child, child_project, False),
                    ]
                )
            return (
                self.crashed_state(255)
                if args[-1] == "controller-test"
                else self.state(False)
            )

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )

        self.assertTrue(result["actual_stop_observed"])
        self.assertTrue(result["terminal"])
        self.assertTrue(result["controller_crash"])
        self.assertEqual(result["controller_exit_code"], 255)
        self.assertFalse(result["writers_stopped"])
        self.assertEqual((run / "control-status.json").read_bytes(), control_before)
        receipt = runner_common.read_json(run / "terminal-receipt.json")
        self.assertEqual(receipt["official_rewards"], [])
        facts = receipt["business_terminal"]
        self.assertEqual(facts["business_status"], "preflight")
        self.assertFalse(facts["business_finished"])
        self.assertIsNone(facts["business_failed"])
        self.assertFalse(facts["formal_result_exists"])
        self.assertEqual(
            facts["scoring"],
            "missing_or_not_run",
        )
        self.assertIn("preflight", receipt["reward_note"])
        self.assertIn("控制器异常退出", receipt["reward_note"])
        controller_exit = runner_common.read_json(run / "controller-exit.json")
        self.assertFalse(controller_exit["writers_stopped"])
        self.assertTrue(controller_exit["actors_stopped_observed"])
        self.assertEqual(controller_exit["controller_exit_code"], 255)
        self.assertTrue(controller_exit["controller_crash"])
        self.assertEqual(
            controller_exit["terminal_basis"],
            "controller_crash",
        )
        self.assertEqual(controller_exit["business_status_preserved"], "preflight")

    def test_stale_preflight_crash_does_not_finalize_while_child_lives(self) -> None:
        run = self.make_run()
        job_config = run / "jobs" / "controller-preflight" / "config.json"
        job_config.parent.mkdir(parents=True)
        runner_common.write_json(job_config, {"job_name": "controller-preflight"})
        trial_config = (
            run
            / "jobs"
            / "controller-preflight"
            / "preflight-trial"
            / "config.json"
        )
        trial_config.parent.mkdir()
        runner_common.write_json(trial_config, {"trial_name": "preflight-trial"})
        runner_common.write_json(
            run / "control-status.json",
            {"state": "preflight", "writers_stopped": False},
        )
        child = "preflight-trial__abc-env-main-1"

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(child, "preflight-trial__env", True),
                    ]
                )
            return (
                self.crashed_state(255)
                if args[-1] == "controller-test"
                else self.state(True)
            )

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )

        self.assertTrue(result["controller_crash"])
        self.assertFalse(result["actual_stop_observed"])
        self.assertFalse(result["terminal"])
        self.assertFalse((run / "terminal-receipt.json").exists())
        self.assertFalse((run / "controller-exit.json").exists())

    def test_controller_crash_preserves_existing_result_and_reward(self) -> None:
        run = self.make_run()
        trial = run / "jobs" / "controller-task-1" / "trial-one"
        trial.mkdir(parents=True)
        runner_common.write_json(
            trial / "config.json",
            {"trial_name": "trial-one"},
        )
        runner_common.write_json(
            trial / "result.json",
            {
                "verifier_result": {"rewards": {"reward": 0.0}},
                "exception_info": {
                    "exception_type": "RuntimeError",
                    "exception_message": "controller exited during collection",
                },
                "agent_result": {"model_usage": {}},
            },
        )
        runner_common.write_json(
            run / "control-status.json",
            {"state": "paused", "writers_stopped": False},
        )
        control_before = (run / "control-status.json").read_bytes()

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return self.docker_row("controller-test", "", False)
            return self.crashed_state(255)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )

        self.assertFalse(result["terminal"])
        self.assertEqual(
            result["scope"]["missing_identities"],
            [
                {
                    "kind": "project",
                    "project": "trial-one__env",
                    "role": "env",
                },
                {
                    "kind": "project",
                    "project": "trial-one__verifier__trial",
                    "role": "verifier",
                }
            ],
        )
        self.assertFalse((run / "terminal-receipt.json").exists())

        def complete_runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(
                            "trial-one__abc-env-main-1",
                            "trial-one__env",
                            False,
                        ),
                        self.docker_row(
                            "trial-one__abc-verifier-1",
                            "trial-one__verifier__trial",
                            False,
                        ),
                    ]
                )
            return (
                self.crashed_state(255)
                if args[-1] == "controller-test"
                else self.state(False)
            )

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=complete_runner,
        )
        self.assertTrue(result["terminal"])
        self.assertTrue(result["controller_crash"])
        self.assertEqual((run / "control-status.json").read_bytes(), control_before)
        receipt = runner_common.read_json(run / "terminal-receipt.json")
        self.assertEqual(receipt["official_rewards"], [0.0])
        self.assertEqual(
            receipt["exceptions"][0]["exception_message"],
            "controller exited during collection",
        )
        self.assertEqual(receipt["business_terminal"]["business_status"], "paused")
        self.assertEqual(
            receipt["business_terminal"]["scoring"],
            "official_result_available",
        )
        facts = receipt["business_terminal"]
        self.assertFalse(facts["business_finished"])
        self.assertIsNone(facts["business_failed"])
        self.assertTrue(facts["trial_result_exists"])
        self.assertEqual(facts["official_verifier_result_count"], 1)
        self.assertTrue(facts["formal_result_exists"])
        self.assertIn("已暂停", receipt["reward_note"])
        self.assertIn("没有证明成功或正常作答", receipt["reward_note"])
        controller_exit = runner_common.read_json(run / "controller-exit.json")
        self.assertEqual(controller_exit["terminal_basis"], "controller_crash")
        self.assertFalse(controller_exit["writers_stopped"])
        self.assertEqual(controller_exit["controller_exit_code"], 255)

    def test_failed_with_unknown_model_start_uses_neutral_no_result_note(self) -> None:
        run = self.make_run()
        runner_common.write_json(
            run / "control-status.json",
            {
                "state": "failed",
                "error": "RuntimeError('interrupted during model execution')",
                "writers_stopped": False,
            },
        )

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return self.docker_row("controller-test", "", False)
            return self.state(False)

        watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )
        receipt = runner_common.read_json(run / "terminal-receipt.json")
        facts = receipt["business_terminal"]
        self.assertFalse(facts["business_finished"])
        self.assertTrue(facts["business_failed"])
        self.assertIsNone(facts["model_execution_started"])
        self.assertIn("failed", receipt["reward_note"])
        self.assertIn("没有正式评分结果", receipt["reward_note"])
        self.assertEqual(
            facts["scoring"],
            "missing_or_not_run",
        )

    def test_execution_error_trial_result_does_not_claim_official_result(self) -> None:
        run = self.make_run()
        trial = run / "jobs" / "controller-task-1" / "trial-one"
        trial.mkdir(parents=True)
        runner_common.write_json(
            run / "jobs" / "controller-task-1" / "config.json",
            {"job_name": "controller-task-1"},
        )
        runner_common.write_json(
            trial / "config.json",
            {"trial_name": "trial-one"},
        )
        exception = {
            "exception_type": "RuntimeError",
            "exception_message": "组织工作流未完成：status=hold",
        }
        runner_common.write_json(
            trial / "result.json",
            {
                "verifier_result": None,
                "exception_info": exception,
                "agent_result": {},
            },
        )
        runner_common.write_json(
            run / "control-status.json",
            {"state": "execution_error", "writers_stopped": True},
        )
        child = "trial-one__abc-env-main-1"
        child_project = bench_controller.compose_project("trial-one", "env")

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(child, child_project, False),
                    ]
                )
            return self.crashed_state(0)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )

        self.assertTrue(result["terminal"])
        receipt = runner_common.read_json(run / "terminal-receipt.json")
        facts = receipt["business_terminal"]
        self.assertEqual(facts["business_status"], "execution_error")
        self.assertFalse(facts["business_finished"])
        self.assertTrue(facts["business_failed"])
        self.assertTrue(facts["trial_result_exists"])
        self.assertEqual(facts["trial_result_count"], 1)
        self.assertEqual(facts["official_verifier_result_count"], 0)
        self.assertFalse(facts["formal_result_exists"])
        self.assertEqual(facts["valid_reward_count"], 0)
        self.assertEqual(facts["missing_reward_count"], 1)
        self.assertEqual(facts["malformed_reward_count"], 0)
        self.assertEqual(facts["scoring"], "verifier_not_run")
        self.assertEqual(receipt["exceptions"], [exception])
        self.assertIn("官方 verifier 未运行", receipt["reward_note"])
        self.assertIn("reward 缺失", receipt["reward_note"])
        self.assertNotIn("奖励畸形", receipt["reward_note"])

    def test_missing_score_is_failed_with_missing_official_reward(self) -> None:
        run = self.make_run()
        trial = run / "jobs" / "controller-task-1" / "trial-one"
        trial.mkdir(parents=True)
        runner_common.write_json(
            run / "jobs" / "controller-task-1" / "config.json",
            {"job_name": "controller-task-1"},
        )
        runner_common.write_json(
            trial / "config.json",
            {"trial_name": "trial-one"},
        )
        runner_common.write_json(
            trial / "result.json",
            {
                "verifier_result": {"rewards": {}},
                "exception_info": None,
                "agent_result": {},
            },
        )
        runner_common.write_json(
            run / "control-status.json",
            {"state": "missing_score", "writers_stopped": True},
        )
        env = "trial-one__abc-env-main-1"
        verifier = "trial-one__abc-verifier-1"

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(env, "trial-one__env", False),
                        self.docker_row(
                            verifier,
                            "trial-one__verifier__trial",
                            False,
                        ),
                    ]
                )
            return self.crashed_state(0)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )

        self.assertTrue(result["terminal"])
        receipt = runner_common.read_json(run / "terminal-receipt.json")
        facts = receipt["business_terminal"]
        self.assertEqual(facts["business_status"], "missing_score")
        self.assertFalse(facts["business_finished"])
        self.assertTrue(facts["business_failed"])
        self.assertTrue(facts["trial_result_exists"])
        self.assertEqual(facts["official_verifier_result_count"], 1)
        self.assertTrue(facts["formal_result_exists"])
        self.assertEqual(facts["missing_reward_count"], 1)
        self.assertEqual(facts["malformed_reward_count"], 0)
        self.assertEqual(facts["scoring"], "official_result_missing_reward")
        self.assertIn("missing_score", receipt["reward_note"])
        self.assertIn("没有 reward", receipt["reward_note"])

    def test_paused_without_score_is_not_reported_as_success(self) -> None:
        run = self.make_run()
        runner_common.write_json(
            run / "control-status.json",
            {"state": "paused", "writers_stopped": True},
        )

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return self.docker_row("controller-test", "", False)
            return self.crashed_state(0)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )

        self.assertTrue(result["terminal"])
        receipt = runner_common.read_json(run / "terminal-receipt.json")
        facts = receipt["business_terminal"]
        self.assertEqual(facts["business_status"], "paused")
        self.assertFalse(facts["business_finished"])
        self.assertIsNone(facts["business_failed"])
        self.assertEqual(facts["scoring"], "missing_or_not_run")
        self.assertIn("已暂停", receipt["reward_note"])
        self.assertIn("没有证明成功或正常作答", receipt["reward_note"])
        self.assertNotIn("已结束（finished）", receipt["reward_note"])

    def test_running_and_unknown_do_not_fake_business_outcome(self) -> None:
        for label, status in (("running", "running"), ("missing", None)):
            with self.subTest(status=status):
                run = self.root / f"run-{label}"
                run.mkdir()
                (run / "jobs").mkdir()
                runner_common.write_json(run / "run-sources.json", {})
                if status is not None:
                    runner_common.write_json(
                        run / "control-status.json",
                        {"state": status, "writers_stopped": False},
                    )

                def runner(docker, *args, **kwargs):
                    if args[0] == "ps":
                        return self.docker_row("controller-test", "", False)
                    return self.crashed_state(0)

                result = watch_run.observe_once(
                    run,
                    "controller-test",
                    runner=runner,
                )
                facts = result["business_terminal"]
                self.assertEqual(
                    facts["business_status"],
                    status if status is not None else "unknown",
                )
                self.assertFalse(facts["business_finished"])
                self.assertIsNone(facts["business_failed"])
                self.assertFalse(result["terminal"])
                self.assertFalse((run / "terminal-receipt.json").exists())

    def test_business_status_failure_classification_keeps_unknown_as_null(self) -> None:
        run = self.make_run()
        expected = {
            "finished": False,
            "failed": True,
            "execution_error": True,
            "missing_score": True,
            "mechanism_stopped": True,
            "stop_unconfirmed": True,
            "paused": None,
            "running": None,
            "preflight": None,
            "unknown": None,
        }
        for status, business_failed in expected.items():
            with self.subTest(status=status):
                facts = watch_run.terminal_facts(
                    run,
                    {"state": status},
                    [],
                )
                self.assertEqual(facts["business_status"], status)
                self.assertEqual(facts["business_finished"], status == "finished")
                self.assertIs(facts["business_failed"], business_failed)

        missing = watch_run.terminal_facts(run, None, [])
        self.assertEqual(missing["business_status"], "unknown")
        self.assertFalse(missing["business_finished"])
        self.assertIsNone(missing["business_failed"])

    def test_score_container_is_in_round_scope(self) -> None:
        run = self.make_run()
        score = watch_run.score_container_name(run)
        seen = []

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(score, "", False),
                    ]
                )
            seen.append(args[-1])
            return self.state(args[-1] == "controller-test")

        containers = watch_run.discover(run, "controller-test", runner=runner)
        self.assertEqual(
            [(item["name"], item["role"]) for item in containers],
            [
                ("controller-test", "controller"),
                (score, "score"),
            ],
        )
        self.assertEqual(seen, ["controller-test", score])

    def test_completed_score_container_still_prevents_terminal_while_live(self) -> None:
        run = self.make_run()
        score = watch_run.score_container_name(run)
        score_dir = run / "current-score"
        score_dir.mkdir()
        runner_common.write_json(
            score_dir / "result.json",
            {"state": "scored", "reward": 0.0},
        )
        runner_common.write_json(
            run / "control-status.json",
            {"state": "finished", "writers_stopped": True},
        )
        seen = []

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return "\n".join(
                    [
                        self.docker_row("controller-test", "", False),
                        self.docker_row(score, "", True),
                    ]
                )
            seen.append(args[-1])
            return self.state(args[-1] == score)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )
        self.assertFalse(result["terminal"])
        self.assertFalse(result["actual_stop_observed"])
        self.assertEqual(seen, ["controller-test", score])
        self.assertFalse((run / "terminal-receipt.json").exists())

    def test_terminal_receipt_allows_previous_stop_verification(self) -> None:
        run = self.make_run()
        runner_common.write_json(
            run / "control-status.json",
            {"state": "finished", "writers_stopped": True},
        )
        trial = run / "jobs" / "controller-task-1" / "trial-one"
        trial.mkdir(parents=True)
        runner_common.write_json(
            trial / "result.json",
            {
                "verifier_result": {"rewards": {"reward": 0.0}},
                "exception_info": None,
                "agent_result": {},
            },
        )

        def observe_runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return self.docker_row("controller-test", "", False)
            return self.state(False)

        watch_run.observe_once(
            run,
            "controller-test",
            runner=observe_runner,
        )
        receipt = runner_common.read_json(run / "terminal-receipt.json")
        self.assertTrue(receipt["writers_stopped_observed"])
        self.assertEqual(receipt["official_rewards"], [0.0])
        facts = receipt["business_terminal"]
        self.assertEqual(facts["business_status"], "finished")
        self.assertTrue(facts["business_finished"])
        self.assertFalse(facts["business_failed"])
        self.assertTrue(facts["trial_result_exists"])
        self.assertEqual(facts["official_verifier_result_count"], 1)
        self.assertTrue(facts["formal_result_exists"])
        self.assertEqual(facts["valid_reward_count"], 1)
        self.assertEqual(facts["scoring"], "official_result_available")
        self.assertIn("finished", receipt["reward_note"])

        verified = launch_run.verify_previous(
            run,
            query=lambda docker, name: json.loads(self.state(False)),
        )
        self.assertEqual(verified["containers"][0]["name"], "controller-test")

    def test_previous_scope_missing_verifier_is_rejected(self) -> None:
        previous = self.make_run()
        incomplete_scope = {
            "scope_complete": False,
            "discovered_container_names": ["controller-test"],
            "missing_identities": [
                {
                    "kind": "project",
                    "project": "trial-one__verifier__trial",
                    "role": "verifier",
                }
            ],
        }
        runner_common.write_json(
            previous / "terminal-receipt.json",
            {
                "writers_stopped_observed": True,
                "scope": incomplete_scope,
            },
        )
        runner_common.write_json(
            previous / "runtime-containers.json",
            {
                "containers": ["controller-test"],
                "scope": incomplete_scope,
            },
        )
        with self.assertRaisesRegex(RuntimeError, "范围不完整"):
            launch_run.verify_previous(
                previous,
                query=lambda docker, name: json.loads(self.state(False)),
            )

    def test_docker_failure_preserves_error_and_traceback(self) -> None:
        run = self.make_run()

        def broken(docker, *args, **kwargs):
            raise RuntimeError("mock docker unavailable")

        with self.assertRaisesRegex(RuntimeError, "mock docker unavailable"):
            watch_run.watch(
                run,
                "controller-test",
                runner=broken,
                interval=0,
                max_seconds=1,
            )
        error = runner_common.read_json(run / "watch-error.json")
        self.assertEqual(error["error_type"], "RuntimeError")
        self.assertIn("mock docker unavailable", error["error"])
        self.assertIn("Traceback", error["traceback"])

    def test_watch_query_nonzero_preserves_real_process_evidence(self) -> None:
        run = self.make_run()
        script = (
            "import sys; "
            "sys.stdout.write('query-stdout'); "
            "sys.stderr.write('query-stderr'); "
            "sys.exit(17)"
        )
        docker = self.root / "fake-docker.cmd"
        docker.write_bytes(
            (
                "@echo off\r\n"
                f"\"{sys.executable}\" -c "
                "\"import sys; "
                "sys.stdout.write('query-stdout'); "
                "sys.stderr.write('query-stderr'); "
                "sys.exit(17)\"\r\n"
            ).encode("ascii")
        )

        with self.assertRaisesRegex(RuntimeError, "Docker 查询失败"):
            watch_run.discover(
                run,
                "controller-test",
                docker=str(docker),
                runner=watch_run.query,
            )
        try:
            watch_run.query(
                str(docker),
                "ps",
                "-a",
                "--size=false",
                "--format",
                "{{json .}}",
            )
        except RuntimeError as error:
            evidence = error.evidence
        self.assertEqual(evidence["stage"], "watch_docker")
        self.assertEqual(evidence["argv"][-1], "{{json .}}")
        self.assertIn("--size=false", evidence["argv"])
        self.assertEqual(evidence["returncode"], 17)
        self.assertIn("query-stdout", evidence["stdout"])
        self.assertIn("query-stderr", evidence["stderr"])

        def runner(docker_path, *args, **kwargs):
            try:
                watch_run.query(docker_path, *args, **kwargs)
            except RuntimeError as error:
                raise error

        with self.assertRaisesRegex(RuntimeError, "Docker 查询失败"):
            watch_run.watch(
                run,
                "controller-test",
                docker=str(docker),
                runner=runner,
                interval=0,
                max_seconds=1,
            )
        recorded = runner_common.read_json(run / "watch-error.json")
        self.assertEqual(recorded["error_type"], "RuntimeError")
        self.assertEqual(recorded["evidence"]["stage"], "watch_docker")
        self.assertEqual(recorded["evidence"]["returncode"], 17)
        self.assertIn("query-stdout", recorded["evidence"]["stdout"])
        self.assertIn("query-stderr", recorded["evidence"]["stderr"])

    def test_watch_query_timeout_preserves_real_process_evidence(self) -> None:
        run = self.make_run()
        script = (
            "import sys,time; "
            "sys.stdout.write('timeout-stdout'); sys.stdout.flush(); "
            "sys.stderr.write('timeout-stderr'); sys.stderr.flush(); "
            "time.sleep(3)"
        )

        def timeout_runner(*_args, **_kwargs):
            return watch_run.query(sys.executable, "-c", script, timeout=1.0)

        with self.assertRaises(subprocess.TimeoutExpired):
            watch_run.watch(
                run,
                "controller-test",
                runner=timeout_runner,
                interval=0,
                max_seconds=1,
            )
        recorded = runner_common.read_json(run / "watch-error.json")
        self.assertEqual(recorded["error_type"], "TimeoutExpired")
        self.assertEqual(recorded["evidence"]["stage"], "watch_docker")
        self.assertEqual(
            recorded["evidence"]["argv"],
            [sys.executable, "-c", script],
        )
        self.assertIsNone(recorded["evidence"]["returncode"])
        self.assertIn("timeout-stdout", recorded["evidence"]["stdout"])
        self.assertIn("timeout-stderr", recorded["evidence"]["stderr"])

    def test_watch_query_binary_timeout_keeps_original_error_and_json_evidence(
        self,
    ) -> None:
        run = self.make_run()
        command = ["fixture-docker", "ps", "-a", "--size=false", "--format", "{{json .}}"]
        original = subprocess.TimeoutExpired(
            command,
            1.0,
            output=b"timeout-\xff-stdout",
            stderr=b"timeout-\xfe-stderr",
        )

        def timeout_runner(docker, *args, **kwargs):
            return watch_run.query(docker, *args, **kwargs)

        with mock.patch.object(watch_run.subprocess, "run", side_effect=original):
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                watch_run.watch(
                    run,
                    "controller-test",
                    runner=timeout_runner,
                    interval=0,
                    max_seconds=1,
                )

        self.assertIs(raised.exception, original)
        self.assertEqual(original.output, b"timeout-\xff-stdout")
        self.assertEqual(original.stderr, b"timeout-\xfe-stderr")
        recorded = runner_common.read_json(run / "watch-error.json")
        self.assertEqual(recorded["error_type"], "TimeoutExpired")
        self.assertEqual(
            recorded["evidence"]["stdout"],
            {
                "encoding": "base64",
                "data": "dGltZW91dC3/LXN0ZG91dA==",
            },
        )
        self.assertEqual(
            recorded["evidence"]["stderr"],
            {
                "encoding": "base64",
                "data": "dGltZW91dC3+LXN0ZGVycg==",
            },
        )

    def test_watch_query_oserror_keeps_original_error_and_json_evidence(
        self,
    ) -> None:
        run = self.make_run()
        original = OSError("docker executable unavailable")

        def failed_runner(docker, *args, **kwargs):
            return watch_run.query(docker, *args, **kwargs)

        with mock.patch.object(watch_run.subprocess, "run", side_effect=original):
            with self.assertRaises(OSError) as raised:
                watch_run.watch(
                    run,
                    "controller-test",
                    runner=failed_runner,
                    interval=0,
                    max_seconds=1,
                )

        self.assertIs(raised.exception, original)
        recorded = runner_common.read_json(run / "watch-error.json")
        self.assertEqual(recorded["error_type"], "OSError")
        self.assertEqual(recorded["evidence"]["stage"], "watch_docker")
        self.assertEqual(
            recorded["evidence"]["argv"],
            [watch_run.DOCKER_EXE, "ps", "-a", "--size=false", "--format", "{{json .}}"],
        )
        self.assertIsNone(recorded["evidence"]["returncode"])
        self.assertEqual(recorded["evidence"]["stdout"], "")
        self.assertEqual(recorded["evidence"]["stderr"], "")

    def test_zero_and_missing_rewards_remain_distinct(self) -> None:
        run = self.make_run()
        job = run / "jobs" / "controller-task-1"
        trial = job / "trial-one"
        trial.mkdir(parents=True)
        runner_common.write_json(
            trial / "result.json",
            {
                "verifier_result": {"rewards": {"reward": 0.0}},
                "exception_info": None,
                "agent_result": {"model_usage": {}},
            },
        )
        runner_common.write_json(
            trial.with_name("trial-two") / "result.json",
            {
                "verifier_result": None,
                "exception_info": {
                    "exception_type": "RuntimeError",
                    "exception_message": "missing reward",
                },
                "agent_result": {"model_usage": None},
            },
        )
        self.assertEqual(
            [
                (
                    row["status"],
                    row["reward"],
                    row["official_verifier_result_exists"],
                )
                for row in watch_run.reward_rows(run)
            ],
            [("valid", 0.0, True), ("missing", None, False)],
        )
        rows = watch_run.reward_rows(run)
        self.assertEqual(
            rows[1]["exception"]["exception_type"],
            "RuntimeError",
        )

    def test_bad_rewards_do_not_become_official_values(self) -> None:
        run = self.make_run()
        job = run / "jobs" / "controller-task-1"
        for index, reward in enumerate(
            [True, "0", float("nan"), float("inf")]
        ):
            path = job / f"trial-{index}" / "result.json"
            path.parent.mkdir(parents=True)
            path.write_text(
                json.dumps(
                    {
                        "verifier_result": {"rewards": {"reward": reward}},
                        "exception_info": None,
                        "agent_result": {},
                    }
                ),
                encoding="utf-8",
            )
        rows = watch_run.reward_rows(run)
        self.assertEqual(
            [row["status"] for row in rows],
            ["malformed"] * 4,
        )
        self.assertEqual([row["reward"] for row in rows], [None] * 4)
        self.assertEqual(
            [row["official_verifier_result_exists"] for row in rows],
            [True, True, False, False],
        )

        runner_common.write_json(
            run / "control-status.json",
            {"state": "finished", "writers_stopped": True},
        )

        def runner(docker, *args, **kwargs):
            if args[0] == "ps":
                return self.docker_row("controller-test", "", False)
            return self.state(False)

        result = watch_run.observe_once(
            run,
            "controller-test",
            runner=runner,
        )
        self.assertTrue(result["terminal"])
        receipt = runner_common.read_json(run / "terminal-receipt.json")
        self.assertEqual(receipt["official_rewards"], [])
        facts = receipt["business_terminal"]
        self.assertTrue(facts["business_finished"])
        self.assertFalse(facts["business_failed"])
        self.assertEqual(facts["trial_result_count"], 4)
        self.assertEqual(facts["official_verifier_result_count"], 2)
        self.assertTrue(facts["formal_result_exists"])
        self.assertEqual(
            receipt["official_reward_status"],
            "official_result_malformed",
        )
        self.assertEqual(
            [row["status"] for row in receipt["reward_rows"]],
            ["malformed"] * 4,
        )
        self.assertEqual(
            len(receipt["reward_errors"]),
            4,
        )
        self.assertIn("畸形", receipt["reward_note"])
        self.assertIn("官方 verifier", receipt["reward_note"])

    def test_bad_result_root_is_malformed_without_dropping_other_results(self) -> None:
        run = self.make_run()
        job = run / "jobs" / "controller-task-1"
        json_path = job / "trial-array" / "result.json"
        json_path.parent.mkdir(parents=True)
        json_path.write_text("[]\n", encoding="utf-8")
        for index, raw in enumerate(("true", "null")):
            path = job / f"trial-root-{index}" / "result.json"
            path.parent.mkdir(parents=True)
            path.write_text(raw + "\n", encoding="utf-8")
        runner_common.write_json(
            job / "trial-valid" / "result.json",
            {
                "verifier_result": {"rewards": {"reward": 0.0}},
                "exception_info": None,
                "agent_result": {},
            },
        )

        rows = watch_run.reward_rows(run)
        self.assertEqual(len(rows), 4)
        self.assertCountEqual(
            [(row["status"], row["reward"]) for row in rows],
            [
                ("malformed", None),
                ("malformed", None),
                ("malformed", None),
                ("valid", 0.0),
            ],
        )

    def test_prepare_rejects_stale_model_metadata_without_live_run(self) -> None:
        sources_path, run, sources = self.make_prepare_sources()
        metadata_path = Path(sources["model_metadata_path"])
        metadata = runner_common.read_json(metadata_path)
        metadata["models"]["other/deepseek/DeepSeek-Test"] = metadata["models"].pop(
            "trusted/minimax/MiniMax-Test"
        )
        runner_common.write_json(metadata_path, metadata)
        sources["model_metadata_sha256"] = runner_common.digest(metadata_path)
        runner_common.write_json(sources_path, sources)

        with self.assertRaisesRegex(ValueError, "没有完整选定模型"):
            prepare_run.prepare(sources_path)

        self.assertFalse(run.exists())

    def test_prepare_rejects_bad_extra_compose_hash_without_publishing_run(self) -> None:
        sources_path, run, sources = self.make_prepare_sources()
        sources["extra_docker_compose_sha256"] = "0" * 64
        runner_common.write_json(sources_path, sources)

        with self.assertRaisesRegex(ValueError, "网络覆写来源摘要不符"):
            prepare_run.prepare(sources_path)

        self.assertFalse(run.exists())

    def test_prepare_rejects_old_external_provider_as_runtime_alias(self) -> None:
        sources_path, run, sources = self.make_prepare_sources()
        config = runner_common.read_json(Path(sources["config_source"]))
        config["agents"][0]["source_metadata"] = {
            "model_name": "openai/minimax-code/MiniMax-M3.1-Flash",
            "provider": "openai",
            "model": "minimax-code/MiniMax-M3.1-Flash",
            "thinking": "high",
        }
        runner_common.write_json(Path(sources["config_source"]), config)
        sources["config_source_sha256"] = runner_common.digest(
            Path(sources["config_source"])
        )
        runner_common.write_json(sources_path, sources)

        with self.assertRaisesRegex(ValueError, "绑定"):
            prepare_run.prepare(sources_path)

        self.assertFalse(run.exists())

    def test_prepare_rejects_out_of_parent_run_directory(self) -> None:
        sources_path, run, sources = self.make_prepare_sources()
        other_parent = self.root / "other"
        other_parent.mkdir()
        sources["run_dir"] = str(other_parent / "run")
        runner_common.write_json(sources_path, sources)

        with self.assertRaisesRegex(ValueError, "直接位于"):
            prepare_run.prepare(sources_path)

        self.assertFalse((other_parent / "run").exists())


if __name__ == "__main__":
    unittest.main()
