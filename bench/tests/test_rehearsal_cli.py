"""彩排命令接线测试：Node 调用使用 mock，不是完整产品彩排。"""
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from bench import cli


class RehearsalCliTest(unittest.TestCase):
    def setUp(self):
        parent = Path(os.environ["PAO_HOME"])
        if not parent.is_absolute():
            raise ValueError("测试须显式设置隔离 PAO_HOME")
        parent.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="rehearsal-cli-", dir=parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.node = self.root / "fixture-node"
        self.node.write_text("模拟可执行文件；不会实际执行", encoding="utf-8")

    def test_rehearsal_uses_node_entry_without_real_run_inputs(self):
        with (
            mock.patch.object(cli.shutil, "which", return_value=str(self.node)),
            mock.patch.object(cli.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run,
            mock.patch.object(cli.prepare_module, "prepare") as prepare,
            mock.patch.object(cli.launch, "launch") as launch,
            mock.patch.object(cli.network, "observe_live_networks") as network,
        ):
            self.assertEqual(cli.main(["run", "--rehearsal"]), 0)
        command = run.call_args.args[0]
        self.assertEqual(command[0], str(self.node))
        self.assertEqual(Path(command[1]).name, "run-rehearsal.mjs")
        self.assertTrue(Path(command[1]).is_file())
        prepare.assert_not_called()
        launch.assert_not_called()
        network.assert_not_called()

    def test_rehearsal_preserves_failure_exit_and_explicit_paths(self):
        output = self.root / "运行证据"
        with mock.patch.object(cli.subprocess, "run", return_value=subprocess.CompletedProcess([], 7)) as run:
            result = cli.main(["run", "--rehearsal", "--node", str(self.node), "--output", str(output)])
        self.assertEqual(result, 7)
        self.assertEqual(run.call_args.args[0][-2:], ["--output", str(output.resolve())])

    def test_rehearsal_rejects_frozen_real_run_before_starting_process(self):
        with (
            mock.patch.object(cli.subprocess, "run") as run,
            mock.patch("sys.stderr", new=io.StringIO()),
            mock.patch("sys.stdout", new=io.StringIO()),
        ):
            result = cli.main(["run", "--rehearsal", "--run", str(self.root)])
        self.assertEqual(result, 1)
        run.assert_not_called()

    def test_missing_node_does_not_start_a_process(self):
        with (
            mock.patch.object(cli.shutil, "which", return_value=None),
            mock.patch.object(cli.subprocess, "run") as run,
            mock.patch("sys.stderr", new=io.StringIO()),
            mock.patch("sys.stdout", new=io.StringIO()),
        ):
            result = cli.main(["run", "--rehearsal"])
        self.assertEqual(result, 1)
        run.assert_not_called()

    def test_cleanup_failure_or_retained_resources_does_not_exit_success(self):
        for payload in ({"ok": False, "completed": False}, {"ok": True, "completed": False}):
            with (
                self.subTest(payload=payload),
                mock.patch.object(cli.clean_module, "clean", return_value=payload),
                mock.patch("sys.stdout", new=io.StringIO()),
            ):
                result = cli.main([
                    "clean", "--run", str(self.root), "--execute",
                    "--confirm-run", self.root.name, "--authorize-docker",
                ])
                self.assertEqual(result, 1)


if __name__ == "__main__":
    unittest.main()
