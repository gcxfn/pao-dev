# 用途：在本机无用户技能/项目上下文祖先的隔离测试目录中复跑原失败集合门。
# 输入：现有本地fork与fd/rg；输出：唯一时间前缀JSON、原stdout/stderr及比较日志；不发模型、不改基线或系统权限。
param([string]$输出前缀 = ('S7-完整基线-' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')))
$ErrorActionPreference = 'Stop'
$taskRepo = 'D:\AI\workspace\pao-dev\PAO'
$taskLogs = 'D:\AI\workspace\pao-dev\.pao\后续执行-20261004'
if ($输出前缀 -notmatch '^[\p{L}\p{N}_-]+$') { throw '输出前缀只能含字母、数字、中文、下划线和连字符' }
$taskReport = Join-Path $taskLogs ($输出前缀 + '.json')
$taskLog = Join-Path $taskLogs ($输出前缀 + '.log')
foreach ($taskFile in @($taskReport, $taskLog, ($taskReport + '.raw.log'))) {
    if (Test-Path -LiteralPath $taskFile) { throw "禁止覆盖已有证据：$taskFile" }
}
Get-Item -Force -LiteralPath 'C:\Windows\Temp' | Out-Null
foreach ($taskTool in @('fd.exe','rg.exe')) {
    Get-Item -LiteralPath (Join-Path 'C:\Users\ASUS\.pi\agent\bin' $taskTool) | Out-Null
}
$taskNames = @('PATH', 'TMP', 'TEMP', 'TMPDIR')
$taskSavedEnv = @{}
foreach ($taskName in $taskNames) { $taskSavedEnv[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }
$taskOldDir = Get-Location
try {
    $env:PATH = 'C:\Users\ASUS\.pi\agent\bin;' + $env:PATH
    $env:TMP = 'C:\Windows\Temp'
    $env:TEMP = $env:TMP
    $env:TMPDIR = $env:TMP
    Set-Location -LiteralPath $taskRepo
    & node scripts/check-baseline-failures.mjs --save-log $taskReport *> $taskLog
    $taskExit = $LASTEXITCODE
} finally {
    Set-Location -LiteralPath $taskOldDir.Path
    foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName, $taskSavedEnv[$taskName], 'Process') }
}
Write-Output "原基线比较退出码：$taskExit；证据：$taskReport；比较日志：$taskLog"
exit $taskExit
