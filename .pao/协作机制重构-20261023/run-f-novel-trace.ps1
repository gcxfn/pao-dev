$ErrorActionPreference = 'Stop'
$trace = 'D:\AI\workspace\pao-dev\.pao\协作机制重构-20261023\f-novel-trace2'
Remove-Item -LiteralPath "$trace\runtime-event.log", "$trace\runtime-perf.log" -Force -ErrorAction SilentlyContinue
$env:PAO_FNOVEL_TRACE = '1'
Push-Location 'D:\AI\workspace\pao-dev\PAO'
try {
    & 'C:\Users\ASUS\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
        '.\node_modules\vitest\vitest.mjs' run `
        'packages/coding-agent/test/pao/f-novel-loop.test.ts' `
        --reporter=verbose -t '第 1、2、3 步'
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
"EXIT_CODE=$code"
if (Test-Path -LiteralPath "$trace\runtime-event.log") {
    "EVENT_SIZE=$((Get-Item -LiteralPath "$trace\runtime-event.log").Length)"
} else {
    'EVENT_MISSING'
}
exit $code
