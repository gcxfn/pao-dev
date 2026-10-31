"""旧活跃入口与正式 bench 模块的兼容测试；不运行 Docker 或模型。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest


REPOSITORY = Path(__file__).resolve().parents[2]
LEGACY = REPOSITORY / ".pao" / "地图简报与部门协作-20261020" / "benchmark"


class EntryCompatibilityTest(unittest.TestCase):
    def test_legacy_modules_are_the_formal_module_objects(self) -> None:
        probe = textwrap.dedent(
            """
            import json
            from pathlib import Path
            import sys
            from unittest import mock

            legacy = Path(sys.argv[1]).resolve()
            repository = Path(sys.argv[2]).resolve()
            sys.path.insert(0, str(repository))
            sys.path.insert(0, str(legacy))

            import bench_controller
            import launch_run
            import map_bench_pao_organized
            import preparation_agent
            import prepare_run
            import runner_common
            import watch_run

            from bench import controller
            from bench import launch
            from bench import map_bench_pao_organized as formal_map
            from bench import preparation_agent as formal_preparation
            from bench import prepare
            from bench import runner_common as formal_common
            from bench import watch

            pairs = {
                "bench_controller": bench_controller is controller,
                "launch_run": launch_run is launch,
                "prepare_run": prepare_run is prepare,
                "watch_run": watch_run is watch,
                "runner_common": runner_common is formal_common,
                "map_bench_pao_organized": (
                    map_bench_pao_organized is formal_map
                ),
                "preparation_agent": preparation_agent is formal_preparation,
            }
            assert all(pairs.values()), pairs

            sentinel = object()
            with mock.patch("bench_controller.observe_runtime", sentinel):
                assert controller.observe_runtime is sentinel

            old_tests = {}
            test_pairs = {
                "test_bench_controller": "test_controller",
                "test_governance_runner": "test_runner",
                "test_prepare_sources": "test_prepare",
                "test_usage": "test_usage",
                "test_final_assembly": "test_final_assembly",
                "test_pao_agent": "test_agent",
            }
            for old_name, formal_name in test_pairs.items():
                old_module = __import__(old_name)
                formal = __import__(
                    "bench.tests." + formal_name,
                    fromlist=[formal_name],
                )
                old_tests[old_name] = old_module is formal
            assert all(old_tests.values()), old_tests

            print(json.dumps({
                "modules": pairs,
                "observer_patch_reaches_controller": True,
                "tests": old_tests,
            }, ensure_ascii=False))
            """
        )
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                probe,
                str(LEGACY),
                str(REPOSITORY),
            ],
            check=False,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
            cwd=LEGACY,
            env={
                **os.environ,
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
                "PYTHONPATH": "",
            },
            shell=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            (completed.stdout or "") + "\n" + (completed.stderr or ""),
        )
        result = json.loads(completed.stdout)
        self.assertTrue(all(result["modules"].values()))
        self.assertTrue(result["observer_patch_reaches_controller"])
        self.assertTrue(all(result["tests"].values()))


if __name__ == "__main__":
    unittest.main()
