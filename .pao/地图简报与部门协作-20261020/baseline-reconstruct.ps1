# 用途：从本目录 baseline 下的压缩包与补丁重建三仓的 HEAD 和当前源码基线。
# 输入：本脚本所在目录的 baseline 输出。
# 输出：本目录下 reconstructed-sources；脚本拒绝覆盖已存在目录，只解包源码与核对摘要。

$ErrorActionPreference = "Stop"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$repositories = @("pao-dev", "PAO", "desktop")
$baselineRoot = Join-Path $PSScriptRoot "baseline"
$destinationRoot = Join-Path $PSScriptRoot "reconstructed-sources"

if (Test-Path -LiteralPath $destinationRoot) {
    throw "重建目标已存在，拒绝覆盖：$destinationRoot"
}
$utf8Bom = [System.Text.UTF8Encoding]::new($true)
$scriptBytes = [System.IO.File]::ReadAllBytes($PSCommandPath)
if (
    $scriptBytes.Length -lt 3 -or
    $scriptBytes[0] -ne 0xEF -or
    $scriptBytes[1] -ne 0xBB -or
    $scriptBytes[2] -ne 0xBF
) {
    $scriptText = $utf8NoBom.GetString($scriptBytes)
    [System.IO.File]::WriteAllText($PSCommandPath, $scriptText, $utf8Bom)
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$gitExe = (Get-Command git.exe -ErrorAction Stop).Source

function Expand-VerifiedZip {
    param(
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $hashPath = "$ZipPath.sha256"
    if (-not (Test-Path -LiteralPath $hashPath)) {
        throw "缺少压缩包摘要：$hashPath"
    }
    $expectedHash = ((Get-Content -LiteralPath $hashPath -Raw -Encoding UTF8).Trim() -split '\s+')[0]
    $actualHash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "压缩包摘要不符：$ZipPath"
    }
    [System.IO.Compression.ZipFile]::ExtractToDirectory(
        $ZipPath,
        $Destination,
        $utf8NoBom
    )
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Verify-Manifest {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )
    $rows = @(Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    $differences = [System.Collections.Generic.List[object]]::new()
    foreach ($row in $rows) {
        $candidate = Join-Path $Root ($row.path.Replace("/", "\"))
        $actual = if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            Get-FileSha256 -Path $candidate
        }
        else {
            "<missing>"
        }
        if ($actual -ne $row.sha256) {
            $differences.Add([pscustomobject]@{
                path = $row.path
                expected = $row.sha256
                actual = $actual
            })
        }
    }
    if ($differences.Count -gt 0) {
        throw "源码摘要核验失败：`n$($differences | ConvertTo-Json -Depth 4)"
    }
}

[void][System.IO.Directory]::CreateDirectory($destinationRoot)
foreach ($repository in $repositories) {
    $source = Join-Path $baselineRoot $repository
    $destination = Join-Path $destinationRoot $repository
    [void][System.IO.Directory]::CreateDirectory($destination)

    $head = (Get-Content -LiteralPath (Join-Path $source "head.txt") -Raw -Encoding UTF8).Trim()
    [void][System.IO.Directory]::CreateDirectory((Join-Path $destination "head"))

    # 先由归档重建 HEAD，再按当前文件字节重建工作快照。
    Expand-VerifiedZip `
        -ZipPath (Join-Path $source "head-tree.zip") `
        -Destination (Join-Path $destination "head")

    [void][System.IO.Directory]::CreateDirectory((Join-Path $destination "current"))
    Expand-VerifiedZip `
        -ZipPath (Join-Path $source "tracked-current.zip") `
        -Destination (Join-Path $destination "current")
    $untrackedArchive = Join-Path $source "untracked-sources.zip"
    Expand-VerifiedZip -ZipPath $untrackedArchive -Destination (Join-Path $destination "current")

    $currentManifest = Join-Path $source "tracked-current.sha256.json"
    $untrackedManifest = Join-Path $source "untracked-included.json"
    Verify-Manifest -Root (Join-Path $destination "current") -ManifestPath $currentManifest
    Verify-Manifest -Root (Join-Path $destination "current") -ManifestPath $untrackedManifest

    Write-Host "$repository 重建通过：HEAD=$head"
}

Write-Host "源码基线重建完成：$destinationRoot"
