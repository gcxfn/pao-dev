$ErrorActionPreference = 'Continue'
$f = (Get-ChildItem -Path 'D:\AI\workspace\pao-dev\.pao' -Recurse -Filter 'e2e-core-full-*.log' | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
"LOG: $f"
$lines = Get-Content -LiteralPath $f | ForEach-Object { $_ -replace '\x1b\[[0-9;]*[A-Za-z]', '' }
"LINES: $($lines.Count)"
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*\d+\)\s+\S*spec\.ts') {
    "==================== $($lines[$i].Trim())"
    for ($j = $i + 1; $j -lt [Math]::Min($i + 30, $lines.Count); $j++) {
      $t = $lines[$j].Trim()
      if ($t -match '^\d+\)\s+\S*spec\.ts' -or $t -match '^\d+ (failed|passed|flaky)') { break }
      if ($t -ne '') { "  $t" }
    }
  }
}
"`n===== 进度 ====="
$p = $lines | Where-Object { $_ -match '\[\d+/\d+\]' } | Select-Object -Last 1
"LAST: $($p.Trim())"
