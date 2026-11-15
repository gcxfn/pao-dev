param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot "baseline")
)

# 用途：在不修改源仓 index、不提交、不 stash、不 reset 的前提下，固定三仓
#       HEAD、当前已跟踪源码、未跟踪源码与文档以及对应状态清单。
# 输入：D:\AI\workspace\pao-dev、PAO、desktop 三个 Git 仓的当前工作区。
# 输出：OutputRoot 下的 HEAD 快照、当前内容快照、差异补丁、清单、摘要与重建核对。
# 边界：不复制 node_modules、dist、.git、旧 .pao、archive、临时目录、缓存、日志与凭证。

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:GitExe = (Get-Command git.exe -ErrorAction Stop).Source

$repos = @(
    [pscustomobject]@{
        Key = "pao-dev"
        Root = "D:\AI\workspace\pao-dev"
        Project = $null
    },
    [pscustomobject]@{
        Key = "PAO"
        Root = "D:\AI\workspace\pao-dev\PAO"
        Project = "D-AI-workspace-pao-dev-PAO"
    },
    [pscustomobject]@{
        Key = "desktop"
        Root = "D:\AI\workspace\pao-dev\desktop"
        Project = "D-AI-workspace-pao-dev-desktop"
    }
)

$excludedDirectoryNames = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
)
@(
    ".git",
    ".cache",
    ".pao",
    "_out_stale_20261017",
    "archive",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "release",
    "releases",
    "test-results",
    "临时文件夹",
    ".dsh-acl-recovery"
) | ForEach-Object { [void]$excludedDirectoryNames.Add($_) }

$excludedFilePatterns = @(
    "*.log",
    "*.tmp",
    "*.temp",
    "*.bak",
    "*.bak-*",
    "*.dmp",
    "*.pid",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "credentials*",
    "secrets*"
)

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$WorkingDirectory = $null,
        [int[]]$AcceptedExitCodes = @(0)
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FileName
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $utf8NoBom
    $startInfo.StandardErrorEncoding = $utf8NoBom
    if ($WorkingDirectory) {
        $startInfo.WorkingDirectory = $WorkingDirectory
    }
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    if ($AcceptedExitCodes -notcontains $exitCode) {
        throw "命令失败（退出码 $($process.ExitCode)）：$FileName $($Arguments -join ' ')`n$stderr"
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Stdout = $stdout
        Stderr = $stderr
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int[]]$AcceptedExitCodes = @(0)
    )

    return Invoke-CapturedProcess `
        -FileName $script:GitExe `
        -Arguments (@("-C", $Root) + $Arguments) `
        -AcceptedExitCodes $AcceptedExitCodes
}

function Get-NulSeparatedItems {
    param([AllowEmptyString()][string]$Text)

    if ([string]::IsNullOrEmpty($Text)) {
        return @()
    }
    return @($Text.Split([char]0, [System.StringSplitOptions]::RemoveEmptyEntries))
}

function Get-ExclusionReason {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $normalized = $RelativePath.Replace("\", "/")
    $segments = @($normalized.Split("/"))
    foreach ($segment in $segments) {
        if ($excludedDirectoryNames.Contains($segment)) {
            return "排除目录：$segment"
        }
    }

    $leaf = $segments[-1]
    foreach ($pattern in $excludedFilePatterns) {
        if ($leaf -like $pattern) {
            return "排除文件：$pattern"
        }
    }
    return $null
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Utf8Text {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Text
    )
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Write-Utf8BomText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Text
    )
    $utf8Bom = [System.Text.UTF8Encoding]::new($true)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8Bom)
}

function Convert-ScriptToUtf8Bom {
    param([Parameter(Mandatory = $true)][string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        return
    }
    $text = $utf8NoBom.GetString($bytes)
    Write-Utf8BomText -Path $Path -Text $text
}

function Write-TarList {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyCollection()][string[]]$Items
    )
    $utf8Bom = [System.Text.UTF8Encoding]::new($true)
    [System.IO.File]::WriteAllText($Path, (($Items -join "`n") + "`n"), $utf8Bom)
}

function New-FileListZip {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string[]]$RelativePaths,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = [System.IO.File]::Open(
        $OutputPath,
        [System.IO.FileMode]::Create,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        $archive = [System.IO.Compression.ZipArchive]::new(
            $stream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false,
            $utf8NoBom
        )
        try {
            foreach ($relativePath in $RelativePaths) {
                $fullPath = Join-Path $Root ($relativePath.Replace("/", "\"))
                $entryName = $relativePath.Replace("\", "/")
                [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive,
                    $fullPath,
                    $entryName,
                    [System.IO.Compression.CompressionLevel]::Optimal
                )
            }
        }
        finally {
            $archive.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Expand-ZipToDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory(
        $ArchivePath,
        $DestinationPath,
        $utf8NoBom
    )
}

function Get-WorktreeHashes {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ListPath
    )

    $rows = [System.Collections.Generic.List[object]]::new()
    $relativePaths = Get-NulSeparatedItems (Invoke-Git -Root $Root -Arguments @(
        "ls-files", "-z", "--cached"
    )).Stdout
    foreach ($relativePath in $relativePaths) {
        $fullPath = Join-Path $Root ($relativePath.Replace("/", "\"))
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            $rows.Add([pscustomobject]@{
                path = $relativePath
                sha256 = Get-Sha256 -Path $fullPath
            })
        }
        else {
            $rows.Add([pscustomobject]@{
                path = $relativePath
                sha256 = "<missing>"
            })
        }
    }
    Write-Utf8Text -Path $ListPath -Text (($rows | ConvertTo-Json -Depth 4) + "`n")
}

function Compare-HashManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedPath,
        [Parameter(Mandatory = $true)][string]$ActualPath
    )

    $expected = @(Get-Content -LiteralPath $ExpectedPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    $actual = @(Get-Content -LiteralPath $ActualPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    $actualMap = @{}
    foreach ($row in $actual) {
        $actualMap[$row.path] = $row.sha256
    }

    $differences = [System.Collections.Generic.List[object]]::new()
    foreach ($row in $expected) {
        if (-not $actualMap.ContainsKey($row.path)) {
            $differences.Add([pscustomobject]@{
                path = $row.path
                expected = $row.sha256
                actual = "<missing>"
            })
        }
        elseif ($actualMap[$row.path] -ne $row.sha256) {
            $differences.Add([pscustomobject]@{
                path = $row.path
                expected = $row.sha256
                actual = $actualMap[$row.path]
            })
        }
    }
    if ($differences.Count -gt 0) {
        throw "重建后的已跟踪文件与当前工作区不一致：`n$($differences | ConvertTo-Json -Depth 4)"
    }
}

function Assert-WithinDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidateFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "路径越界，拒绝文件操作：$candidateFull（期望位于 $parentFull 内）"
    }
    return $candidateFull
}

function Assert-ScriptUtf8Bom {
    param([Parameter(Mandatory = $true)][string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
        throw "脚本不是 UTF-8 BOM 编码：$Path"
    }
}

function Get-ComparableStatus {
    param(
        [AllowEmptyString()][string]$StatusText,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ExcludedFullPath
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    $excludedRelative = [System.IO.Path]::GetRelativePath(
        $rootFull,
        [System.IO.Path]::GetFullPath($ExcludedFullPath)
    ).Replace("\", "/").TrimEnd("/")
    $excludedPrefix = "$excludedRelative/"

    $kept = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($StatusText -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        $candidatePaths = @()
        if ($line.Length -gt 3) {
            $candidatePaths += $line.Substring(3)
        }
        if ($line -match '^.. (.+) -> (.+)$') {
            $candidatePaths += $Matches[1]
            $candidatePaths += $Matches[2]
        }
        $belongsToBatch = $false
        foreach ($candidatePath in $candidatePaths) {
            $normalized = $candidatePath.Trim('"').Replace("\", "/")
            if (
                $normalized -eq $excludedRelative -or
                $normalized.StartsWith($excludedPrefix, [System.StringComparison]::OrdinalIgnoreCase)
            ) {
                $belongsToBatch = $true
                break
            }
        }
        if (-not $belongsToBatch) {
            $kept.Add($line)
        }
    }
    return $kept
}

if (Test-Path -LiteralPath $OutputRoot) {
    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputRoot)
    $resolvedTargetRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "baseline"))
    if ($resolvedOutput -ne $resolvedTargetRoot) {
        throw "为避免覆盖非本批基线，拒绝清理：$resolvedOutput"
    }
    Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
}
[void][System.IO.Directory]::CreateDirectory($OutputRoot)

$summaryRows = [System.Collections.Generic.List[object]]::new()

foreach ($repo in $repos) {
    Write-Host "固定 $($repo.Key) ..."
    $repoOutput = Join-Path $OutputRoot $repo.Key
    [void][System.IO.Directory]::CreateDirectory($repoOutput)

    $head = (Invoke-Git -Root $repo.Root -Arguments @("rev-parse", "HEAD")).Stdout.Trim()
    $branch = (Invoke-Git -Root $repo.Root -Arguments @("branch", "--show-current")).Stdout.Trim()
    $topLevel = (Invoke-Git -Root $repo.Root -Arguments @("rev-parse", "--show-toplevel")).Stdout.Trim()
    Write-Utf8Text -Path (Join-Path $repoOutput "head.txt") -Text ("$head`n")

    $beforeStatusText = (Invoke-Git -Root $repo.Root -Arguments @(
        "-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all"
    )).Stdout
    Write-Utf8Text -Path (Join-Path $repoOutput "status-before.txt") -Text $beforeStatusText

    $trackedPatchPath = Join-Path $repoOutput "tracked-changes.patch"
    $trackedPatch = (Invoke-Git -Root $repo.Root -Arguments @(
        "diff", "HEAD", "--binary", "--no-ext-diff",
        "--src-prefix=a/", "--dst-prefix=b/"
    )).Stdout
    Write-Utf8Text -Path $trackedPatchPath -Text $trackedPatch

    $headTreeLines = Get-NulSeparatedItems (Invoke-Git -Root $repo.Root -Arguments @(
        "ls-tree", "-r", "-z", "--full-tree", "HEAD"
    )).Stdout
    $treeRows = [System.Collections.Generic.List[object]]::new()
    foreach ($line in $headTreeLines) {
        $tab = $line.IndexOf("`t")
        $treeRows.Add([pscustomobject]@{
            metadata = $line.Substring(0, $tab)
            path = $line.Substring($tab + 1)
        })
    }
    Write-Utf8Text -Path (Join-Path $repoOutput "tracked-tree-at-head.json") -Text (
        (($treeRows | ConvertTo-Json -Depth 4) + "`n")
    )

    $untrackedPaths = Get-NulSeparatedItems (Invoke-Git -Root $repo.Root -Arguments @(
        "ls-files", "-z", "--others", "--exclude-standard"
    )).Stdout
    $includedUntracked = [System.Collections.Generic.List[string]]::new()
    $includedRows = [System.Collections.Generic.List[object]]::new()
    $excludedRows = [System.Collections.Generic.List[object]]::new()
    foreach ($relativePath in $untrackedPaths) {
        $fullPath = Join-Path $repo.Root ($relativePath.Replace("/", "\"))
        $length = if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            [int64](Get-Item -LiteralPath $fullPath -Force).Length
        }
        else {
            [int64]-1
        }
        $reason = Get-ExclusionReason -RelativePath $relativePath
        if ($reason) {
            $excludedRows.Add([pscustomobject]@{
                path = $relativePath
                bytes = $length
                reason = $reason
            })
            continue
        }
        if ($length -lt 0) {
            throw "未跟踪路径不是普通文件，无法固定：$fullPath"
        }
        $includedUntracked.Add($relativePath)
        $includedRows.Add([pscustomobject]@{
            path = $relativePath
            bytes = $length
            sha256 = Get-Sha256 -Path $fullPath
        })
    }

    $excludedCategorySummary = @(
        $excludedRows |
            Group-Object -Property { ($_.reason -split "：", 2)[1] } |
            Sort-Object -Property Name |
            ForEach-Object {
                [pscustomobject]@{
                    category = $_.Name
                    entries = $_.Count
                    known_bytes = (($_.Group | Measure-Object -Property bytes -Sum).Sum)
                    reason = ($_.Group | Select-Object -First 1).reason
                }
            }
    )
    Write-Utf8Text -Path (Join-Path $repoOutput "untracked-excluded-summary.json") -Text (
        (($excludedCategorySummary | ConvertTo-Json -Depth 4) + "`n")
    )

    Write-Utf8Text -Path (Join-Path $repoOutput "untracked-included.json") -Text (
        (($includedRows | ConvertTo-Json -Depth 4) + "`n")
    )
    Write-Utf8Text -Path (Join-Path $repoOutput "untracked-excluded.json") -Text (
        (($excludedRows | ConvertTo-Json -Depth 4) + "`n")
    )

    $untrackedArchive = Join-Path $repoOutput "untracked-sources.zip"
    if ($includedUntracked.Count -gt 0) {
        New-FileListZip `
            -Root $repo.Root `
            -RelativePaths @($includedUntracked) `
            -OutputPath $untrackedArchive
    }
    else {
        $stream = [System.IO.File]::Open(
            $untrackedArchive,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        try {
            $archive = [System.IO.Compression.ZipArchive]::new(
                $stream,
                [System.IO.Compression.ZipArchiveMode]::Create,
                $false,
                $utf8NoBom
            )
            $archive.Dispose()
        }
        finally {
            $stream.Dispose()
        }
    }

    $headArchive = Join-Path $repoOutput "head-tree.zip"
    [void](Invoke-CapturedProcess -FileName $script:GitExe -Arguments @(
        "-C", $repo.Root, "archive", "--format=zip", "-o", $headArchive, $head
    ))

    $trackedPaths = Get-NulSeparatedItems (Invoke-Git -Root $repo.Root -Arguments @(
        "ls-files", "-z", "--cached"
    )).Stdout
    $currentTrackedRows = [System.Collections.Generic.List[object]]::new()
    $currentTrackedFiles = [System.Collections.Generic.List[string]]::new()
    $deletedTrackedRows = [System.Collections.Generic.List[object]]::new()
    foreach ($relativePath in $trackedPaths) {
        $fullPath = Join-Path $repo.Root ($relativePath.Replace("/", "\"))
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            $currentTrackedFiles.Add($relativePath)
            $currentTrackedRows.Add([pscustomobject]@{
                path = $relativePath
                bytes = [int64](Get-Item -LiteralPath $fullPath -Force).Length
                sha256 = Get-Sha256 -Path $fullPath
            })
        }
        else {
            $deletedTrackedRows.Add([pscustomobject]@{
                path = $relativePath
                state = "missing-or-deleted"
            })
        }
    }
    $currentManifestPath = Join-Path $repoOutput "tracked-current.sha256.json"
    Write-Utf8Text -Path $currentManifestPath -Text (
        (($currentTrackedRows | ConvertTo-Json -Depth 4) + "`n")
    )
    Write-Utf8Text -Path (Join-Path $repoOutput "tracked-deleted.json") -Text (
        (($deletedTrackedRows | ConvertTo-Json -Depth 4) + "`n")
    )
    if ($currentTrackedFiles.Count -eq 0) {
        throw "$($repo.Key) 没有当前已跟踪文件，无法生成源码基线。"
    }
    $trackedCurrentArchive = Join-Path $repoOutput "tracked-current.zip"
    New-FileListZip `
        -Root $repo.Root `
        -RelativePaths @($currentTrackedFiles) `
        -OutputPath $trackedCurrentArchive

    $reconstructDir = Join-Path $repoOutput ".reconstruct-check"
    [void][System.IO.Directory]::CreateDirectory($reconstructDir)
    Expand-ZipToDirectory -ArchivePath $trackedCurrentArchive -DestinationPath $reconstructDir
    if ($includedUntracked.Count -gt 0) {
        Expand-ZipToDirectory -ArchivePath $untrackedArchive -DestinationPath $reconstructDir
    }

    $reconstructGitDir = Join-Path $reconstructDir ".git"
    [void][System.IO.Directory]::CreateDirectory($reconstructGitDir)
    $currentManifest = Get-Content -LiteralPath $currentManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $reconstructedRows = foreach ($row in $currentManifest) {
        $candidate = Join-Path $reconstructDir ($row.path.Replace("/", "\"))
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            [pscustomobject]@{
                path = $row.path
                sha256 = Get-Sha256 -Path $candidate
            }
        }
        else {
            [pscustomobject]@{
                path = $row.path
                sha256 = "<missing>"
            }
        }
    }
    Write-Utf8Text -Path (Join-Path $repoOutput "tracked-reconstructed.sha256.json") -Text (
        (($reconstructedRows | ConvertTo-Json -Depth 4) + "`n")
    )
    Compare-HashManifest `
        -ExpectedPath (Join-Path $repoOutput "tracked-current.sha256.json") `
        -ActualPath (Join-Path $repoOutput "tracked-reconstructed.sha256.json")

    $untrackedDifferences = [System.Collections.Generic.List[object]]::new()
    foreach ($row in $includedRows) {
        $candidate = Join-Path $reconstructDir ($row.path.Replace("/", "\"))
        $actualHash = if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            Get-Sha256 -Path $candidate
        }
        else {
            "<missing>"
        }
        if ($actualHash -ne $row.sha256) {
            $untrackedDifferences.Add([pscustomobject]@{
                path = $row.path
                expected = $row.sha256
                actual = $actualHash
            })
        }
    }
    if ($untrackedDifferences.Count -gt 0) {
        throw "重建后的未跟踪源码与当前工作区不一致：`n$($untrackedDifferences | ConvertTo-Json -Depth 4)"
    }
    Write-Utf8Text -Path (Join-Path $repoOutput "reconstruction-check.json") -Text (
        ([pscustomobject]@{
            status = "pass"
            tracked_files = @($currentManifest).Count
            untracked_files = $includedRows.Count
            tracked_deleted_files = $deletedTrackedRows.Count
            method = "按 git ls-files 枚举当前真实文件字节导出 tracked-current.zip，再覆盖 untracked-sources.zip 并逐文件核对 SHA-256"
        } | ConvertTo-Json -Depth 4) + "`n"
    )

    $afterStatusText = (Invoke-Git -Root $repo.Root -Arguments @(
        "-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all"
    )).Stdout
    Write-Utf8Text -Path (Join-Path $repoOutput "status-after.txt") -Text $afterStatusText
    $sourceChangedDuringCapture = $false
    $beforeComparable = Get-ComparableStatus `
        -StatusText $beforeStatusText `
        -Root $repo.Root `
        -ExcludedFullPath $OutputRoot
    $afterComparable = Get-ComparableStatus `
        -StatusText $afterStatusText `
        -Root $repo.Root `
        -ExcludedFullPath $OutputRoot
    $statusDifferences = Compare-Object `
        -ReferenceObject @($beforeComparable) `
        -DifferenceObject @($afterComparable) `
        -SyncWindow 0
    if ($statusDifferences.Count -gt 0) {
        Write-Utf8Text -Path (Join-Path $repoOutput "status-differences.json") -Text (
            (($statusDifferences | ConvertTo-Json -Depth 4) + "`n")
        )
        throw "$($repo.Key) 的状态在固定过程中发生变化，需要重新核实。"
    }
    Get-WorktreeHashes -Root $repo.Root -ListPath (Join-Path $repoOutput "tracked-after-capture.sha256.json")
    $beforeHashPath = Join-Path $repoOutput "tracked-current.sha256.json"
    $afterHashPath = Join-Path $repoOutput "tracked-after-capture.sha256.json"
    $beforeHashes = @(Get-Content -LiteralPath $beforeHashPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    $afterHashes = @(Get-Content -LiteralPath $afterHashPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    $afterHashMap = @{}
    foreach ($row in $afterHashes) {
        $afterHashMap[$row.path] = $row.sha256
    }
    $hashDifferences = [System.Collections.Generic.List[object]]::new()
    foreach ($row in $beforeHashes) {
        $actual = if ($afterHashMap.ContainsKey($row.path)) {
            $afterHashMap[$row.path]
        }
        else {
            "<missing>"
        }
        if ($actual -ne $row.sha256) {
            $hashDifferences.Add([pscustomobject]@{
                path = $row.path
                before = $row.sha256
                after = $actual
            })
        }
    }
    if ($hashDifferences.Count -gt 0) {
        Write-Utf8Text -Path (Join-Path $repoOutput "tracked-hash-differences.json") -Text (
            (($hashDifferences | ConvertTo-Json -Depth 4) + "`n")
        )
        $sourceChangedDuringCapture = $true
        throw "$($repo.Key) 的已跟踪源码在基线捕获期间发生变化，需要重新核实。"
    }

    $files = @(
        $headArchive,
        $trackedPatchPath,
        $trackedCurrentArchive,
        (Join-Path $repoOutput "untracked-sources.zip")
    )
    foreach ($file in $files) {
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $hashPath = "$file.sha256"
            Write-Utf8Text -Path $hashPath -Text ("$(Get-Sha256 -Path $file)  $([System.IO.Path]::GetFileName($file))`n")
        }
    }

    $summaryRows.Add([pscustomobject]@{
        repo = $repo.Key
        root = $topLevel
        branch = $branch
        head = $head
        status_entries = @($beforeStatusText -split "`r?`n" | Where-Object { $_ }).Count
        tracked_patch_bytes = (Get-Item -LiteralPath $trackedPatchPath).Length
        tracked_files_current = @($currentManifest).Count
        tracked_deleted = $deletedTrackedRows.Count
        untracked_included = $includedRows.Count
        untracked_included_bytes = (($includedRows | Measure-Object bytes -Sum).Sum)
        untracked_excluded = $excludedRows.Count
        reconstruction = "pass"
        source_changed_during_capture = $sourceChangedDuringCapture
    })
    $safeReconstructDir = Assert-WithinDirectory -Candidate $reconstructDir -Parent $OutputRoot
    $safeRepoOutput = [System.IO.Path]::GetFullPath($repoOutput).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $expectedReconstructDir = Join-Path $safeRepoOutput ".reconstruct-check"
    if (
        $safeReconstructDir -ne $expectedReconstructDir -or
        [System.IO.Path]::GetFileName($safeReconstructDir) -ne ".reconstruct-check"
    ) {
        throw "重建核对目录身份不符，拒绝删除：$safeReconstructDir"
    }
    Remove-Item -LiteralPath $safeReconstructDir -Recurse -Force
}

$summaryJsonPath = Join-Path $OutputRoot "summary.json"
Write-Utf8Text -Path $summaryJsonPath -Text (($summaryRows | ConvertTo-Json -Depth 5) + "`n")

$summaryLines = [System.Collections.Generic.List[string]]::new()
$summaryLines.Add("# 三仓源码基线摘要")
$summaryLines.Add("")
$summaryLines.Add("生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$summaryLines.Add("")
$summaryLines.Add("| 仓库 | 分支 | HEAD | 状态项 | 已跟踪补丁字节 | 当前已跟踪文件 | 当前缺失已跟踪 | 未跟踪纳入 | 未跟踪纳入字节 | 重建核对 |")
$summaryLines.Add("|---|---|---|---:|---:|---:|---:|---:|---:|---|")
foreach ($row in $summaryRows) {
    $summaryLines.Add(
        "| $($row.repo) | $($row.branch) | $($row.head) | $($row.status_entries) | " +
        "$($row.tracked_patch_bytes) | $($row.tracked_files_current) | $($row.tracked_deleted) | " +
        "$($row.untracked_included) | $($row.untracked_included_bytes) | $($row.reconstruction) |"
    )
}
Write-Utf8Text -Path (Join-Path $OutputRoot "summary.md") -Text (($summaryLines -join "`n") + "`n")

$scriptPath = [System.IO.Path]::GetFullPath($PSCommandPath)
Convert-ScriptToUtf8Bom -Path $scriptPath
Assert-ScriptUtf8Bom -Path $scriptPath

Write-Host "基线完成：$OutputRoot"
