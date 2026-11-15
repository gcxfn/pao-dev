# 用途：在临时 Git index 中逐个验证提交补丁，不改正式 index 或工作树。
param(
    [string]$Repo = 'D:\AI\workspace\pao-dev',
    [string]$Evidence = '.pao\协作机制重构-20261023\系统稳定性治理-20261025'
)

$ErrorActionPreference = 'Stop'
$tempIndex = Join-Path ([System.IO.Path]::GetTempPath()) ('pao-submit-index-' + [guid]::NewGuid().ToString('N'))
$previousIndex = $env:GIT_INDEX_FILE
$rows = [System.Collections.Generic.List[object]]::new()

try {
    $env:GIT_INDEX_FILE = $tempIndex
    & git -C $Repo read-tree HEAD
    if ($LASTEXITCODE -ne 0) {
        throw 'git read-tree HEAD 失败'
    }

    $patchDirectory = Join-Path $Repo (Join-Path $Evidence '提交增量补丁')
    $patches = Get-ChildItem -LiteralPath $patchDirectory -Filter '*.patch' |
        Sort-Object Name
    foreach ($patch in $patches) {
        $message = & git -C $Repo apply --cached --check --verbose --whitespace=nowarn $patch.FullName 2>&1
        $exit = $LASTEXITCODE
        $rows.Add([pscustomobject]@{
            Patch = $patch.Name
            Exit = $exit
            Message = ($message -join ' ').Trim()
        })
    }
}
finally {
    if ($null -eq $previousIndex) {
        Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    }
    else {
        $env:GIT_INDEX_FILE = $previousIndex
    }
    if (Test-Path -LiteralPath $tempIndex) {
        Remove-Item -LiteralPath $tempIndex -Force
    }
}

$rows | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Repo (Join-Path $Evidence '补丁检查.json')) -Encoding utf8
$rows | Format-Table -Wrap -AutoSize
