# 自建轻壳（Electron/Tauri 从模板起步）与 herdr 协议参照

- 日期：2026-10-02（晚）
- 状态：被否决／退役，由「fork pi-gui 为壳母体」取代

## 被否的方案

1. **自建轻壳**：M3 原定案「桌面壳走自建，抄三样（herdr 命名管道协议、ZCode Desktop 交互范式、Electron/Tauri 框架模板）」。
2. **herdr 相关一切**：包括已写进 OMP 销账采纳清单的「命名管道单向状态上报作壳↔本体观察通道协议参照」。

## 为什么否

- **herdr**：用户澄清「跟 herdr 完全没关系，之前是没对齐」——herdr 是误引入的参照（用户机器上装过、点 pi 条目跑的却是上游 pi），与本项目无真实关联，全部退役。此前围绕它做的盘点（29 agent 探测清单、ConPTY 结构）一并作废。
- **自建轻壳**：生态调研发现 pi-gui（社区做的 pi 桌面壳：MIT、1.1k stars、Electron＋React＋TS、901 commits）——它把「驱动 pi」隔离成独立包 `packages/pi-sdk-driver`，且「会话文件是唯一真相」与 PAO「不造第二套任务真相」哲学同构，还带壳扩展机制。自建要手写的整层地基（窗口框架、终端嵌入、会话管理、diff 审查）它已写好；fork 母体路线只写真正的增量（pao 语义面板）。与 pi fork 路线同构（定制集中一层、跟上游 rebase）。
- **「先试兼容再 fork」也被否**：用户拍板「不试兼容，直接按 fork 母体路线走」——不做 Pi Desktop 自定义引擎指 pao 的零改动实验，起点就是 fork。

## 取代方案

fork pi-gui（github.com/minghinmatthewlam/pi-gui）为壳母体；终端与桌面＝两个运行时、共用一个文件系统（PAO_HOME＋~/.pi＋同一 fork 构建产物）、单实例互斥（运行时锁，worker 子进程豁免）。详见 `plans/未完成/2026-10-02-M3桌面壳.md` 选型节与 M3-01。

## 风险知情

pi-gui 仍在 Alpha 期（Windows 构建未签名）——「快速稳定」需求以 M3-05 真机验收为准，fork 后由我们自养；上游活跃度高（901 commits/1.1k stars）是 rebase 红利也是跟进成本。
