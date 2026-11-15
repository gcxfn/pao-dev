"""固定 PAO 源码的 Harbor Pi 薄适配器；不读取题目答案或隐藏验收。"""

from __future__ import annotations

import hashlib
import json
import shlex
from pathlib import Path
from typing import Literal, override

import yaml
from pydantic import Field, SecretStr, model_validator

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.pi import Pi, PiOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext, ModelUsage
from .usage import aggregate_session_usage, classify_session_file


class PAOOptions(PiOptions):
    """Harbor kwargs；路径与 profile 不来自模型，也不传给 PAO CLI。"""

    source_archive: str = Field(description="固定 PAO 源码归档的宿主机绝对路径。")
    source_sha256: str = Field(
        pattern=r"^(?:[0-9a-f]{64}|pending)$",
        description="源码归档 SHA-256。",
    )
    profile: Literal["single", "pre-pao", "post-pao"] = Field(
        description="公平对比组身份。",
    )
    source_overlay_archive: str | None = None
    source_overlay_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    archive_format: Literal["zip", "tar.gz"] = "tar.gz"
    model_data_archive: str | None = None
    model_data_sha256: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')
    node_archive: str = Field(description="宿主本地的 Node Linux x64 归档绝对路径。")
    node_sha256: str = Field(pattern=r"^[0-9a-f]{64}$", description="Node 归档 SHA-256。")
    no_extensions: bool = Field(
        default=False,
        description="三组均为 false；single 在 SDK 中只不注册 PAO 工厂。",
    )
    tools: str | None = Field(
        default=None,
        description="三组共同的四项初始工具；其他原生和共同扩展能力沿默认装配。",
    )
    source_build_command: str = Field(
        default="npm ci --ignore-scripts --no-audit --no-fund && npm run build",
        min_length=1,
        description="容器内的固定源码构建命令。",
    )

    @model_validator(mode="after")
    def validate_profile_boundary(self):
        if self.no_extensions:
            raise ValueError("不能使用 --no-extensions 代替 single 的 SDK 边界。")
        if bool(self.source_overlay_archive) != bool(self.source_overlay_sha256):
            raise ValueError("overlay 路径和摘要必须同时提供。")
        if bool(self.model_data_archive) != bool(self.model_data_sha256):
            raise ValueError('模型构建数据路径和摘要必须同时提供。')
        if self.profile == "pre-pao" and (self.archive_format != "zip" or not self.source_overlay_archive):
            raise ValueError("pre-pao 必须使用主验的 tracked+untracked 两份 ZIP。")
        if not self.tools:
            raise ValueError("三组都必须显式设置共同初始工具。")
        if self.tools != "read,bash,edit,write":
            raise ValueError("本次固定配置只允许四项共同初始工具；其余原生能力沿默认装配。")
        return self


class PAOAgent(Pi):
    """复用 Pi 运行与轨迹转换，只替换安装入口和轨迹同步。"""

    options_model = PAOOptions
    options: PAOOptions
    DEFAULT_SETUP_TIMEOUT_SEC = 1800.0  # 安装编译整套源码；不改变题目的执行或验收时限。

    _OUTPUT_FILENAME = "pao.txt"
    _REMOTE_SOURCE_ARCHIVE = "/tmp/harbor-pao-source.tar.gz"
    _REMOTE_SOURCE_DIR = "/tmp/harbor-pao-source"
    _REMOTE_PAO = "/tmp/harbor-pao-source/packages/coding-agent/dist/bundle/cli.js"
    _WORKER_SESSIONS_DIRECTORY = Path("pao/worker-sessions")
    _REMOTE_LAUNCHER = "/tmp/harbor-pao-launch"

    @override
    def get_version_command(self) -> str:
        return f'"$HOME/.local/pao-node/bin/node" {self._REMOTE_PAO} --version'

    @staticmethod
    @override
    def name() -> str:
        return "pao"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if self.options.source_sha256 == "pending":
            raise ValueError("最终源码尚未封板；禁止用 pending 启动安装。")
        archive = Path(self.options.source_archive).expanduser().resolve()
        if not archive.is_file():
            raise FileNotFoundError(f"PAO 源码归档不存在：{archive}")
        node_archive = Path(self.options.node_archive).expanduser().resolve()
        if not node_archive.is_file():
            raise FileNotFoundError(f"Node 归档不存在：{node_archive}")
        if hashlib.sha256(node_archive.read_bytes()).hexdigest() != self.options.node_sha256:
            raise ValueError("Node 归档摘要与本机冻结值不符")

        await self.ensure_system_dependencies(
            environment, ("bash", "coreutils", "tar", "python3")
        )
        await self.exec_as_agent(environment, command="python3 -c 'import zipfile, tarfile, lzma'")
        await environment.upload_file(archive, self._REMOTE_SOURCE_ARCHIVE)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"printf '%s  %s\\n' {shlex.quote(self.options.source_sha256)} "
                f"{shlex.quote(self._REMOTE_SOURCE_ARCHIVE)} | sha256sum -c -; "
                f"mkdir -p {shlex.quote(self._REMOTE_SOURCE_DIR)}; "
                + (f"python3 -m zipfile -e {shlex.quote(self._REMOTE_SOURCE_ARCHIVE)} {shlex.quote(self._REMOTE_SOURCE_DIR)}"
                   if self.options.archive_format == "zip" else
                   f"tar -xzf {shlex.quote(self._REMOTE_SOURCE_ARCHIVE)} -C {shlex.quote(self._REMOTE_SOURCE_DIR)} --strip-components=1")
            ),
        )
        if self.options.source_overlay_archive:
            overlay = Path(self.options.source_overlay_archive).resolve()
            if not overlay.is_file():
                raise FileNotFoundError(overlay)
            remote_overlay = "/tmp/harbor-pao-overlay.zip"
            await environment.upload_file(overlay, remote_overlay)
            await self.exec_as_agent(environment, command=(
                "set -euo pipefail; "
                f"printf '%s  %s\\n' {shlex.quote(self.options.source_overlay_sha256)} {remote_overlay} | sha256sum -c -; "
                f"python3 -m zipfile -e {remote_overlay} {self._REMOTE_SOURCE_DIR}"
            ))
        if not self.options.model_data_archive:
            raise ValueError('缺少冻结的离线模型构建数据，禁止联网重新生成源码。')
        model_data = Path(self.options.model_data_archive).resolve()
        if not model_data.is_file():
            raise FileNotFoundError(model_data)
        await environment.upload_file(model_data, '/tmp/harbor-model-data.zip')
        await self.exec_as_agent(environment, command=(
            'set -euo pipefail; '
            f"printf '%s  %s\\n' {self.options.model_data_sha256} /tmp/harbor-model-data.zip | sha256sum -c -; "
            f'python3 -m zipfile -e /tmp/harbor-model-data.zip {self._REMOTE_SOURCE_DIR}'
        ))
        await environment.upload_file(node_archive, "/tmp/pao-node.tar.xz")
        await self.exec_as_agent(environment, command=self._node_install_command(self.options.node_sha256))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"mkdir -p {shlex.quote(str(self.environment_logs_dir))}; {{ "
                'export PATH="$HOME/.local/pao-node/bin:$PATH"; '
                f"cd {shlex.quote(self._REMOTE_SOURCE_DIR)}; "
                f"{self.options.source_build_command}; "
                f"test -f {shlex.quote(self._REMOTE_PAO)}; "
                f"node {shlex.quote(self._REMOTE_PAO)} --version; "
                f"}} 2>&1 | tee {shlex.quote(str(self.environment_logs_dir / 'source-build.log'))}"
            ),
        )
        single_entry = Path(__file__).resolve().parents[1] / "scripts" / "single-entry.mjs"
        await environment.upload_file(single_entry, "/tmp/harbor-pao-single.mjs")
        if self.options.profile != 'pre-pao':
            await self.exec_as_agent(environment, command='mkdir -p /tmp/harbor-pao-probe')
            await environment.upload_file(single_entry, '/tmp/harbor-pao-probe/single-entry.mjs')
            await environment.upload_file(single_entry.with_name('probe-single.mjs'), '/tmp/harbor-pao-probe/probe-single.mjs')
            await self.exec_as_agent(environment, command=(
                '"$HOME/.local/pao-node/bin/node" /tmp/harbor-pao-probe/probe-single.mjs '
                f'{self._REMOTE_SOURCE_DIR} {self.environment_logs_dir}/single-sdk-probe'))
        target = "/tmp/harbor-pao-single.mjs" if self.options.profile == "single" else self._REMOTE_PAO
        wrapper = (
            "#!/bin/sh\n"
            f'export PAO_BENCH_SOURCE={shlex.quote(self._REMOTE_SOURCE_DIR)}\n'
            f'exec "$HOME/.local/pao-node/bin/node" {shlex.quote(target)} "$@"\n'
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"printf '%s' {shlex.quote(wrapper)} > {self._REMOTE_LAUNCHER} && "
                f"chmod 755 {self._REMOTE_LAUNCHER}"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "REPLACE_" in self.model_name:
            raise ValueError("尚未固定实际模型；禁止运行占位符。")
        if self._resume or self.mcp_servers or self.options.max_turns is not None:
            raise ValueError("本次固定单题配置不支持 resume/MCP/max_turns 扩展。")
        provider, model_id = self._parse_model_name(self.model_name)
        access = self.model_connection
        provider = access.provider or provider
        models_json = self._build_custom_models_json(access, model_id)
        if models_json is not None:
            # 本机已登记的 DeepSeek 组元数据；避免 Harbor 的通用默认窗口截短同一模型。
            custom = models_json['providers']['harbor-endpoint']
            custom['compat'] = {'sendSessionAffinityHeaders': True}
            custom['models'][0].update(contextWindow=1048576, maxTokens=384000,
                                        input=['text', 'image'], thinkingLevelMap={'high': 'high'})
            await self._write_custom_models_json(environment, models_json)
            provider = "harbor-endpoint"
        # 主控、部长、worker 的默认档位都指向同一已授权模型；不读取正式 PAO_HOME。
        await self.exec_as_agent(environment, command='mkdir -p /tmp/harbor-pao-home/pao配置 /tmp/harbor-pi-agent')
        tiers = {'provider': 'pao', '档位': [
            {'名': name, 'provider': provider, 'model': model_id, 'thinkingLevel': self.options.thinking}
            for name in ('fast', 'primary')
        ]}
        await self._upload_config_text(environment, content=json.dumps(tiers, ensure_ascii=False),
            remote_path='/tmp/harbor-pao-home/pao配置/档位.json', filename='benchmark-tiers.json')
        settings = {'defaultProvider': provider, 'defaultModel': model_id,
                    'defaultThinkingLevel': self.options.thinking,
                    'retry': {'enabled': False, 'provider': {'maxRetries': 0}}}
        await self._upload_config_text(environment, content=json.dumps(settings),
            remote_path='/tmp/harbor-pi-agent/settings.json', filename='benchmark-settings.json')
        env = dict(access.env)
        secret = access.api_key
        if secret is not None:
            env["PAO_BENCH_API_KEY"] = secret.get_secret_value() if isinstance(secret, SecretStr) else str(secret)
        env.update({"PAO_HOME": "/tmp/harbor-pao-home", "PI_CODING_AGENT_DIR": "/tmp/harbor-pi-agent",
                    "PAO_CODING_AGENT_DIR": "/tmp/harbor-pi-agent", "PI_SKIP_VERSION_CHECK": "1"})
        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)
        session_dir = self.environment_logs_dir / self._SESSIONS_DIRECTORY
        output_path = self.environment_logs_dir / self._OUTPUT_FILENAME
        command = (
            "set -euo pipefail; "
            f"mkdir -p {shlex.quote(str(session_dir))}; "
            f"{self._REMOTE_LAUNCHER} --print --mode json --session-dir {shlex.quote(str(session_dir))} "
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model_id)} "
            f"{self.build_cli_flags()} {shlex.quote(instruction)} </dev/null 2>&1 | tee {shlex.quote(str(output_path))}"
        )
        try:
            result = await self.exec_as_agent(environment, command=command, env=env)
            if result.return_code != 0:
                raise RuntimeError(f"被测 agent 失败：exit={result.return_code}")
        finally:
            await self._sync_pao_sessions(environment)

    async def _sync_pao_sessions(self, environment: BaseEnvironment) -> None:
        """把嵌套 worker 会话同步到独立目录，避免冒充父轨迹。"""
        target = self.environment_logs_dir / self._WORKER_SESSIONS_DIRECTORY
        project_sessions = "/app/.pao/worker会话"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"mkdir -p {shlex.quote(str(target))}; "
                f"if [ -d {shlex.quote(project_sessions)} ]; then "
                f"cp -a {shlex.quote(project_sessions)}/. {shlex.quote(str(target))}/; fi"
                f"; if [ -d /tmp/harbor-pi-agent/sessions ]; then "
                f"cp -a /tmp/harbor-pi-agent/sessions {shlex.quote(str(target))}/native-default-sessions; fi; "
                f"if [ -d .pao ]; then cp -a .pao {shlex.quote(str(target))}/project-state; fi"
            ),
        )

    @override
    def build_cli_flags(self) -> str:
        flags = super().build_cli_flags()
        if self.options.profile == "single":
            return f"{flags} --tools {shlex.quote(self.options.tools)}".strip()
        # SDK 默认共同基础工具加扩展工具；显式 --tools 会把 PAO 工具一并关闭。
        # 隔离配置不设置 defaultTools，四项共同基础工具沿 pi 原生默认值。
        return flags

    @staticmethod
    def _node_install_command(node_sha256: str) -> str:
        """安装命令只接受已上传归档；不含下载入口或隐式重试。"""
        return (
            "set -euo pipefail; "
            "NODE_DIR=$HOME/.local/pao-node; "
            "if [ ! -x \"$NODE_DIR/bin/node\" ]; then "
            "mkdir -p \"$HOME/.local\"; "
            f"printf '%s  %s\\n' {shlex.quote(node_sha256)} /tmp/pao-node.tar.xz | sha256sum -c -; "
            'NODE_STAGE=$(mktemp -d "$HOME/.local/pao-node-unpack.XXXXXX"); '
            'python3 -m tarfile -e /tmp/pao-node.tar.xz "$NODE_STAGE"; '
            'mv "$NODE_STAGE"/node-*-linux-x64 "$NODE_DIR"; rmdir "$NODE_STAGE"; '
            "fi; "
            'export PATH="$NODE_DIR/bin:$PATH"; '
            "\"$NODE_DIR/bin/node\" --version; \"$NODE_DIR/bin/npm\" --version"
        )

    def _usage_candidates(self) -> tuple[list[Path], list[str], list[str]]:
        """只读取有原生会话契约的目录；候选分类结果全部留证。"""
        if not self.logs_dir.is_dir():
            return [], [], [f"日志目录不存在或不可读：{self.logs_dir}"]
        main_dir = self.logs_dir / self._SESSIONS_DIRECTORY
        worker_dir = self.logs_dir / self._WORKER_SESSIONS_DIRECTORY
        project_state = worker_dir / "project-state"
        non_session_paths = {
            *(project_state / "执行映射").glob("*.jsonl"),
            project_state / "派发日志.jsonl",
        }
        candidates = sorted(path for path in {
            *main_dir.glob("*.jsonl"),
            *worker_dir.glob("*.jsonl"),
            *(project_state / "worker会话").glob("*.jsonl"),
            *(project_state / "benchmark/部长会话").glob("*/*.jsonl"),
            *(project_state / "archive").glob("**/部长会话/*/*.jsonl"),
            *(project_state / "archive").glob("**/worker会话/*.jsonl"),
            *(project_state / "benchmark/worker-evidence").glob("*.live.jsonl"),
            *(worker_dir / "native-default-sessions").glob("**/*.jsonl"),
            *non_session_paths,
        } if path.is_file())
        session_files = []
        ignored = []
        errors = []
        for path in candidates:
            if path in non_session_paths:
                ignored.append(str(path.relative_to(self.logs_dir)))
                continue
            kind, reason = classify_session_file(path)
            if kind == "session":
                session_files.append(path)
            elif kind == "non_session":
                ignored.append(str(path.relative_to(self.logs_dir)))
            else:
                errors.append(f"{path}: {reason}")
        return session_files, ignored, errors

    def _usage_evidence_counts(self) -> tuple[int | None, int | None, int, int, list[str]]:
        """按清单与执行快照中的真实身份去重，证据文件另计。"""
        if not self.logs_dir.is_dir():
            return None, None, 0, 0, [f"日志目录不存在或不可读：{self.logs_dir}"]
        project_state = self.logs_dir / self._WORKER_SESSIONS_DIRECTORY / "project-state"
        instance_paths = sorted(project_state.glob("**/工作流实例-*.md"))
        instance_ids: set[str] = set()
        instance_dirs: dict[Path, str] = {}
        errors: list[str] = []
        for path in instance_paths:
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeError) as exc:
                errors.append(f"{path}: 工作流实例清单不可读：{type(exc).__name__}: {exc}")
                continue
            if not lines or lines[0].strip() != "---":
                errors.append(f"{path}: 工作流实例清单缺少 frontmatter")
                continue
            try:
                end = lines.index("---", 1)
                frontmatter = yaml.safe_load("\n".join(lines[1:end]))
            except (ValueError, yaml.YAMLError) as exc:
                errors.append(f"{path}: 工作流实例 frontmatter 无法解析：{type(exc).__name__}: {exc}")
                continue
            instance_id = frontmatter.get("实例") if isinstance(frontmatter, dict) else None
            if not isinstance(instance_id, str) or not instance_id.strip():
                errors.append(f"{path}: 工作流实例 frontmatter 缺少实例身份")
                continue
            instance_id = instance_id.strip()
            instance_ids.add(instance_id)
            instance_dirs[path.parent.resolve()] = instance_id

        attempt_paths = sorted(project_state.glob("**/execution-contexts/card-*-attempt-*.json"))
        attempt_ids: set[tuple[str, str, int, int]] = set()
        for path in attempt_paths:
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                key = record["key"]
                cards_dir = key["cardsDir"]
                card_no = key["cardNo"]
                attempt = key["attempt"]
                if not (
                    isinstance(record, dict)
                    and isinstance(cards_dir, str)
                    and cards_dir
                    and isinstance(card_no, int)
                    and not isinstance(card_no, bool)
                    and isinstance(attempt, int)
                    and not isinstance(attempt, bool)
                ):
                    raise ValueError("执行身份字段无效")
            except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                errors.append(f"{path}: 执行上下文身份不可读：{type(exc).__name__}: {exc}")
                continue
            ancestor_instances = [
                (len(directory.parts), candidate)
                for directory, candidate in instance_dirs.items()
                if path.parent.resolve().is_relative_to(directory)
            ]
            if not ancestor_instances:
                errors.append(f"{path}: 执行上下文无法绑定工作流实例")
                continue
            nearest_depth = max(depth for depth, _ in ancestor_instances)
            instance_id, *conflicts = {
                candidate
                for depth, candidate in ancestor_instances
                if depth == nearest_depth
            }
            if conflicts:
                errors.append(f"{path}: 执行上下文绑定多个工作流实例")
                continue
            normalized_cards_dir = cards_dir.replace("\\", "/").rstrip("/")
            attempt_ids.add((instance_id, normalized_cards_dir, card_no, attempt))
        return (
            len(instance_ids) if not errors else None,
            len(attempt_ids) if not errors else None,
            len(instance_paths),
            len(attempt_paths),
            errors,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        # 父轨迹仍由固定提交中的 Pi 逻辑生成，worker 会话放在独立目录。
        super().populate_context_post_run(context)
        session_files, ignored_non_session, classification_errors = self._usage_candidates()
        totals = self._aggregate_session_usage(session_files)
        if classification_errors:
            # 原生会话候选损坏必须使覆盖结论失败，不能因分类过滤而无痕消失。
            totals["errors"] = [*classification_errors, *totals["errors"]]
            totals["complete"] = False
        (
            internal_instance_count,
            worker_attempt_count,
            instance_evidence_file_count,
            attempt_evidence_file_count,
            evidence_errors,
        ) = self._usage_evidence_counts()
        if evidence_errors:
            totals["errors"] = [*totals["errors"], *evidence_errors]
            totals["complete"] = False
        context.n_input_tokens = totals["input"] if not totals["unknown_tokens"] and not totals["errors"] else None
        context.n_output_tokens = totals["output"] if not totals["unknown_tokens"] and not totals["errors"] else None
        context.n_cache_tokens = totals["cache"] if not totals["unknown_tokens"] and not totals["errors"] else None
        # 自定义端点没有已核实的计价表，原生默认 cost=0 不能当成真实免费。
        context.cost_usd = None
        context.model_usage = {
            name: ModelUsage(n_input_tokens=value["input"], n_output_tokens=value["output"],
                             n_cache_tokens=value["cache"], cost_usd=None)
            for name, value in totals["models"].items()
        } if not totals["errors"] and not totals["unknown_tokens"] else None
        if self.options.profile != "single":
            # 部门/RPC 会话覆盖尚未实测，不能把已观察下界当作全角色总用量。
            context.n_input_tokens = context.n_output_tokens = context.n_cache_tokens = None
            context.model_usage = None
        context.metadata = {
            **(context.metadata or {}),
            "pao_profile": self.options.profile,
            "pao_source_sha256": self.options.source_sha256,
            "pao_node_sha256": self.options.node_sha256,
            "pao_node_archive": str(Path(self.options.node_archive).expanduser().resolve()),
            "pao_session_file_count": len(session_files),
            "pao_observed_usage_event_count": totals["events"],
            "pao_harbor_trials_observed": 1,
            "pao_internal_instance_count": internal_instance_count,
            "pao_internal_instance_count_status":
                "observed" if internal_instance_count is not None else "unknown",
            "pao_internal_instance_evidence_file_count": instance_evidence_file_count,
            "pao_worker_attempt_count": worker_attempt_count,
            "pao_worker_attempt_count_status":
                "observed" if worker_attempt_count is not None else "unknown",
            "pao_worker_attempt_evidence_file_count": attempt_evidence_file_count,
            "pao_model_request_count": None,
            "pao_model_requests_status": "unknown",
            "pao_model_requests_reason": "用量事件身份不是请求身份；同一请求可能有多条回执，工具用量或转录也可能重复",
            "pao_role_session_counts": totals["role_session_counts"],
            "pao_usage_coverage_status": "unknown",
            "pao_usage_coverage_reason": "只统计已发现的受管会话和辅助请求信号，未证明所有部门、RPC、辅助调用和内部实例均已归档",
            "pao_role_coverage_status": {
                role: "observed" if count else "not_observed"
                for role, count in totals["role_session_counts"].items()
            },
            "pao_cost_status": totals["cost_status"],
            "pao_cost_source": totals["cost_source"],
            "pao_usage_candidate_count": len(session_files) + len(ignored_non_session) + len(classification_errors),
            "pao_usage_ignored_non_session": ignored_non_session,
            "pao_usage_scope": "父会话与已同步 worker 会话按 session+event 去重",
            "pao_discovered_usage_complete": totals["complete"],
            "pao_nested_usage_complete": totals["complete"] and self.options.profile == "single",
            "pao_usage_errors": totals["errors"],
            "pao_unknown_token_events": totals["unknown_tokens"],
            "pao_known_input_tokens_lower_bound": totals["input"],
            "pao_known_output_tokens_lower_bound": totals["output"],
            "pao_known_cache_read_tokens_lower_bound": totals["cache"],
            "pao_known_cache_write_tokens_lower_bound": totals["cache_write"],
            "pao_accounting_limit": "尚未在容器核对所有部门/RPC/辅助调用的会话覆盖，PAO 总数只作已观察下界",
            "pao_price_status": "自定义端点单价未核实；原生默认零费用不代表真实账单为零",
        }

    _aggregate_session_usage = staticmethod(aggregate_session_usage)
