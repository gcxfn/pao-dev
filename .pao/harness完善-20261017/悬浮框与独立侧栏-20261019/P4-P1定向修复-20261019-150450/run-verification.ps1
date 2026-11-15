$ErrorActionPreference = "Stop"

$evidence = "D:\AI\workspace\pao-dev\.pao\harness完善-20261017\悬浮框与独立侧栏-20261019\P4-P1定向修复-20261019-150450"
$desktop = "D:\AI\workspace\pao-dev\desktop"
$files = @(
  "apps/desktop/src/features/side-chat/side-chat-panel.tsx",
  "apps/desktop/src/features/workboard/department-execution-panel.tsx",
  "apps/desktop/tests/unit/side-chat-panel-model.spec.ts",
  "apps/desktop/src/styles/side-chat.css"
)

function Write-RunLog {
  param(
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [string] $Command,
    [AllowEmptyCollection()] [object[]] $Output = @(),
    [Parameter(Mandatory)] [int] $ExitCode
  )
  $path = Join-Path $evidence $Name
  @(
    "COMMAND: $Command"
    "EXIT_CODE: $ExitCode"
    "BEGIN_OUTPUT"
    $Output
    "END_OUTPUT"
  ) | Set-Content -LiteralPath $path
}

Set-Location $desktop
$formatOutput = @(& ./node_modules/.bin/prettier --check @files 2>&1)
$formatExit = $LASTEXITCODE
Write-RunLog "P4-format-final.log" "prettier --check <four files>" $formatOutput $formatExit

$eslintFiles = @($files[0..2])
$eslintOutput = @(& ./node_modules/.bin/eslint @eslintFiles 2>&1)
$eslintExit = $LASTEXITCODE
Write-RunLog "P4-eslint-final.log" "eslint <component and unit test files>" $eslintOutput $eslintExit

$tscOutput = @(& ./node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit --pretty false 2>&1)
$tscExit = $LASTEXITCODE
Write-RunLog "P4-renderer-typecheck-final.log" "tsc -p apps/desktop/tsconfig.json --noEmit" $tscOutput $tscExit

$testOutput = @(
  & ./node_modules/.bin/playwright test -c apps/desktop/playwright.config.ts `
    apps/desktop/tests/unit/side-chat-panel-model.spec.ts `
    apps/desktop/tests/unit/side-chat-ipc.spec.ts `
    apps/desktop/tests/unit/department-board.spec.ts `
    "--output=$(Join-Path $evidence 'playwright-results/final')" 2>&1
)
$testExit = $LASTEXITCODE
Write-RunLog "P4-unit-final.log" "playwright test <three unit specs>" $testOutput $testExit

[pscustomobject]@{
  FormatExit = $formatExit
  EslintExit = $eslintExit
  RendererTypecheckExit = $tscExit
  UnitExit = $testExit
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence "P4-final-exit-codes.json")

if (($formatExit -ne 0) -or ($eslintExit -ne 0) -or ($tscExit -ne 0) -or ($testExit -ne 0)) {
  exit 1
}
