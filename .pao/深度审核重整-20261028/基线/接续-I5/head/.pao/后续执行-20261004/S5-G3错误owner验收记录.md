# 错误原 owner 图形拒绝验收

2026-10-04。当前未完成，未达到确认及 owner 拒绝门。

先读 workflow/tools.ts 与 control.ts：正式 `/pao flow control` 的恢复先出现人工确认，再进入 resumeControl；其锁内读取控制后先核实例、原owner及理由，再改owner/save。错误owner在控制正本写入前拒绝。桌面Flow服务则更早核owner，因此本次计划通过正式composer命令走真实确认。

首轮使用新profile、空agent、turns0、无私有auth；New thread显示“No models available”，Start thread禁用，脚本18秒失败，未到恢复命令提交。没有为通过而force点击或增加产品接口。原截图、trace与日志在 S5-G3错误owner真实拒绝/ 及同名.log 保留。不将此结果写成owner或轮次PASS。

目标仅本轮旧失败业务-bugfix-real-20261004实例ffc97a6c-4350-45aa-bb83-43d98f37ba06，未触及在途firstrun-v2项目。模型继续暂停。待解决无模型配置下建立命令会话的可达性后继续；无真实凭证/无模型调用要求不变。

## 配置后真实操作结果

主代理明确允许复制单provider私有凭证、仍turns0，仅提交slash命令。配置后正式可见Electron操作1项通过（4.7秒）：恢复确认框实际出现并点击Confirm，随后显示 [FLOW_CONTROL] 恢复身份不符或缺现场核查说明。旧实例工作区全部文件SHA256前后相同，控制/卡/回执未改变。截图已目视确认错误文本。未恢复成功，未到轮次门，不能称轮次PASS。

证据 S5-G3错误owner真实拒绝-配置后/，含确认前/拒绝截图、原文件快照、结果、trace。会话JSONL核无assistant、无usage；预算turns0，不将与主M2并行的全局账本变化归本轮。私有auth已删除并核不存在。初始 `/pao runtime status` 被现有命令用法拒绝（正确命令应是 `/pao runtime`），仍只创建本轮命令会话，无模型；该提示保留在截图，后续准备脚本订正命令，不改本次证据。
