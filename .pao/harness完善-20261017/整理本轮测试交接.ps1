# 用途：只撤回本轮新增的五个回归用例，并保留交接正文；输入为已有测试文件，输出为交接文档。
$taskRoot = Split-Path (Split-Path $PSScriptRoot)
$testPath = Join-Path $taskRoot 'PAO/packages/coding-agent/test/pao/workflow-plan-tools.test.ts'
$testText = [IO.File]::ReadAllText($testPath)
$beginMarker = 'it("宿主项目不能被工具参数改写，拒绝前不创建另一个项目的计划", async () => {'
$endMarker = 'it("没有宿主确认回调也没有界面时一律拒：模型自述不算确认", async () => {'
$startIndex = $testText.IndexOf($beginMarker)
if ($startIndex -lt 0) { throw '未找到本轮新增测试的起点，未修改文件' }
$endIndex = $testText.IndexOf($endMarker, $startIndex)
if ($endIndex -le $startIndex) { throw '未找到本轮新增测试的终点，未修改文件' }
$snippet = $testText.Substring($startIndex, $endIndex - $startIndex)
if (([regex]::Matches($snippet, '\bit\(')).Count -ne 5) { throw '用例数量不符，未修改文件' }
$fence = '```'
$handoff = "# 待实施回归用例`n`n这些是本轮新增的五个用例，已从活动测试文件撤回，供后续实施者使用。四项已反向运行并复现原缺陷，确认等待取消项尚未运行。需要原测试文件的 setup/call/mockPi 等助手。`n`n"
$handoff += $fence + "typescript`n" + $snippet + "`n" + $fence + "`n"
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '待实施回归用例.md'), $handoff)
$restored = $testText.Remove($startIndex, $endIndex - $startIndex).Replace(
    'import { planExecDir, planRecipeName, readTemporaryPlan }',
    'import { planRecipeName, readTemporaryPlan }'
)
[IO.File]::WriteAllText($testPath, $restored)
[pscustomobject]@{
    ArchivedTests = 5
    RemovedTestStillActive = $restored.Contains('宿主项目不能被工具参数改写')
    ExistingTestCount = ([regex]::Matches($restored, '\bit\(')).Count
}
