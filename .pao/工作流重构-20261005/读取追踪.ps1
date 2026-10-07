# 用途：定位本轮隔离 Electron 测试失败；输入 trace.zip；输出最后的操作和错误，不写回追踪。
param([Parameter(Mandatory=$true)][string]$TracePath)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip = [System.IO.Compression.ZipFile]::OpenRead($TracePath)
try {
  foreach ($taskEntry in $taskZip.Entries) {
    if (-not $taskEntry.FullName.EndsWith('.trace')) {continue}
    $taskReader = [System.IO.StreamReader]::new($taskEntry.Open())
    try {$taskLines = $taskReader.ReadToEnd() -split "`n"} finally {$taskReader.Dispose()}
    $taskCalls = @{}
    $taskEvents = foreach ($taskLine in $taskLines) {
      if (-not $taskLine) {continue}
      $taskEvent = $taskLine | ConvertFrom-Json
      if ($taskEvent.type -eq 'before') {$taskCalls[$taskEvent.callId] = $taskEvent}
      if ($taskEvent.type -eq 'after') {
        $taskBefore = $taskCalls[$taskEvent.callId]
        [PSCustomObject]@{Action=$taskBefore.apiName; Selector=$taskBefore.params.selector; Error=$taskEvent.error.message}
      }
    }
    $taskEvents | Select-Object -Last 22 | Format-List
  }
} finally {$taskZip.Dispose()}
