$ErrorActionPreference = 'Stop'
$path = 'D:\AI\workspace\pao-dev\.pao\协作机制重构-20261023\f-novel-trace2\runtime-event.log'
$events = foreach ($line in [System.IO.File]::ReadLines($path)) {
    $line | ConvertFrom-Json
}
$starts = @($events | Where-Object event -eq 'start')
$exits = @($events | Where-Object event -eq 'exit')
$exitsBySid = @{}
foreach ($event in $exits) {
    $exitsBySid[$event.sid] = $event
}
$rows = foreach ($start in $starts) {
    $argv = $start.argv -join ' '
    $exit = $exitsBySid[$start.sid]
    [pscustomobject]@{
        sid = $start.sid
        start = [datetime]$start.time
        duration_ms = if ($exit) { [math]::Round(($exit.t_abs - $start.t_abs) * 1000, 2) } else { $null }
        code = $exit.code
        argv = $argv
    }
}
"STARTS=$($starts.Count) EXITS=$($exits.Count) MATCHED=$(@($rows).Count)"
$rows | Group-Object { ($_.argv -split ' ')[3..7] -join ' ' } |
    Sort-Object Count -Descending |
    Select-Object -First 30 Count, Name |
    Format-Table -Wrap
'LONGEST'
$rows | Sort-Object duration_ms -Descending |
    Select-Object -First 40 duration_ms, code, start, argv |
    Format-Table -Wrap
'LAST'
$rows | Sort-Object start | Select-Object -Last 30 duration_ms, code, start, argv | Format-Table -Wrap
