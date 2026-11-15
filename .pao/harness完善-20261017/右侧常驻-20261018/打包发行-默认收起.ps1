# 用途：把「窄窗默认收起」这一版源码打成独立输出目录，避免覆盖正在运行的已装目录。
# 输入：D:\AI\workspace\pao-dev 当前工作区；输出：临时文件夹\窄窗加固-20261018\release-默认收起 与日志。
$ErrorActionPreference = 'Continue'
$root = 'D:\AI\workspace\pao-dev'
$out = 'D:\AI\workspace\临时文件夹\窄窗加固-20261018\release-默认收起'
$log = 'D:\AI\workspace\临时文件夹\窄窗加固-20261018\发行构建-默认收起.log'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Location (Join-Path $root 'desktop')
Push-Location apps\desktop
"=== build ===" | Out-File -FilePath $log -Encoding utf8
pnpm run build *>> $log
$buildExit = $LASTEXITCODE
"build exit=$buildExit" | Out-File -FilePath $log -Append -Encoding utf8
"=== vendor:kernel ===" | Out-File -FilePath $log -Append -Encoding utf8
pnpm run vendor:kernel *>> $log
$vendorExit = $LASTEXITCODE
"vendor exit=$vendorExit" | Out-File -FilePath $log -Append -Encoding utf8
"=== package ===" | Out-File -FilePath $log -Append -Encoding utf8
node scripts/package-windows.mjs --win --dir --publish never --config.npmRebuild=false --config.directories.output=$out *>> $log
$packageExit = $LASTEXITCODE
"package exit=$packageExit" | Out-File -FilePath $log -Append -Encoding utf8
Pop-Location
$files = (Get-ChildItem (Join-Path $out 'win-unpacked') -Recurse -File | Measure-Object).Count
$asar = Join-Path $out 'win-unpacked\resources\app.asar'
$sha = if (Test-Path $asar) { (Get-FileHash $asar -Algorithm SHA256).Hash } else { 'missing' }
Write-Output "build=$buildExit vendor=$vendorExit package=$packageExit files=$files asar=$sha"