# 用途：检查本轮活文档及修复报告是否落盘、非空，且本地 Markdown 文件链接存在。
# 输入：开发仓当前文档；输出：产物/文档核查-<时间>.log。只检查文件路径，不宣称代码运行或锚点验收。
$ErrorActionPreference = 'Stop'
$项目根 = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$文件 = @(
    'AGENTS.md',
    'plans/AGENTS.md',
    'plans/v2-REQUIREMENTS.md',
    'plans/v2-ARCHITECTURE.md',
    'plans/持续维护与升级.md',
    'plans/附件/验收与度量口径.md',
    'plans/未完成/2026-10-02-全阶段总计划.md',
    'plans/未完成/2026-10-02-M2各部分加厚.md',
    'plans/未完成/2026-10-02-M2-01在线宿主与部门配方-设计包.md',
    'plans/未完成/2026-10-03-审查修复与验收补齐.md',
    'plans/已完成/2026-10-02-M1各部分最小形态.md',
    '摩擦日志.md',
    '.agents/notes/implemented/2026-10-03-摩擦草稿与正式日志归属.md',
    '.pao/审查修复-20261003/产物/修复报告.md',
    '.pao/审查修复-20261003/产物/修复前同条件核对说明.md'
)
$结果 = [Collections.Generic.List[string]]::new()
$错误 = [Collections.Generic.List[string]]::new()
$链接数 = 0
foreach ($相对路径 in $文件) {
    $路径 = Join-Path $项目根 $相对路径
    if (-not (Test-Path -LiteralPath $路径 -PathType Leaf)) {
        $错误.Add("缺文件：$相对路径")
        continue
    }
    $正文 = Get-Content -LiteralPath $路径 -Raw
    if ([string]::IsNullOrWhiteSpace($正文)) {
        $错误.Add("空文件：$相对路径")
        continue
    }
    $结果.Add("已落盘：$相对路径；字节=$((Get-Item -LiteralPath $路径).Length)")
    foreach ($匹配 in [regex]::Matches($正文, '\[[^\]\r\n]+\]\(([^)\r\n]+)\)')) {
        $目标 = $匹配.Groups[1].Value.Trim().Trim('<', '>')
        if ($目标 -match '^(https?://|mailto:|codex:|app:|#)') { continue }
        $目标 = [Uri]::UnescapeDataString(($目标 -split '#', 2)[0])
        if ([string]::IsNullOrWhiteSpace($目标)) { continue }
        # Codex 文件链接支持 path:行号；本脚本只核文件存在，不核行号内容。
        $文件目标 = $目标 -replace ':\d+$', ''
        $实际路径 = if ([IO.Path]::IsPathRooted($文件目标)) { $文件目标 } else { Join-Path ([IO.Path]::GetDirectoryName($路径)) $文件目标 }
        $链接数++
        if (-not (Test-Path -LiteralPath $实际路径)) {
            $错误.Add("无效本地链接：$相对路径 -> $目标")
        }
    }
}
$结果.Add("检查文档=$($文件.Count)；本地链接=$链接数；错误=$($错误.Count)")
$结果.AddRange($错误)
$日志 = Join-Path $PSScriptRoot ('产物/文档核查-' + (Get-Date).ToString('yyyy-MM-dd-HHmmssfff') + '.log')
$结果 | Set-Content -LiteralPath $日志 -Encoding utf8
$结果
if ($错误.Count -gt 0) { exit 1 }
exit 0
