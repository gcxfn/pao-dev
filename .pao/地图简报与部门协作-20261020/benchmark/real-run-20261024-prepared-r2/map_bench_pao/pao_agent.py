"""固定 PAO 源码的 Harbor Pi 薄适配器；不读取题目答案或隐藏验收。"""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Literal, override

from pydantic import Field, model_validator

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.pi import Pi, PiOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext, ModelUsage
from .usage import aggregate_session_usage


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

        await self.ensure_system_dependencies(
            environment, ("bash", "coreutils", "curl", "tar", "unzip", "xz", "git", "python3")
        )
        # 实际运行版本检查后才声明依赖就绪，准备失败时不调用模型。
        await self.exec_as_agent(environment, command=(
            "python3 -c " + shlex.quote(
                "import json,pathlib,subprocess; "
                "data={name:subprocess.check_output([name,'--version'],text=True).strip() "
                "for name in ('git','python3')}; "
                "pathlib.Path('/tmp/benchmark-prerequisites.json').write_text(json.dumps(data))"
            )
        ))
        await environment.upload_file(archive, self._REMOTE_SOURCE_ARCHIVE)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"printf '%s  %s\\n' {shlex.quote(self.options.source_sha256)} "
                f"{shlex.quote(self._REMOTE_SOURCE_ARCHIVE)} | sha256sum -c -; "
                f"mkdir -p {shlex.quote(self._REMOTE_SOURCE_DIR)}; "
                + (f"unzip -q {shlex.quote(self._REMOTE_SOURCE_ARCHIVE)} -d {shlex.quote(self._REMOTE_SOURCE_DIR)}"
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
                f"unzip -qo {remote_overlay} -d {self._REMOTE_SOURCE_DIR}"
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
            f'unzip -qo /tmp/harbor-model-data.zip -d {self._REMOTE_SOURCE_DIR}'
        ))
        node_install = (
            "set -euo pipefail; "
            "NODE_VERSION=v24.18.0; "
            "NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742; "
            "NODE_DIR=$HOME/.local/pao-node; "
            "if [ ! -x \"$NODE_DIR/bin/node\" ]; then "
            "mkdir -p \"$HOME/.local\"; "
            "curl -fsSLo /tmp/pao-node.tar.xz "
            "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz; "
            "printf '%s  %s\\n' \"$NODE_SHA256\" /tmp/pao-node.tar.xz | sha256sum -c -; "
            "mkdir -p \"$NODE_DIR\"; "
            "tar -xJf /tmp/pao-node.tar.xz --strip-components=1 -C \"$NODE_DIR\"; "
            "fi; "
            'export PATH="$NODE_DIR/bin:$PATH"; '
            "\"$NODE_DIR/bin/node\" --version; \"$NODE_DIR/bin/npm\" --version"
        )
        await self.exec_as_agent(environment, command=node_install)
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

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        # 父轨迹仍由固定提交中的 Pi 逻辑生成，worker 会话放在独立目录。
        super().populate_context_post_run(context)
        main_dir = self.logs_dir / self._SESSIONS_DIRECTORY
        worker_dir = self.logs_dir / self._WORKER_SESSIONS_DIRECTORY
        session_files = sorted(
            [
                *(main_dir.glob("*.jsonl") if main_dir.is_dir() else []),
                *(worker_dir.rglob("*.jsonl") if worker_dir.is_dir() else []),
            ]
        )
        totals = self._aggregate_session_usage(session_files)
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
            "pao_session_file_count": len(session_files),
            "pao_usage_event_count": totals["events"],
            "pao_usage_unknown_events": totals["unknown_cost"],
            "pao_usage_known_cost_lower_bound_usd": totals["cost"],
            "pao_usage_scope": "父会话与已同步 worker 会话按 session+event 去重",
            "pao_observed_usage_complete": totals["complete"],
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
