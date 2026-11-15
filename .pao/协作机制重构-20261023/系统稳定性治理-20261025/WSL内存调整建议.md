# WSL 内存调整建议（待授权，尚未执行）

2026-10-25。目标是为 Windows 留出更多内存余量，减少再次运行第一题时发生资源耗尽的风险；这不是已证明能够根治 Docker 重启的结论。

## 已核实的事实

- r15 安装预检期间 Windows System 事件2004报告虚拟内存不足，随后 Docker VM 重新启动，两只本轮容器退出255。无模型作答及评分。
- 之后只读查询系统已提交内存约40.0GB/43.4GB、92%；物理内存约16GB，页面文件已分配约25GB，不能简单归因为没有页面文件。
- 用户现有 `C:/Users/ASUS/.wslconfig` 仅设置 `[wsl2] networkingMode=mirrored`，没有显式内存上限。
- 查询时 Ubuntu 与 docker-desktop 都在运行，Docker 没有活动容器。WSL 全局重启仍可能打断 Ubuntu 中的其他工作。

## 推荐的受控调整

审核候选文件 [wslconfig.proposed](wslconfig.proposed)：保留镜像网络，只增加 `memory=4GB`，把当前默认约8GB的虚拟机内存上限降低。默认值为主机物理内存的50%，参数和全局影响范围见[Microsoft官方说明](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#main-wsl-settings)。4GB是针对本机当前压力的试运行选择，不是上游保证，也可能增加编译时间或使单个任务内存不足。

不改 Windows 页面文件、网络、系统服务启动策略或 PAO_HOME。用户明确批准后，先核对配置原件未发生新修改并保存原件，再写入候选配置；只有用户确认 Ubuntu 工作可中断后才执行 WSL 关闭/重启。`wsl --shutdown` 会结束全部运行中的 WSL 发行版，见[官方重启说明](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#the-8-second-rule-for-configuration-changes)。

配置生效后先无模型验证实际内存上限、Docker可用和安装预检，再决定是否让原授权第一题进入模型；历史失败原件保留。若4GB确实不足，明确报告，不自动逐档提高、不修改原题或官方测试。回退为恢复保存的原配置，并同样在允许中断时重启。

## 需要用户决定

是否允许修改这一全局设置，以及 Ubuntu 工作能否在此次操作中中断。现有项目授权不包含系统全局调整；项目 AGENTS.md 的“全局操作须授权”明确要求另行批准。
