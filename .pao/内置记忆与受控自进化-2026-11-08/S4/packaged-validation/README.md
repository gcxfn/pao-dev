# S4-17 发行物跨宿主测试

前置：主对话已在 `desktop/apps/desktop` 执行 `pnpm run package:win:dir`，并确认产物位于本次构建的 `release/win-unpacked/`。

在 PowerShell 中执行：

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PI_APP_TEST_MODE='background'
$env:PI_APP_TEST_RELEASE_DIR='D:\AI\workspace\pao-dev\desktop\apps\desktop\release'
Push-Location 'D:\AI\workspace\pao-dev\desktop\apps\desktop'
try {
  pnpm --dir ../.. exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/production/packaged-memory.spec.ts
} finally {
  Pop-Location
}
```

测试会隔离 PAO_HOME、agentDir、会话目录和工作区，并由打包 Electron 的 `ELECTRON_RUN_AS_NODE` 运行 `app.asar` 内 CLI。脚本 provider 只返回本地事件流，实际执行 `pao_memory_write`、打包桌面记忆页纠正和重开会话后的 `pao_memory_recall`。

固定证据目录：

```text
D:\AI\workspace\pao-dev\.pao\内置记忆与受控自进化-2026-11-08\S4\packaged-validation\runs\latest
```

目录中的 `evidence.json` 记录本次实际路径、工具结果、修订与页面操作来源；同目录保留 SQLite、provider 事件、会话和纠正后页面截图。只有本命令在 `package:win:dir` 产物上实际通过后，才可另行生成 S4-17 的通过 manifest。
