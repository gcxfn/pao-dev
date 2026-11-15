$ErrorActionPreference = 'Stop'

$workspace = 'D:\AI\workspace\pao-dev'
$benchmark = Join-Path $workspace '.pao\地图简报与部门协作-20261020\benchmark'
$sdkHost = Join-Path $workspace '.pao\协作机制重构-20261023\benchmark-sdk-host'
$evidence = Join-Path $workspace '.pao\协作机制重构-20261023\系统稳定性治理-20261025'
$snapshot = Join-Path $evidence '运行器修复基线'

if (Test-Path -LiteralPath $snapshot) {
    throw "基线目录已存在，拒绝覆盖：$snapshot"
}

$files = @(
    (Join-Path $benchmark 'bench_controller.py'),
    (Join-Path $benchmark 'test_bench_controller.py'),
    (Join-Path $benchmark 'map_bench_pao_organized.py'),
    (Join-Path $benchmark 'test_pao_agent.py'),
    (Join-Path $benchmark 'test_usage.py')
)

$directories = @(
    (Join-Path $benchmark 'map_bench_pao'),
    (Join-Path $benchmark 'organized-post'),
    (Join-Path $benchmark 'scripts'),
    $sdkHost
)

$sourceFiles = [System.Collections.Generic.List[string]]::new()
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "基线源文件不存在：$file"
    }
    $sourceFiles.Add($file)
}

foreach ($directory in $directories) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "基线源目录不存在：$directory"
    }
    Get-ChildItem -LiteralPath $directory -File -Recurse |
        Where-Object {
            $_.FullName -notmatch '[\\/]__pycache__[\\/]' -and
            $_.Extension -ne '.pyc'
        } |
        ForEach-Object { $sourceFiles.Add($_.FullName) }
}

New-Item -ItemType Directory -Path $snapshot | Out-Null
$records = [System.Collections.Generic.List[object]]::new()

foreach ($source in ($sourceFiles | Sort-Object -Unique)) {
    $relative = [System.IO.Path]::GetRelativePath($workspace, $source)
    $destination = Join-Path $snapshot $relative
    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination

    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    $snapshotHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHash -ne $snapshotHash) {
        throw "基线复制摘要不一致：$source"
    }

    $records.Add([ordered]@{
        source = $source
        snapshot = $destination
        size = (Get-Item -LiteralPath $source).Length
        sha256 = $sourceHash
    })
}

$manifest = [ordered]@{
    createdAt = (Get-Date).ToString('o')
    workspace = $workspace
    fileCount = $records.Count
    files = $records
}
$manifestPath = Join-Path $snapshot '基线清单.json'
$manifest | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $manifestPath -Encoding utf8

Push-Location $workspace
try {
    git status --short |
        Set-Content -LiteralPath (Join-Path $snapshot 'git-status.txt') -Encoding utf8
}
finally {
    Pop-Location
}

Write-Output "基线文件数：$($records.Count)"
Write-Output "基线目录：$snapshot"
