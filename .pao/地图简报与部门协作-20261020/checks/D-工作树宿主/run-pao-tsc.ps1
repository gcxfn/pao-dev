$ErrorActionPreference = 'Stop'
$evidence = 'D:\AI\workspace\pao-dev\.pao\地图简报与部门协作-20261020\checks\D-工作树宿主'
$log = Join-Path $evidence '01-PAO-tsc-build-noemit.log'
Push-Location 'D:\AI\workspace\pao-dev\PAO\packages\coding-agent'
try {
  & 'D:\AI\workspace\pao-dev\PAO\node_modules\.bin\tsc.cmd' -p tsconfig.build.json --noEmit *> $log
  $code = $LASTEXITCODE
  Write-Output "exit=$code"
  Get-Content -LiteralPath $log -Tail 80
  exit $code
} finally { Pop-Location }
