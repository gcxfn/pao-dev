---
name: commit
description: 为已暂存的 git 改动创建一条符合 Conventional Commits 规范的本地提交。当用户要求提交(commit)、落一个 commit、把当前改动记入版本历史时使用;不用于创建/审查/合并 pull request,不用于推送。
license: MIT
compatibility: 本机 git 可用(无其他依赖)
---

# 提交已暂存改动

对当前暂存区内容创建一条 Conventional Commits 规范的本地提交。

## 步骤

1. **先看现场**：运行 `git status` 与 `git diff --staged`，弄清要提交的是什么。
2. **分析改动**：改了/增了/删了哪些文件；改动性质是功能(feat)、修复(fix)、重构、文档还是别的；影响范围(scope)是什么模块。
3. **写提交信息**，格式：
   ```
   <type>(<scope>): <描述>

   [可选正文]

   [可选尾注]
   ```
   type 取值：feat 新功能 / fix 修 bug / docs 纯文档 / style 格式不动的代码 / refactor 既非修 bug 也非加功能 / perf 性能 / test 测试 / chore 构建与依赖。
4. **执行提交**：运行 `git commit`。**不推送远端**。
5. **如实回报**：提交成功给出哈希与信息；失败给出完整报错。

## 边界

- 只做提交这一件事：不改文件、不推送、不顺手做别的。
- 暂存区为空时：告知用户，建议 `git add` 需要的文件，**不要自行代加**（提交范围是用户的决定）。
- 用户给了参数时，作为提交信息的补充上下文。
- 本仓库另有约定时（如 AGENTS.md 规定主会话统一提交），遵守仓库约定并指出。
