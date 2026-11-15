$path = 'D:\AI\workspace\pao-dev\.pao\协作机制重构-20261023\f-novel-trace2\runtime-event.log'
$events = foreach ($line in [System.IO.File]::ReadLines($path)) {
    $line | ConvertFrom-Json
}
$starts = @($events | Where-Object event -eq 'start')
$exits = @{}
foreach ($event in ($events | Where-Object event -eq 'exit')) {
    $exits[$event.sid] = $event
}
$rows = foreach ($start in $starts) {
    $exit = $exits[$start.sid]
    [pscustomobject]@{
        time = ([datetimeoffset]::Parse($start.time)).LocalDateTime
        duration_ms = if ($exit) { [math]::Round(($exit.t_abs - $start.t_abs) * 1000, 2) } else { $null }
        argv = $start.argv -join ' '
    }
}
"COUNT=$(@($rows).Count)"
$rows | Sort-Object time | Select-Object -Last 50 |
    Sort-Object time |
    Format-Table -Wrap
