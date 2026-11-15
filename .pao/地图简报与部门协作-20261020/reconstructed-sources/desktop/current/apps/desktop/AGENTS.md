# Desktop Guidelines

Apply these rules for changes under `apps/desktop/`.

- Preserve Codex-style information architecture and polish; avoid generic dashboard UI.
- PAO 的目标 Windows 是本项目必需的桌面与原生行为验收环境；保留上游其他平台测试，但不以其通过替代 Windows 验证。打包成功不等于界面或系统行为通过。
- Verify desktop changes on the real Electron surface, and prefer Playwright coverage for repeatable proofs. Distinguish fixture-backed Electron checks, deterministic runtime integration, real-provider conversations, native OS behavior, and packaged-app proof; a passing lane or skipped provider test cannot establish all of these.
- Use `apps/desktop/README.md` for lane/setup commands, and `apps/desktop/tests/AGENTS.md` for test-surface rules under the test tree.
- 会话页面保持对话、工具时间线与输入优先；工作流和看板页面遵循 PAO 已确认的产品定案，不用会话布局覆盖它们。
- Don’t expose broad filesystem/process APIs through preload; add only narrow IPC needed by the renderer.
- Prefer shared helpers over duplicating Electron test harness or IPC glue.
- Keep composer and timeline behavior fast on hot paths; avoid full-state disk writes for keystrokes if a narrower path works.
