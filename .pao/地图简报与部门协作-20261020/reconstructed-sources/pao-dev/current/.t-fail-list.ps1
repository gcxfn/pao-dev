$ErrorActionPreference = 'Continue'
$f = (Get-ChildItem -Path 'D:\AI\workspace\pao-dev\.pao' -Recurse -Filter 'e2e-core-full-*.log' | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
$lines = Get-Content -LiteralPath $f | ForEach-Object { $_ -replace '\x1b\[[0-9;]*[A-Za-z]', '' }
$n = 0
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*\d+\)\s+\S*spec\.ts') {
    $n++
    $title = $lines[$i].Trim()
    $err = ''
    for ($j = $i + 1; $j -lt [Math]::Min($i + 12, $lines.Count); $j++) {
      $t = $lines[$j].Trim()
      if ($t -match '^(Error|TimeoutError|TypeError|ReferenceError|SyntaxError)') { $err = $t; break }
    }
    "$n | $title"
    "    $err"
  }
}
"TOTAL_FAILURES_SEEN: $n"
$p = $lines | Where-Object { $_ -match '\[\d+/\d+\]' } | Select-Object -Last 1
"PROGRESS: $($p.Trim())"
