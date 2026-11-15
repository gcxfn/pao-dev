"""用途：只读提取r12执行角色公开答复及工具错误；输出复盘证据，不恢复模型或改运行。"""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
run = root / '.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared-r12'
agent = run / 'jobs/pao-first-refactor-20261024-r12-task-1/html-js-filter__R7qsiwj/agent'
roles = {
    '工人': agent / 'pao/worker-sessions/project-state/worker会话',
    '实施部长': agent / 'pao/worker-sessions/project-state/benchmark/部长会话',
    '主控': agent / 'pi/sessions',
}
out = ['# r12执行代理原始反馈摘录', '', '这是已结束会话的原始公开答复与工具返回，不是新增访谈；未提取模型思考内容。', '']
for role, directory in roles.items():
    for file in sorted(directory.glob('**/*.jsonl')):
        if role == '实施部长' and '185e331e' not in file.name:
            continue
        replies, errors = [], []
        for line in file.read_text(encoding='utf-8-sig').splitlines():
            row = json.loads(line)
            message = row.get('message', {})
            blocks = message.get('content', [])
            if not isinstance(blocks, list):
                continue
            content = '\n'.join(b.get('text', '') for b in blocks if b.get('type') == 'text')
            if message.get('role') == 'assistant' and content:
                replies.append(content)
            if message.get('role') == 'toolResult' and (message.get('isError') or any(x in content for x in ('INVALID_TRANSITION', '只有已交付或失败卡', '须用户在界面', '覆盖内容已变化'))):
                errors.append(content[:3500])
        out.extend([f'## {role}', '', f'来源：{file.relative_to(root).as_posix()}', '', '### 公开答复（末三条）', '', '\n\n'.join(replies[-3:]), '', '### 相关工具返回（末六条）', '', '\n\n'.join(errors[-6:]), ''])
target = Path(__file__).parent / 'r12执行代理反馈摘录-20261024.md'
target.write_text('\n'.join(out), encoding='utf-8')
print(target)
for role in roles:
    print('已读取角色：' + role)
