# 用途：核查 2026-10-03 审查落盘的文档、链接和修改边界。
# 输入：开发仓当前文档及 Git 工作树；PAO 和使用现场仅只读检查。
# 输出：控制台结果；由调用方保存日志。脚本不修改任何文件。
param([string]$ProjectRoot = 'D:\AI\workspace\pao-dev')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$files = @(
    'AGENTS.md',
    'plans/AGENTS.md',
    'plans/v2-REQUIREMENTS.md',
    'plans/v2-ARCHITECTURE.md',
    'plans/未完成/2026-10-02-全阶段总计划.md',
    'plans/未完成/2026-10-02-M2各部分加厚.md',
    'plans/未完成/2026-10-02-M2-01在线宿主与部门配方-设计包.md',
    'plans/未完成/2026-10-03-审查修复与验收补齐.md',
    'plans/已完成/2026-10-02-M1各部分最小形态.md',
    'plans/已完成/2026-10-02-实施前契约修订.md',
    'plans/持续维护与升级.md',
    'plans/附件/验收与度量口径.md',
    '.pao/全项目审查-20261003/产物/审查报告.md'
)
$issues = [System.Collections.Generic.List[string]]::new()
$linkCount = 0

foreach ($relative in $files) {
    $path = Join-Path $ProjectRoot $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $issues.Add("文件缺失：$relative")
        continue
    }
    $body = Get-Content -Raw -LiteralPath $path -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($body)) { $issues.Add("空文件：$relative") }
    foreach ($match in [regex]::Matches($body, '(?<!!)\[[^\]]+\]\((?<target>[^)]+)\)')) {
        $target = $match.Groups['target'].Value.Trim().Trim('<', '>')
        if ($target -match '^(https?://|mailto:|app://|codex://|#)') { continue }
        $target = [Uri]::UnescapeDataString(($target -split '#', 2)[0])
        $target = $target -replace ':\d+$', ''
        if ([IO.Path]::IsPathRooted($target)) { $resolved = $target }
        else { $resolved = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $path) $target)) }
        $linkCount++
        if (-not (Test-Path -LiteralPath $resolved)) { $issues.Add("坏链接：$relative -> $target") }
    }
}

$reportPath = Join-Path $ProjectRoot '.pao/全项目审查-20261003/产物/审查报告.md'
$planPath = Join-Path $ProjectRoot 'plans/未完成/2026-10-03-审查修复与验收补齐.md'
$reportText = Get-Content -Raw -LiteralPath $reportPath -Encoding UTF8
$planText = Get-Content -Raw -LiteralPath $planPath -Encoding UTF8
foreach ($number in 26..42) {
    if ([regex]::Matches($reportText, "(?m)^### R${number}｜").Count -ne 1) {
        $issues.Add("报告编号缺失或重复：R$number")
    }
    if ([regex]::Matches($planText, "(?m)^\| R${number} \|").Count -ne 1) {
        $issues.Add("计划编号缺失或重复：R$number")
    }
}
if ($planText -notmatch '代码实施未开工' -or $planText -notmatch 'S2 继续暂停') {
    $issues.Add('计划实施／暂停状态不明确')
}
if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'plans/未完成/2026-10-02-实施前契约修订.md')) {
    $issues.Add('已关闭契约仍残留在未完成目录')
}

$changed = @(& git -C $ProjectRoot -c core.quotepath=false diff --name-only)
if ($LASTEXITCODE -ne 0) { throw '无法读取开发仓差异' }
foreach ($relative in $changed) {
    if ($relative -like 'plans/全阶段计划包-2026-10-02/*' -or $relative -like '.pao/M1-*/*') {
        $issues.Add("历史／冻结文件被修改：$relative")
    }
    if ($relative -notin $files -and $relative -ne 'plans/未完成/2026-10-02-实施前契约修订.md') {
        $issues.Add("范围外的已跟踪修改：$relative")
    }
}
& git -C $ProjectRoot diff --check
if ($LASTEXITCODE -ne 0) { $issues.Add('git diff --check 未通过') }

$headAgents = (@(& git -C $ProjectRoot show HEAD:AGENTS.md) -join "`n")
if ($LASTEXITCODE -ne 0) { throw '无法读取原 AGENTS' }
$currentAgents = (Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'AGENTS.md') -Encoding UTF8).Replace("`r`n", "`n")
$embeddedPattern = '(?s)<!-- 上级公约嵌入区.*?<!-- 嵌入区结束 -->'
if ([regex]::Match($headAgents, $embeddedPattern).Value -ne [regex]::Match($currentAgents, $embeddedPattern).Value) {
    $issues.Add('上级公约嵌入区发生修改')
}

foreach ($repo in @('PAO', '..\pao')) {
    $repoPath = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $repo))
    $repoStatus = @(& git -C $repoPath status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw "无法读取仓库：$repo" }
    if ($repoStatus.Count -gt 0) { $issues.Add("本体／使用现场存在修改：$repo") }
}

if ($issues.Count -gt 0) {
    $issues | ForEach-Object { Write-Output "失败：$_" }
    throw "文档核查失败，共 $($issues.Count) 项"
}
Write-Output "通过：$($files.Count) 份文档、$linkCount 条本地 Markdown 链接、R26—R42 完整。"
Write-Output '通过：契约迁移、历史／冻结保护、上级公约嵌入区和 git diff --check。'
Write-Output '通过：PAO 本体与使用现场工作树干净；本轮只有开发仓文档与核查产物。'
Write-Output '边界：未重新运行代码测试、付费模型、供应商写入或真实退出验收。'
