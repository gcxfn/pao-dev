# 用途：在隔离夹具中编译并运行正式 NSIS include，验证升级和卸载都保留
# $INSTDIR\data。输入为桌面端正式 include 与本机 electron-builder 模板；
# 工作夹具放在临时文件夹，运行日志和结果按运行编号写入本目录，不覆盖旧证据。

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$taskRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $taskRoot "..\.."))
$desktopRoot = Join-Path $repoRoot "desktop"
$appRoot = Join-Path $desktopRoot "apps\desktop"
$productionInclude = Join-Path $appRoot "resources\installer.nsh"
$builderRoot = Join-Path $desktopRoot "node_modules\app-builder-lib\templates\nsis"
$upstreamUninstaller = Join-Path $builderRoot "uninstaller.nsh"
$stdUtils = Join-Path $builderRoot "include\StdUtils.nsh"
$makensis = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\nsis-3.0.4.1\nsis-3.0.4.1-1mx3n\Bin\makensis.exe"
$stdUtilsPlugin = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\nsis-resources-3.4.1\nsis-resources-3.4.1-2jx2y\plugins\x86-unicode\StdUtils.dll"
$workspaceRoot = Split-Path -Parent $repoRoot
$runId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$fixtureTaskRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot "临时文件夹\安装数据目录-20261020"))
$testRoot = [System.IO.Path]::GetFullPath((Join-Path $fixtureTaskRoot $runId))
$evidenceRoot = [System.IO.Path]::GetFullPath((Join-Path $taskRoot "nsis-isolated-test\runs\$runId"))

foreach ($requiredPath in @($productionInclude, $upstreamUninstaller, $stdUtils, $stdUtilsPlugin, $makensis)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "缺少必需文件：$requiredPath"
  }
}

$fixturePrefix = $fixtureTaskRoot.TrimEnd("\") + "\"
$evidencePrefix = $taskRoot.TrimEnd("\") + "\"
if (-not $testRoot.StartsWith($fixturePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "拒绝在任务临时目录外创建隔离夹具：$testRoot"
}
if (-not $evidenceRoot.StartsWith($evidencePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "拒绝在任务证据目录外写入结果：$evidenceRoot"
}

$workRoot = Join-Path $testRoot "work"
$fixtureRoot = Join-Path $workRoot "install-fixture"
$localTemp = Join-Path $workRoot "temp"
$uninstallerCopyRoot = Join-Path $workRoot "uninstaller-copy"
$logRoot = Join-Path $evidenceRoot "logs"
$artifactRoot = Join-Path $evidenceRoot "artifacts"
New-Item -ItemType Directory -Force -Path $workRoot, $fixtureRoot, $localTemp, $uninstallerCopyRoot, $logRoot, $artifactRoot | Out-Null

$upstreamText = [System.IO.File]::ReadAllText($upstreamUninstaller)
$functionMatch = [regex]::Match(
  $upstreamText,
  "(?s)Function un\.atomicRMDir.*?(?=!ifndef UNINSTALL_SECTION_NAME)"
)
if (-not $functionMatch.Success) {
  throw "无法从 $upstreamUninstaller 提取 atomicRMDir/restoreFiles"
}

$escapedFixture = $fixtureRoot.Replace('"', '""')
$escapedStdUtils = $stdUtils.Replace('"', '""')
$escapedStdUtilsPluginDir = (Split-Path -Parent $stdUtilsPlugin).Replace('"', '""')
$escapedProductionInclude = $productionInclude.Replace('"', '""')

$harness = @'
Unicode true
Name "PAO NSIS 数据保留隔离测试"
OutFile "__INSTALLER__"
InstallDir "__INSTALL_DIR__"
RequestExecutionLevel user

!include LogicLib.nsh
!addplugindir /x86-unicode "__STD_UTILS_PLUGIN_DIR__"
!include "__STD_UTILS__"

!define PRODUCT_FILENAME "PAO"
!define UNINSTALL_FILENAME "Uninstall PAO.exe"

!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`

!include "__PRODUCTION_INCLUDE__"

__UPSTREAM_FUNCTIONS__

Section "Install"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\${UNINSTALL_FILENAME}"
SectionEnd

Section "Uninstall"
  !insertmacro customRemoveFiles
SectionEnd
'@

$harness = $harness.Replace("__INSTALLER__", (Join-Path $workRoot "pao-nsis-data-test.exe").Replace('"', '""'))
$harness = $harness.Replace("__INSTALL_DIR__", $escapedFixture)
$harness = $harness.Replace("__STD_UTILS__", $escapedStdUtils)
$harness = $harness.Replace("__STD_UTILS_PLUGIN_DIR__", $escapedStdUtilsPluginDir)
$harness = $harness.Replace("__PRODUCTION_INCLUDE__", $escapedProductionInclude)
$harness = $harness.Replace("__UPSTREAM_FUNCTIONS__", $functionMatch.Value)

$harnessPath = Join-Path $workRoot "pao-nsis-data-test.nsi"
[System.IO.File]::WriteAllText($harnessPath, $harness, [System.Text.UTF8Encoding]::new($true))

$compileLog = Join-Path $logRoot "makensis.log"
$compileOutput = & $makensis /V4 $harnessPath 2>&1
$compileExitCode = $LASTEXITCODE
$compileOutput | Set-Content -LiteralPath $compileLog -Encoding utf8
if ($compileExitCode -ne 0) {
  throw "makensis 编译失败，退出码 $compileExitCode，日志：$compileLog"
}

$installerPath = Join-Path $workRoot "pao-nsis-data-test.exe"
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "未生成测试安装器：$installerPath"
}

$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$env:TEMP = $localTemp
$env:TMP = $localTemp

function Reset-Fixture {
  param(
    [Parameter(Mandatory = $true)][string]$DataName,
    [Parameter(Mandatory = $true)][string]$DataContent
  )

  if (Test-Path -LiteralPath $fixtureRoot) {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot "resources\nested-empty") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot "empty-top-level") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot $DataName) | Out-Null
  Set-Content -LiteralPath (Join-Path $fixtureRoot "PAO.exe") -Value "old executable"
  Set-Content -LiteralPath (Join-Path $fixtureRoot "root-file.txt") -Value "old root file"
  Set-Content -LiteralPath (Join-Path $fixtureRoot "resources\app.asar") -Value "old app archive"
  Set-Content -LiteralPath (Join-Path $fixtureRoot "$DataName\identity.txt") -Value $DataContent
}

function Invoke-TestExecutable {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string[]]$Arguments = @()
  )

  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
  return $process.ExitCode
}

function Invoke-CopiedUninstaller {
  param([string[]]$ModeArguments = @())

  $sourceUninstaller = Join-Path $fixtureRoot "Uninstall PAO.exe"
  $copiedUninstaller = Join-Path $uninstallerCopyRoot ("old-uninstaller-{0}.exe" -f [guid]::NewGuid().ToString("N"))
  Copy-Item -LiteralPath $sourceUninstaller -Destination $copiedUninstaller

  # 复现 electron-builder installUtil.nsh 的调用方式：从安装根外复制运行卸载器，
  # 用 _?=指定安装根，并把它放在最后一个参数。
  $arguments = @("/S", "/KEEP_APP_DATA") + $ModeArguments + @("_?=$fixtureRoot")
  $exitCode = Invoke-TestExecutable -Executable $copiedUninstaller -Arguments $arguments

  # 主安装器会在退出后清理自己的 PLUGINSDIR；隔离脚本负责清理本轮副本。
  if (Test-Path -LiteralPath $copiedUninstaller) {
    Remove-Item -LiteralPath $copiedUninstaller -Force
  }

  return $exitCode
}

function Assert-DataPreserved {
  param(
    [Parameter(Mandatory = $true)][string]$DataName,
    [Parameter(Mandatory = $true)][string]$ExpectedContent
  )

  $identityPath = Join-Path $fixtureRoot "$DataName\identity.txt"
  if (-not (Test-Path -LiteralPath $identityPath -PathType Leaf)) {
    throw "data 被删除：$identityPath"
  }
  $actual = (Get-Content -LiteralPath $identityPath -Raw).Trim()
  if ($actual -ne $ExpectedContent) {
    throw "data 内容发生变化：预期 '$ExpectedContent'，实际 '$actual'"
  }
}

function Assert-NonDataRemoved {
  param([Parameter(Mandatory = $true)][string]$DataName)

  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $remaining = @(
      Get-ChildItem -LiteralPath $fixtureRoot -Force |
        Where-Object {
          $_.Name -ne $DataName -and
          $_.Name -ne "Uninstall PAO.exe"
        }
    )
    if ($remaining.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "仍有非 data 项未删除：$($remaining.Name -join ', ')"
}

function Assert-UninstallerRemoved {
  $uninstaller = Join-Path $fixtureRoot "Uninstall PAO.exe"
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    if (-not (Test-Path -LiteralPath $uninstaller)) {
      return
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "卸载器未按预期在成功流程结束时删除：$uninstaller"
}

function Get-FixtureSnapshot {
  $prefix = $fixtureRoot.TrimEnd("\") + "\"
  $rows = foreach ($item in Get-ChildItem -LiteralPath $fixtureRoot -Recurse -Force) {
    $relativePath = $item.FullName.Substring($prefix.Length)
    if ($item.PSIsContainer) {
      "D|$relativePath"
    }
    else {
      $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
      "F|$relativePath|$hash"
    }
  }
  return @($rows | Sort-Object)
}

function Assert-FixtureUnchanged {
  param([string[]]$ExpectedSnapshot)

  $actualSnapshot = Get-FixtureSnapshot
  $difference = Compare-Object -ReferenceObject $ExpectedSnapshot -DifferenceObject $actualSnapshot
  if ($null -ne $difference) {
    $detail = $difference | ForEach-Object {
      "{0} {1}" -f $_.SideIndicator, $_.InputObject
    }
    throw "legacy fixture 发生变化：$($detail -join '; ')"
  }
}

$results = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  runId = $runId
  temporaryFixture = $testRoot
  evidenceDirectory = $evidenceRoot
  compile = [ordered]@{ exitCode = $compileExitCode; harness = $harnessPath; log = $compileLog }
  scenarios = @()
}

try {
  $modeCases = @(
    [ordered]@{ name = "upgrade"; dataName = "data"; arguments = @("--updated") },
    [ordered]@{ name = "ordinary-uninstall"; dataName = "DATA"; arguments = @() }
  )

  foreach ($case in $modeCases) {
    $expected = "preserve-$($case.name)-$([guid]::NewGuid().ToString('N'))"
    Reset-Fixture -DataName $case.dataName -DataContent $expected
    $installExit = Invoke-TestExecutable -Executable $installerPath -Arguments @("/S")
    $uninstaller = Join-Path $fixtureRoot "Uninstall PAO.exe"
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
      throw "$($case.name) 场景未生成卸载器"
    }
    if ($installExit -ne 0) {
      throw "$($case.name) 场景安装器退出码应为 0，实际为 $installExit"
    }
    $uninstallExit = Invoke-CopiedUninstaller -ModeArguments $case.arguments
    if ($uninstallExit -ne 0) {
      throw "$($case.name) 场景卸载器退出码应为 0，实际为 $uninstallExit"
    }
    Assert-DataPreserved -DataName $case.dataName -ExpectedContent $expected
    Assert-NonDataRemoved -DataName $case.dataName
    Assert-UninstallerRemoved

    $results.scenarios += [ordered]@{
      name = $case.name
      installExitCode = $installExit
      uninstallExitCode = $uninstallExit
      dataName = $case.dataName
      dataPreserved = $true
      nonDataRemoved = $true
    }
  }

  $legacyMarkers = @(
    [ordered]@{ configured = "部门"; onDisk = "部门" },
    [ordered]@{ configured = "工作流"; onDisk = "工作流" },
    [ordered]@{ configured = "pao配置"; onDisk = "PAO配置" }
  )
  $legacyModes = @(
    [ordered]@{ name = "legacy-upgrade"; arguments = @("--updated") },
    [ordered]@{ name = "legacy-uninstall"; arguments = @() }
  )

  foreach ($marker in $legacyMarkers) {
    foreach ($mode in $legacyModes) {
      $expected = "preserve-$($mode.name)-$([guid]::NewGuid().ToString('N'))"
      Reset-Fixture -DataName "data" -DataContent $expected
      $markerRoot = Join-Path $fixtureRoot $marker.onDisk
      New-Item -ItemType Directory -Force -Path (Join-Path $markerRoot "nested-empty") | Out-Null
      Set-Content -LiteralPath (Join-Path $markerRoot "legacy-data.bin") -Value "旧现场字节必须保留"

      $installExit = Invoke-TestExecutable -Executable $installerPath -Arguments @("/S")
      if ($installExit -ne 0) {
        throw "$($mode.name) $($marker.configured) 场景安装器退出码应为 0，实际为 $installExit"
      }
      $beforeSnapshot = Get-FixtureSnapshot
      $uninstallExit = Invoke-CopiedUninstaller -ModeArguments $mode.arguments
      if ($uninstallExit -ne 2) {
        throw "$($mode.name) $($marker.configured) 场景必须拒绝操作并返回 2，实际为 $uninstallExit"
      }
      Assert-FixtureUnchanged -ExpectedSnapshot $beforeSnapshot

      $results.scenarios += [ordered]@{
        name = $mode.name
        marker = $marker.configured
        markerOnDisk = $marker.onDisk
        installExitCode = $installExit
        uninstallExitCode = $uninstallExit
        legacyDetectionBeforeMutation = $true
        treeBytePreserved = $true
      }
    }
  }

  # 在部分项目已经移动后强制 atomicRMDir 失败；正式宏必须先恢复全部项目，
  # 再中止升级。
  Reset-Fixture -DataName "data" -DataContent "preserve-rollback"
  New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot "a-directory") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot "z-locked") | Out-Null
  Set-Content -LiteralPath (Join-Path $fixtureRoot "a-directory\keep.txt") -Value "restore me"
  Set-Content -LiteralPath (Join-Path $fixtureRoot "z-locked\locked.txt") -Value "hold open"
  $installExit = Invoke-TestExecutable -Executable $installerPath -Arguments @("/S")

  $lockedFile = Join-Path $fixtureRoot "z-locked\locked.txt"
  $lockStream = [System.IO.File]::Open(
    $lockedFile,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  try {
    $uninstallExit = Invoke-CopiedUninstaller -ModeArguments @("--updated")
  }
  finally {
    $lockStream.Dispose()
  }

  Assert-DataPreserved -DataName "data" -ExpectedContent "preserve-rollback"
  foreach ($relativePath in @(
    "PAO.exe",
    "root-file.txt",
    "resources\app.asar",
    "a-directory\keep.txt",
    "z-locked\locked.txt"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot $relativePath))) {
      throw "回滚未恢复 $relativePath"
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot "resources\nested-empty") -PathType Container)) {
    throw "回滚未恢复嵌套空目录"
  }
  $uninstaller = Join-Path $fixtureRoot "Uninstall PAO.exe"
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "升级回滚后旧卸载器被错误删除"
  }
  if ($installExit -ne 0) {
    throw "回滚场景安装器退出码应为 0，实际为 $installExit"
  }
  if ($uninstallExit -ne 2) {
    throw "升级回滚场景卸载器退出码必须为 2，实际为 $uninstallExit"
  }

  $results.scenarios += [ordered]@{
    name = "upgrade-rollback"
    installExitCode = $installExit
    uninstallExitCode = $uninstallExit
    dataPreserved = $true
    nonDataRestored = $true
    emptyDirectoriesRestored = $true
    uninstallerPreserved = $true
    failureExitNonZero = $true
  }
}
finally {
  $env:TEMP = $previousTemp
  $env:TMP = $previousTmp
}

$results.finishedAt = (Get-Date).ToString("o")
$results.success = $true
Copy-Item -LiteralPath $harnessPath -Destination (Join-Path $artifactRoot "pao-nsis-data-test.nsi")
Copy-Item -LiteralPath $installerPath -Destination (Join-Path $artifactRoot "pao-nsis-data-test.exe")
$results.compile.harness = Join-Path $artifactRoot "pao-nsis-data-test.nsi"
$resultPath = Join-Path $evidenceRoot "result.json"
$results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8

$resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTestRoot.StartsWith($fixturePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "清理前复核失败，拒绝删除任务临时目录外的路径：$resolvedTestRoot"
}
Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
$results.temporaryFixtureCleaned = $true
$results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8
$results | ConvertTo-Json -Depth 8
