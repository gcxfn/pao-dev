# 用途：复用已通过的 integration 17 项结果，运行剩余 4 个受影响测试、生产 tsc，并核对冻结源码与测试前后的 SHA-256。
# 输入：source-frozen.json 与当前 PAO 工作区；输出：同目录日志、Vitest JSON、最终汇总和 source-after-final.json。
$ErrorActionPreference = 'Stop'
$repoRoot = 'D:\AI\workspace\pao-dev'
$evidence = Join-Path $repoRoot '.pao\地图简报与部门协作-20261020\checks\E-进程树补验'
$env:TMP = 'D:\AI\workspace\临时文件夹\地图简报验证-20261020\独立进程树反例-20261021'
$env:TEMP = $env:TMP
$env:TMPDIR = $env:TMP
New-Item -ItemType Directory -Force -Path $env:TMP | Out-Null
Set-Location (Join-Path $repoRoot 'PAO')

$frozen = Get-Content -Raw -LiteralPath (Join-Path $evidence 'source-frozen.json') | ConvertFrom-Json
function Get-CurrentFiles {
	$rows = @()
	foreach ($entry in $frozen.Files) {
		$item = Get-Item -LiteralPath $entry.Path
		$rows += [ordered]@{
			Path = $entry.Path
			Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.Path).Hash
			Bytes = $item.Length
			Kind = $entry.Kind
		}
	}
	return $rows
}
function Assert-Frozen($rows, $phase) {
	$frozenByPath = @{}
	foreach ($entry in $frozen.Files) { $frozenByPath[$entry.Path] = $entry.Hash }
	$changed = @($rows | Where-Object { $frozenByPath[$_.Path] -ne $_.Hash })
	if ($changed.Count -gt 0) {
		[ordered]@{ Phase = $phase; Changed = $changed } | ConvertTo-Json -Depth 5 |
			Set-Content -LiteralPath (Join-Path $evidence "hash-mismatch-$phase.json") -Encoding utf8NoBOM
		throw "$phase 发现冻结文件哈希变化"
	}
}

$beforeFiles = Get-CurrentFiles
Assert-Frozen $beforeFiles 'before-remaining-tests'

$integrationJsonPath = Join-Path $evidence 'final-integration-configured.json'
$integration = Get-Content -Raw -LiteralPath $integrationJsonPath | ConvertFrom-Json
if (-not $integration.success -or $integration.numPassedTests -ne 17 -or $integration.numFailedTests -ne 0) {
	throw '已配置运行的 integration JSON 不是 success=true/17 pass/0 fail'
}

$results = @([ordered]@{
	Name = 'integration.test.ts'
	ExitCode = 0
	Reused = $true
	Success = $integration.success
	Total = $integration.numTotalTests
	Passed = $integration.numPassedTests
	Failed = $integration.numFailedTests
	Pending = $integration.numPendingTests
	LogPath = (Join-Path $evidence 'final-integration-configured.log')
	JsonPath = $integrationJsonPath
})

$tests = @(
	'packages/coding-agent/test/pao/delivery-commit.test.ts',
	'packages/coding-agent/test/pao/delivery-wakeup.test.ts',
	'packages/coding-agent/test/pao/execution-context.test.ts',
	'packages/coding-agent/test/pao/card-process-stop.test.ts'
)
foreach ($test in $tests) {
	$name = [IO.Path]::GetFileName($test)
	$stem = [IO.Path]::GetFileNameWithoutExtension($test)
	$logPath = Join-Path $evidence "final-stable-$stem.log"
	$jsonPath = Join-Path $evidence "final-stable-$stem.json"
	$started = [DateTime]::UtcNow.ToString('o')
	& node node_modules/vitest/vitest.mjs run --config packages/coding-agent/vitest.config.ts $test --maxWorkers=1 --no-file-parallelism --reporter=verbose --reporter=json "--outputFile=$jsonPath" *> $logPath
	$exitCode = $LASTEXITCODE
	$parsed = $null
	if (Test-Path -LiteralPath $jsonPath) {
		$parsed = Get-Content -Raw -LiteralPath $jsonPath | ConvertFrom-Json
	}
	$results += [ordered]@{
		Name = $name
		ExitCode = $exitCode
		Reused = $false
		Success = $(if ($parsed) { $parsed.success } else { $false })
		Total = $(if ($parsed) { $parsed.numTotalTests } else { $null })
		Passed = $(if ($parsed) { $parsed.numPassedTests } else { $null })
		Failed = $(if ($parsed) { $parsed.numFailedTests } else { $null })
		Pending = $(if ($parsed) { $parsed.numPendingTests } else { $null })
		StartedAt = $started
		FinishedAt = [DateTime]::UtcNow.ToString('o')
		LogPath = $logPath
		JsonPath = $jsonPath
		LogBytes = $(if (Test-Path -LiteralPath $logPath) { (Get-Item -LiteralPath $logPath).Length } else { $null })
		JsonBytes = $(if (Test-Path -LiteralPath $jsonPath) { (Get-Item -LiteralPath $jsonPath).Length } else { $null })
	}
	$results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidence 'final-remaining-progress.json') -Encoding utf8NoBOM
}

$tscLog = Join-Path $evidence 'final-stable-production-tsc.log'
$tscStarted = [DateTime]::UtcNow.ToString('o')
& node node_modules/typescript/bin/tsc --noEmit -p packages/coding-agent/tsconfig.build.json *> $tscLog
$tscExit = $LASTEXITCODE
$results += [ordered]@{
	Name = 'production-tsc'
	ExitCode = $tscExit
	Reused = $false
	StartedAt = $tscStarted
	FinishedAt = [DateTime]::UtcNow.ToString('o')
	LogPath = $tscLog
	LogBytes = (Get-Item -LiteralPath $tscLog).Length
}

$afterFiles = Get-CurrentFiles
Assert-Frozen $afterFiles 'after-remaining-tests'
$beforeByPath = @{}
foreach ($entry in $beforeFiles) { $beforeByPath[$entry.Path] = $entry.Hash }
$changedDuringRun = @($afterFiles | Where-Object { $beforeByPath[$_.Path] -ne $_.Hash })
$hashStable = $changedDuringRun.Count -eq 0
$allCommandsPassed = @($results | Where-Object { $_.Name -eq 'production-tsc' -or -not $_.Reused } | Where-Object { $_.ExitCode -ne 0 }).Count -eq 0
$overallSuccess = $hashStable -and $allCommandsPassed

[ordered]@{
	CheckedAt = [DateTime]::UtcNow.ToString('o')
	AllStable = $hashStable
	Files = $afterFiles
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'source-after-final.json') -Encoding utf8NoBOM

[ordered]@{
	CompletedAt = [DateTime]::UtcNow.ToString('o')
	OverallSuccess = $overallSuccess
	HashStable = $hashStable
	Results = $results
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidence 'final-slice-results.json') -Encoding utf8NoBOM

$results | ConvertTo-Json -Depth 6
if ($overallSuccess) { exit 0 } else { exit 1 }
