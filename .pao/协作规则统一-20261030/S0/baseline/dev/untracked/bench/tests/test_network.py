"""只模拟 Docker 网络和宿主路由；不查询或修改真实网络、容器或模型。"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from bench import cli
from bench import network


class NetworkSelectionTest(unittest.TestCase):
    def setUp(self):
        configured = os.environ.get("BENCH_TEST_TEMP_ROOT")
        parent = (
            Path(configured)
            if configured
            else Path(__file__).resolve().parents[3]
            / "临时文件夹"
            / "I4-1收口-20261030"
            / "I4-3a-network-20261030"
            / "cases"
        )
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="network-",
            dir=parent,
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    @staticmethod
    def docker_state(*networks):
        return {
            "ok": True,
            "networks": list(networks),
            "source": "fixture-docker",
        }

    @staticmethod
    def route_state(*networks):
        return {
            "ok": True,
            "networks": list(networks),
            "source": "fixture-route",
        }

    def observe(self, docker_state, route_state):
        with (
            mock.patch.object(
                network,
                "docker_network_inputs",
                return_value=docker_state,
            ),
            mock.patch.object(
                network,
                "host_route_inputs",
                return_value=route_state,
            ),
        ):
            return network.observe_live_networks("fixture-docker")

    def test_reads_all_docker_ipam_subnets_before_selecting(self):
        docker_state = self.docker_state(
            {
                "Name": "first",
                "IPAM": {
                    "Config": [
                        {"Subnet": "10.243.0.0/25"},
                        {"Subnet": "10.243.0.128/25"},
                    ]
                },
            },
            {
                "Name": "second",
                "IPAM": {"Config": [{"Subnet": "10.243.1.0/24"}]},
            },
            {
                "Name": "third",
                "IPAM": {"Config": [{"Subnet": "10.243.2.128/25"}]},
            },
        )

        result = self.observe(docker_state, self.route_state())

        self.assertTrue(result["ok"])
        self.assertEqual(result["candidate_subnet"], "10.243.3.0/24")
        self.assertIsNone(result["error"])
        self.assertFalse(result["writes_performed"])

    def test_host_route_conflict_skips_overlap_but_default_route_does_not(self):
        route_text = """
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.1.1     192.168.1.20      25
        10.243.0.0    255.255.255.0           On-link      10.243.0.1     281
        10.243.1.0    255.255.255.128      10.243.0.1      10.243.0.1     281
""".strip()
        routes = network.parse_windows_route_table(route_text)
        self.assertEqual(
            [str(item) for item in routes],
            ["10.243.0.0/24", "10.243.1.0/25"],
        )

        result = self.observe(
            self.docker_state(),
            self.route_state(*(str(item) for item in routes)),
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["candidate_subnet"], "10.243.2.0/24")

    def test_no_conflict_returns_first_pool_subnet(self):
        result = self.observe(self.docker_state(), self.route_state())
        self.assertTrue(result["ok"])
        self.assertEqual(result["candidate_subnet"], "10.243.0.0/24")

    def test_pool_exhaustion_reports_clear_reason(self):
        docker_state = self.docker_state(
            {
                "Name": "whole-pool",
                "IPAM": {"Config": [{"Subnet": "10.243.0.0/16"}]},
            }
        )
        result = self.observe(docker_state, self.route_state())
        self.assertFalse(result["ok"])
        self.assertIsNone(result["candidate_subnet"])
        self.assertIn("没有可用 /24", result["error"])

    def test_any_source_failure_never_returns_candidate(self):
        cases = [
            (
                "docker",
                {
                    "ok": False,
                    "networks": [],
                    "error": "模拟 Docker 读取失败",
                },
                self.route_state(),
                "Docker 网络读取失败",
            ),
            (
                "route",
                self.docker_state(),
                {
                    "ok": False,
                    "networks": [],
                    "error": "模拟宿主路由读取失败",
                },
                "宿主路由读取失败",
            ),
        ]
        for name, docker_state, route_state, reason in cases:
            with self.subTest(source=name):
                result = self.observe(docker_state, route_state)
                self.assertFalse(result["ok"])
                self.assertIsNone(result["candidate_subnet"])
                self.assertIn(reason, result["error"])
                self.assertFalse(result["writes_performed"])

    def test_windows_default_route_is_ignored_and_specific_route_kept(self):
        routes = network.parse_windows_route_table(
            "0.0.0.0 0.0.0.0 192.168.1.1 192.168.1.20 25\n"
            "0.0.0.0/0 via 192.168.1.1 on-link 192.168.1.20 25\n"
            "10.243.7.0 255.255.255.0 0.0.0.0 10.243.7.1 281\n"
        )
        self.assertEqual([str(item) for item in routes], ["10.243.7.0/24"])

    def test_posix_default_route_is_ignored_and_specific_route_kept(self):
        routes = network.parse_posix_route_table(
            "default via 192.168.1.1 dev eth0\n"
            "0.0.0.0/0 via 192.168.1.1 dev eth0\n"
            "10.243.8.0/24 dev docker0 proto kernel scope link src 10.243.8.1\n"
        )
        self.assertEqual([str(item) for item in routes], ["10.243.8.0/24"])

    def test_corrupt_docker_inspect_json_reports_reason(self):
        responses = [
            subprocess.CompletedProcess(
                ["docker", "network", "ls", "-q"],
                0,
                stdout="network-id\n",
                stderr="",
            ),
            subprocess.CompletedProcess(
                ["docker", "network", "inspect", "network-id"],
                0,
                stdout="{broken json",
                stderr="",
            ),
        ]
        with mock.patch.object(
            network.subprocess,
            "run",
            side_effect=responses,
        ):
            result = network.docker_network_inputs("fixture-docker")

        self.assertFalse(result["ok"])
        self.assertIn("JSON 无效", result["error"])
        self.assertEqual(result["networks"], [])

    def test_doctor_exits_nonzero_when_network_entry_fails(self):
        state = {
            "ok": False,
            "candidate_subnet": None,
            "error": "模拟网络来源读取失败",
            "writes_performed": False,
        }
        with mock.patch.object(
            network,
            "observe_live_networks",
            return_value=state,
        ):
            result, exit_code = cli.doctor(docker="fixture-docker")

        self.assertEqual(exit_code, 1)
        self.assertFalse(result["ok"])
        self.assertFalse(result["checks"]["network"]["ok"])
        self.assertIsNone(result["checks"]["network"]["candidate_subnet"])


if __name__ == "__main__":
    unittest.main()
