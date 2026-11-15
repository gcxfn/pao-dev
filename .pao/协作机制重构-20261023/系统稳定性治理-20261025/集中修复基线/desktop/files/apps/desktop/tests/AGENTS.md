# Desktop Test Guidelines

Apply these rules under `apps/desktop/tests/`.

- PAO 本地验收以项目计划指定的 Windows 为准；下述 macOS/Linux 测试分类供选择入口，不构成本地跨平台验收承诺。native 场景须有目标平台实际证据，不能用 macOS 专属测试替代 Windows 行为。

- Use the lane scripts in `apps/desktop/package.json` before inventing ad hoc Playwright commands.
- Pick the smallest lane that matches the changed surface:
- `unit`: Node-level logic, storage and local Git contracts without launching Electron. Required through `pnpm check`.
- `core`：无真实凭证的 Electron UI 与本地运行集成，覆盖页面、会话、持久化等行为；使用隔离 fixture。CI 平台、分片与 worker 数以工作流和脚本为准，不在本文件维护副本。剪贴板等共享资源失败可单独运行定位竞争。
- `live`: actual external-provider requests. The lane command requires explicit real-auth opt-in and an existing auth source before building. Use real-provider coverage for transcript, tool-call and parallel-run behavior that depends on actual agent execution. A skipped run is not provider proof.
- `native`: macOS OS-surface flows such as keyboard shortcut routing, real clipboard paste, minimize and refocus. These are foreground-only and focus-sensitive. A stubbed picker result proves only application handling and belongs in Core; do not claim it proves OS picker selection.
- `production`: opt-in higher-fidelity smokes such as real-auth `live`, packaged-app launch, and real macOS open-panel coverage. Keep these out of the default `core` and `native` globs so fast lanes stay stable.
- 运行前读取 package.json 确认测试入口覆盖范围，不能将 core 通过当成 live/native/production 通过。
- For `native`, prefer the targeted native spec by default. Expand to `test:e2e:native` only when the change touches shared native helpers, multiple native specs, or lane-wide native behavior.
- Keep `tests/production` behind dedicated scripts or direct `test:e2e:runner` invocations; do not place those specs under `tests/core` or `tests/native`.
- Prefer repo lanes over manual Computer Use. If the local Codex skill `$pi-gui-computer-use-smoke` is installed, use it only for release-readiness sweeps on the real installed app or for focus-hostile native surfaces where Playwright is the wrong proof shape.
- The reasoning is the same as the global agent philosophy: optimize for tools plus clear success criteria, not ad hoc manual steps. Playwright remains the deterministic regression signal; Computer Use is an opt-in complement for believable real-surface proof.
- Prefer shared helpers in `tests/helpers/electron-app.ts`; extend them instead of adding a second harness or new IPC glue.
- Simulate user behavior through Playwright first. Do not add IPC/state shortcuts for visible behavior unless the product surface does not exist yet; if you need one, document the gap in the spec.
- `pasteTinyPng()` proves the renderer paste handler and is suitable for background/core coverage.
- `pasteTinyPngViaClipboard()` proves real Electron clipboard paste and belongs in foreground/native coverage.
- Native failures can be environmental. Before treating a native failure as a product regression, rerun with a clean foreground window and no competing keyboard or mouse input.
- Report which evidence actually ran: fixture-backed Electron, deterministic runtime integration, real-provider conversation, native OS, or packaged artifact. For visible conversation proof without injected events, use the checked-in [verify-pi-gui skill](../../../.agents/skills/verify-pi-gui/SKILL.md); its settings smoke is not conversation proof.
- Real-auth `live` specs must opt in explicitly via `PI_APP_REAL_AUTH=1` plus `PI_APP_REAL_AUTH_SOURCE_DIR=/absolute/path/to/agent`; raw spec discovery may skip without these, but an explicitly requested live lane must fail preflight rather than report an all-skipped success.

## Flaky tests

- 偶发失败需要定位；允许为诊断而隔离复跑，保留首次失败。复跑通过不能冒充根因已解决，不得用盲重试、跳过或放宽超时取得通过。
- Wait on the app's real state, not on what happens to be visible. Content that paints before an async step settles (an extension frame before it reports ready, a row before a pin round-trip moves it) is not readiness. When no observable state exists, expose one on the surface (for example `data-state` on `extension-view-panel`) and wait on it with a shared helper.
- Before clicking inside the transcript right after a thread switch, side-panel toggle or resize, call `waitForTimelineLayout`. Timeline rows move once measured, and a click whose press and release straddle that move is silently lost, so Playwright's own stability check is not enough.
- Do not race product calls against wall-clock deadlines. Assert the behavior (a call returned while its work is still pending) against a fixture that makes the alternative impossible.
- If a flaky test checks nothing a user would notice, propose rewriting or removing it rather than keeping it green.
