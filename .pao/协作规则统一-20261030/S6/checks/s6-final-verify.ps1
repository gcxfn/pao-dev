# 用途：S6 阶段最终验证批（源码定稿后一次跑全）；输入=当前内核源码；输出=逐步日志与 summary.txt
# 运行：必须带 UTF-8 BOM（Windows PowerShell 5.1 无 BOM 会按 GBK 解码中文导致整行被吞）。
# 说明：S6 只动内核（desktop 不涉及），故不跑桌面步骤；build:offline 用于确认打包不受影响。
$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'HHmmss'
$logDir = "D:\AI\workspace\临时文件夹\协作规则统一-20261030\s6-final-20261031-$stamp"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$summary = Join-Path $logDir 'summary.txt'

$env:PAO_HOME = 'D:\AI\workspace\临时文件夹\协作规则统一-20261030\s6\pao-home'
$env:PI_OFFLINE = '1'
$env:PI_NO_LOCAL_LLM = '1'
New-Item -ItemType Directory -Force -Path $env:PAO_HOME | Out-Null

$paoRoot = 'D:\AI\workspace\pao-dev\PAO'
$kernel = Join-Path $paoRoot 'packages\coding-agent'

function Step([string]$name, [string]$workdir, [string]$command) {
	$log = Join-Path $logDir "$name.log"
	Push-Location $workdir
	try {
		cmd /c "$command" *> $log
		$code = $LASTEXITCODE
	} finally {
		Pop-Location
	}
	Add-Content -Path $summary -Value ("{0}`texit={1}`t{2}" -f $name, $code, $log) -Encoding UTF8
	Write-Host ("{0} exit={1}" -f $name, $code)
}

$biomeFiles = 'packages/coding-agent/src/pao/dispatch-brief/workspace.ts packages/coding-agent/test/pao/dispatch-brief-map-read.test.ts packages/coding-agent/test/pao/git-read-boundaries.test.ts'
$s6Matrix = 'test/pao/dispatch-brief-artifacts.test.ts test/pao/dispatch-brief-prepare.test.ts test/pao/dispatch-brief-map-read.test.ts test/pao/git-read-boundaries.test.ts test/pao/workflow-node-map-merge.test.ts test/pao/content-tree-metadata.test.ts test/pao/worker-dispatch-nongit-real.test.ts'

Step 'tsc-noEmit' $paoRoot 'node node_modules\typescript\bin\tsc --noEmit'
Step 'check-types-integration' $paoRoot 'npm run check:types:integration'
Step 'check-ts-imports' $paoRoot 'npm run check:ts-imports'
Step 'check-pao-kernel' $paoRoot 'npm run check:pao:kernel'
Step 'gate-boundary' $kernel 'node scripts/gate-boundary.mjs'
Step 'check-gates' $kernel 'npm run check:gates'
Step 'biome-s6-files' $paoRoot ("node node_modules\@biomejs\biome\bin\biome check " + $biomeFiles)
Step 'vitest-s6-matrix' $kernel ("node ../../node_modules/vitest/vitest.mjs run " + $s6Matrix + ' --maxWorkers=2')
Step 'build-offline' $paoRoot 'npm run build:offline'

Write-Host 'DONE'
