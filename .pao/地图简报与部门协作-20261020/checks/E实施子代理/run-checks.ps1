# 用途：运行 E 批真实定向回归与生产类型检查；输入：当前 PAO 源码；输出：同目录完整日志、JSON 和退出结果。
$ErrorActionPreference = 'Stop'
$env:TMP = 'D:/AI/workspace/临时文件夹/地图简报验证-20261020/E实施子代理'
$env:TEMP = $env:TMP
$env:TMPDIR = $env:TMP
$evidence = $PSScriptRoot
$env:PAO_E_EVIDENCE_DIR = "$evidence/product-evidence"
Set-Location 'D:/AI/workspace/pao-dev/PAO'
$sourcePaths = @('baseline', 'delivery', 'verifier', 'execution-context', 'integration', 'process') | ForEach-Object { "packages/coding-agent/src/pao/cards/$_.ts" }
$testPaths = @('integration', 'delivery-commit', 'delivery-wakeup', 'execution-context', 'card-process-stop') | ForEach-Object { "packages/coding-agent/test/pao/$_.test.ts" }
$beforeHashes = Get-FileHash -Algorithm SHA256 -LiteralPath ($sourcePaths + $testPaths)
$beforeHashes | Select-Object Path, Hash | ConvertTo-Json | Set-Content -Encoding utf8 "$evidence/source-before.json"
$files = @(
    'integration.test.ts',
    'delivery-commit.test.ts',
    'delivery-wakeup.test.ts',
    'execution-context.test.ts',
    'card-process-stop.test.ts'
)
$results = @()
foreach ($file in $files) {
    $name = $file.Replace('.test.ts', '')
    $started = [DateTime]::UtcNow.ToString('o')
    & node node_modules/vitest/vitest.mjs run --config packages/coding-agent/vitest.config.ts "packages/coding-agent/test/pao/$file" --maxWorkers=1 --no-file-parallelism --reporter=verbose --reporter=json "--outputFile=$evidence/final-$name.json" *> "$evidence/final-$name.log"
    $results += [pscustomobject]@{ name=$file; exitCode=$LASTEXITCODE; startedAt=$started; finishedAt=[DateTime]::UtcNow.ToString('o') }
    $results | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$evidence/final-results.json"
    Write-Output "$file exit=$LASTEXITCODE"
}
& node node_modules/typescript/bin/tsc --noEmit -p packages/coding-agent/tsconfig.build.json *> "$evidence/production-tsc.log"
$results += [pscustomobject]@{ name='production-tsc'; exitCode=$LASTEXITCODE; finishedAt=[DateTime]::UtcNow.ToString('o') }
$results | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$evidence/final-results.json"
Write-Output "production-tsc exit=$LASTEXITCODE"
$afterHashes = Get-FileHash -Algorithm SHA256 -LiteralPath ($sourcePaths + $testPaths)
$afterHashes | Select-Object Path, Hash | ConvertTo-Json | Set-Content -Encoding utf8 "$evidence/source-after.json"
if (Compare-Object $beforeHashes.Hash $afterHashes.Hash) { throw '验证期间 E 批源码或测试内容发生变化，结果不能代表同一代码版本' }
if ($results.Where({ $_.exitCode -ne 0 }).Count -gt 0) { exit 1 }
