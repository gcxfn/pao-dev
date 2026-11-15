# 原失败集合门与新任务定稿独立复核

2026-10-04，只读复核；没有重跑正在运行的完整基线，没有API或构建。

`check-baseline-failures.mjs` 唯一差异是runVitest接收原日志路径，将既有捕获stdout后接stderr写到 `.raw.log`，main在--save-log时传路径。原默认基线、失败键比对、文件级错误、未处理运行错误提取、无完整报告拒绝、非零退出但无失败键拒绝等逻辑未更改。原68失败门未放宽。该文件为两流拼接，注释明确不是逐行真实时序；父进程被硬杀时spawnSync尚未返回仍不能保证即时日志，不能扩张为任意中断完整留档。

`复跑完整基线.ps1` 只在当前进程try/finally范围改PATH/TMP/TEMP/TMPDIR，finally恢复值和目录。C:\Windows\Temp仅作为隔离根，实际测试在随机pao-baseline子目录，未修改系统权限、系统环境变量或用户凭证。只读确认现有fd/rg并把bin加到当前进程PATH。新证据前缀防覆盖，传回原基线脚本退出码；无基线替换参数、无忽略新失败。

新任务harness定稿已无条件deepEqual准备正本actualTask与执行actualTask；原样本两侧undefined兼容，新任务执行时漏传/替换参数失败。限bugfix、7字段非空及明确预算保留，两个脚本node --check通过。此前三项发现及缺配置绕过均已关闭。

结论：本次窄改无必修；实际当前全量结果仍以主代理正在运行的终态证据为准，本报告不预先判PASS。
