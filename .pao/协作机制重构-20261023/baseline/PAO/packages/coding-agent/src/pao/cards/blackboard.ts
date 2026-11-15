/**
 * 任务黑板（架构 §任务工作区 / M2-03）：`.pao/黑板.md`——任务工作区内 worker 自由写的
 * 中间结论与同伴便条页（便签先挂链接再散写），任务归档即冻结。
 *
 * 机制砍到最小（「不增加一套数据库维持这些信息」是 M2-03 原文）：
 * - 首建：派发认领成功时 ensureBlackboard（存在即跳过,幂等）——模板只给纪律引导不预置内容；
 * - 指路：派发附加系统提示词注入黑板指针一行（指针＝路径＋读取目的,不搬运内容——
 *   「传递指针，不搬运内容」铁律）；worker 自己决定读不读；
 * - 谁在写项目/谁在等依赖：/pao queue 卡视图已有（owner＋状态＋依赖＋[就绪]），不在此重复；
 * - 便签被引用：不机械追踪——「先挂链接」是写法约定（模板引导），引用计数没有干净落点，
 *   建追踪库违反「不增加一套数据库」。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../shared/atomic.ts";

export const BLACKBOARD_FILENAME = "黑板.md";

/** 黑板住卡目录的父级＝任务工作区根（`.pao/黑板.md`,与 `卡/`、`产物/` 同级） */
export function blackboardPath(cardsDir: string): string {
	return join(dirname(cardsDir), BLACKBOARD_FILENAME);
}

export const BLACKBOARD_TEMPLATE = `# 任务黑板

本任务 worker 自由写：中间结论、给同伴的便条（任务归档即冻结,不再改本文件）。规则：

- 便签先挂链接再散写：\`- [标题](产物/文件名)\` 一行挂出,细节写在链接目标或该行下方
- 项目改动写回项目本体,不把改好的代码复制进本工作区;报告/补丁/截图等附件放 产物/
- 谁在写项目、谁在等依赖看 /pao queue（卡状态＋owner＋[就绪] 标记）;黑板只放过程结论,不记任务态
- 主控/部长不当搬运工：需要同伴看的内容挂链接,不复述正文

## 便签

`;

export function ensureBlackboard(cardsDir: string): "已建" | "已存在" {
	const path = blackboardPath(cardsDir);
	if (existsSync(path)) return "已存在";
	writeFileAtomic(path, BLACKBOARD_TEMPLATE);
	return "已建";
}

/** 派发附加系统提示词的指针行（worker cwd＝项目根,给相对路径＋读取目的） */
export function blackboardPointer(cardsDir: string): string {
	const projectRoot = dirname(dirname(cardsDir));
	// 卡目录不在「项目根/.pao/卡」平铺形状下(调用方自定义工作区)时退绝对路径,不硬猜
	const absolute = !cardsDir.startsWith(projectRoot);
	const location = absolute
		? blackboardPath(cardsDir).replaceAll("\\", "/")
		: `${dirname(cardsDir).slice(projectRoot.length + 1)}/${BLACKBOARD_FILENAME}`.replaceAll("\\", "/");
	const where = absolute ? location : `${location}(相对项目根)`;
	return `任务黑板:${where}——本任务同伴的中间结论与便条;接卡先瞄一眼,值得留给同伴的结论挂链接写进去(便签先挂链接再散写,任务归档即冻结)`;
}
