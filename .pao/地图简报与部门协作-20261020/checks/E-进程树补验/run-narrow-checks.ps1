# 用途：冻结 E 进程树补验写集，运行受影响测试与生产类型检查，并核对运行前后源码哈希。
# 输入：当前 PAO 的 cards 源码与对应测试；输出：同目录原始日志、Vitest JSON、结果汇总和前后哈希。
$ErrorActionPreference = 'Stop'
$env:TMP = 'D:\AI\workspace\临时文件夹\地图简报验证-20261020\独立进程树反例-20261021'
$env:TEMP = $env:TMP
$env:TMPDIR = $env:TMP
New-Item -ItemType Directory -Force -Path $env:TMP | Out-Null
$evidence = $PSScriptRoot
$env:PAO_E_EVIDENCE_DIR = Join-Path $evidence 'product-evidence'
Set-Location 'D:\AI\workspace\pao-dev\PAO'

$sourcePaths = @('baseline', 'delivery', 'verifier', 'execution-context', 'integration', 'process') |
    ForEach-Object { "packages/coding-agent/src/pao/cards/$_.ts" }
$testPaths = @('integration', 'delivery-commit', 'delivery-wakeup', 'execution-context', 'card-process-stop') |
    ForEach-Object { "packages/coding-agent/test/pao/$_.test.ts" }
$allPaths = $sourcePaths + $testPaths
function Get-FrozenFiles {
    $hashRows = Get-FileHash -Algorithm SHA256 -LiteralPath $allPaths
    return @(foreach ($row in $hashRows) {
        $relativePath = [IO.Path]::GetRelativePath((Get-Location).Path, $row.Path).Replace('\', '/')
        [ordered]@{
            Path = $row.Path
            Hash = $row.Hash
            Kind = $(if ($sourcePaths -contains $relativePath) { 'source' } else { 'test' })
        }
    })
}

$beforeFiles = Get-FrozenFiles
[ordered]@{ FrozenAt = [DateTime]::UtcNow.ToString('o'); Files = $beforeFiles } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'source-before.json') -Encoding utf8

$results = @()
$files = @(
    'card-process-stop.test.ts',
    'integration.test.ts',
    'execution-context.test.ts'
)
foreach ($file in $files) {
    $name = $file.Replace('.test.ts', '')
    $jsonPath = Join-Path $evidence "result-$name.json"
    $logPath = Join-Path $evidence "result-$name.log"
    $started = [DateTime]::UtcNow.ToString('o')
    & node node_modules/vitest/vitest.mjs run --config packages/coding-agent/vitest.config.ts "packages/coding-agent/test/pao/$file" --maxWorkers=1 --no-file-parallelism --reporter=verbose --reporter=json "--outputFile=$jsonPath" *> $logPath
    $results += [pscustomobject]@{
        Name = $file
        ExitCode = $LASTEXITCODE
        StartedAt = $started
        FinishedAt = [DateTime]::UtcNow.ToString('o')
        JsonPath = $jsonPath
        LogPath = $logPath
    }
    $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'final-results.json') -Encoding utf8
    Write-Output "$file exit=$LASTEXITCODE"
}

$tscLog = Join-Path $evidence 'production-tsc.log'
& node node_modules/typescript/bin/tsc --noEmit -p packages/coding-agent/tsconfig.build.json *> $tscLog
$results += [pscustomobject]@{
    Name = 'production-tsc'
    ExitCode = $LASTEXITCODE
    FinishedAt = [DateTime]::UtcNow.ToString('o')
    LogPath = $tscLog
}
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'final-results.json') -Encoding utf8
Write-Output "production-tsc exit=$LASTEXITCODE"

$afterFiles = Get-FrozenFiles
[ordered]@{ FrozenAt = [DateTime]::UtcNow.ToString('o'); Files = $afterFiles } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'source-after.json') -Encoding utf8
$beforeMap = @{}
foreach ($row in $beforeFiles) { $beforeMap[$row.Path] = $row.Hash }
$changed = @($afterFiles | Where-Object { $beforeMap[$_.Path] -ne $_.Hash })
if ($changed.Count -gt 0) {
    $changed | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'changed-files.json') -Encoding utf8
    throw '验证期间冻结源码或测试内容发生变化'
}
if ($results.Where({ $_.ExitCode -ne 0 }).Count -gt 0) { exit 1 }
