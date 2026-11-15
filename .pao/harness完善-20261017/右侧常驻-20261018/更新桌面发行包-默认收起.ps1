# 用途：按用户授权把「窄窗默认收起」这一版发行包替换到桌面固定发行目录。
# 输入：临时文件夹\窄窗加固-20261018\release-默认收起\win-unpacked；输出：固定发行目录及核验 JSON。
$ErrorActionPreference = 'Stop'
$newPackage = 'D:\AI\workspace\临时文件夹\窄窗加固-20261018\release-默认收起\win-unpacked'
$releaseRoot = [IO.Path]::GetFullPath('D:\AI\workspace\pao-dev\desktop\apps\desktop\release')
$installedPackage = [IO.Path]::GetFullPath((Join-Path $releaseRoot 'win-unpacked'))
$stagedPackage = [IO.Path]::GetFullPath((Join-Path $releaseRoot '默认收起-20261019-staging'))
$installedExe = Join-Path $installedPackage 'PAO.exe'
$expectedArchiveHash = 'F119701119F96FE184104D5ACEB230C4D95DEC04A928A143E01E55219111DA8B'
if ((Get-FileHash -LiteralPath (Join-Path $newPackage 'resources\app.asar') -Algorithm SHA256).Hash -ne $expectedArchiveHash) { throw '新包身份与已验证发行物不一致' }
if (Test-Path -LiteralPath $stagedPackage) { throw '准备目录已存在，不能覆盖未知文件' }
Copy-Item -LiteralPath $newPackage -Destination $stagedPackage -Recurse
$sourceFiles = @(Get-ChildItem -LiteralPath $newPackage -File -Recurse)
$copiedFiles = @(Get-ChildItem -LiteralPath $stagedPackage -File -Recurse)
if ($sourceFiles.Count -ne $copiedFiles.Count) { throw '复制后的文件数量不一致' }
foreach ($sourceFile in $sourceFiles) {
  $relativeName = $sourceFile.FullName.Substring($newPackage.Length).TrimStart('\')
  $copiedFile = Get-Item -LiteralPath (Join-Path $stagedPackage $relativeName)
  if ($copiedFile.Length -ne $sourceFile.Length) { throw "复制文件长度不一致：$relativeName" }
}
foreach ($criticalFile in @('PAO.exe', 'resources\app.asar')) {
  $originalHash = (Get-FileHash -LiteralPath (Join-Path $newPackage $criticalFile) -Algorithm SHA256).Hash
  $copyHash = (Get-FileHash -LiteralPath (Join-Path $stagedPackage $criticalFile) -Algorithm SHA256).Hash
  if ($originalHash -ne $copyHash) { throw "复制文件校验失败：$criticalFile" }
}
$oldProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'PAO.exe'" | Where-Object { $_.ExecutablePath -eq $installedExe })
foreach ($oldProcess in @($oldProcesses | Where-Object { $_.CommandLine -notmatch '--type=' })) {
  & "$env:SystemRoot\System32\taskkill.exe" /PID $oldProcess.ProcessId /T /F
  if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $oldProcess.ProcessId -ErrorAction SilentlyContinue)) { throw '旧版主进程终止失败' }
}
foreach ($remainingProcess in @(Get-CimInstance Win32_Process -Filter "Name = 'PAO.exe'" | Where-Object { $_.ExecutablePath -eq $installedExe })) {
  Stop-Process -Id $remainingProcess.ProcessId -Force
}
if (@(Get-CimInstance Win32_Process -Filter "Name = 'PAO.exe'" | Where-Object { $_.ExecutablePath -eq $installedExe }).Count -gt 0) { throw '旧版进程仍在运行' }
$resolvedInstalled = (Resolve-Path -LiteralPath $installedPackage).ProviderPath
if ($resolvedInstalled -ne (Join-Path $releaseRoot 'win-unpacked') -or [IO.Path]::GetDirectoryName($resolvedInstalled) -ne $releaseRoot) { throw '旧包删除路径不在预期发行目录' }
if ([IO.Path]::GetDirectoryName($stagedPackage) -ne $releaseRoot) { throw '准备目录移动范围异常' }
Remove-Item -LiteralPath $resolvedInstalled -Recurse -Force
Move-Item -LiteralPath $stagedPackage -Destination $installedPackage
$installedHash = (Get-FileHash -LiteralPath (Join-Path $installedPackage 'resources\app.asar') -Algorithm SHA256).Hash
if ($installedHash -ne $expectedArchiveHash) { throw '替换后发行物身份不符' }
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PAO.lnk'
$shortcutShell = New-Object -ComObject WScript.Shell
$desktopShortcut = $shortcutShell.CreateShortcut($shortcutPath)
if ($desktopShortcut.TargetPath -ne $installedExe) { throw '桌面快捷方式未指向已更新目录' }
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$startedProcess = Start-Process -FilePath $installedExe -WorkingDirectory $installedPackage -WindowStyle Hidden -PassThru
[pscustomobject]@{ Installed=$installedPackage; Shortcut=$shortcutPath; Files=$sourceFiles.Count; ArchiveSha256=$installedHash; OldProcessesStopped=@($oldProcesses | ForEach-Object { $_.ProcessId }); StartedProcessId=$startedProcess.Id } | ConvertTo-Json -Depth 3