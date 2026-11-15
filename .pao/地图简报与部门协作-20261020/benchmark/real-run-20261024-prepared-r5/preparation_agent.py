"""真实三题环境的准备预检；沿用相同安装流程，run只检查证据，不调用模型。"""
from map_bench_pao_organized import OrganizedPAOAgent


class PreparationOnlyAgent(OrganizedPAOAgent):
    @staticmethod
    def name():
        return 'pao-preparation-only'

    async def run(self, instruction, environment, context):
        await self.exec_as_agent(environment, command=(
            'set -eu; test -s /tmp/benchmark-prerequisites.json; '
            'test -s /logs/agent/organization/git-baseline.json; '
            'git -C /app rev-parse HEAD; python3 --version; '
            'cp /tmp/benchmark-prerequisites.json /logs/agent/prerequisites.json; '
            'printf "%s\\n" preparation_complete_no_model_calls '
            '> /logs/agent/preparation-complete.txt'
        ))
        context.metadata = {**(context.metadata or {}), 'preparation_only': True, 'model_calls': 0}
