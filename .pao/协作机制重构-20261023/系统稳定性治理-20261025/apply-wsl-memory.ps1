# 用途：按用户明确授权备份原配置、仅增加4GB内存上限并关闭WSL。
# 输入：用户当前.wslconfig及审核候选；输出：原件、变更回执。
$ErrorActionPreference = 'Stop'
$configPath = 'C:/Users/ASUS/.wslconfig'
$evidenceDir = $PSScriptRoot
$backupPath = Join-Path $evidenceDir 'wslconfig.before-memory-change'
$candidatePath = Join-Path $evidenceDir 'wslconfig.proposed'
if (Test-Path -LiteralPath $backupPath) { throw '原件备份已存在，拒绝覆盖或重复执行' }
$originalText = [System.IO.File]::ReadAllText($configPath)
if ($originalText.Replace("`r`n", "`n").Trim() -ne "[wsl2]`nnetworkingMode=mirrored") {
    throw 'WSL配置与审核原件不符，拒绝覆盖新修改'
}
$candidateText = [System.IO.File]::ReadAllText($candidatePath)
if ($candidateText.Replace("`r`n", "`n").Trim() -ne "[wsl2]`nnetworkingMode=mirrored`nmemory=4GB") {
    throw '候选配置与已批准范围不符'
}
Copy-Item -LiteralPath $configPath -Destination $backupPath
[System.IO.File]::WriteAllText($configPath, $candidateText, [System.Text.UTF8Encoding]::new($false))
$receipt = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString('o')
    authorization = '用户批准调整并重启，Ubuntu可中断'
    backup = $backupPath
    before_sha256 = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
    after_sha256 = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
    memory = '4GB'
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidenceDir 'wsl-memory-change.json') -Encoding utf8
& 'C:/Windows/system32/wsl.exe' --shutdown
if ($LASTEXITCODE -ne 0) { throw "WSL关闭失败，退出码$LASTEXITCODE；配置已保存，勿声称重启完成" }
Write-Output '原配置已保存；4GB设置已写入；WSL关闭命令成功'
