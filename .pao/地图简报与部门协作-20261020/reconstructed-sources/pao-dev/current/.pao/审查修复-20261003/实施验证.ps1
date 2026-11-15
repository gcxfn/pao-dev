# 用途：审查修复的本地验证与完整日志留档；不提交、不推送、不调用付费模型。
# 输入：PAO 当前工作树及现有依赖；输出：本工作区产物内对应日志和退出码。
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('代码检查', '浏览器检查', 'PAO测试', '内核测试', '脚本测试', '全量基线', '离线构建', '命令冒烟')]
    [string]$检查
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$项目根 = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$本体根 = Join-Path $项目根 'PAO'
$输出目录 = Join-Path $PSScriptRoot '产物'
[IO.Directory]::CreateDirectory($输出目录) | Out-Null
$node路径 = 'C:\Program Files\nodejs\node.exe'
$npm入口 = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
$本次标识 = (Get-Date).ToString('yyyy-MM-dd-HHmmssfff')
$日志 = Join-Path $输出目录 ($检查 + '-' + $本次标识 + '.log')

# 只影响此验证进程：离线检查不继承用户端点凭证或 PAO 的运行角色。
foreach ($变量 in Get-ChildItem Env:) {
    if ($变量.Name -match '(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET)$' -or
        $变量.Name -match '^(PAO_ROLE|PAO_WORKER_BUDGET|PI_AUTH_JSON|PI_SETTINGS_JSON)$') {
        Remove-Item -LiteralPath ('Env:' + $变量.Name)
    }
}
$env:PI_OFFLINE = '1'
# 本机现有 fd/rg 二进制供隔离 HOME 的测试使用，不加载该目录的配置或凭证。
$工具目录 = 'C:\Users\ASUS\.pi\agent\bin'
if (-not (Test-Path -LiteralPath (Join-Path $工具目录 'fd.exe') -PathType Leaf)) {
    throw "缺少已声明的本机测试依赖 fd.exe：$工具目录"
}
$env:PATH = $工具目录 + [IO.Path]::PathSeparator + $env:PATH
$开始 = Get-Date

switch ($检查) {
    '代码检查' { $工作目录 = $本体根; $参数 = @($npm入口, 'run', 'check') }
    '浏览器检查' { $工作目录 = $本体根; $参数 = @($npm入口, 'run', 'check:browser-smoke') }
    'PAO测试' {
        $工作目录 = Join-Path $本体根 'packages\coding-agent'
        $参数 = @('..\..\node_modules\vitest\vitest.mjs', 'run', 'test/pao/', '--maxWorkers=4')
    }
    '内核测试' {
        $工作目录 = Join-Path $本体根 'packages\agent'
        $参数 = @('..\..\node_modules\vitest\vitest.mjs', 'run', 'test/abort-before-request.test.ts', 'test/agent-loop.test.ts', 'test/agent.test.ts', '--maxWorkers=4')
    }
    '脚本测试' { $工作目录 = $本体根; $参数 = @('--test', 'scripts/upgrade-pi.test.mjs') }
    '全量基线' {
        $工作目录 = $本体根
        $参数 = @('scripts/check-baseline-failures.mjs', '--save-log', (Join-Path $输出目录 ('coding-agent全量-' + $本次标识 + '.json')))
    }
    '离线构建' { $工作目录 = $本体根; $参数 = @($npm入口, 'run', 'build:offline') }
    '命令冒烟' {
        $工作目录 = $本体根
        $参数 = @('packages/coding-agent/dist/bundle/cli.js', '--version')
    }
}

Push-Location $工作目录
try {
    & $node路径 @参数 2>&1 | Tee-Object -FilePath $日志
    $退出码 = $LASTEXITCODE
} finally {
    Pop-Location
}
$秒数 = [math]::Round(((Get-Date) - $开始).TotalSeconds, 2)
"检查=$检查；退出码=$退出码；耗时=$秒数 秒；日志=$日志"
@("检查=$检查", "开始=$($开始.ToString('o'))", "退出码=$退出码", "耗时秒=$秒数") |
    Set-Content -LiteralPath (Join-Path $输出目录 ($检查 + '-' + $本次标识 + '-结果.txt')) -Encoding utf8
exit $退出码
