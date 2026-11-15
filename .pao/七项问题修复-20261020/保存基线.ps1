# 用途：在本轮子代理修改前保存既有工作树；输入 PAO 源码和 Git 差异，输出本目录 baseline。
$ErrorActionPreference = 'Stop'
$repoRoot = 'D:\AI\workspace\pao-dev\PAO'
$baselineRoot = Join-Path $PSScriptRoot 'baseline'
if (Test-Path -LiteralPath $baselineRoot) { throw "基线目录已存在，拒绝覆盖：$baselineRoot" }
New-Item -ItemType Directory -Path $baselineRoot | Out-Null
git -C $repoRoot diff --binary --output (Join-Path $baselineRoot '开工差异.patch')
if ($LASTEXITCODE -ne 0) { throw '保存 Git 差异失败' }
git -C $repoRoot status --short | Set-Content -LiteralPath (Join-Path $baselineRoot '开工状态.txt') -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw '读取 Git 状态失败' }
foreach ($area in @('worker','usage','fanout','knowledge','memory','desktop','workflow')) {
    $source = Join-Path $repoRoot "packages\coding-agent\src\pao\$area"
    $target = Join-Path $baselineRoot "src\pao\$area"
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'packages\coding-agent\test\pao') -Destination (Join-Path $baselineRoot 'test-pao') -Recurse
Copy-Item -LiteralPath (Join-Path $repoRoot 'packages\coding-agent\src\pao\已知边界.md') -Destination $baselineRoot
Write-Output '本轮开工基线已保存。'
