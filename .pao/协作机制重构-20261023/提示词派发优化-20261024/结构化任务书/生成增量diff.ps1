$ErrorActionPreference = "Stop"

$reportRoot = "D:\AI\workspace\pao-dev\.pao\协作机制重构-20261023\提示词派发优化-20261024\结构化任务书"
$currentRoot = "D:\AI\workspace\pao-dev\PAO"
$baselineRoot = Join-Path $reportRoot "baseline\PAO"
$reviewRoot = Join-Path $reportRoot "baseline-review2\PAO"
$emptyFile = Join-Path $reportRoot "empty-baseline-file"
$diffFile = Join-Path $reportRoot "incremental.diff"

$items = @(
	@("packages\coding-agent\src\pao\worker\index.ts", $baselineRoot),
	@("packages\coding-agent\src\pao\intake\accept.ts", $baselineRoot),
	@("packages\coding-agent\src\pao\intake\types.ts", $baselineRoot),
	@("packages\coding-agent\src\pao\intake\index.ts", $baselineRoot),
	@("packages\coding-agent\src\pao\intake\ledger.ts", $reviewRoot),
	@("packages\coding-agent\src\pao\host\tools.ts", $baselineRoot),
	@("packages\coding-agent\src\pao\workflow\minister.ts", $baselineRoot),
	@("packages\coding-agent\test\pao\intake-tool.test.ts", $baselineRoot),
	@("packages\coding-agent\test\pao\host-tools.test.ts", $baselineRoot),
	@("packages\coding-agent\test\pao\intake-accept.test.ts", $reviewRoot),
	@("packages\coding-agent\test\pao\workflow-control.test.ts", $reviewRoot),
	@("packages\coding-agent\src\pao\intake\task-book.ts", $null)
)

try {
	Set-Content -LiteralPath $emptyFile -Value "" -NoNewline
	$patch = [System.Collections.Generic.List[string]]::new()
	foreach ($item in $items) {
		$relativePath = $item[0]
		$origin = $item[1]
		$oldPath = if ($origin) { Join-Path $origin $relativePath } else { $emptyFile }
		$newPath = Join-Path $currentRoot $relativePath
		$oldLabel = "a/" + ($relativePath -replace "\\", "/")
		$newLabel = "b/" + ($relativePath -replace "\\", "/")
		$lines = @(& git -c core.quotepath=false diff --no-index --no-ext-diff --no-color --unified=3 -- $oldPath $newPath)
		if ($lines.Count -eq 0) { continue }
		$patch.Add("diff --git $oldLabel $newLabel")
		$inHunk = $false
		foreach ($line in $lines) {
			if ($line.StartsWith("@@")) {
				$inHunk = $true
				$patch.Add($line)
				continue
			}
			if ($inHunk) { $patch.Add($line) }
		}
	}
	Set-Content -LiteralPath $diffFile -Value ($patch -join "`n") -Encoding utf8
	$global:LASTEXITCODE = 0
	Write-Output "diff_generated=ok"
	Select-String -LiteralPath $diffFile -Pattern "^diff --git " | ForEach-Object { $_.Line }
} finally {
	Remove-Item -LiteralPath $emptyFile -Force -ErrorAction SilentlyContinue
}
