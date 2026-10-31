"""解释器检查的错误传播；真实 Linux 链接另由主控容器预检验证。"""
import os
from pathlib import Path
import subprocess
import unittest
from unittest import mock

from bench import launch


class InterpreterIdentityTest(unittest.TestCase):
    def test_linux_resolution_failure_is_not_recorded_as_success(self):
        failure = subprocess.CompletedProcess([], 1, "", "outside runtime root")
        with mock.patch.object(launch, "docker_query", return_value=failure):
            with self.assertRaisesRegex(RuntimeError, "outside runtime root"):
                launch._linux_interpreter_identity(launch.LINUX_PYTHON, Path.cwd(), "fixture-docker")

    def test_unexpected_filesystem_failure_is_not_hidden(self):
        with mock.patch.object(Path, "is_file", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(PermissionError, "denied"):
                launch.interpreter_identity(launch.LINUX_PYTHON, Path.cwd())

    @unittest.skipUnless(os.name == "nt", "Windows WSL 链接错误")
    def test_windows_unreadable_linux_link_uses_readonly_linux_inspection(self):
        failure = OSError(22, "WSL reparse point", None, 1920)
        observed = {"container_path": launch.LINUX_PYTHON, "inspection": "linux_container_readonly"}
        with (
            mock.patch.object(Path, "is_file", side_effect=failure),
            mock.patch.object(launch, "_linux_interpreter_identity", return_value=observed) as inspect,
        ):
            self.assertEqual(launch.interpreter_identity(launch.LINUX_PYTHON, Path.cwd(), docker="fixture"), observed)
        self.assertEqual(inspect.call_args.args[2], "fixture")
