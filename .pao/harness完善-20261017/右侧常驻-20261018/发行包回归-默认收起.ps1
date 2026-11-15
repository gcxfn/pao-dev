# 用途：用「窄窗默认收起」新打包的解包发行物跑真实 Electron 回归，验证发行包内嵌渲染层仍是新行为。
# 输入：临时文件夹\窄窗加固-20261018\release-默认收起\win-unpacked；输出：日志 发行包回归-默认收起.log。
$ErrorActionPreference = 'Continue'
$root = 'D:\AI\workspace\pao-dev'
$log = 'D:\AI\workspace\临时文件夹\窄窗加固-20261018\发行包回归-默认收起.log'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PI_APP_TEST_LANE = 'core'
$env:PI_APP_REAL_AUTH = '0'
$env:PI_APP_TEST_MODE = 'background'
$env:PI_APP_TEST_RELEASE_DIR = 'D:\AI\workspace\临时文件夹\窄窗加固-20261018\release-默认收起'
Set-Location (Join-Path $root 'desktop')
npx playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/core/d4-sidebar-draft.spec.ts apps/desktop/tests/core/department-workspace.spec.ts apps/desktop/tests/core/workbench-tabs.spec.ts *> $log
Write-Output "tests=$LASTEXITCODE"