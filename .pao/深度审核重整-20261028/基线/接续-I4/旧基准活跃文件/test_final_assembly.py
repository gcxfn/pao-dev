"""真实 Harbor organizer 安装链与当前内核父子 RPC；不启动 Docker、不调用模型。"""

from __future__ import annotations

import hashlib
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


WORKSPACE = Path(__file__).resolve().parents[4]
REPOSITORY = Path(__file__).resolve().parents[3]
BENCHMARK = Path(__file__).resolve().parent
SDK_HOST = REPOSITORY / ".pao" / "协作机制重构-20261023" / "benchmark-sdk-host"
TEST_PARENT = WORKSPACE / "临时文件夹" / "PAO集中修复-20261025" / "w8-final-assembly"


def _windows_to_wsl(path: Path) -> str:
    absolute = path.resolve()
    drive = absolute.drive.rstrip(":")
    if not drive:
        raise ValueError("Windows 路径缺少盘符：" + str(absolute))
    relative = absolute.as_posix().split(":", 1)[1].lstrip("/")
    return f"/mnt/{drive.lower()}/{relative}"


def _wsl_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


class FinalAssemblyTest(unittest.TestCase):
    def setUp(self) -> None:
        sources_value = os.environ.get("PAO_FINAL_ASSEMBLY_SOURCES")
        if not sources_value:
            self.skipTest(
                "缺少 PAO_FINAL_ASSEMBLY_SOURCES；请显式提供 prepare 来源清单"
            )
        self.sources_path = Path(sources_value).expanduser().resolve()
        if not self.sources_path.is_file():
            self.fail("PAO_FINAL_ASSEMBLY_SOURCES 不是文件：" + str(self.sources_path))
        TEST_PARENT.mkdir(parents=True, exist_ok=True)
        self.root = Path(
            tempfile.mkdtemp(prefix="pao-final-assembly-", dir=TEST_PARENT)
        ).resolve()
        self.addCleanup(self._cleanup)
        self.harbor_python, self.wsl = self._find_harbor_python()

    def _cleanup(self) -> None:
        if os.environ.get("PAO_KEEP_TEST_FIXTURE") == "1":
            print("保留最终装配测试现场：" + str(self.root))
            return
        shutil.rmtree(self.root)

    def _find_harbor_python(self) -> tuple[str | None, Path | None]:
        explicit = os.environ.get("PAO_HARBOR_PYTHON")
        if os.name == "nt":
            wsl = shutil.which("wsl.exe") or shutil.which("wsl")
            return explicit, Path(wsl) if wsl else None
        candidate = Path(sys.executable).resolve()
        return explicit or str(candidate), None

    @staticmethod
    def _to_wsl_path(value: str | Path) -> str:
        text = str(value)
        return text if text.startswith("/") else _windows_to_wsl(Path(text))

    def _harbor_command(self, script: Path, *args: Path | str) -> list[str]:
        if self.harbor_python is None:
            self.skipTest(
                "真实 Harbor 不可用；请用 PAO_HARBOR_PYTHON 指定可导入 harbor 的解释器"
            )
        if self.wsl is None:
            return [str(self.harbor_python), str(script), *(str(arg) for arg in args)]
        quoted_arguments = " ".join(
            _wsl_quote(
                self._to_wsl_path(arg)
                if isinstance(arg, Path)
                else str(arg)
            )
            for arg in args
        )
        return [
            str(self.wsl),
            "-u",
            "root",
            "-e",
            "/bin/bash",
            "-lc",
            (
                f"cd {_wsl_quote(self._to_wsl_path(self.root))} && "
                f"{_wsl_quote(self._to_wsl_path(self.harbor_python))} "
                f"{_wsl_quote(self._to_wsl_path(script))} {quoted_arguments}"
            ),
        ]

    def _stage_wsl_local(
        self, run: Path, script: Path
    ) -> tuple[str, str, str]:
        self.assertIsNotNone(self.wsl)
        created = subprocess.run(
            [str(self.wsl), "-e", "/bin/bash", "-lc", "mktemp -d /tmp/pao-w8.XXXXXX"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        self.assertEqual(created.returncode, 0, created.stderr)
        local_root = created.stdout.strip()
        self.assertRegex(local_root, r"^/tmp/pao-w8\.[A-Za-z0-9]{6}$")
        stage_script = self.root / "stage_wsl_local.sh"
        stage_script.write_bytes(
            r'''#!/bin/bash
set -euo pipefail
local_root=$1
original_run=$2
original_script=$3
mkdir -p "$local_root/run" "$local_root/harbor-evidence"
cp -a -- "$original_run/." "$local_root/run/"
cp -a -- "$original_script" "$local_root/run_real_harbor_setup.py"
manifest="$local_root/harbor-evidence/wsl-local-copy.tsv"
printf 'original_sha256\tcopy_sha256\toriginal_path\tcopy_path\n' > "$manifest"
while IFS= read -r -d '' relative; do
  relative=${relative#./}
  original_path="$original_run/$relative"
  copy_path="$local_root/run/$relative"
  original_sha=$(sha256sum -- "$original_path" | cut -d ' ' -f 1)
  copy_sha=$(sha256sum -- "$copy_path" | cut -d ' ' -f 1)
  if [[ "$original_sha" != "$copy_sha" ]]; then
    printf 'copy SHA mismatch: %s\n' "$relative" >&2
    exit 1
  fi
  printf '%s\t%s\t%s\t%s\n' \
    "$original_sha" "$copy_sha" "$original_path" "$copy_path" >> "$manifest"
done < <(cd "$original_run" && find . -type f -print0 | sort -z)
original_script_sha=$(sha256sum -- "$original_script" | cut -d ' ' -f 1)
copy_script="$local_root/run_real_harbor_setup.py"
copy_script_sha=$(sha256sum -- "$copy_script" | cut -d ' ' -f 1)
if [[ "$original_script_sha" != "$copy_script_sha" ]]; then
  printf 'copy SHA mismatch: run_real_harbor_setup.py\n' >&2
  exit 1
fi
printf '%s\t%s\t%s\t%s\n' \
  "$original_script_sha" "$copy_script_sha" "$original_script" "$copy_script" >> "$manifest"
'''.replace("\n", "\r\n").replace("\r\n", "\n").encode("utf-8"),
        )
        staged = subprocess.run(
            [
                str(self.wsl),
                "--",
                "/bin/bash",
                _windows_to_wsl(stage_script),
                local_root,
                _windows_to_wsl(run),
                _windows_to_wsl(script),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
        if staged.returncode != 0:
            self._remove_wsl_local(local_root)
        self.assertEqual(staged.returncode, 0, staged.stderr)
        return (
            local_root,
            local_root + "/run",
            local_root + "/run_real_harbor_setup.py",
        )

    def _remove_wsl_local(self, local_root: str) -> None:
        self.assertIsNotNone(self.wsl)
        self.assertRegex(local_root, r"^/tmp/pao-w8\.[A-Za-z0-9]{6}$")
        removed = subprocess.run(
            [str(self.wsl), "-u", "root", "-e", "/bin/bash", "-lc", "rm -rf -- " + _wsl_quote(local_root)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
        self.assertEqual(removed.returncode, 0, removed.stderr)

    def _collect_wsl_evidence(self, local_root: str, evidence: Path) -> bool:
        self.assertIsNotNone(self.wsl)
        try:
            evidence.mkdir(parents=True, exist_ok=True)
            copied = subprocess.run(
                [
                    str(self.wsl),
                    "-u",
                    "root",
                    "-e",
                    "/bin/bash",
                    "-lc",
                    "cp -a -- "
                    + _wsl_quote(local_root + "/harbor-evidence/.")
                    + " "
                    + _wsl_quote(_windows_to_wsl(evidence) + "/"),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
            )
            if copied.returncode != 0:
                raise AssertionError(copied.stderr)
        except BaseException as error:
            raise AssertionError(
                "证据复制失败，保留本轮 WSL 临时目录："
                + local_root
                + "\n"
                + str(error)
            ) from error
        self._remove_wsl_local(local_root)
        return True

    def test_evidence_copy_failure_preserves_wsl_root(self) -> None:
        calls = []

        def fail_copy(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(
                command,
                1,
                "",
                "simulated copy failure",
            )

        class FakeWsl:
            def __str__(self):
                return "wsl.exe"

        self.wsl = FakeWsl()
        remove_calls = []
        self._remove_wsl_local = remove_calls.append
        with mock.patch.object(subprocess, "run", side_effect=fail_copy):
            with self.assertRaisesRegex(
                AssertionError,
                "保留本轮 WSL 临时目录：/tmp/pao-w8.AbCd12",
            ):
                self._collect_wsl_evidence(
                    "/tmp/pao-w8.AbCd12",
                    self.root / "evidence",
                )
        self.assertEqual(len(calls), 1)
        self.assertEqual(remove_calls, [])

    def _write_sources(self) -> Path:
        sources = runner_common.read_json(self.sources_path)
        run = self.root / "run"
        sources.update(
            {
                "run_parent": str(self.root),
                "run_dir": str(run),
                "job_name": "offline-final-assembly-w8",
                "controller_name": "offline-final-assembly-w8",
            }
        )
        path = self.root / "final-assembly-sources.json"
        runner_common.write_json(path, sources)
        return path

    def _prepare(self) -> tuple[Path, dict, dict]:
        sources_path = self._write_sources()
        result = prepare_run.prepare(sources_path)
        run = Path(result["run"])
        config = runner_common.read_json(run / "run-config.json")
        self.assertEqual(config["environment"]["type"], "docker")
        self.assertEqual(result["docker_calls"], 0)
        self.assertEqual(result["model_calls"], 0)
        source_manifest = runner_common.read_json(run / "source-manifest.json")
        self.assertEqual(
            runner_common.digest(run / "source.zip"),
            result["source_sha256"],
        )
        self.assertEqual(
            config["agents"][0]["kwargs"]["source_sha256"],
            result["source_sha256"],
        )
        self.assertEqual(
            config["agents"][0]["kwargs"]["organization_manifest_sha256"],
            runner_common.digest(run / "organized-post" / "manifest.json"),
        )
        self.assertEqual(
            source_manifest["package_assembly"],
            sorted(
                source_manifest["package_assembly"],
                key=lambda record: record["target"],
            ),
        )
        return run, config, result

    def _run_real_harbor_setup(self, run: Path, config: dict) -> None:
        script = self.root / "run_real_harbor_setup.py"
        script.write_text(
            r'''
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

from harbor.agents.factory import AgentFactory
from harbor.environments.base import BaseEnvironment, EnvironmentCapabilities, ExecResult
from harbor.models.task.config import EnvironmentConfig as TaskEnvironmentConfig
from harbor.models.trial.config import AgentConfig
from harbor.models.trial.paths import TrialPaths


class LocalHarborEnvironment(BaseEnvironment):
    """测试专用执行桥；不替代真实 Harbor adapter 或安装父类。"""

    ROOTS = ("/app", "/tmp", "/logs", "/installed-agent", "/home/agent")

    def __init__(self, root: Path, evidence: Path, trial_paths):
        self.root = root.resolve()
        self.evidence = evidence.resolve()
        self.commands = []
        for relative in ("app", "tmp", "logs", "installed-agent", "home"):
            (self.root / relative).mkdir(parents=True, exist_ok=True)
            os.chown(self.root / relative, 1000, 1000)
        # 正式镜像提供 agent 账户；只在本轮挂载空间内提供相同身份，不改宿主账户。
        (self.root / "etc").mkdir()
        (self.root / "etc" / "passwd").write_text(
            "root:x:0:0:root:/root:/bin/bash\n"
            "agent:x:1000:1000:agent:/home/agent:/bin/bash\n",
            encoding="utf-8",
        )
        (self.root / "etc" / "group").write_text(
            "root:x:0:\nagent:x:1000:\n", encoding="utf-8"
        )
        super().__init__(
            environment_dir=self.root / "environment",
            environment_name="final-assembly",
            session_id="final-assembly__env",
            trial_paths=trial_paths,
            task_env_config=TaskEnvironmentConfig(),
            logger=logging.getLogger("final-assembly-environment"),
        )
        self.default_user = "agent"

    @staticmethod
    def type() -> str:
        return "local-final-assembly"

    @property
    def capabilities(self) -> EnvironmentCapabilities:
        return EnvironmentCapabilities()

    def _validate_definition(self) -> None:
        return None

    async def start(self, force_build: bool) -> None:
        return None

    async def stop(self, delete: bool) -> None:
        return None

    def _local_path(self, remote: str) -> Path:
        path = PurePosixPath(remote)
        for prefix in self.ROOTS:
            prefix_path = PurePosixPath(prefix)
            if path == prefix_path or prefix_path in path.parents:
                local_name = "home" if prefix == "/home/agent" else prefix.lstrip("/")
                return self.root.joinpath(local_name, *path.relative_to(prefix).parts)
        raise ValueError("测试环境桥没有该远端路径映射：" + remote)

    async def upload_file(self, source_path, target_path):
        source = Path(source_path)
        target = self._local_path(str(target_path))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        self._record({
            "type": "upload_file",
            "source": str(source),
            "target": str(target_path),
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "size": source.stat().st_size,
        })

    async def upload_dir(self, source_dir, target_dir):
        target = self._local_path(str(target_dir))
        target.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_dir, target, dirs_exist_ok=True)
        self._record({"type": "upload_dir", "source": str(source_dir), "target": str(target_dir)})

    async def download_file(self, source_path, target_path):
        source = self._local_path(str(source_path))
        target = Path(target_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        self._record({"type": "download_file", "source": str(source_path), "target": str(target)})

    async def download_dir(self, source_dir, target_dir):
        source = self._local_path(str(source_dir))
        target = Path(target_dir)
        target.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target, dirs_exist_ok=True)
        self._record({"type": "download_dir", "source": str(source_dir), "target": str(target)})

    def _record(self, record):
        self.commands.append(record)
        self.evidence.mkdir(parents=True, exist_ok=True)
        (self.evidence / "environment-events.json").write_text(
            json.dumps(self.commands, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        full_env = dict(os.environ)
        merged_env = self._merge_env(env) or {}
        full_env.update(merged_env)
        full_env["HOME"] = merged_env.get("HOME", "/home/agent")
        if re.search(r"(^|[;&|]\s*)(?:sudo|apt|apt-get)(?:\s|$)", command):
            raise ValueError("本地测试桥禁止可能修改宿主系统工具链的命令：" + command)
        base_sandbox = [
            "bwrap",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--die-with-parent",
            "--ro-bind",
            "/usr",
            "/usr",
            "--symlink",
            "usr/bin",
            "/bin",
            "--symlink",
            "usr/sbin",
            "/sbin",
            "--symlink",
            "usr/lib",
            "/lib",
            "--symlink",
            "usr/lib64",
            "/lib64",
            "--ro-bind",
            "/etc",
            "/etc",
            "--ro-bind",
            str(self.root / "etc" / "passwd"),
            "/etc/passwd",
            "--ro-bind",
            str(self.root / "etc" / "group"),
            "/etc/group",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--perms",
            "0755",
            "--dir",
            "/home",
        ]
        resolv_conf_target = Path("/etc/resolv.conf").resolve()
        if not any(resolv_conf_target.is_relative_to(root) for root in ("/etc", "/usr")):
            for parent in reversed(resolv_conf_target.parents):
                if parent != Path("/"):
                    base_sandbox.extend(["--perms", "0755", "--dir", str(parent)])
            base_sandbox.extend([
                "--ro-bind",
                str(resolv_conf_target),
                str(resolv_conf_target),
            ])
        for remote, relative in (
            ("/app", "app"),
            ("/tmp", "tmp"),
            ("/logs", "logs"),
            ("/installed-agent", "installed-agent"),
            ("/home/agent", "home"),
        ):
            base_sandbox.extend(["--bind", str(self.root / relative), remote])

        def command_argv(command_text):
            return [
                *base_sandbox,
                "--chdir",
                cwd or "/app",
                *(
                    [] if user in ("root", 0) else [
                        "/usr/bin/setpriv", "--reuid=1000", "--regid=1000", "--clear-groups"
                    ]
                ),
                "/bin/bash",
                "-c",
                command_text,
            ]

        executed_command = command
        simulated_system_dependency_install = False
        dpkg_match = re.search(
            r"dpkg --install /tmp/pao-system-dependencies/\*\.deb", command
        )
        if dpkg_match:
            executed_command = command[: dpkg_match.start()].rstrip(" ;")
            completed = subprocess.run(
                command_argv(executed_command),
                cwd=self.root,
                env=full_env,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=timeout_sec,
            )
            packages = sorted(
                (self.root / "tmp" / "pao-system-dependencies").glob("*.deb")
            )
            if completed.returncode == 0 and not packages:
                completed = subprocess.CompletedProcess(
                    completed.args,
                    1,
                    completed.stdout,
                    completed.stderr + "\n未找到已解包的 .deb，不能模拟系统依赖边界\n",
                )
            elif completed.returncode == 0:
                simulated_system_dependency_install = True
                completed = subprocess.CompletedProcess(
                    completed.args,
                    0,
                    completed.stdout
                    + (
                        "[本地测试桥] 已核对并解包 "
                        + str(len(packages))
                        + " 个 .deb；未执行 dpkg，宿主机系统改动为 0\n"
                    ),
                    completed.stderr,
                )
        else:
            completed = subprocess.run(
                command_argv(command),
                cwd=self.root,
                env=full_env,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=timeout_sec,
            )
        probe_tokens = (
            shlex.split(command)
            if any(name in command for name in ("probe-tools.mjs", "probe-child-rpc.mjs"))
            else []
        )
        record = {
            "type": "exec",
            "command": command,
            "executed_command": executed_command,
            "node_scripts": [
                PurePosixPath(argument).name
                for executable, argument in zip(probe_tokens, probe_tokens[1:])
                if PurePosixPath(executable).name == "node"
            ],
            "cwd": cwd or "/app",
            "env_keys": sorted(merged_env),
            "user": user,
            "sandbox": "bubblewrap:test-only",
            "simulated_system_dependency_install": simulated_system_dependency_install,
            "return_code": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
        }
        self._record(record)
        return ExecResult(
            stdout=completed.stdout,
            stderr=completed.stderr,
            return_code=completed.returncode,
        )


def main(run_arg, root_arg, evidence_arg):
    print("stage=harbor-main-start", flush=True)
    if os.geteuid() != 0:
        raise RuntimeError("真实安装测试桥需要root启动以执行隔离目录内的真实chown和agent用户切换")
    for credential in (
        "PAO_BENCH_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ):
        os.environ.pop(credential, None)
    os.environ["PAO_BENCH_API_KEY"] = "offline-test-placeholder"
    run = Path(run_arg).resolve()
    root = Path(root_arg).resolve()
    evidence = Path(evidence_arg).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(run))
    print("stage=read-run-config", flush=True)
    config = json.loads((run / "run-config.json").read_text(encoding="utf-8"))
    agent_data = config["agents"][0]
    kwargs = dict(agent_data["kwargs"])
    for key in ("source_archive", "model_data_archive", "node_archive",
                "system_dependencies_archive", "model_metadata_path"):
        value = kwargs.get(key)
        if value is not None:
            local = run / Path(value).name
            if not local.is_file():
                raise FileNotFoundError(local)
            kwargs[key] = str(local)
    kwargs["configuration_root"] = str(run)
    agent_config_data = {
        key: value
        for key, value in agent_data.items()
        if key in AgentConfig.model_fields
    }
    agent_config_data["kwargs"] = kwargs
    agent_config = AgentConfig(**agent_config_data)
    print("stage=preflight", flush=True)
    AgentFactory.run_preflight(agent_config, skip_credential_checks=True)
    print("stage=create-agent", flush=True)
    logs_dir = evidence / "agent"
    agent = AgentFactory.create_agent_from_config(agent_config, logs_dir=logs_dir)
    print("stage=create-environment", flush=True)
    trial_paths = TrialPaths(root / "trial")
    trial_paths.mkdir()
    environment_root = Path(
        tempfile.mkdtemp(prefix="pao-final-assembly-env-", dir="/tmp")
    ).resolve()
    environment = LocalHarborEnvironment(
        environment_root,
        evidence / "environment-events",
        trial_paths,
    )

    def read_json_object(path):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise AssertionError("无法读取真实探针结果：" + str(path)) from error
        if not isinstance(value, dict):
            raise AssertionError("真实探针结果不是 JSON 对象：" + str(path))
        return value

    result = None
    primary_error = None
    try:
        print("stage=agent-setup", flush=True)
        async def run_setup():
            with environment.scoped_exec_env(agent.extra_env):
                await agent.setup(environment)

        asyncio.run(run_setup())
        print("stage=validate-setup-results", flush=True)
        events = list(environment.commands)
        probe_execs = [
            event
            for event in events
            if event["type"] == "exec"
            and "probe-tools.mjs" in event.get("node_scripts", [])
            and event["return_code"] == 0
        ]
        probe_roles = sorted(
            role
            for role in ("main", "minister", "worker")
            if any(event["command"].endswith(" " + role) for event in probe_execs)
        )
        rpc_execs = [
            event
            for event in events
            if event["type"] == "exec"
            and "probe-child-rpc.mjs" in event.get("node_scripts", [])
            and event["return_code"] == 0
        ]
        organization_logs = environment_root / "logs" / "agent" / "organization"
        child_rpc_file = (
            organization_logs / "child-rpc" / "child-rpc-probe.json"
        )
        probe_files = [
            organization_logs
            / "probes"
            / role
            / ("probe-" + role + ".json")
            for role in ("main", "minister", "worker")
        ]
        if probe_roles != ["main", "minister", "worker"] or len(probe_execs) != 3:
            raise AssertionError("agent.setup 未自然完成三个角色的探针")
        if len(rpc_execs) != 1 or not child_rpc_file.is_file():
            raise AssertionError("agent.setup 未自然完成子进程 RPC")
        if not all(path.is_file() for path in probe_files):
            raise AssertionError("agent.setup 缺少角色探针结果文件")
        organization_names = (
            "setup.mjs",
            "kit.json",
            "activate-tools.mjs",
            "probe-tools.mjs",
            "benchmark-organized-entry.mjs",
            "benchmark-worktree-host.mjs",
            "benchmark-host-factories.mjs",
            "benchmark-child-entry.mjs",
            "probe-child-rpc.mjs",
        )
        organization_uploads = {}
        for name in organization_names:
            target = "/tmp/benchmark-organization/" + name
            matching = [
                event
                for event in events
                if event["type"] == "upload_file" and event["target"] == target
            ]
            if len(matching) != 1:
                raise AssertionError(
                    "agent.setup 未恰好上传一次组织文件：" + name
                )
            # 真实适配器以 read_text 上传；Windows CRLF 在此按同一文本契约转成 LF。
            expected_sha256 = hashlib.sha256(
                (run / "organized-post" / name).read_text(encoding="utf-8").encode("utf-8")
            ).hexdigest()
            if matching[0]["sha256"] != expected_sha256:
                raise AssertionError("agent.setup 上传的组织文件摘要不符：" + name)
            organization_uploads[name] = {
                "target": target,
                "sha256": expected_sha256,
            }
        probe_results = {}
        for role, path in zip(("main", "minister", "worker"), probe_files):
            probe = read_json_object(path)
            if probe.get("ok") is not True or probe.get("role") != role:
                raise AssertionError("角色探针未成功：" + role)
            active_tools = probe.get("active")
            if not isinstance(active_tools, list) or not active_tools:
                raise AssertionError("角色探针没有活动工具证据：" + role)
            probe_results[role] = {
                "ok": True,
                "role": role,
                "active_tool_count": len(active_tools),
            }
        child_rpc = read_json_object(child_rpc_file)
        rpc_proofs = child_rpc.get("proofs")
        if child_rpc.get("model_calls") != 0 or not isinstance(rpc_proofs, list):
            raise AssertionError("子进程 RPC 结果缺少零模型调用或角色证明")
        rpc_roles = [proof.get("role") for proof in rpc_proofs]
        if sorted(rpc_roles) != ["main", "minister", "worker"]:
            raise AssertionError("子进程 RPC 未覆盖三个角色：" + repr(rpc_roles))
        for proof in rpc_proofs:
            if (
                proof.get("rpc_get_state") != "passed"
                or proof.get("parent_ipc") is not True
                or not proof.get("session_id")
            ):
                raise AssertionError("子进程 RPC 身份或父 IPC 未通过：" + repr(proof))
            if (
                proof.get("role") in ("main", "minister")
                and proof.get("worktree_host") != "installed"
            ):
                raise AssertionError("主控或部长未安装工作树服务：" + repr(proof))
        child_rpc_result = {
            "ok": True,
            "model_calls": 0,
            "roles": sorted(rpc_roles),
            "parent_ipc": True,
        }
        simulated_system_dependency_install = any(
            event.get("simulated_system_dependency_install")
            and event["return_code"] == 0
            for event in events
        )
    except BaseException as error:
        primary_error = error
    try:
        print("stage=copy-environment-logs", flush=True)
        environment_logs = evidence / "environment-root" / "logs"
        if (environment_root / "logs").is_dir():
            shutil.copytree(environment_root / "logs", environment_logs, dirs_exist_ok=True)
        shutil.rmtree(environment_root)
    except BaseException as error:
        if primary_error is None:
            raise
        raise BaseExceptionGroup(
            "真实 Harbor setup 与测试环境清理均失败",
            [primary_error, error],
        ) from None
    if primary_error is not None:
        raise primary_error
    print("stage=write-harbor-result", flush=True)
    result = {
        "agent_class": type(agent).__module__ + "." + type(agent).__name__,
        "agent_mro": [cls.__module__ + "." + cls.__name__ for cls in type(agent).__mro__],
        "environment_class": type(environment).__module__ + "." + type(environment).__name__,
        "environment_base": BaseEnvironment.__module__ + "." + BaseEnvironment.__name__,
        "setup_calls": 1,
        "probe_roles": probe_roles,
        "probe_results": probe_results,
        "child_rpc": child_rpc_result,
        "organization_uploads": organization_uploads,
        "setup_environment_scope": "scoped_exec_env(agent.extra_env)",
        "scoped_environment_paths": {
            key: agent.extra_env[key]
            for key in (
                "PAO_HOME",
                "PI_CODING_AGENT_DIR",
                "PAO_CODING_AGENT_DIR",
            )
        },
        "system_dependency_install": (
            "simulated-after-archive-check"
            if simulated_system_dependency_install
            else "unknown"
        ),
        "model_calls": 0,
        "docker_calls": 0,
    }
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "harbor-setup.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main(*sys.argv[1:])
''',
            encoding="utf-8",
        )
        evidence = self.root / "harbor-evidence"
        local_root = None
        completed = None
        primary_error = None
        try:
            if self.wsl is None:
                local_run = run
                local_script = script
                execution_root = self.root
                local_evidence = evidence
            else:
                local_root, local_run, local_script = self._stage_wsl_local(run, script)
                execution_root = local_root
                local_evidence = local_root + "/harbor-evidence"
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / "stage.log").write_text(
                "stage=wsl-local-staged\n"
                + (
                    f"local_root={local_root}\n"
                    f"local_run={local_run}\n"
                    f"local_script={local_script}\n"
                    if local_root is not None
                    else "execution=host\n"
                ),
                encoding="utf-8",
            )
            completed = subprocess.run(
                self._harbor_command(
                    local_script,
                    local_run,
                    execution_root,
                    local_evidence,
                ),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=1800,
            )
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / "harbor-setup.stdout.log").write_text(
                completed.stdout, encoding="utf-8"
            )
            (evidence / "harbor-setup.stderr.log").write_text(
                completed.stderr, encoding="utf-8"
            )
            if completed.returncode != 0:
                primary_error = AssertionError(completed.stderr)
        except BaseException as error:
            primary_error = error
        cleanup_errors = []
        if local_root is not None:
            try:
                self._collect_wsl_evidence(local_root, evidence)
            except BaseException as error:
                cleanup_errors.append(error)
        if cleanup_errors:
            errors = ([primary_error] if primary_error is not None else []) + cleanup_errors
            raise BaseExceptionGroup("Harbor setup 或测试现场清理失败", errors)
        if primary_error is not None:
            raise primary_error
        if completed is None:
            raise AssertionError("真实 Harbor setup 没有返回结果")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = runner_common.read_json(evidence / "harbor-setup.json")
        self.assertIn("harbor.agents.installed.pi.Pi", result["agent_mro"])
        self.assertEqual(
            result["environment_base"],
            "harbor.environments.base.BaseEnvironment",
        )
        self.assertEqual(result["model_calls"], 0)
        self.assertEqual(result["docker_calls"], 0)
        events = runner_common.read_json_value(
            evidence / "environment-events" / "environment-events.json"
        )
        self.assertTrue(
            any(
                event["type"] == "exec"
                and "/installed-agent" in event["command"]
                for event in events
            )
        )
        self.assertTrue(any(event["type"] == "upload_file" for event in events))
        organization_names = (
            "setup.mjs",
            "kit.json",
            "activate-tools.mjs",
            "probe-tools.mjs",
            "benchmark-organized-entry.mjs",
            "benchmark-worktree-host.mjs",
            "benchmark-host-factories.mjs",
            "benchmark-child-entry.mjs",
            "probe-child-rpc.mjs",
        )
        for name in organization_names:
            target = "/tmp/benchmark-organization/" + name
            uploads = [
                event
                for event in events
                if event["type"] == "upload_file" and event["target"] == target
            ]
            self.assertEqual(len(uploads), 1, name)
            self.assertEqual(
                uploads[0]["sha256"],
                result["organization_uploads"][name]["sha256"],
            )
            self.assertEqual(
                uploads[0]["sha256"],
                hashlib.sha256(
                    (run / "organized-post" / name).read_text(encoding="utf-8").encode("utf-8")
                ).hexdigest(),
            )
        self.assertEqual(
            set(result["organization_uploads"]),
            set(organization_names),
        )
        self.assertEqual(
            result["setup_environment_scope"],
            "scoped_exec_env(agent.extra_env)",
        )
        self.assertEqual(
            result["scoped_environment_paths"],
            {
                "PAO_HOME": "/tmp/harbor-pao-home",
                "PI_CODING_AGENT_DIR": "/tmp/harbor-pi-agent",
                "PAO_CODING_AGENT_DIR": "/tmp/harbor-pi-agent",
            },
        )
        scoped_keys = set(result["scoped_environment_paths"])
        self.assertTrue(
            all(
                scoped_keys.issubset(set(event["env_keys"]))
                for event in events
                if event["type"] == "exec" and event.get("env_keys")
            )
        )
        self.assertTrue(
            any(
                event.get("simulated_system_dependency_install")
                and event["return_code"] == 0
                for event in events
            )
        )
        organization_events = [
            event
            for event in events
            if event["type"] == "exec"
            and "probe-tools.mjs" in event.get("node_scripts", [])
            and event["return_code"] == 0
        ]
        self.assertEqual(
            sorted(
                role
                for role in ("main", "minister", "worker")
                if any(event["command"].endswith(" " + role) for event in organization_events)
            ),
            ["main", "minister", "worker"],
        )
        rpc_events = [
            event
            for event in events
            if event["type"] == "exec"
            and "probe-child-rpc.mjs" in event.get("node_scripts", [])
            and event["return_code"] == 0
        ]
        self.assertEqual(len(rpc_events), 1)
        self.assertEqual(result["probe_roles"], ["main", "minister", "worker"])
        self.assertEqual(
            set(result["probe_results"]),
            {"main", "minister", "worker"},
        )
        for role in ("main", "minister", "worker"):
            self.assertIs(result["probe_results"][role]["ok"], True)
            self.assertEqual(result["probe_results"][role]["role"], role)
            self.assertGreater(result["probe_results"][role]["active_tool_count"], 0)
        self.assertEqual(
            result["child_rpc"],
            {
                "ok": True,
                "model_calls": 0,
                "roles": ["main", "minister", "worker"],
                "parent_ipc": True,
            },
        )
        organization_logs = (
            evidence / "environment-root" / "logs" / "agent" / "organization"
        )
        self.assertTrue((organization_logs / "organization-setup.json").is_file())
        for role in ("main", "minister", "worker"):
            self.assertTrue(
                (
                    organization_logs
                    / "probes"
                    / role
                    / ("probe-" + role + ".json")
                ).is_file()
            )
        for role in ("main", "minister", "worker"):
            probe = runner_common.read_json(
                organization_logs
                / "probes"
                / role
                / ("probe-" + role + ".json")
            )
            self.assertIs(probe.get("ok"), True)
            self.assertEqual(probe.get("role"), role)
            self.assertTrue(probe.get("active"))
        child_rpc = runner_common.read_json(
            organization_logs / "child-rpc" / "child-rpc-probe.json"
        )
        self.assertEqual(child_rpc.get("model_calls"), 0)
        self.assertEqual(
            sorted(proof.get("role") for proof in child_rpc.get("proofs", [])),
            ["main", "minister", "worker"],
        )
        self.assertTrue(
            all(
                proof.get("rpc_get_state") == "passed"
                and proof.get("parent_ipc") is True
                and proof.get("session_id")
                for proof in child_rpc["proofs"]
            )
        )

    def test_final_assembly_real_harbor_setup_and_current_kernel_rpc(self) -> None:
        run, config, prepare_result = self._prepare()
        self._run_real_harbor_setup(run, config)
        runner_common.write_json(
            self.root / "evidence-summary.json",
            {
                "prepare": prepare_result,
                "harbor_setup": "real AgentFactory + real OrganizedPAOAgent.setup",
                "local_environment": "test-only BaseEnvironment bridge",
                "docker_calls": 0,
                "model_calls": 0,
            },
        )


if __name__ == "__main__":
    unittest.main()
