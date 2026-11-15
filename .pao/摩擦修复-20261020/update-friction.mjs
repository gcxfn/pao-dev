// 用途：按本轮验收证据更新10月20日处置栏；输入：摩擦日志唯一正本；输出：原文件原位更新。
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'D:/AI/workspace/pao-dev/摩擦日志.md';
const updates = [
  ['机械验收沙箱把', '本轮不处理（用户 2026-10-20 明确排除磁盘空间再验收）；命令安检与沙箱规则保留'],
  ['派卡完成通知一次未送达', '已修（2026-10-20 源码及离线验收）：主动 followUp 唤醒主控，完整通知缓冲补投，关闭后不唤醒；盘点分开卡状态/当前尝试/历史回执。订正：in_progress 与最近尝试 failed 并非互斥。真实模型与已安装桌面未验'],
  ['worker 证据文件落在自身删除目标内', '已修（2026-10-20）：有卡时默认任务根 worker-evidence，裸 runner 使用实际 cwd/.pao/worker-evidence；删除预演保护证据及祖先目录。真文件/子进程测试通过，不宣称任意外部脚本绝不可能删除证据'],
  ['自报项计入机械验收惩罚诚实', '已修（2026-10-20）：自报 fail/not_run 停 owner 逐项复核，accepted_deviations 绑定当前 attempt/原始索引/条件及依据，总 basis 必填；机械失败、越界、声明变更和 blocked/checkpoint 仍阻断'],
  ['回执格式无兜底', '订正并补齐指引（2026-10-20）：当前已有 owner 完成复核入口，缺/坏 JSON 明确标成果待复核，引导 pao_change_status 加 basis；不把未知结果当成功，不绕过机械失败；failed 卡沿原合法状态迁移处理'],
  ['卡面机械验收段重复写入', '已修（2026-10-20）：同卡追加加文件锁；同 attempt、同时间、同验收事实重复不追加；真实结论变化保留新记录与历史，混合人工项/越界结论均参与去重'],
  ['`包含:` 验收的路径基准未文档化', '已修（2026-10-20）：工具说明写明相对项目根，读侧错误给出项目根与实际路径，真实 IO 错误不冒充 ENOENT'],
  ['删除类卡无 dry-run', '已修显式删除任务（2026-10-20）：正文声明删除目标→pao_preview_cleanup 只读列真实文件与各目标 Git 跟踪情况→owner 确认→共享派发门禁重核；目标变化失效，保护卡/证据/任务 cleanup 与任意 .git，不跟随链接。不宣称识别未声明的任意删除脚本'],
  ['`PAO_HOME` 指向开发仓', '诊断已修（2026-10-20）：预检/查库显示实际绝对根、缺失配置与初始化建议，正常未建部不误断为开发仓；权限等 IO 错误保留。原正式现场配置未改'],
  ['非 git 目录下越界核查静默失效', '已修提示（2026-10-20）：盘点明确显示越界核查未执行；删除预演逐目标标注 Git 未核查，不伪装未跟踪或无改动。合法非 Git 任务继续支持'],
  ['部门体系无「运维/清理」档', '已补（2026-10-20）：pao_create_dept 可显式选 preset=operations，含运维配方和默认能力标签；文档明确 dept 不是部长路由、直通由 owner 复核，需部门复核时显式启动部长/审查卡。未自动建立正式部门'],
  ['worker 脚本编码', '已修本地 write 路径（2026-10-20）：Windows 默认 write 写 .ps1 使用 UTF-8 BOM，已有 BOM 不叠加，edit 保留；真实 PowerShell 5.1 中文路径执行通过。其他程序/自定义远程写入仍由生成方指定编码；未证实它就是原缺 JSON 的原因'],
];
let lines = readFileSync(file, 'utf8').split(/\r?\n/);
for (const [key, disposition] of updates) {
  const matches = lines.map((line, index) => line.startsWith('| 2026-10-20 |') && line.includes(key) ? index : -1).filter(index => index >= 0);
  if (matches.length !== 1) throw new Error(`未唯一定位日志条目：${key}`);
  const index = matches[0];
  if (!/\| 未修；待立项.*\|$/.test(lines[index])) throw new Error(`处置已变化，停止自动覆盖：${key}`);
  lines[index] = lines[index].replace(/\| 未修；待立项.*\|$/, `| ${disposition} |`);
}
writeFileSync(file, lines.join('\n'));
