# 三模板 bugfix 首次真实运行独立核验

运行：real-20261004 / run-d236a6ff-0ee2-46ce-9f23-457e884b53aa。只读核查，未改工作树、模板、输入或模型调用。结论：**本次业务未完成，不能接回为已验收成果。**

- 主控真实读取出厂小bug模板及现场 codebase-memory/SKILL.md，调用 pao_落配方保存新业务配方。实际 flow 生成实例 ffc97a6c-4350-45aa-bb83-43d98f37ba06。
- 开发部长真实会话 8e26d53b-110c-44f1-8321-5ed06e244570 拆一张卡，提交拆解结束。worker 会话 385eb682-2ad6-439f-9e1f-8e3d9dbd92f9。
- worker 原会话有真实 read SKILL.md；search_graph 命中当前业务树 listRecipes。trace_path 首次 --symbol 失败后按工具帮助改用 --function-name listRecipes --direction inbound，真实返回11调用者；随后才修改源码。技能调用证据成立，不能仅凭这一局部成功称整条 M1 完成。
- 真实修改仅 recipe.ts：readdirSync withFileTypes → isFile 且名字.md →去扩展排序。diff为4增4删；属于真实目标中的修复候选，但未补测试、未运行测试，尚不满足全部冻结验收。历史HEAD仍为开工608261f，没有交卷提交。
- 开发worker达到卡级12轮上限，回执失败“预算已耗尽：turns；执行已停止”，卡真实落失败；后续测试/审查节点均未运行，回边次数为空。用量回执 input22404/output4914/cacheRead188032，目录估价0.10187552，缺用量轮次1；不能把缺用量当0或把目录价当供应商账单。
- 脚本本次共享账 before356→after378，共22请求。结果.json 明确“真实流程未完成:运行中”，非业务成功；主控CLI正常退出码0不推翻业务失败。关闭后控制正本记录“主会话关闭，须显式人工恢复”。

本次未覆盖：测试和审查角色完成、真实change回边、人工成功恢复、复盘/存流/复用配方运行。所有失败及真实费用原件保留。需要后续明确恢复与真实验收才能决定业务成果可采用；本报告没有自行重试或扩大卡预算。

证据正本：三模板-bugfix-real-20261004/run-d236a6ff-0ee2-46ce-9f23-457e884b53aa 的 stdout.jsonl/结果.json/最终.patch；业务工作树 .pao/业务验收 控制/卡/部长会话与 .pao/worker会话。原worker回执证据路径已写卡面。

## “运行中”与“挂起”的读时点核查

stdout.jsonl 第8995行已是 pao-workflow custom 消息，按真实卡报告“挂起”；第8996行 prompt response disposition=handled。因此不是脚本在正式命令尚未结束前抢读，也不是后台任务仍正常推进。

源码原因：auto.ts v2 worker失败后 stopped 分支直接返回 `controlReport(readControl(...))`。controlReport 依据卡状态重新计算，发现失败即返回挂起，但该分支没有进入 tick/mutate 保存流程状态字段。三模板脚本随即用 readControl 读文件，得到上次保存的“运行中”字段。正常关闭随后 host.shutdown 调 pauseControl；control.mutate 重新计算并保存，于是文件最终为“挂起”，暂停原因为“主会话关闭，须显式人工恢复”。

两份观测分别是即时派生报告和上次落盘状态字段，不能取其中任一个伪造成功。建议后续脚本同时留 raw control 与 controlReport，并按实时卡/控制事实判断；本次原证据不重写，脚本/源码未修改。
