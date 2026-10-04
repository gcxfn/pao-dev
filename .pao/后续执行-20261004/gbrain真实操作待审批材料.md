# gbrain 真实操作待审批材料（2026-10-04）

当前仅准备与只读：使用现有 MCP 客户端和现场配置，initialize/tools-list/close 已成功，服务提供 remember/recall/forget。没有调用任何工具、没有召回用户共享内容、没有创建、更正或忘却。凭证仅沿现有 loadGbrainToken 在内存使用，未打印。只读证据 gbrain只读入口核查.json；未进行模型/嵌入工具请求，不能由此推断未来记忆读写免费。

可审操作清单位于 D:/AI/workspace/临时文件夹/PAO-对照验收-20261004/gbrain待审批操作.json；脚本 gbrain只读入口核查.mjs 只能握手列schema，没有写入执行模式。后续真实写操作必须先获得明确许可，此材料不是许可。

## 准确接口与范围

- 现场基址 http://127.0.0.1:7333，MCP /mcp。真实schema：remember必需fact/provenance，另支持visibility、ttl、request_id等；recall无必填、支持query/limit/grep等；forget必需id、另支持reason/request_id。完整schema保存在只读证据，未读取事实正文。
- PAO现有适配器写入映射 remember {fact:内容,provenance:"pao｜标签:...",visibility:"world"}，返回 {记忆ID:String(id),状态:inserted|duplicate|superseded}。召回映射 recall {query,limit}，只从facts[].fact/fact_id/provenance投影内容/准确ID/来源。忘却映射 forget {id}，要求返回同id和expired布尔。
- PAO正式工具为 pao_记忆写入 {内容,标签?}、pao_记忆召回 {检索词,上限?}、pao_记忆忘却 {记忆ID,确认}。UI /pao memory 展示本会话实际注入条目，correct/forget 使用当时界面编号并确认准确ID，不能猜编号。显式工具召回不自动等于实际已注入；来源页验收须核真实状态记录，若需要一轮已授权主控请求来触发召回则单独计600账，不自动声称已有。
- 现有 correctMemory 是先写新文、再忘旧ID，两步非事务。CLI/UI会先展示原文、新文、ID与共享影响，取消不修改；会话变化/中途取消或忘旧失败须保留部分成功证据。

## 审批对象

最多3条新ID，正常链预计2条，第三条仅在确需单独验证来源或取消时再决定，不为了用满创建。唯一标记 PAO验收样本-20261004-gbrain-71f89c6a。旧文是“仅为记忆纠错验收，虚构验收项目颜色偏好蓝色，不是用户真实偏好”；新文同标记改绿色。详细逐字内容见操作JSON。世界可见world意味着Hermes等其他agent也可能读到，即使只写验收条目也是真实共享修改。

写入前先确认没有使用用户历史ID；仅本轮明确inserted回执得到的新ID可列入本地许可台账。duplicate/superseded、缺ID、超时结果未知都停，不把召回候选ID直接当清理许可。现有provider未透传request_id/ttl，因此不得假称自动幂等重试或自动过期；超时不盲重写，不为验收扩provider。

批准后次序：正式写旧文→仅唯一标记召回→来源UI核ID/来源→取消纠正一次→确认纠正→保留新ID/旧ID两步证据→再召回绿色→确认忘却本轮新ID→仅唯一标记复核。忘却expired=false是服务幂等返回，不等于本次删了一条；无匹配结合准确ID忘却回执才形成验证，不宣称物理删除。

所有共享操作只对白名单本轮ID，最多3个，禁止历史记录/批量检索后删。候选召回若混入其他ID只记录数量与已省略，不保存历史正文。来源原文仅保留这两条标记样本；不保存raw共享库响应、token或headers。

## 半失败与费用

更正新条已写/旧条忘却失败须记“部分成功”并保留两个ID、操作顺序与服务返回；取消后迟到新ID也记部分成功，不注入新会话。新ID未返回则不清理猜测条目，保留未知，等待人工处理。取消、关闭测试先做无写确认取消，不人为破坏真实服务制造故障；离线注入覆盖不冒充真实半失败。

记忆服务内部嵌入/处理费用不由600模型账本完整覆盖，服务未给usage时写未知，不能写0。本次零模型的握手/schema核查不替代写→召回→纠正→再召回→忘却，也不解除当前共享写入授权阻塞。本轮未向用户提出新许可问题，审批由主代理统一处理。

## 已批准后的真实首段（本轮追加）

用户批准唯一标记、正常2条最多3新ID、最多12次gbrain工具调用，失败计入不自动重试；只允许本轮明确inserted ID。已执行临时目录 gbrain有限真实链.mjs create-recall，正式 GbrainVendor remember→recall 共2次，返回 inserted ID“4”，召回命中同ID；模型请求0。只读握手/list不计工具调用；共享工具调用硬门局部包装McpClient.callTool逐次先登记，错误也计数。证据 gbrain本轮真实调用.json。

现状态：旧样本保留等待真实UI纠正/忘却，尚非全链通过。剩余工具10次、新ID最多2个；任何后续UI都必须接续同一计数/白名单，不能另起12。自动召回/自动交接不得在背景突破本轮标记范围。

补充源码实核：正式 pao_记忆召回 execute 已调用 sessionMemory(pi).record，因此同一真实会话可在工具召回后直接 /pao memory 展示来源，无需为注入自行发模型；直接provider召回则没有此UI状态效果。此前材料“工具召回不自动等于注入”不能用于否定当前正式工具的此接线。
