# S7 fresh project settings 新失败调查

截至 2026-10-04，已找到具体原因并复现。不是无证据的随机抖动；没有修改产品、测试断言、基线或构建产物，没有模型调用。

原 S7-最终完整基线.json 的 package-command-paths / allows local package install to initialize fresh project settings 在约 66.7ms 读取 project/.pi/settings.json 得到 ENOENT。原.log为比较摘要，未含该次Vitest console。

## 复跑与原因

1. 同空环境变量、单 worker，首次隔离根放开发项目 .pao/后续执行-20261004：目标精确通过，整文件目标亦通过；整文件另有中文临时路径被 .cmd 错误解码等无关失败，此次路径与官方运行器原生 TEMP 不同，不能据它推断原失败已消除。所有日志保留。
2. 改为官方运行器同样的 `mkdtemp(join(tmpdir(), 'pao-baseline-'))`，保持空环境及单worker跑整文件：fresh 12ms 再现 ENOENT；console 明确 **Project is not trusted. Use --approve to modify local package config.**。不是写入延迟；安装被信任门拒绝，所以不存在 settings.json。日志 S7-package-command-paths-整文件-原生临时路径隔离复跑.log。
3. 源码 trust-manager.ts hasTrustRequiringProjectResources 会向所有祖先查 .agents/skills，且只豁免当前 HOME/.agents/skills。隔离测试 HOME 指向 `...pao-baseline-RPqYwI/home`，TMP 的祖先却真实包含 `C:/Users/ASUS/.agents/skills`，它不等于当前隔离HOME路径，因此合法地被视为待信任项目资源。project-trust.ts 在无UI、无保存信任时返回false，package-manager-cli拒绝local安装。

代码图 trace_call_path 已确认探测函数被 resolveProjectTrusted / createCommandSettingsManager 等正式入口调用。

## 独立诊断

S7-fresh信任环境诊断.mjs 仅调用源码探测函数，不装载技能。对相同原生临时目录，cwd/.pi不存在；真实祖先技能目录存在：

- HOME=隔离home → trustRequiring=true。
- HOME=C:/Users/ASUS → trustRequiring=false（该目录被按用户资源豁免）。

结果 S7-fresh信任环境诊断.json。这只是读取环境诊断，恢复进程内原 HOME，没有改用户目录或凭证。

## 建议与边界

应修复测试“fresh无项目资源”的隔离前提：当前确实受到真实用户祖先技能影响。不能给用例加 --approve 掩盖原应验证的无资源自动允许，也不能删用户技能、放宽产品信任门或添加到原baseline。建议主代理选用确实不含真实祖先技能的隔离位置，明确记录环境调整并复核整套；或在该测试建立明确的资源发现隔离（同时保留真实信任边界用例）。这属于验收环境污染归因，尚未授权/实施任何改变，不能据此宣称完整基线通过。

## 主代理拟用临时父目录复核

逐级核对 `D:/AI/workspace/临时文件夹/PAO-对照验收-20261004` 至 D:/，均没有 `.agents/skills`；在该目录局部设置 TMP/TEMP/TMPDIR，原运行器 mkdtemp(tmpdir) 能保持空 HOME 且消除上述真实用户技能祖先。无需改默认、无需新CLI参数、不改变测试集合。不能携带真实 auth。

另有已证实的路径编码影响：本轮首次整文件复跑在中文 `.pao/后续执行-20261004/S7-隔离环境-fiEOSp` 下，测试生成的 UTF-8 managed npm.cmd 将中文路径解码成乱码，导致 managed-npm.cjs MODULE_NOT_FOUND；原日志保留。这与fresh信任问题不同，拟用“临时文件夹”也含中文，应在本轮调用环境核命令页编码与夹具一致或使用已有 ASCII 隔离父路径。该目录 `%~sI` 未返回 ASCII 短路径。不能把新的编码失败加入baseline或误归产品。

## C:/Windows/Temp 最小验证

主代理授权后，唯一创建目录 `C:/Windows/Temp/pao-baseline-probe-M6vghB`。其中本轮 permission-probe.txt 独占创建、读回、删除均成功，未改权限或其他系统文件。

沿原运行器空 HOME/USERPROFILE/TMP/npm 配置，不改变默认cmd码页936，三场景各精确单worker通过：fresh install 1通过/32未选，ancestor layering 1通过/49未选，worker PATH垫片 1通过/10未选。未运行full。脚本 S7-WindowsTemp三场景探测.mjs 与 S7-WindowsTemp-*-隔离精确复跑.log。此既有ASCII系统临时父目录可供主代理本轮局部TMP/TEMP/TMPDIR使用，保留原门槛与完整原始日志；三项通过不是整套基线通过。
