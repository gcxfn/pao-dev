"""最小离线测试；只验证配置解析、入口与边界，不启动容器或模型。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from map_bench_pao.pao_agent import PAOAgent, PAOOptions


class PAOOptionsTest(unittest.TestCase):
    def base_kwargs(self) -> dict:
        return {
            "source_archive": "source.tar.gz",
            "source_sha256": "0" * 64,
            "thinking": "off",
            "tools": "read,bash,edit,write",
        }

    def test_single_rejects_no_extensions_shortcut(self) -> None:
        with self.assertRaises(ValueError):
            PAOOptions(profile="single", no_extensions=True, **self.base_kwargs())

    def test_single_preserves_normal_resources(self) -> None:
        options = PAOOptions(profile="single", **self.base_kwargs())
        self.assertFalse(options.no_extensions)

    def test_pending_is_preparation_only(self) -> None:
        kwargs = self.base_kwargs()
        kwargs["source_sha256"] = "pending"
        self.assertEqual(PAOOptions(profile="single", **kwargs).source_sha256, "pending")

    def test_pao_profile_rejects_no_extensions(self) -> None:
        with self.assertRaises(ValueError):
            PAOOptions(profile="post-pao", no_extensions=True, **self.base_kwargs())

    def test_allowlist_is_required(self) -> None:
        kwargs = self.base_kwargs()
        kwargs.pop("tools")
        with self.assertRaises(ValueError):
            PAOOptions(profile="post-pao", **kwargs)

    def test_framework_fields_do_not_become_cli_flags(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            agent = PAOAgent(
                logs_dir=Path(temp),
                model_name="dummy/model",
                skip_model_parsing=True,
                version="local",
                source_archive="source.tar.gz",
                source_sha256="0" * 64,
                thinking="off",
                tools="read,bash,edit,write",
                profile="post-pao",
            )
            flags = agent.build_cli_flags()
            self.assertIn("--thinking off", flags)
            self.assertNotIn("--tools", flags)  # 不误关 PAO 扩展工具。
            self.assertNotIn("profile", flags)
            self.assertNotIn("source_archive", flags)
            self.assertNotIn("--no-extensions", flags)

    def test_single_builds_explicit_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            agent = PAOAgent(
                logs_dir=Path(temp),
                model_name="dummy/model",
                skip_model_parsing=True,
                version="local",
                source_archive="source.tar.gz",
                source_sha256="0" * 64,
                thinking="off",
                tools="read,bash,edit,write",
                profile="single",
                no_extensions=False,
            )
            flags = agent.build_cli_flags()
            self.assertNotIn("--no-extensions", flags)
            self.assertNotIn("--exclude-tools", flags)
            self.assertIn("--tools read,bash,edit,write", flags)


if __name__ == "__main__":
    unittest.main()
