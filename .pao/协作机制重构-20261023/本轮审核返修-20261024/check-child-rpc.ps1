# 用途：验证本轮编译源码的三角色装配；输入：开发 dist 与现有离线组织配方；输出：本目录独立现场与证据。无模型调用。
$ErrorActionPreference = 'Stop'
$nodeExe = 'C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$sourceDir = 'D:/AI/workspace/pao-dev/PAO'
$projectDir = 'D:/AI/workspace/pao-dev'
$hostDir = Join-Path $projectDir '.pao/协作机制重构-20261023/benchmark-sdk-host'
$fixtureSetup = Join-Path $projectDir '.pao/协作机制重构-20261023/stopchain-baseline-20261024/organized-post'
$probeRoot = Join-Path $PSScriptRoot ('rpc-check-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$paoRunHome = Join-Path $probeRoot 'isolated-home'
$probeAgentDir = Join-Path $probeRoot 'agent'
$evidenceDir = Join-Path $probeRoot 'evidence'
if (Test-Path -LiteralPath $probeRoot) { throw '验证目录已存在，拒绝覆盖' }
New-Item -ItemType Directory -Path $paoRunHome,$probeAgentDir,$evidenceDir | Out-Null
& $nodeExe (Join-Path $fixtureSetup 'setup.mjs') $sourceDir (Join-Path $fixtureSetup 'kit.json') $paoRunHome $probeAgentDir $evidenceDir *> (Join-Path $probeRoot 'setup.log')
if ($LASTEXITCODE -ne 0) { throw "隔离组织初始化失败，见 $probeRoot/setup.log" }
Copy-Item -LiteralPath (Join-Path $hostDir 'activate-tools.mjs') -Destination (Join-Path $probeAgentDir 'extensions/benchmark-organization.js')
$env:PAO_BENCH_SOURCE = $sourceDir
$env:PAO_HOME = $paoRunHome
$env:PI_CODING_AGENT_DIR = $probeAgentDir
$env:PAO_CODING_AGENT_DIR = $probeAgentDir
$env:PI_OFFLINE = '1'
$env:PI_SKIP_VERSION_CHECK = '1'
& $nodeExe (Join-Path $hostDir 'probe-child-rpc.mjs') $evidenceDir *> (Join-Path $probeRoot 'rpc.log')
$probeCode = $LASTEXITCODE
Write-Output "证据目录：$probeRoot"
if ($probeCode -ne 0) { throw "三角色RPC检查失败（$probeCode），见 rpc.log" }
Get-Content -LiteralPath (Join-Path $evidenceDir 'child-rpc-probe.json')
