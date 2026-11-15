# Windows真实工具树停止修复

2026-10-04，源码稳定，未自行构建/调用模型。首次真实G3正常关窗失败原件保留：根与worker退出但Git bash/Node继续写。本修复不把根退出当工具树停止。

## 实现

- worker/kill.ts：Windows停止前用系统PowerShell/CIM抓目标树，保留CreationDate；同一短命helper中逐成员复核身份，叶到根调用系统taskkill，最后核全部捕获成员消失。根已退出仍按保留的PPID关系找后代；不按进程名全局清理、不加常驻服务。
- worker/runner.ts、host/host.ts、parent-lifecycle.ts、cards/process.ts、app.ts：只在内部登记/闭包保存进程生成后的时间上界并传给停止方法，拒绝后续复用的根PID。卡14字段及旧回执不变。默认直接killTree(pid)只约束调用后身份，不宣称能识别未传历史出生时间的根复用。
- core/tools/bash.ts：Windows取消/超时复用树停止Promise，等待后再返回/解除追踪；停止错误通过调用Promise传播，不在abort回调裸抛。POSIX维持原行为。原killProcessTree全部调用者已查，未更改该同步公开接口；新可等待路径接实际bash执行消费者。
- windows-shell-stop.test.ts：实际Git bash→Node持续写入，取消后等待Node停止、短观察字节不增、独立Node仍存活。

## 验证和边界

全仓tsc --noEmit exit0；8个改动文件Biome通过。新增真实本地进程回归及bash-close-hang共2文件3项通过。S1独立旧dist根先退出探针明确继续写入且3成员残留；同探针加载修后src为0残留且不再写入，原失败未覆盖。另S1实际3文件7项通过。具体源码稳定时主代理已获通知，整套模块及新构建/真实图形关窗仍由主代理执行。

PID/CreationDate检查用于降低PID复用误杀；不是Windows内核Job Object级原子保证。系统拒绝查询/停止时会报错，不能宣称停止成功。图形真实退出尚须修后复验，不把本地探针当GUI通过。
