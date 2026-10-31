---
版本: 2
实例: 8be1fd10-fb72-4387-ad52-9c2f60d2a6e6
owner: owner
脉络: 8be1fd10-fb72-4387-ad52-9c2f60d2a6e6
工作流: S1协议核对
卡目录: D:\AI\workspace\临时文件夹\协作规则统一-20261030\s1-protocol-gap-vdxkdr\.pao\卡
启动: 2026-10-31T01:26:20.269Z
状态: 挂起
冻结配方:
  版本: 2
  名字: S1协议核对
  自动执行: false
  参数: []
  节点:
    - 只读: false
      工人数量: 1
      审核: false
      允许请求主控裁定: true
      回边: []
      名字: 执行
      目标: 产出
      部门: 开发
      验收: 人工判断
      depends_on: []
      人工确认: false
    - 只读: false
      工人数量: 1
      审核: false
      允许请求主控裁定: false
      回边: []
      名字: 下游
      目标: 核对
      部门: 审核
      验收: 人工判断
      depends_on:
        - 执行
      人工确认: false
  说明: ""
  文件路径: D:\AI\workspace\临时文件夹\协作规则统一-20261030\s1-protocol-gap-vdxkdr\S1协议核对.md
  占位符: []
  拓扑序:
    - 执行
    - 下游
参数: {}
运行方式: 无人值守
节点:
  - 名字: 执行
    轮次: 1
    卡: []
    拆解结束: true
    历史: []
    部长会话: minister
    基线:
      项目根: D:\AI\workspace\临时文件夹\协作规则统一-20261030\s1-protocol-gap-vdxkdr
      提交: 614ab22b6ed43d97950418ab0f8214d68da7478a
      未跟踪: []
    零卡理由: 协议验证无需工人产物
  - 名字: 下游
    轮次: 1
    卡: []
    拆解结束: false
    历史: []
回边次数: {}
记录:
  - 时间: 2026-10-31T00:00:00Z
    事件: 请求主控裁定
    节点: 执行
    轮次: 1
    理由: 等待主控裁定 普通裁定:8be1fd10-fb72-4387-ad52-9c2f60d2a6e6:执行:1:-:-：核对成果；截止
      2026-10-31T00:30:00.000Z
待决:
  key: 普通裁定:8be1fd10-fb72-4387-ad52-9c2f60d2a6e6:执行:1:-:-
  kind: 普通裁定
  channel: 主控
  instance: 8be1fd10-fb72-4387-ad52-9c2f60d2a6e6
  node: 执行
  round: 1
  reason: 核对成果
  created_at: 2026-10-31T00:00:00Z
  deadline: 2026-10-31T00:30:00.000Z
  default_action: failed
  phase: 待处理
  items: []
暂停: 等待主控裁定:核对成果
裁定:
  节点: 执行
  轮次: 1
  理由: 核对成果
  通道: 主控
---
<!-- v2 流程控制正本，不得从卡重建或当缓存删除 -->
