import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { pathKey } from "../shared/path-key.ts";
import { nowString } from "../shared/time.ts";
import {
	type BaselineDiff,
	type BoundaryWriteCheck,
	baselineSnapshotPath,
	checkBoundaryWrite,
	diffAgainstBaseline,
} from "./baseline.ts";
import { listCards, loadCard, projectRootForCards, readCard, serializeCard } from "./cardfile.ts";
import { formatCardNumber, parseCardRef } from "./counter.ts";
import { PaoCardError } from "./errors.ts";
import { runCardProcess as runProc } from "./process.ts";
import { changeCardStatus } from "./statemachine.ts";
import type { ParsedCard, Receipt } from "./types.ts";
import { findUnlockedCards, renderUnlockNotice, wakeupViews } from "./wakeup.ts";

/**
 * 机械验收员（架构 §12，2026-10-02 定案）：
 * - 验收字段 v1 只三种机械句式：跑命令看退出码（跑:）/文件存在（存在:）/文本包含（包含:），
 *   逐行解析；其余行照旧＝人话句（人工/审查口径），可与机械条目混写。
 * - 「跑命令」在临时影子沙箱执行：robocopy 多线程增量拷项目源码（跳 node_modules/.git/.pao、
 *   不拷 .env、/XJ 不跟随联接点），node_modules 以目录联接指回真目录；.env 不拷、密钥环境
 *   变量不传（白名单 env）；工作目录锁沙箱＋超时。
 * - 叠加句式安检（执行前拦形状不对的命令）：禁 shell 串联符、禁删除类动词（整串分词扫描）、
 *   禁绝对路径（盘符/~/git-bash 式//开头）、禁嵌套壳调用（cmd/powershell/pwsh/bash/sh/wsl
 *   作命令头即拒）、禁 node_modules 路径（联接指回真目录，写它＝写真项目）。
 * - 项目含指向外部的 junction/symlink 时拒绝跑命令自动验收并亮明原因（R16）。
 * - 收尾：全过删沙箱；有败保留沙箱（按卡编号命名）供主控排障；存在/包含只读直查真项目。
 * - 交付规则：验收全部为机械条目且全过 → 自动落已交付（经 statemachine.changeCardStatus，
 *   owner 权威不变）；混有人话句或有败/无法机械判 → 停给主控，不自动交付。
 * - 卡协议 14 字段不动：解析与核对结果只作为派生数据追加在正文 `## 机械验收` 段。
 */

// ============================================================================
// 验收条目解析（纯函数）
// ============================================================================

export type CardEntryType = "跑" | "存在" | "包含" | "自报";

export interface MechanicalEntry {
	序号: number;
	类型: CardEntryType;
	/** 句式主体：跑=命令串；存在/包含=相对项目根路径 */
	主体: string;
	/** 包含句式的子串（其余类型 undefined） */
	子串?: string;
	原文: string;
}

export interface ParseEntry {
	mechanicalEntry: MechanicalEntry[];
	plainSentence: string[];
}

/** 行首机械句式前缀（容忍列表符与全角冒号） */
const entryPrefix: readonly { type: CardEntryType; prefix: RegExp }[] = [
	{ type: "跑", prefix: /^跑\s*[:：]\s*/ },
	{ type: "存在", prefix: /^存在\s*[:：]\s*/ },
	{ type: "包含", prefix: /^包含\s*[:：]\s*/ },
];

/**
 * 验收字段 → 结构化条目：逐行扫描，命中三种句式前缀即机械条目，其余行为人话句。
 * 纯函数；建卡侧可复用本函数在建卡时即校验条目形状（配合点说明见模块尾注）。
 */
export function parseAcceptance(acceptance: string): ParseEntry {
	const mechanicalEntry: MechanicalEntry[] = [];
	const plainSentence: string[] = [];
	for (const rawLine of acceptance.split(/\r?\n/)) {
		const line = rawLine.trim().replace(/^[-*]\s+/, "");
		if (line.length === 0) continue;
		let matched = false;
		for (const { type, prefix } of entryPrefix) {
			const m = prefix.exec(line);
			if (!m) continue;
			const rest = line.slice(m[0].length).trim();
			if (rest.length === 0) break; // 前缀后为空：当作残句归人话，不生成空条目
			if (type === "包含") {
				// 包含句式：<相对路径> :: <子串>；无 :: 分隔视为残句归人话
				const sep = /\s+::\s+/.exec(rest) ?? /::/.exec(rest);
				if (!sep) break;
				const path = rest.slice(0, sep.index).trim();
				const substring = rest.slice(sep.index + sep[0].length).trim();
				if (path.length === 0 || substring.length === 0) break;
				mechanicalEntry.push({
					序号: mechanicalEntry.length + 1,
					类型: type,
					主体: path,
					子串: substring,
					原文: line,
				});
			} else {
				mechanicalEntry.push({ 序号: mechanicalEntry.length + 1, 类型: type, 主体: rest, 原文: line });
			}
			matched = true;
			break;
		}
		if (!matched) plainSentence.push(line);
	}
	return { mechanicalEntry: mechanicalEntry, plainSentence: plainSentence };
}

// ============================================================================
// 句式安检门（纯函数，R16）
// ============================================================================

const concatSymbol = /[&|<>`;]/;
const deleteVerb = new Set([
	"rm",
	"rmdir",
	"del",
	"rd",
	"erase",
	"unlink",
	"shred",
	"remove-item",
	"ri",
	"deltree",
	"format",
	"mkfs",
	"diskpart",
]);
const shellCommandHead = new Set([
	"cmd",
	"cmd.exe",
	"powershell",
	"powershell.exe",
	"pwsh",
	"pwsh.exe",
	"bash",
	"sh",
	"wsl",
	"wsl.exe",
	"zsh",
]);

export interface SecurityVerdict {
	过: boolean;
	违规: string[];
}

/** 分词：按空白切，去引号包裹（安检按整串分词扫描，非仅命令头）。 */
function tokenize(command: string): string[] {
	return command
		.replace(/["']/g, "")
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

/**
 * 执行用分词：引号感知——双引号段作为单个参数整体保留（内层引号原样），
 * 使 `node -e "require('fs').writeFileSync(…)"` 这类带字符串字面量的参数不被拆散剥皮。
 * 安检仍用分词的剥引号视图（两视图叠加：安检拦形状，执行保语义）。
 */
function tokenizeForExec(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const ch of command) {
		if (quote) {
			if (ch === quote) {
				if (current.length > 0) tokens.push(current);
				current = "";
				quote = undefined;
			} else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (current.length > 0) tokens.push(current);
			current = "";
		} else current += ch;
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

function isAbsolutePath(token: string): boolean {
	return (
		/^[a-zA-Z]:/.test(token) || // 盘符
		token.startsWith("~/") ||
		token.startsWith("~\\") ||
		token.startsWith("/") || // POSIX 绝对 / git-bash 式 /c/...
		token.startsWith("\\")
	);
}

/**
 * 跑命令句式安检（§12.2，执行前拦「形状不对」的命令）：
 * - 禁 shell 串联符（& ; | > < ` 与换行/$()——要跑两步就写两条目；
 * - 禁删除类动词：整串分词扫描，任何位置命中即拒（验收只查不改）；
 * - 禁绝对路径：盘符、~/、/ 开头（含 git-bash 式盘符路径）一律拒，只收相对沙箱的相对路径；
 * - 禁嵌套壳调用：cmd/powershell/pwsh/bash/sh/wsl/zsh 作命令头即拒（拦不含串联符的绕过）；
 * - 禁 node_modules 路径：联接指回真目录，写它＝写真项目（R16 知情声明）。
 */
export function checkCommandSafety(command: string): SecurityVerdict {
	const violation: string[] = [];
	if (/[\r\n]/.test(command)) violation.push("禁换行（多步拆多条目）");
	if (concatSymbol.test(command)) violation.push("禁 shell 串联符（& ; | > < `）");
	if (/\$\(/.test(command)) violation.push("禁命令替换 $(…)");
	const tokens = tokenize(command);
	if (tokens.length > 0) {
		const head = tokens[0].toLowerCase();
		if (shellCommandHead.has(head)) violation.push(`禁嵌套壳调用（命令头 ${tokens[0]}）`);
	}
	for (const token of tokens) {
		const lower = token.toLowerCase().replace(/\.exe$/, "");
		if (deleteVerb.has(lower)) violation.push(`禁删除类动词（${token}）`);
	}
	for (const token of tokens) {
		if (isAbsolutePath(token)) violation.push(`禁绝对路径（${token}，只收相对沙箱的相对路径）`);
	}
	if (/node_modules/.test(command.toLowerCase()))
		violation.push("禁 node_modules 路径（联接指回真目录，写它＝写真项目）");
	return { 过: violation.length === 0, 违规: violation };
}

// ============================================================================
// 临时影子沙箱（§12.2）
// ============================================================================

export interface SandboxOptions {
	signal?: AbortSignal;
	/** 影子沙箱根目录；缺省 <系统临时目录>/pao-验收沙箱。按项目保留同名影子目录增量刷新。 */
	sandbox_root?: string;
	/** 单条命令超时毫秒，缺省 120000 */
	命令超时毫秒?: number;
}

export interface SandboxBuildResult {
	/** 沙箱工作目录（项目源码副本） */
	workDir: string;
	/** 指向外部的链接清单（发现即拒绝跑命令自动验收，R16） */
	externalLink: string[];
}

const scanSkipDirs = new Set(["node_modules", ".git", ".pao"]);
const copyExcludeDirs = ["node_modules", ".git", ".pao"];

/** git 仓库顶层（从卡目录向上找）；非 git 返回 undefined。 */
async function findProjectRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	const out = await runProc("git", ["rev-parse", "--show-toplevel"], cwd, 15000, undefined, signal);
	return out.code === 0 && out.stdout.trim().length > 0 ? path.normalize(out.stdout.trim()) : undefined;
}

/** 项目根推导：git 顶层优先；非 git（纯目录工作区）复用 cardfile 的 projectRootForCards——
 * 平铺 .pao/卡 与任务 .pao/<任务>/卡 同一口径（执行/回执侧也用它，单一实现无两处口径漂移）。 */
async function resolveProjectRoot(cardDir: string, signal?: AbortSignal): Promise<string> {
	const root = await findProjectRoot(cardDir, signal);
	if (root) return root;
	return projectRootForCards(cardDir);
}

/** 深度优先扫项目内链接，返回指向项目外部的 junction/symlink（跳 node_modules/.git/.pao，容量上限防大库）。 */
function findExternalLinks(projectRoot: string): string[] {
	const external: string[] = [];
	// 比对键：反斜杠折叠正斜杠（startsWith 前缀判定依赖统一分隔符），大小写折叠走 pathKey 正本
	const rootCompare = pathKey(projectRoot.replace(/\\/g, "/")).replace(/\/+$/, "");
	let visited = 0;
	const walk = (dir: string, depth: number): void => {
		if (depth > 12 || visited > 20000 || external.length >= 10) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (scanSkipDirs.has(name)) continue;
			visited++;
			if (visited > 20000) return;
			const full = path.join(dir, name);
			let st: ReturnType<typeof lstatSync>;
			try {
				st = lstatSync(full);
			} catch {
				continue;
			}
			if (st.isSymbolicLink()) {
				try {
					const target = path.resolve(dir, readlinkSync(full));
					const t = pathKey(target.replace(/\\/g, "/"));
					if (t !== rootCompare && !t.startsWith(`${rootCompare}/`)) external.push(full);
				} catch {
					external.push(full);
				}
				continue; // 不跟随
			}
			if (st.isDirectory()) walk(full, depth + 1);
		}
	};
	walk(projectRoot, 0);
	return external;
}

function sanitizeProjectName(projectRoot: string): string {
	return path.basename(projectRoot).replace(/[^\w\u4e00-\u9fff.-]+/g, "_") || "项目";
}

function isSymlinkLike(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * junction/符号链接安全删除（红线，pnpm#10707 级事故教训）：
 * 先对 junction 本身单独 unlink 解除链接，再删其余；手工递归删除，遇链接只 unlink 不深入——
 * 绝不允许递归删除穿透 junction 删掉真目录。
 */
export function removeSandboxSafe(target: string): void {
	if (!existsSync(target) && !isSymlinkLike(target)) return;
	if (isSymlinkLike(target)) {
		unlinkSync(target);
		return;
	}
	const st = lstatSync(target);
	if (!st.isDirectory()) {
		unlinkSync(target);
		return;
	}
	for (const name of readdirSync(target)) {
		removeSandboxSafe(path.join(target, name));
	}
	try {
		rmdirOrUnlink(target);
	} catch {
		// 只读/占用残留不掩盖主流程；下次增量刷新覆盖
	}
}

function rmdirOrUnlink(p: string): void {
	if (isSymlinkLike(p)) unlinkSync(p);
	else rmSync(p, { recursive: true, force: true });
}

function copyWithNodeFallback(projectRoot: string, workDir: string): void {
	// 非 Windows 兜底：安全删旧＋过滤拷贝。Windows 主路径是 robocopy 增量，不经过这里。
	removeSandboxSafe(workDir);
	mkdirSync(workDir, { recursive: true });
	const isExcludedEnv = (p: string) => {
		const base = path.basename(p).toLowerCase();
		return base === ".env" || base.startsWith(".env.");
	};
	const walk = (src: string, dst: string, depth: number): void => {
		if (depth > 40) return;
		for (const name of readdirSync(src)) {
			if (scanSkipDirs.has(name)) continue;
			const s = path.join(src, name);
			const d = path.join(dst, name);
			const st = lstatSync(s);
			if (st.isSymbolicLink()) continue; // 一律不拷链接（/XJ 等价）
			if (isExcludedEnv(s)) continue; // .env 不拷
			if (st.isDirectory()) {
				mkdirSync(d, { recursive: true });
				walk(s, d, depth + 1);
			} else copyFileSync(s, d);
		}
	};
	walk(projectRoot, workDir, 0);
}

/**
 * 构建/刷新影子沙箱：按项目保留同名影子目录（<沙箱根>/<项目名>/work），robocopy 增量刷新
 * （默认只拷差异），跳 node_modules/.git/.pao、不拷 .env、/XJ 不跟随联接点；node_modules 以
 * 目录联接（免管理员权限）指回真目录。返回工作目录与外部链接清单（调用方拒绝自动验收用）。
 */
export async function refreshShadowSandbox(projectRoot: string, options?: SandboxOptions): Promise<SandboxBuildResult> {
	options?.signal?.throwIfAborted();
	const sandboxRoot = options?.sandbox_root ?? path.join(tmpdir(), "pao-验收沙箱");
	const projectName = sanitizeProjectName(projectRoot);
	const workDir = path.join(sandboxRoot, projectName, "work");
	mkdirSync(workDir, { recursive: true });

	// 拷贝前先解除上一次遗留的 node_modules 联接：robocopy 不可经联接写入真目录（红线前置）
	const shadowNode = path.join(workDir, "node_modules");
	if (isSymlinkLike(shadowNode)) unlinkSync(shadowNode);

	if (process.platform === "win32") {
		// robocopy 多线程增量：/E 含子目录（默认只拷差异不删残留）、/XD 按名排除目录、
		// /XF 排除 .env、/XJ 不跟随联接点（防把外部目录拷进来）、/MT 多线程。退出码 <8 视为成功（1=有拷贝）。
		const out = await runProc(
			"robocopy",
			[
				projectRoot,
				workDir,
				"/E",
				"/XD",
				...copyExcludeDirs,
				"/XF",
				".env",
				".env.*",
				"/XJ",
				"/MT:8",
				"/R:2",
				"/W:1",
				"/NFL",
				"/NDL",
				"/NJH",
				"/NJS",
			],
			projectRoot,
			120000,
			undefined,
			options?.signal,
		);
		if (out.code >= 8) {
			throw new PaoCardError(
				"INVALID_CARD",
				`影子沙箱 robocopy 失败（exit ${out.code}）：${out.stderr.slice(0, 300)}`,
				{
					项目根: projectRoot,
				},
			);
		}
	} else {
		copyWithNodeFallback(projectRoot, workDir);
	}

	// node_modules 目录联接指回真目录（免管理员权限；跑依赖时 import 解析可用）
	const realNode = path.join(projectRoot, "node_modules");
	if (existsSync(realNode)) {
		symlinkSync(realNode, shadowNode, "junction");
	}

	const externalLink = findExternalLinks(projectRoot);
	return { workDir: workDir, externalLink: externalLink };
}

/** 沙箱收尾：全过删沙箱（junction 先解除）；有败/无法判按卡改名保留供主控排障。 */
export function settleSandbox(workDir: string, cardNo: number, keep: boolean): string | undefined {
	if (!keep) {
		removeSandboxSafe(workDir);
		return undefined;
	}
	const shadowProjectDir = path.dirname(workDir);
	const sandboxRoot = path.dirname(shadowProjectDir);
	const projectName = path.basename(shadowProjectDir);
	const keepPath = path.join(sandboxRoot, "保留", `${projectName}-${formatCardNumber(cardNo)}-沙箱`);
	// 红线：保留的排障副本不带活联接——先对 junction 本身单独 unlink，再搬移其余
	const shadowNode = path.join(workDir, "node_modules");
	if (isSymlinkLike(shadowNode)) unlinkSync(shadowNode);
	mkdirSync(path.dirname(keepPath), { recursive: true });
	try {
		if (existsSync(keepPath)) removeSandboxSafe(keepPath);
		renameSync(workDir, keepPath);
	} catch {
		return workDir; // 改名失败则原位保留
	}
	writeFileSync(
		path.join(keepPath, "pao-沙箱说明.txt"),
		`${formatCardNumber(cardNo)} 机械验收有败/无法判，影子沙箱副本保留供主控排障（node_modules 联接已解除，防穿透误删）。\n`,
	);
	return keepPath;
}

/** 沙箱进程环境白名单：.env 不拷、密钥环境变量不传（§12.2 环境净化）。 */
function sanitizedEnv(): NodeJS.ProcessEnv {
	const allowed = [
		"PATH",
		"Path",
		"SystemRoot",
		"SYSTEMROOT",
		"SystemDrive",
		"ComSpec",
		"PATHEXT",
		"TEMP",
		"TMP",
		"USERPROFILE",
		"HOME",
		"NO_COLOR",
		"CI",
	];
	const env: NodeJS.ProcessEnv = {};
	for (const key of allowed) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	return env;
}

// ============================================================================
// 核对执行与结论
// ============================================================================

export type EntryResultState = "过" | "未过" | "安检拦截" | "无法判";

export interface EntryResult {
	序号: number;
	类型: CardEntryType;
	摘要: string;
	结果: EntryResultState;
	说明: string;
}

export type AcceptanceVerdict = "全过自动交付" | "全过停人工审" | "未过" | "无法机械判";

export interface AcceptanceResult {
	card_no: number;
	结论: AcceptanceVerdict;
	条目结果: EntryResult[];
	人话句: string[];
	自动交付?: boolean;
	交付说明?: string;
	/** 自动交付前的 git 真值比对（§14 对 worker 自报 changes/产物路径 的核查；无可核面时缺省）。 */
	越界核查?: BoundaryWriteCheck;
	沙箱保留路径?: string;
	汇总: string;
}

/** 验收段标题格式冻结：`## 机械验收 YYYY-MM-DD HH:mm`，解析与追加都靠它。 */
export const VERDICT_HEADING_PATTERN = /^## 机械验收 (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;

/** 卡上派生数据的落盘段（不进 frontmatter，14 字段协议不动）。 */
function serializeVerdictSection(result: AcceptanceResult, time: string): string {
	const lines = [`## 机械验收 ${time}`];
	lines.push(`- 结论: ${result.结论}`);
	for (const r of result.条目结果) {
		lines.push(`- [${r.类型}] ${r.摘要} → ${r.结果}（${r.说明}）`);
	}
	if (result.人话句.length > 0) lines.push(`- 人话句 ${result.人话句.length} 条待主控审`);
	if (result.交付说明) lines.push(`- 交付: ${result.交付说明}`);
	if (result.越界核查) lines.push(`- 越界核查: ${result.越界核查.结论}（${result.越界核查.汇总}）`);
	if (result.沙箱保留路径) lines.push(`- 沙箱: 保留于 ${result.沙箱保留路径}`);
	return lines.join("\n");
}

export interface CardAcceptanceRecord {
	时间: string;
	结论: string;
	原文: string;
}

/** 读卡正文最近一次机械验收记录（交卷侧衔接用；无记录返回 undefined）。 */
export function readLatestVerdict(body: string): CardAcceptanceRecord | undefined {
	const lines = body.split(/\r?\n/);
	let found: { 时间: string; 结论: string; start: number } | undefined;
	for (let i = 0; i < lines.length; i++) {
		const m = VERDICT_HEADING_PATTERN.exec(lines[i].trim());
		if (m) {
			let verdict = "";
			for (let j = i + 1; j < lines.length; j++) {
				if (/^## /.test(lines[j].trim())) break;
				const f = /^-\s*结论:\s*(.+)$/.exec(lines[j].trim());
				if (f) {
					verdict = f[1].trim();
					break;
				}
			}
			found = { 时间: m[1], 结论: verdict, start: i };
		}
	}
	if (!found) return undefined;
	const end = lines.findIndex((l, idx) => idx > found!.start && /^## /.test(l.trim()));
	const originalText = lines
		.slice(found.start, end === -1 ? lines.length : end)
		.join("\n")
		.trim();
	return { 时间: found.时间, 结论: found.结论, 原文: originalText };
}

/**
 * 存在/包含读侧路径安检（与跑命令安检门同等级，R16）：只收相对项目根内的路径——
 * 禁绝对路径（盘符/根开头）、禁反斜杠（Windows 变体）、禁 `..` 越出项目根（防读根外任意文件如 .env）。
 * 违规返回说明，合规返回 undefined。
 */
function checkReadPath(subject: string, projectRoot: string): string | undefined {
	if (subject.includes("\\")) return "禁反斜杠路径（Windows 变体），用 / 分隔";
	if (path.isAbsolute(subject) || /^[a-zA-Z]:/.test(subject)) return "禁绝对路径，写相对项目根的相对路径";
	const rel = path.relative(path.resolve(projectRoot), path.resolve(projectRoot, subject));
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		return "路径越出项目根（禁 .. 越界读根外文件）";
	}
	return undefined;
}

async function checkFileEntries(entry: MechanicalEntry[], projectRoot: string): Promise<EntryResult[]> {
	const results: EntryResult[] = [];
	for (const e of entry) {
		if (e.类型 === "存在") {
			const violation = checkReadPath(e.主体, projectRoot);
			if (violation) {
				results.push({ 序号: e.序号, 类型: e.类型, 摘要: e.主体, 结果: "安检拦截", 说明: violation });
				continue;
			}
			const ok = existsSync(path.join(projectRoot, e.主体));
			results.push({
				序号: e.序号,
				类型: e.类型,
				摘要: e.主体,
				结果: ok ? "过" : "未过",
				说明: ok ? "文件存在" : "文件不存在",
			});
		} else if (e.类型 === "包含") {
			const violation = checkReadPath(e.主体, projectRoot);
			if (violation) {
				results.push({
					序号: e.序号,
					类型: e.类型,
					摘要: `${e.主体} :: ${e.子串}`,
					结果: "安检拦截",
					说明: violation,
				});
				continue;
			}
			const abs = path.join(projectRoot, e.主体);
			let ok = false;
			let description = "文件不存在";
			try {
				const text = readFileSync(abs, "utf8");
				ok = text.includes(e.子串 ?? "");
				description = ok ? "找到目标文本" : "未找到目标文本";
			} catch (error) {
				description = `读取失败：${String((error as Error).message).slice(0, 120)}`;
			}
			results.push({
				序号: e.序号,
				类型: e.类型,
				摘要: `${e.主体} :: ${e.子串}`,
				结果: ok ? "过" : "未过",
				说明: description,
			});
		}
	}
	return results;
}

async function runCommandEntries(
	entry: MechanicalEntry[],
	projectRoot: string,
	cardNo: number,
	options?: SandboxOptions,
): Promise<{ 结果: EntryResult[]; 沙箱保留路径?: string }> {
	const results: EntryResult[] = [];
	const securityVerdict = new Map(
		entry.map((e) => {
			const check = checkCommandSafety(e.主体);
			return [e.序号, check] as const;
		}),
	);
	for (const e of entry) {
		const check = securityVerdict.get(e.序号)!;
		if (!check.过) {
			results.push({ 序号: e.序号, 类型: e.类型, 摘要: e.主体, 结果: "安检拦截", 说明: check.违规.join("；") });
		}
	}
	const executable = entry.filter((e) => securityVerdict.get(e.序号)!.过);
	if (executable.length === 0) {
		return { 结果: results };
	}
	const { workDir, externalLink } = await refreshShadowSandbox(projectRoot, options);
	if (externalLink.length > 0) {
		const reason = `项目含指向外部的 junction/symlink ${externalLink.length} 处（如 ${externalLink[0]}），影子拷贝不完整，拒绝自动验收（R16）`;
		for (const e of executable) {
			results.push({ 序号: e.序号, 类型: e.类型, 摘要: e.主体, 结果: "无法判", 说明: reason });
		}
		return { 结果: results };
	}
	const timeout = options?.命令超时毫秒 ?? 120000;
	for (const e of executable) {
		options?.signal?.throwIfAborted();
		const tokens = tokenizeForExec(e.主体);
		const head = tokens[0];
		const args = tokens.slice(1);
		let out: { code: number; stdout: string; stderr: string };
		try {
			out = await runProc(head, args, workDir, timeout, sanitizedEnv(), options?.signal);
		} catch (error) {
			// 停止链自身失败（如高负载下树杀 PowerShell 报错）：该条降级为「无法判」留主控，
			// 不炸穿 verifyCard；取消语义（AbortError）照旧向上抛，不吞。
			// 说明截尾保留（.slice(-160)）：execFile 报文头部是 powershell 路径＋脚本回显样板，
			// 真实原因（如 Tree member still alive: N）在尾部 1000+ 字符之后，截头只会留样板。
			options?.signal?.throwIfAborted();
			results.push({
				序号: e.序号,
				类型: e.类型,
				摘要: e.主体,
				结果: "无法判",
				说明: `验收命令停止链失败：${String((error as Error).message ?? error).slice(-160)}`,
			});
			continue;
		}
		const ok = out.code === 0;
		results.push({
			序号: e.序号,
			类型: e.类型,
			摘要: e.主体,
			结果: ok ? "过" : "未过",
			说明: ok
				? "exit 0"
				: `exit ${out.code}${out.stderr.trim().length > 0 ? `：${out.stderr.trim().slice(0, 160)}` : ""}`,
		});
	}
	// 收尾：全过删沙箱；有败按卡保留沙箱（junction 已解除）供主控进场排障
	const batchAllPassed = executable.every((e) => results.find((r) => r.序号 === e.序号)?.结果 === "过");
	const sandboxKeepPath = settleSandbox(workDir, cardNo, !batchAllPassed);
	return { 结果: results, 沙箱保留路径: sandboxKeepPath };
}

export interface VerifyCardOptions extends SandboxOptions {
	/** 调用者身份（owner 名）——自动交付经 changeCardStatus 的单写者校验用 */
	operator: string;
	时间?: string;
}

/**
 * 机械验收总入口（工具 pao_verify_card 与 §11 驱动器共用）：
 * 解析条目 → 存在/包含直查真项目 → 跑命令安检后进影子沙箱 → 汇总三态结论 →
 * 全机械全过且状态进行中自动落已交付 → 派生结果落卡正文 `## 机械验收` 段（14 字段不动）。
 */
export async function verifyCard(
	cardsDir: string,
	cardNo: number,
	options: VerifyCardOptions,
): Promise<{ card: ParsedCard; result: AcceptanceResult }> {
	options.signal?.throwIfAborted();
	const card = loadCard(cardsDir, cardNo);
	const { mechanicalEntry, plainSentence } = parseAcceptance(card.frontmatter.acceptance);
	const time = options.时间 ?? nowString();
	// 最新当前尝试（非留档）回执的 worker 自报（S5 包1）；无回执＝旧链路，行为照旧
	const latestReceipt = [...card.receipts].reverse().find((r) => r.archive_flag === undefined);

	if (mechanicalEntry.length === 0 && (latestReceipt?.verification?.length ?? 0) === 0) {
		const result: AcceptanceResult = {
			card_no: card.card_no,
			结论: "无法机械判",
			条目结果: [],
			人话句: plainSentence,
			汇总: `验收无可机械核对的条目（${plainSentence.length} 条人话句），走人工/审查口径（§12 边界）`,
		};
		options.signal?.throwIfAborted();
		appendVerdict(card, result, time);
		return { card: readCard(card.path), result };
	}

	const entryResults: EntryResult[] = [];
	let sandboxKeepPath: string | undefined;
	if (mechanicalEntry.length > 0) {
		const projectRoot = await resolveProjectRoot(cardsDir, options.signal);
		const containsExist = mechanicalEntry.filter((e) => e.类型 !== "跑");
		const runEntries = mechanicalEntry.filter((e) => e.类型 === "跑");
		entryResults.push(...(await checkFileEntries(containsExist, projectRoot)));
		if (runEntries.length > 0) {
			const run = await runCommandEntries(runEntries, projectRoot, card.card_no, options);
			entryResults.push(...run.结果);
			sandboxKeepPath = run.沙箱保留路径;
		}
	}
	// 自报 verification 消费（只拦不放行，§12.2）：fail/not_run 各生成一条未过；pass 不免检不授予
	(latestReceipt?.verification ?? []).forEach((v, idx) => {
		if (v.结论 !== "fail" && v.结论 !== "not_run") return;
		entryResults.push({
			序号: 1000 + idx,
			类型: "自报",
			摘要: v.条件,
			结果: "未过",
			说明: `worker 自报 ${v.结论}${v.证据 ? `（证据：${v.证据.slice(0, 200)}）` : "（无证据）"}`,
		});
	});
	entryResults.sort((a, b) => a.序号 - b.序号);

	const hasFailed = entryResults.some((r) => r.结果 === "未过" || r.结果 === "安检拦截");
	const hasIndeterminable = entryResults.some((r) => r.结果 === "无法判");
	let verdict: AcceptanceVerdict;
	if (hasFailed) verdict = "未过";
	else if (hasIndeterminable) verdict = "无法机械判";
	else if (plainSentence.length > 0) verdict = "全过停人工审";
	else verdict = "全过自动交付";

	const result: AcceptanceResult = {
		card_no: card.card_no,
		结论: verdict,
		条目结果: entryResults,
		人话句: plainSentence,
		汇总: "",
	};

	// 自动交付：验收全部为机械条目且全过（§12.1 交付规则）；混有人话句或有败一律停给主控；
	// S5 包1 叠加自报门：checkpoint/blocked 不冒充完成、git 真值比对 changes、验收哈希重审门
	options.signal?.throwIfAborted();
	if (verdict === "全过自动交付") {
		if (card.frontmatter.status === "in_progress") {
			const gate = await selfReportDeliveryGate(card, cardsDir, latestReceipt, options.signal);
			if (gate.越界核查) result.越界核查 = gate.越界核查;
			if (gate.阻断) {
				result.交付说明 = `机械全过但${gate.阻断}，不自动交付，留 owner 处理`;
			} else {
				changeCardStatus(card, {
					操作者: options.operator,
					to: "delivered",
					依据: `机械验收全部通过（${entryResults.length} 条全过），§12 自动交付`,
					时间: time,
				});
				result.自动交付 = true;
				result.交付说明 = "已自动落已交付";
			}
		} else {
			result.交付说明 = `机械全过但状态为 ${card.frontmatter.status}（非进行中），不自动交付，留主控处理`;
		}
	}

	result.汇总 =
		verdict === "全过自动交付"
			? `机械条目 ${entryResults.length} 条全过${result.自动交付 ? "，已自动落已交付" : `，${result.交付说明 ?? "未自动交付"}`}`
			: verdict === "全过停人工审"
				? `机械条目 ${entryResults.length} 条全过，另有 ${plainSentence.length} 条人话句，停给主控审（§12 不自动交付）`
				: verdict === "未过"
					? `机械验收 ${entryResults.filter((r) => r.结果 !== "过").length}/${entryResults.length} 条未过，输出结构化结果留 owner`
					: `存在无法机械判定的条目，留 owner（${entryResults.filter((r) => r.结果 === "无法判").length} 条无法判）`;
	if (sandboxKeepPath) result.沙箱保留路径 = sandboxKeepPath;

	options.signal?.throwIfAborted();
	appendVerdict(card, result, time);
	return { card: readCard(card.path), result };
}

/**
 * 自动交付自报门（S5 包1，§12.2 只拦不放行 + §14 git 真值比对）：
 * ① 最新回执 checkpoint/blocked → 不冒充完成；② 验收哈希与认领时不符 → 原许可失效须重审；
 * ③ 有改动声明（自报 changes 优先，缺省回落产物路径）→ git 真值比对，虚报/越界阻断。
 * 无认领快照（手动旧链路卡）时 ②③ 无从比对，机械全过照旧交付（行为不回退）。
 */
async function selfReportDeliveryGate(
	card: ParsedCard,
	cardsDir: string,
	latest: Receipt | undefined,
	signal?: AbortSignal,
): Promise<{ 阻断?: string; 越界核查?: BoundaryWriteCheck }> {
	if (latest?.任务态 === "checkpoint") return { 阻断: "最新回执为 checkpoint（到决策点须指引，不冒充完成）" };
	if (latest?.任务态 === "blocked") return { 阻断: "最新回执为 blocked（无法继续须用户输入，不走自动交付）" };
	let diff: BaselineDiff | undefined;
	try {
		diff = await diffAgainstBaseline(baselineSnapshotPath(cardsDir, card.card_no), signal);
	} catch {
		diff = undefined;
	}
	if (diff?.基线可用 && diff.验收哈希) {
		const currentHash = createHash("sha256").update(card.frontmatter.acceptance, "utf8").digest("hex");
		if (currentHash !== diff.验收哈希) return { 阻断: "验收声明已变化（与认领时不符，原许可失效），须 owner 重审" };
	}
	const declarations = latest?.changes?.length ? latest.changes.map((c) => c.路径) : latest?.artifact_path;
	if (diff?.基线可用 && declarations && declarations.length > 0) {
		const check = checkBoundaryWrite(diff, declarations, { 项目根: diff.项目根 });
		if (check.结论 === "虚报" || check.结论 === "越界" || check.结论 === "虚报+越界")
			return { 阻断: `越界核查 ${check.结论}（改动与声明对不上）：${check.汇总}`, 越界核查: check };
		return { 越界核查: check };
	}
	return {};
}

/** 把派生验收结果追加到卡正文（重读最新内容再写，缩小与回执/改状态并发的窗口）。 */
function appendVerdict(card: ParsedCard, result: AcceptanceResult, time: string): void {
	const fresh = readCard(card.path);
	const section = serializeVerdictSection(result, time);
	const body = fresh.body.trim().length > 0 ? `${fresh.body.trimEnd()}\n\n${section}\n` : `${section}\n`;
	writeFileAtomic(fresh.path, serializeCard(fresh.frontmatter, body));
}

// ============================================================================
// 工具注册（pao_verify_card）
// ============================================================================

const verifyParams = Type.Object({
	cards_dir: Type.Optional(
		Type.String({ description: "卡目录（任务工作区的 卡/ 目录，绝对路径）；已配置默认卡目录时可省略" }),
	),
	card_ref: Type.Union([Type.Number(), Type.String()], { description: "卡号（数字或 卡#N）" }),
	operator: Type.String({ description: "调用者身份（owner 名）；机械全过时以该身份自动落已交付" }),
	sandbox_root: Type.Optional(Type.String({ description: "影子沙箱根目录；缺省 <系统临时目录>/pao-验收沙箱" })),
	command_timeout_seconds: Type.Optional(Type.Number({ description: "单条跑命令超时秒，缺省 120" })),
});

async function executeVerify(
	params: Static<typeof verifyParams>,
	options?: VerifierToolsOptions,
	signal?: AbortSignal,
): Promise<string> {
	try {
		const cardsDir = params.cards_dir ?? options?.resolveCardsDir?.();
		if (!cardsDir) throw new PaoCardError("INVALID_CARD", "缺少 cards_dir 参数，且未配置默认卡目录", {});
		const { card, result } = await verifyCard(cardsDir, parseCardRef(String(params.card_ref)), {
			signal,
			operator: params.operator,
			sandbox_root: params.sandbox_root ?? options?.sandbox_root,
			命令超时毫秒:
				params.command_timeout_seconds !== undefined
					? params.command_timeout_seconds * 1000
					: options?.命令超时毫秒,
		});
		const lines = [`${formatCardNumber(result.card_no)} 机械验收：${result.结论}`, result.汇总];
		for (const r of result.条目结果) {
			lines.push(`  [${r.类型}] ${r.摘要} → ${r.结果}（${r.说明}）`);
		}
		if (result.人话句.length > 0)
			lines.push(`  人话句 ${result.人话句.length} 条待主控审：${result.人话句.join("／")}`);
		if (result.交付说明) lines.push(`  交付：${result.交付说明}`);
		// §19 通道①：机械验收自动落已交付时，下游就绪就地提示（无就绪卡零噪音）
		if (result.自动交付) {
			const note = renderUnlockNotice(findUnlockedCards(wakeupViews(listCards(cardsDir))));
			if (note) lines.push(note);
		}
		if (result.沙箱保留路径) lines.push(`  沙箱保留（排障）：${result.沙箱保留路径}`);
		lines.push(`结果已落 ${card.filename}（## 机械验收 派生段，卡协议字段未动）。`);
		if (result.结论 === "全过停人工审")
			lines.push("混有人话句：机械部分全过也不自动交付，主控审后经 pao_change_status 落终态。");
		if (result.结论 === "未过" || result.结论 === "无法机械判")
			lines.push("未自动交付：请 owner 复核后处理（修卡重派 / pao_change_status / 人工验收）。");
		return lines.join("\n");
	} catch (error) {
		if (error instanceof PaoCardError) throw new Error(`[${error.code}] ${error.message}`);
		throw error;
	}
}

export interface VerifierToolsOptions {
	/** 返回默认卡目录（任务工作区的 卡/ 目录）的解析函数。 */
	resolveCardsDir?: () => string;
	/** 影子沙箱根目录；缺省 <系统临时目录>/pao-验收沙箱 */
	sandbox_root?: string;
	/** 单条跑命令超时毫秒，缺省 120000 */
	命令超时毫秒?: number;
}

/** 注册机械验收员工具（pi 扩展入口）：pao_verify_card。主控可手动调用，§11 驱动器收回执后同一入口自动调用。 */
export function registerVerifierTools(pi: ExtensionAPI, options?: VerifierToolsOptions): void {
	pi.registerTool({
		name: "pao_verify_card",
		label: "机械验收",
		description:
			"机械验收员（§12）：解析卡验收字段的三种机械句式（跑:命令看退出码／存在:文件／包含:文件 :: 文本）并机械核对。跑命令在临时影子沙箱执行（不碰真项目、.env 与密钥不进沙箱、命令安检门拦串联符/删除动词/绝对路径/嵌套壳）。纯机械条目全过→自动落已交付；混有人话句→机械部分跑完停主控审；有败或无法机械判→输出结构化结果留 owner。结果作为派生数据落卡正文，不改卡协议字段。worker 不得调用（owner/驱动器侧专用）。",
		parameters: verifyParams,
		execute: async (_toolCallId, params, signal) => {
			const text = await executeVerify(params, options, signal);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}

/*
 * 配合点说明（不改他人文件的接线项）：
 * 1. cards/tools.ts 的 pao_create_card：建议在 createCard 前调 parseAcceptance(params.验收)，
 *    对命中「跑:/存在:/包含:」前缀但形状不完整的行（如 `跑:` 空主体、`包含: 无::分隔`）在建卡时
 *    即报结构化错误或提示——避免坏条目流到验收时才炸。tools.ts 由并行代理在改，故本批不动。
 * 2. §11 驱动器：收回执＋越界比对后调 verifyCard(cardsDir, 卡号, { operator: owner名 })，
 *    结论=全过自动交付 后调 delivery.deliverCard（§13 自动入口）——同一函数入口，工具只是壳。
 * 3. src/pao/cards/index.ts：追加 export * from "./verifier.ts"（并行代理同文件在改，留给接线批）。
 * 4. 架构 §12 写「新模块 src/pao/accept/」；本批按实施边界落在 src/pao/cards/verifier.ts
 *    （卡读写必须 import cards 现有函数，且禁止改既有 cards/*.ts 之外的共享目录），功能面无差。
 */
