$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$env:PI_APP_TEST_RELEASE_DIR = "D:\AI\workspace\pao-dev\desktop\apps\desktop\release"
$env:PAO_PACKAGED_MEMORY_ARTIFACT_DIR = Join-Path $root "production-spec-runs\latest"
New-Item -ItemType Directory -Path $env:PAO_PACKAGED_MEMORY_ARTIFACT_DIR -Force | Out-Null
Set-Location "D:\AI\workspace\pao-dev\desktop"
pnpm exec playwright test `
  -c apps/desktop/playwright.config.ts `
  apps/desktop/tests/production/packaged-memory.spec.ts `
  --workers=1 `
  --reporter=line
