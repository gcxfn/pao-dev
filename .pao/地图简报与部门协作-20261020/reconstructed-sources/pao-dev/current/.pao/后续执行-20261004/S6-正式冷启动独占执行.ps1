# 用途：正式CLI首次冷启动；输入新构建，输出隔离窗口与日志。无模型凭证。
$root='D:/AI/workspace/临时文件夹/PAO-正式冷启动独占-20261004'
$proof='D:/AI/workspace/pao-dev/.pao/后续执行-20261004/S6-正式冷启动独占零API'
New-Item -ItemType Directory -Force $root,$proof,"$root/agent","$root/profile","$root/project" | Out-Null
Get-ChildItem Env: | Where-Object { $_.Name -match 'API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PI_APP_TEST_MODE|ELECTRON_RUN_AS_NODE' } | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$env:PAO_HOME='D:/AI/workspace/pao'
$env:PAO_CODING_AGENT_DIR="$root/agent"
$env:PI_APP_USER_DATA_DIR="$root/profile"
$env:PI_APP_INITIAL_WORKSPACES="$root/project"
$env:PAO_SESSION_BUDGET='{"turns":0}'
$env:PAO_REQUEST_BUDGET='{"path":"D:/AI/workspace/pao-dev/.pao/后续执行-20261004/真实请求额度.json","requests":600,"concurrency":2}'
Copy-Item 'D:/AI/workspace/pao-dev/.pao/后续执行-20261004/真实请求额度.json' "$proof/budget-before.json"
Get-FileHash 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/bundle/cli.js','D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/pao/app.js','D:/AI/workspace/pao-dev/桌面端/apps/desktop/out/main/main.js' | ConvertTo-Json | Set-Content "$proof/build.json"
& node 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/bundle/cli.js' app *> "$proof/cli.log"
$LASTEXITCODE | Set-Content "$proof/exit-code.txt"
Copy-Item 'D:/AI/workspace/pao-dev/.pao/后续执行-20261004/真实请求额度.json' "$proof/budget-after.json"

