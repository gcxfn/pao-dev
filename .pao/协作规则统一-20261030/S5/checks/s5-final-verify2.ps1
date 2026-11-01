# 用途：S5 阶段最终验证批（源码定稿后一次跑全）；输入=当前三仓源码；输出=逐步日志与 summary.txt
# 运行：本文件必须带 UTF-8 BOM（Windows PowerShell 5.1 无 BOM 会按 GBK 解码中文导致整行被吞）。
$ErrorActionPreference = 'Continue'
$logDir = 'D:\AI\workspace\临时文件夹\协作规则统一-20261030\s5-final4-20261031'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$summary = Join-Path $logDir 'summary.txt'
if (Test-Path $summary) { Remove-Item $summary -Force }

$env:PAO_HOME = 'D:\AI\workspace\临时文件夹\协作规则统一-20261030\pao-home-s5'
$env:PI_OFFLINE = '1'
$env:PI_NO_LOCAL_LLM = '1'
New-Item -ItemType Directory -Force -Path $env:PAO_HOME | Out-Null

$paoRoot = 'D:\AI\workspace\pao-dev\PAO'
$kernel = Join-Path $paoRoot 'packages\coding-agent'
$desktopDriver = 'D:\AI\workspace\pao-dev\desktop\packages\pi-sdk-driver'

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

$s5Matrix = 'test/pao/assembly-failure.test.ts test/pao/assembly-manifest.test.ts test/pao/assembly-validation.test.ts test/pao/assembly-real-loader.test.ts test/pao/loadout-role.test.ts test/pao/index-wiring.test.ts test/pao/runtime-wiring.test.ts test/pao/session-shutdown-fixture.test.ts test/pao/memory-resident.test.ts'

Step 'tsc-noEmit' $paoRoot 'node node_modules\typescript\bin\tsc --noEmit'
Step 'check-types-integration' $paoRoot 'npm run check:types:integration'
Step 'check-ts-imports' $paoRoot 'npm run check:ts-imports'
Step 'check-pao-kernel' $paoRoot 'npm run check:pao:kernel'
Step 'gate-boundary' $kernel 'node scripts/gate-boundary.mjs'
Step 'check-gates' $kernel 'npm run check:gates'
Step 'biome-s5-files' $paoRoot 'node node_modules\@biomejs\biome\bin\biome check packages/coding-agent/src/pao/index.ts packages/coding-agent/src/pao/role.ts packages/coding-agent/src/pao/preflight/assembly.ts packages/coding-agent/src/pao/routing/config.ts packages/coding-agent/src/pao/worker/index.ts packages/coding-agent/test/pao/assembly-failure.test.ts packages/coding-agent/test/pao/assembly-manifest.test.ts packages/coding-agent/test/pao/assembly-validation.test.ts packages/coding-agent/test/pao/assembly-real-loader.test.ts packages/coding-agent/test/pao/cli-assembly-failure-real.test.ts'
Step 'vitest-s5-matrix' $kernel "node ../../node_modules/vitest/vitest.mjs run $s5Matrix --maxWorkers=2"
Step 'vitest-minister-policy' $kernel 'node ../../node_modules/vitest/vitest.mjs run test/pao/workflow-minister-tool-policy.test.ts --maxWorkers=2'
Step 'vitest-wiring-smoke' $kernel 'node ../../node_modules/vitest/vitest.mjs run test/pao/wiring-smoke.test.ts --maxWorkers=2'
Step 'build-offline' $paoRoot 'npm run build:offline'
Step 'cli-assembly-failure-real' $kernel 'node ../../node_modules/vitest/vitest.mjs run test/pao/cli-assembly-failure-real.test.ts --maxWorkers=2'
Step 'desktop-driver-tsc' $desktopDriver 'pnpm exec tsc -p tsconfig.json'
Step 'desktop-assembly-guard' $desktopDriver 'node --test test/pao-assembly-guard.test.mts'

Write-Host 'DONE'
