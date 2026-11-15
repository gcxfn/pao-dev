# 正式 pao app 冷启动零 API 验收准备

2026-10-04，状态：准备完成，等待主代理统一构建后放行执行。未启动窗口、未调用模型。

使用正式 CLI `node PAO/packages/coding-agent/dist/bundle/cli.js app`，不得以 Playwright electron.launch 或直接 Electron exe 替代。CLI 保留普通桌面 IPC 父生命周期；不设置 PI_APP_TEST_MODE。首次必须直接出现可见顶层窗口，不通过第二实例或手动 show 补救。

执行前记录 CLI/runtime chunk、app dist、桌面 main、driver 文件修改时间和 SHA256；确认主代理已完成包含取消窄修的统一构建。使用独立 proof 目录与隔离 profile、空私有 agentDir，PAO_SESSION_BUDGET turns=0；不载入用户模型凭证。模型活任务两场继续保持 prepared，不夹入本次。

启动后用 Win32 EnumWindows（复用 S6-正式窗口只读枚举.ps1）、CIM 父子树确认实际 CLI → Electron 主进程、主窗口 visible=True。保存窗口截图并目视核对加载成功，不能只凭进程活着或 MainWindowHandle。记录首次显示时间、CLI PID、主 PID 和子树。

经真实窗口关闭操作退出，确认 CLI 与本次 Electron 子树均终止。失败则保留日志/截图/PID，不用第二次启动算冷启动成功。无 API 证据核对全局账本前后请求数相同；隔离 agent 无用户配置只是附加防线。

原隐藏窗口证据及第二实例补显示证据保留在 S6-正式入口隐藏窗口调查.md；本次通过后仅追加新的正式冷启动结果，不覆盖原失败。
