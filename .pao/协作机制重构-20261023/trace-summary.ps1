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
        duration_ms = [math]::Round(($exit.t_abs - $start.t_abs) * 1000, 2)
        argv = $start.argv -join ' '
    }
}
"COUNT=$($rows.Count) TOTAL_MS=$([math]::Round(($rows | Measure-Object duration_ms -Sum).Sum, 2))"
$rows | Group-Object { $_.time.ToString('yyyy-MM-dd HH:mm:ss') } |
    Sort-Object Name |
    ForEach-Object {
        [pscustomobject]@{
            second = $_.Name
            count = $_.Count
            git_ms = [math]::Round(($_.Group | Measure-Object duration_ms -Sum).Sum, 2)
        }
    } |
    Format-Table -AutoSize
