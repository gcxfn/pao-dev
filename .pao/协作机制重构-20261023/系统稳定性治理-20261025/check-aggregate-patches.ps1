# 用途：在各自独立的临时 Git index 中验证聚合补丁；不改正式 index。
param(
    [string]$Repo = 'D:\AI\workspace\pao-dev',
    [string]$Evidence = '.pao\协作机制重构-20261023\系统稳定性治理-20261025'
)

$ErrorActionPreference = 'Stop'
$rows = [System.Collections.Generic.List[object]]::new()
$previousIndex = $env:GIT_INDEX_FILE

function Assert-Patch {
    param(
        [string]$Name,
        [string]$IndexPath
    )
    $env:GIT_INDEX_FILE = $IndexPath
    & git -C $Repo read-tree HEAD
    if ($LASTEXITCODE -ne 0) {
        throw 'git read-tree HEAD 失败'
    }
    $patchPath = Join-Path $Repo (Join-Path $Evidence $Name)
    $message = & git -C $Repo apply --cached --check --verbose --whitespace=nowarn $patchPath 2>&1
    $rows.Add([pscustomobject]@{
        Patch = $Name
        Exit = $LASTEXITCODE
        Message = ($message -join ' ').Trim()
    })
}

try {
    $safeIndex = Join-Path ([System.IO.Path]::GetTempPath()) ('pao-safe-index-' + [guid]::NewGuid().ToString('N'))
    $previewIndex = Join-Path ([System.IO.Path]::GetTempPath()) ('pao-preview-index-' + [guid]::NewGuid().ToString('N'))
    Assert-Patch '可安全分离.patch' $safeIndex
    Assert-Patch '基线完整增量预览.patch' $previewIndex
}
finally {
    if ($null -eq $previousIndex) {
        Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    }
    else {
        $env:GIT_INDEX_FILE = $previousIndex
    }
    foreach ($indexPath in @($safeIndex, $previewIndex)) {
        if ($indexPath -and (Test-Path -LiteralPath $indexPath)) {
            Remove-Item -LiteralPath $indexPath -Force
        }
    }
}

$rows | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Repo (Join-Path $Evidence '聚合补丁检查.json')) -Encoding utf8
$rows | Format-Table -Wrap -AutoSize
