# 用途：读取已留档的 Vitest JSON，定位指定文件的失败；不重新执行测试。
# 输入：报告路径和文件名；输出：失败用例与原始错误，不修改报告或基线。
param(
    [Parameter(Mandatory = $true)][string]$报告路径,
    [string[]]$文件名 = @('agent-session-concurrent.test.ts', 'agent-session-dynamic-tools.test.ts', 'bash-close-hang-windows.test.ts'),
    [int]$每条最大字符 = 2600
)
$ErrorActionPreference = 'Stop'
$报告 = Get-Content -LiteralPath $报告路径 -Raw | ConvertFrom-Json
foreach ($文件 in $报告.testResults) {
    if ($文件名 -notcontains [IO.Path]::GetFileName($文件.name)) { continue }
    foreach ($断言 in $文件.assertionResults) {
        if ($断言.status -ne 'failed') { continue }
        $错误 = $断言.failureMessages -join "`n"
        [pscustomobject]@{
            文件 = [IO.Path]::GetFileName($文件.name)
            用例 = $断言.fullName
            错误 = $错误.Substring(0, [math]::Min($每条最大字符, $错误.Length))
        } | ConvertTo-Json -Depth 5
    }
}
