"""配置部门与流水线的新版 PAO；复用本 run 的基础适配器，不修改产品源码。"""
import hashlib
import json
from pathlib import Path
import shlex

from pydantic import Field
from map_bench_pao.pao_agent import PAOAgent, PAOOptions


class OrganizedOptions(PAOOptions):
    organization_manifest_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')


class OrganizedPAOAgent(PAOAgent):
    options_model = OrganizedOptions

    @staticmethod
    def name():
        return 'pao-organized'

    async def install(self, environment):
        await super().install(environment)
        run_root = Path(__file__).resolve().parent
        kit = run_root / 'organized-post'
        manifest = kit / 'manifest.json'
        if hashlib.sha256(manifest.read_bytes()).hexdigest() != self.options.organization_manifest_sha256:
            raise ValueError('组织配置清单摘要不符')
        records = json.loads(manifest.read_text(encoding='utf-8'))['files']
        for item in records:
            source = (run_root / item['path']).resolve()
            if run_root not in source.parents:
                raise ValueError('组织文件越出 run 根：' + item['path'])
            if hashlib.sha256(source.read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('组织配置文件摘要不符：' + item['path'])
        await self.exec_as_agent(
            environment,
            command='mkdir -p /tmp/benchmark-organization /logs/agent/organization',
        )
        for name in ('setup.mjs', 'kit.json', 'activate-tools.mjs', 'probe-tools.mjs',
                     'benchmark-organized-entry.mjs', 'benchmark-worktree-host.mjs',
                     'benchmark-host-factories.mjs', 'benchmark-child-entry.mjs',
                     'probe-child-rpc.mjs', 'query-organized-terminal.mjs'):
            await self._upload_config_text(
                environment,
                content=(kit / name).read_text(encoding='utf-8'),
                remote_path='/tmp/benchmark-organization/' + name,
                filename='organization-' + name,
            )
        result = await self.exec_as_agent(
            environment,
            command=(
                '"$HOME/.local/pao-node/bin/node" /tmp/benchmark-organization/setup.mjs '
                + shlex.quote(self._REMOTE_SOURCE_DIR)
                + ' /tmp/benchmark-organization/kit.json'
                + ' /tmp/harbor-pao-home /tmp/harbor-pi-agent /logs/agent/organization /app'
                + ' /tmp/benchmark-model-binding.json'
            ),
        )
        if result.return_code != 0:
            raise RuntimeError('组织初始化或 Git 基线失败，不启动模型：' + str(result.return_code))
        launcher = (
            '#!/bin/sh\n'
            f'export PAO_BENCH_SOURCE={shlex.quote(self._REMOTE_SOURCE_DIR)}\n'
            'exec "$HOME/.local/pao-node/bin/node" /tmp/benchmark-organization/benchmark-organized-entry.mjs "$@"\n'
        )
        await self.exec_as_agent(environment, command=(
            f"printf '%s' {shlex.quote(launcher)} > {self._REMOTE_LAUNCHER} && "
            f"chmod 755 {self._REMOTE_LAUNCHER}"
        ))
        for role in ('main', 'minister', 'worker'):
            result = await self.exec_as_agent(
                environment,
                command=(
                    '"$HOME/.local/pao-node/bin/node" /tmp/benchmark-organization/probe-tools.mjs '
                    + shlex.quote(self._REMOTE_SOURCE_DIR)
                    + ' /tmp/harbor-pi-agent /logs/agent/organization/probes/' + role + ' ' + role
                ),
            )
            if result.return_code != 0:
                raise RuntimeError('SDK 角色工具预检失败，不启动模型：' + role)

        result = await self.exec_as_agent(environment, command=(
            'PAO_BENCH_SOURCE=' + shlex.quote(self._REMOTE_SOURCE_DIR)
            + ' "$HOME/.local/pao-node/bin/node" /tmp/benchmark-organization/probe-child-rpc.mjs '
            + '/logs/agent/organization/child-rpc'
        ))
        if result.return_code != 0:
            raise RuntimeError('真实子进程RPC装配预检失败，不启动模型：' + str(result.return_code))

    async def run(self, instruction, environment, context):
        workflow_instruction = (
            '本轮已经建立四个部门和“基准开发流水线”，/app 已在 setup 最开场建立或保留真实 Git 输入基线。'
            '必须调用 pao_start_flow，name="基准开发流水线"，cards_dir 为当前项目根下'
            ' .pao/benchmark/卡 的绝对路径，params 的“任务”字段填写下方原始任务全文。'
            '主控只协调；派发部门后结束当前模型轮次，不sleep等待，宿主会继续后台并在结果、异常或监督到期时唤醒。'
            '主控每30分钟监督部门；实际检查后调用 pao_ack_supervision。'
            '最终官方测试独立运行。\n\n原始任务全文：\n' + instruction
        )
        context.metadata = {
            **(context.metadata or {}),
            'pao_organization_manifest_sha256': self.options.organization_manifest_sha256,
            'pao_organization_started': False,
            'pao_organization_git_baseline': False,
            'pao_organization_workflow_status': None,
            'pao_organization_completed': False,
            'pao_organization_control_instance': None,
            'pao_organization_control_owner': None,
            'pao_organization_control_workflow': None,
            'pao_organization_report_workflow': None,
            'pao_organization_terminal_query_error': None,
        }
        original_error = None
        try:
            await super().run(workflow_instruction, environment, context)
        except BaseException as error:
            original_error = error
            raise
        finally:
            try:
                copied = await self.exec_as_agent(environment, command=(
                    'if [ -d /tmp/harbor-pao-home/部门 ]; then cp -a /tmp/harbor-pao-home/部门 /logs/agent/organization/; fi; '
                    'if [ -d /tmp/harbor-pao-home/工作流 ]; then cp -a /tmp/harbor-pao-home/工作流 /logs/agent/organization/; fi; '
                    'if [ -f /tmp/harbor-pao-home/pao配置/保温.json ]; then '
                    'cp /tmp/harbor-pao-home/pao配置/保温.json /logs/agent/organization/保温.json; fi'
                ))
                if copied.return_code != 0:
                    raise RuntimeError('组织配置留证失败：' + str(copied.return_code))
            except BaseException as evidence_error:
                message = type(evidence_error).__name__ + ': ' + str(evidence_error)
                context.metadata = {
                    **(context.metadata or {}),
                    'pao_organization_evidence_error': message,
                }
                if original_error is None:
                    raise
                note = '组织配置留证同时失败：' + message
                add_note = getattr(original_error, 'add_note', None)
                if callable(add_note):
                    add_note(note)
                else:
                    setattr(original_error, 'pao_organization_evidence_error', message)
        proof = await self.exec_as_agent(environment, command=(
            'test -f .pao/benchmark/工作流实例-基准开发流水线.md && '
            'cp .pao/benchmark/工作流实例-基准开发流水线.md /logs/agent/organization/final-flow.md && '
            'test -f /logs/agent/organization/git-baseline.json && '
            'git -C /app rev-parse HEAD > /logs/agent/organization/final-git-head.txt'
        ))
        if proof.return_code != 0:
            raise RuntimeError('组织流程未实际启动或缺少 Git 基线，不能视作部门协作试验成功')
        context.metadata = {
            **(context.metadata or {}),
            'pao_organization_started': True,
            'pao_organization_git_baseline': True,
        }
        try:
            terminal_result = await self.exec_as_agent(
                environment,
                command=(
                    '"$HOME/.local/pao-node/bin/node" '
                    '/tmp/benchmark-organization/query-organized-terminal.mjs '
                    + shlex.quote(self._REMOTE_SOURCE_DIR) + ' '
                    + shlex.quote('/tmp/harbor-pao-home') + ' '
                    + shlex.quote('/app') + ' '
                    + shlex.quote('基准开发流水线')
                ),
            )
        except BaseException as error:
            message = type(error).__name__ + ': ' + str(error)
            context.metadata = {
                **(context.metadata or {}),
                'pao_organization_terminal_query_error': message,
            }
            raise RuntimeError('组织工作流终态查询执行失败：' + message) from error

        stdout = terminal_result.stdout or ''
        stderr = terminal_result.stderr or ''
        try:
            terminal = json.loads(stdout)
        except (json.JSONDecodeError, TypeError) as error:
            message = '查询结果不是严格 JSON：' + type(error).__name__ + ': ' + str(error)
            context.metadata = {
                **(context.metadata or {}),
                'pao_organization_terminal_query_error': message,
            }
            raise RuntimeError('组织工作流终态查询结果无法解析') from error

        if terminal_result.return_code != 0:
            error_detail = terminal.get('error') if isinstance(terminal, dict) else None
            if isinstance(error_detail, dict):
                message = str(error_detail.get('name') or 'QueryError') + ': ' + str(
                    error_detail.get('message') or ''
                )
            else:
                message = (stderr or stdout).strip()
            message = '查询退出码 ' + str(terminal_result.return_code) + (
                '：' + message if message else ''
            )
            context.metadata = {
                **(context.metadata or {}),
                'pao_organization_terminal_query_error': message,
            }
            raise RuntimeError('组织工作流终态查询失败：' + message)

        control = terminal.get('control') if isinstance(terminal, dict) else None
        report = terminal.get('report') if isinstance(terminal, dict) else None
        if (
            not isinstance(terminal, dict)
            or terminal.get('ok') is not True
            or not isinstance(control, dict)
            or not isinstance(report, dict)
            or report.get('status') not in ('running', 'hold', 'completed')
            or not isinstance(control.get('instance'), str)
            or not control.get('instance')
            or not isinstance(control.get('owner'), str)
            or not control.get('owner')
            or not isinstance(control.get('workflow'), str)
            or not control.get('workflow')
            or not isinstance(report.get('workflow'), str)
            or not report.get('workflow')
        ):
            message = '查询结果缺少完整控制身份、报告标识或合法终态'
            context.metadata = {
                **(context.metadata or {}),
                'pao_organization_terminal_query_error': message,
            }
            raise RuntimeError('组织工作流终态查询结果不完整')

        status = report['status']
        context.metadata = {
            **(context.metadata or {}),
            'pao_organization_workflow_status': status,
            'pao_organization_completed': status == 'completed',
            'pao_organization_control_instance': control['instance'],
            'pao_organization_control_owner': control['owner'],
            'pao_organization_control_workflow': control['workflow'],
            'pao_organization_report_workflow': report['workflow'],
        }
        if status != 'completed':
            raise RuntimeError('组织工作流未完成：status=' + status)
