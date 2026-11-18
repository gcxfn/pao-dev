$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$checkRoot = Join-Path $PSScriptRoot '../checks'
function Resolve-TaskPath([string]$relative) {
    $resolved = [IO.Path]::GetFullPath((Join-Path $taskRoot $relative))
    if (-not $resolved.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "目标超出项目：$relative"
    }
    return $resolved
}

$moves = @()
$badRoot = Resolve-TaskPath '.pao/鍗忎綔瑙勫垯缁熶竴-20261030'
Get-ChildItem -LiteralPath $badRoot -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($badRoot.Length + 1)
    $moves += [pscustomobject]@{ source = $_.FullName; target = Resolve-TaskPath ('.pao/协作规则统一-20261030/' + $relative) }
}
foreach ($name in @('终审-画布-1280.png', '终审-画布-900.png')) {
    $moves += [pscustomobject]@{
        source = Resolve-TaskPath ('desktop/.pao/工作区切换画布过滤-2026-11-04/' + $name)
        target = Resolve-TaskPath ('.pao/工作区切换画布过滤-2026-11-04/desktop-captures/' + $name)
    }
}
$recycle = @(
    'PAO/memory-restored.ts',
    'desktop/f1',
    'PAO/pnpm-lock.yaml',
    'PAO/pnpm-workspace.yaml',
    'PAO/tui-plan.md',
    '.zcodeignore',
    '.pao/test-runs',
    '.pao/test-pao-home-review',
    '.pao/鍗忎綔瑙勫垯缁熶竴-20261030',
    'desktop/.pao'
) | ForEach-Object { Resolve-TaskPath $_ }
foreach ($move in $moves) {
    if (-not (Test-Path -LiteralPath $move.source -PathType Leaf)) { throw "源文件不存在：$($move.source)" }
    if (Test-Path -LiteralPath $move.target) { throw "目标已存在：$($move.target)" }
}
foreach ($file in $recycle) {
    if (-not (Test-Path -LiteralPath $file)) { throw "回收目标不存在：$file" }
}
$manifest = [pscustomobject]@{ moves = $moves; recycle = $recycle }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $checkRoot 'E03-cleanup-manifest.json') -Encoding utf8
if ($args -notcontains '-Apply') {
    $manifest | ConvertTo-Json -Depth 5
    exit 0
}
foreach ($move in $moves) {
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($move.target)) -Force | Out-Null
    Move-Item -LiteralPath $move.source -Destination $move.target
}
Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($file in $recycle) {
    if (Test-Path -LiteralPath $file -PathType Container) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($file, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
    } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($file, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
    }
}
$missingMoves = @($moves | Where-Object { (Test-Path -LiteralPath $_.source) -or -not (Test-Path -LiteralPath $_.target -PathType Leaf) })
$remaining = @($recycle | Where-Object { Test-Path -LiteralPath $_ })
if ($missingMoves.Count -gt 0 -or $remaining.Count -gt 0) { throw '移入或回收结果不完整' }
Write-Output "Moved $($moves.Count) files; recycled $($recycle.Count) paths."
