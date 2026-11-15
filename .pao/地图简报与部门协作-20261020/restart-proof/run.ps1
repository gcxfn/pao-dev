$ErrorActionPreference = "Stop"

$proofRoot = "D:\AI\workspace\临时文件夹\地图简报验证-20261020\restart-proof"
$tmpRoot = Join-Path $proofRoot "TMP"
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
$env:TMP = $tmpRoot
$env:TEMP = $tmpRoot
$env:TMPDIR = $tmpRoot
$env:RESTART_PROOF_ROOT = $proofRoot
$env:RESTART_PROOF_STATE = Join-Path $proofRoot "state.json"

$firstLog = Join-Path $proofRoot "first-process.log"
$secondLog = Join-Path $proofRoot "second-process.log"

node --experimental-strip-types (Join-Path $proofRoot "create.mts") *> $firstLog
$firstExit = $LASTEXITCODE
Set-Content -LiteralPath (Join-Path $proofRoot "first-process.exit") -Value $firstExit
if ($firstExit -ne 0) {
    exit $firstExit
}

node --experimental-strip-types (Join-Path $proofRoot "read.mts") *> $secondLog
$secondExit = $LASTEXITCODE
Set-Content -LiteralPath (Join-Path $proofRoot "second-process.exit") -Value $secondExit
exit $secondExit
