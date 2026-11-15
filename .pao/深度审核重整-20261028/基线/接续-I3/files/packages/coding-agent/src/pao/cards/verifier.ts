import { createHash, randomUUID } from "node:crypto";
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
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parse as parseShellCommand, type ParseEntry as ShellParseEntry } from "shell-quote";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { pathKey } from "../shared/path-key.ts";
import { createPythonCacheDir, PYTHON_CACHE_ENV } from "../shared/python-cache.ts";
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
import {
	type ExecutionKey,
	executionContextPath,
	type ResolvedExecutionContext,
	resolveExecutionContext,
} from "./execution-context.ts";
import { type CardProcessResult, runCardProcess as runProc } from "./process.ts";
import { currentAttemptReceipt, validateReceiptContent } from "./receipts.ts";
import { changeCardStatus } from "./statemachine.ts";
import type { ParsedCard, Receipt } from "./types.ts";
import { findUnlockedCards, renderUnlockNotice, wakeupViews } from "./wakeup.ts";

/**
 * 机械验收员（架构 §12，2026-10-02 定案）：
 * - 验收字段 v1 只三种机械句式：跑命令看退出码（跑:）/文件存在（存在:）/文本包含（包含:），
 *   逐行解析；其余行照旧＝人话句（人工/审查口径），可与机械条目混写。
 * - 「跑命令」在每次独立的临时影子沙箱执行：robocopy 多线程拷项目源码（跳 node_modules/.git/.pao、
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

/**
 * 建卡前验收静态预检：只检查最终验收文本的形状和安全边界，不执行命令、不要求未来产物存在。
 * 正常人话句保留；机械前缀后的空主体和包含句缺 `::` 属于残句，直接拒绝。
 * 这是 addNodeCards 整批发号前的公共门；逐条错误都给出行号和可替换写法，便于部长当场修正。
 */
export function validateAcceptance(acceptance: string, projectRoot: string): void {
	const invalid: string[] = [];
	const lines = acceptance.split(/\r?\n/);
	const { mechanicalEntry } = parseAcceptance(acceptance);
	const parsedEntries = new Map(mechanicalEntry.map((entry) => [entry.原文, entry]));
	const mechanicalPrefix = /^(?:跑|存在|包含)\s*[:：]/;

	const reject = (lineNo: number, line: string, reason: string, fix: string) => {
		invalid.push(`第 ${lineNo} 行「${line}」：${reason}；改法：${fix}`);
	};

	for (const [index, rawLine] of lines.entries()) {
		const lineNo = index + 1;
		const line = rawLine.trim().replace(/^[-*]\s+/, "");
		if (!line || !mechanicalPrefix.test(line)) continue;
		const entry = parsedEntries.get(line);
		if (!entry) {
			if (/^包含\s*[:：]/.test(line)) {
				reject(lineNo, line, "「包含」机械项缺少路径与文本的 `::` 分隔", "写成 `包含: 相对路径 :: 要查找的文本`");
			} else {
				reject(lineNo, line, "机械项主体为空或句式不完整", "冒号后必须填写主体，例如 `跑: node scripts/检查.js`");
			}
			continue;
		}
		if (entry.类型 === "跑") {
			const safety = checkCommandSafety(entry.主体);
			if (!safety.过) {
				reject(
					lineNo,
					line,
					`命令未通过静态安检：${safety.违规.join("；")}`,
					"改用一条相对路径命令；多步拆成多条 `跑:`，不要串联、重定向、嵌套壳或使用绝对路径",
				);
			}
		} else {
			const violation = checkReadPath(entry.主体, projectRoot);
			if (violation) {
				reject(
					lineNo,
					line,
					`读路径未通过静态安检：${violation}`,
					"改用 `/` 分隔、位于项目根内的相对路径，例如 `src/结果.txt`",
				);
			}
		}
	}

	if (invalid.length > 0) {
		throw new PaoCardError(
			"INVALID_CARD",
			`[INVALID_CARD] 验收预检未通过：\n${invalid.map((item) => `- ${item}`).join("\n")}`,
			{
				项目根: projectRoot,
				问题: invalid,
			},
		);
	}
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

const shellEnvExpansionMarker = { paoShellEnvExpansion: true } as const;

interface ShellSyntaxInspection {
	/** 仅供 shell-quote 切词的规范化文本；绝不交给执行器。 */
	normalizedCommand: string;
	violations: string[];
}

/**
 * 一次遍历完成两件事：拒绝 shell-quote 会宽松接受的未支持语法，并把 Windows
 * 相对路径的反斜杠保护成字面分隔符。这里不解释命令、不产生执行 argv；执行只消费
 * shell-quote 对规范化文本解析出的同一份 argv。
 */
function inspectShellSyntax(command: string): ShellSyntaxInspection {
	const violations = new Set<string>();
	let normalized = "";
	if (command.trim().length === 0) return { normalizedCommand: normalized, violations: ["空命令"] };
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (quote === "'") {
			normalized += char;
			if (char === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			normalized += char;
			if (char === "\\") {
				if (index + 1 >= command.length) {
					violations.add("命令以单个反斜杠结尾，转义不完整");
					break;
				}
				normalized += command[++index];
			} else if (char === '"') {
				quote = undefined;
			} else if (char === "$") {
				violations.add("禁环境变量/参数展开");
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			normalized += char;
			continue;
		}
		if (char === "\\") {
			if (index + 1 >= command.length) {
				violations.add("命令以单个反斜杠结尾，转义不完整");
				break;
			}
			const next = command[index + 1];
			if (/[A-Za-z0-9._-]/.test(next)) {
				// 保留 Windows 相对路径中的一个字面反斜杠，不让 shell-quote 当作 POSIX 转义。
				normalized += "\\\\";
			} else {
				normalized += char;
				normalized += command[++index];
			}
			continue;
		}
		normalized += char;
		if (char === "$" && command[index + 1] === "'") {
			violations.add("禁 ANSI-C 引号（$'…'）");
			continue;
		}
		if (char === "$") {
			violations.add("禁环境变量/参数展开");
			continue;
		}
		if (char === "*" || char === "?" || char === "[" || char === "]") {
			violations.add("禁未引用的通配符或方括号模式");
		}
	}
	if (quote === "'") violations.add("单引号未闭合");
	if (quote === '"') violations.add("双引号未闭合");
	return { normalizedCommand: normalized, violations: [...violations] };
}

interface InspectedCommand {
	argv: string[];
	verdict: SecurityVerdict;
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
 * 旧安检的保守词视图：去掉全部引号后按空白切词。它只用于删除词和绝对路径检查，
 * 不参与执行，也不与 shell-quote 争抢参数语义；执行 argv 仍只有一个来源。
 */
function tokenizeSafetyWords(command: string): string[] {
	return command
		.replace(/["']/g, "")
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

function addWordSafetyViolations(tokens: readonly string[], violations: Set<string>): void {
	for (const token of tokens) {
		const lower = token.toLowerCase().replace(/\.exe$/, "");
		if (deleteVerb.has(lower)) violations.add(`禁删除类动词（${token}）`);
	}
	for (const token of tokens) {
		if (isAbsolutePath(token)) violations.add(`禁绝对路径（${token}，只收相对沙箱的相对路径）`);
	}
}

/**
 * 跑命令句式安检（§12.2，执行前拦「形状不对」的命令）：
 * - 禁 shell 串联符（& ; | > < ` 与换行/$()——要跑两步就写两条目；
 * - 禁删除类动词：整串分词扫描，任何位置命中即拒（验收只查不改）；
 * - 禁绝对路径：盘符、~/、/ 开头（含 git-bash 式盘符路径）一律拒，只收相对沙箱的相对路径；
 * - 禁嵌套壳调用：cmd/powershell/pwsh/bash/sh/wsl/zsh 作命令头即拒（拦不含串联符的绕过）；
 * - 禁 node_modules 路径：联接指回真目录，写它＝写真项目（R16 知情声明）。
 *
 * shell-quote 的解析结果就是最终 argv；预检与执行只调用本函数，避免两套分词
 * 对同一字符串给出不同含义。对象 token（环境展开、operator、comment、glob）
 * 一律不进入执行器。保守词视图只补充删除词和绝对路径检查，绝不用于执行。
 */
function inspectCommand(command: string): InspectedCommand {
	const violation = new Set<string>();
	if (/[\r\n]/.test(command)) violation.add("禁换行（多步拆多条目）");
	if (concatSymbol.test(command)) violation.add("禁 shell 串联符（& ; | > < `）");
	if (/\$\(/.test(command)) violation.add("禁命令替换 $(…)");
	const syntax = inspectShellSyntax(command);
	for (const item of syntax.violations) violation.add(item);

	let parsed: (ShellParseEntry | typeof shellEnvExpansionMarker)[] = [];
	try {
		parsed = parseShellCommand(syntax.normalizedCommand, () => shellEnvExpansionMarker);
	} catch (error) {
		violation.add(`命令解析失败：${String((error as Error).message ?? error).slice(0, 200)}`);
	}
	for (const token of parsed) {
		if (typeof token === "string") continue;
		if (token === shellEnvExpansionMarker) {
			violation.add("禁环境变量/参数展开");
		} else if ("comment" in token) {
			violation.add("禁 shell 注释");
		} else if ("op" in token) {
			if (token.op === "glob") violation.add("禁 shell 通配符");
			else violation.add(`禁 shell 操作符（${token.op}）`);
		} else {
			violation.add("禁非 string 的 shell 解析 token");
		}
	}
	const argv = parsed.filter((token): token is string => typeof token === "string");
	if (argv.length === 0) violation.add("空命令");
	else if (argv[0].trim().length === 0) violation.add("命令头不能为空或纯空白");
	if (argv.length > 0) {
		const head = argv[0].toLowerCase();
		if (shellCommandHead.has(head)) violation.add(`禁嵌套壳调用（命令头 ${argv[0]}）`);
		if (/^npx(?:\.cmd|\.exe)?$/.test(head) && !argv.includes("--no-install"))
			violation.add("npx 验收须显式加 --no-install；缺少本地工具应报告环境问题，不能临时联网安装同名包");
	}
	// 安全视图与执行 argv 各扫一遍，保留旧视图的保守命中面；两者都不用于执行。
	addWordSafetyViolations(tokenizeSafetyWords(command), violation);
	addWordSafetyViolations(argv, violation);
	// 内联脚本/--key=value 中的字面量同样属于显式路径；这不是解释器隔离。
	if (/(?:^|[\s'"=(:,[])(?:[a-zA-Z]:[/\\]|~[/\\]|\\\\|\/(?!\/)[\w.])/.test(command))
		violation.add("禁参数或内联脚本中的绝对路径字面量（只收相对沙箱的相对路径）");
	if (/node_modules/.test(command.toLowerCase()))
		violation.add("禁 node_modules 路径（联接指回真目录，写它＝写真项目）");
	return { argv, verdict: { 过: violation.size === 0, 违规: [...violation] } };
}

export function checkCommandSafety(command: string): SecurityVerdict {
	return inspectCommand(command).verdict;
}

// ============================================================================
// 临时影子沙箱（§12.2）
// ============================================================================

/** 可信宿主可限制模型产物的执行权限；不改变命令超时与取消契约。 */
export type VerificationCommandRunner = typeof runProc;

export interface SandboxOptions {
	verificationCommandRunner?: VerificationCommandRunner;
	signal?: AbortSignal;
	/** 影子沙箱根目录；缺省 <系统临时目录>/pao-验收沙箱。每次验收使用独立子目录。 */
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

/** 验收与执行、回执共用项目根；Git 仓库可包含多个项目，不能把仓库根当成项目根。 */
async function resolveProjectRoot(cardDir: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	return projectRootForCards(cardDir);
}

/** 深度优先扫项目内链接，返回指向项目外部的 junction/symlink（跳 node_modules/.git/.pao，容量上限防大库）。 */
function findExternalLinks(projectRoot: string): string[] {
	const external: string[] = [];
	// 比对键：反斜杠折叠正斜杠（startsWith 前缀判定依赖统一分隔符），大小写折叠走 pathKey 正本
	const rootCompare = pathKey(projectRoot.replace(/\\/g, "/")).replace(/\/+$/, "");
	let visited = 0;
	function incomplete(location: string, reason: unknown): never {
		throw new PaoCardError(
			"INVALID_CARD",
			`外链扫描不完整，不能自动验收：${location}（${reason instanceof Error ? reason.message : String(reason)}）`,
		);
	}
	const walk = (dir: string, depth: number): void => {
		if (external.length >= 10) return;
		if (depth > 12 || visited > 20000) incomplete(dir, "超出扫描容量，须人工核查");
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (error) {
			incomplete(dir, error);
		}
		for (const name of entries) {
			if (scanSkipDirs.has(name)) continue;
			visited++;
			if (visited > 20000) incomplete(dir, "超出扫描容量，须人工核查");
			const full = path.join(dir, name);
			let st: ReturnType<typeof lstatSync>;
			try {
				st = lstatSync(full);
			} catch (error) {
				incomplete(full, error);
			}
			if (!st) incomplete(full, "文件状态不可读");
			if (st.isSymbolicLink()) {
				try {
					const target = path.resolve(dir, readlinkSync(full));
					const t = pathKey(target.replace(/\\/g, "/"));
					if (t !== rootCompare && !t.startsWith(`${rootCompare}/`)) external.push(full);
				} catch (error) {
					incomplete(full, error);
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
		// 只读/占用残留不掩盖主流程；下一次验收使用新目录，不会读取这些残留。
	}
}

function rmdirOrUnlink(p: string): void {
	if (isSymlinkLike(p)) unlinkSync(p);
	else rmSync(p, { recursive: true, force: true });
}

function copyWithNodeFallback(projectRoot: string, workDir: string): void {
	// 非 Windows 兜底：过滤拷贝到本次独立目录。Windows 主路径使用 robocopy。
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
 * 构建影子沙箱：每次使用 <沙箱根>/<项目名>-<唯一标识>/work，避免跨次残留与并发清理干扰。
 * 跳 node_modules/.git/.pao、不拷 .env、/XJ 不跟随联接点；node_modules 以
 * 目录联接（免管理员权限）指回真目录。返回工作目录与外部链接清单（调用方拒绝自动验收用）。
 */
export async function refreshShadowSandbox(projectRoot: string, options?: SandboxOptions): Promise<SandboxBuildResult> {
	options?.signal?.throwIfAborted();
	const sandboxRoot = options?.sandbox_root ?? path.join(tmpdir(), "pao-验收沙箱");
	// 每次验收使用独立副本，另一轮的刷新、保留或清理不能移走当前命令的 cwd/依赖联接。
	const projectName = `${sanitizeProjectName(projectRoot)}-${randomUUID()}`;
	const workDir = path.join(sandboxRoot, projectName, "work");
	// 扫描失败在复制或命令执行前暴露；不可达不能冒充没有外链。
	const externalLink = findExternalLinks(projectRoot);
	mkdirSync(workDir, { recursive: true });

	const shadowNode = path.join(workDir, "node_modules");

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
	/** 本次核对绑定的卡面当前尝试。 */
	尝试: number;
	结论: AcceptanceVerdict;
	条目结果: EntryResult[];
	人话句: string[];
	自动交付?: boolean;
	交付说明?: string;
	/** 自动交付前的 git 真值比对（§14 对 worker 自报 changes/产物路径 的核查；无可核面时缺省）。 */
	越界核查?: BoundaryWriteCheck;
	沙箱保留路径?: string;
	/** 自报未达项的 owner 逐项复核状态；只有人工完成入口可消费接受记录。 */
	自报未达项?: {
		尝试: number;
		/** 当前 attempt 回执 verification 数组的 0 起稳定索引。 */
		verification_index: number;
		条件: string;
		自报结论: "fail" | "not_run";
		证据?: string;
	}[];
	汇总: string;
	/** 本次验收所读取的真实执行根与持久关联摘要。 */
	执行上下文?: {
		cardsDir: string;
		attempt: number;
		projectRoot: string;
		executionRoot: string;
		repositoryRoot: string;
		bindingDigest: string;
		worktreeBindingDigest: string;
		snapshotDigest: string;
		briefRef?: string;
	};
	/** 检查前后各捕获一次；两者不等时不允许放行。 */
	代码内容?: {
		基线Tree?: string;
		检查前Tree: string;
		检查后Tree: string;
		检查前HEAD: string;
		检查后HEAD: string;
		检查前内容摘要: string;
		检查后内容摘要: string;
	};
}

/** 验收段标题格式冻结：`## 机械验收 YYYY-MM-DD HH:mm`，解析与追加都靠它。 */
export const VERDICT_HEADING_PATTERN = /^## 机械验收 (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;

/** 卡上派生数据的落盘段（不进 frontmatter，14 字段协议不动）。 */
function serializeVerdictSection(result: AcceptanceResult, time: string): string {
	const lines = [`## 机械验收 ${time}`];
	lines.push(`- 结论: ${result.结论}`);
	lines.push(`- 尝试: ${result.尝试}`);
	if (result.执行上下文) {
		lines.push(`- 执行根: ${result.执行上下文.executionRoot}`);
		lines.push(`- 仓库根: ${result.执行上下文.repositoryRoot}`);
		lines.push(`- 关联摘要: ${result.执行上下文.bindingDigest}`);
		lines.push(`- 工作树摘要: ${result.执行上下文.worktreeBindingDigest}`);
		lines.push(`- 输入快照: ${result.执行上下文.snapshotDigest}`);
		if (result.执行上下文.briefRef) lines.push(`- 简报: ${result.执行上下文.briefRef}`);
	}
	if (result.代码内容) {
		lines.push(`- 基线 tree: ${result.代码内容.基线Tree ?? "(旧版无内容树)"}`);
		lines.push(`- 检查前 tree: ${result.代码内容.检查前Tree}`);
		lines.push(`- 检查后 tree: ${result.代码内容.检查后Tree}`);
		lines.push(`- 检查前 HEAD: ${result.代码内容.检查前HEAD}`);
		lines.push(`- 检查后 HEAD: ${result.代码内容.检查后HEAD}`);
		lines.push(`- 检查后内容摘要: ${result.代码内容.检查后内容摘要}`);
	}
	if (result.自报未达项 !== undefined && result.自报未达项.length > 0) {
		for (const item of result.自报未达项) {
			lines.push(
				`- [自报复核] #${item.verification_index} ${item.条件} → ${item.自报结论}（${item.证据 || "无证据"}）`,
			);
		}
	}
	for (const r of result.条目结果) {
		if (r.类型 === "自报") continue;
		lines.push(`- [${r.类型}] ${r.摘要} → ${r.结果}（${r.说明}）`);
	}
	if (result.人话句.length > 0) {
		lines.push(`- 人话句 ${result.人话句.length} 条待主控审`);
		for (const sentence of result.人话句) lines.push(`- [人话句] ${JSON.stringify(sentence)}`);
	}
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

/** 先区分文件不存在、目标不是普通文件和读取失败，避免把所有 catch 都误写成 ENOENT。 */
function fileReadPreflight(projectRoot: string, absolutePath: string): string | undefined {
	try {
		if (statSync(absolutePath).isFile()) return undefined;
		return `目标不是普通文件（项目根 ${projectRoot}；实际路径 ${absolutePath}）`;
	} catch (error) {
		const reason =
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? "ENOENT，文件不存在"
				: String((error as Error).message).slice(0, 160);
		return `读取失败：项目根 ${projectRoot}；实际路径 ${absolutePath}；原因 ${reason}`;
	}
}

/** `存在` 核对沿用 statSync，区分真正不存在与其他 I/O 失败，且始终报告项目根和实际路径。 */
function pathExistsForAcceptance(projectRoot: string, absolutePath: string): { exists: boolean; description: string } {
	try {
		statSync(absolutePath);
		return { exists: true, description: `路径存在（项目根 ${projectRoot}；实际路径 ${absolutePath}）` };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return {
				exists: false,
				description: `ENOENT，文件不存在（项目根 ${projectRoot}；实际路径 ${absolutePath}）`,
			};
		}
		return {
			exists: false,
			description: `状态读取失败：项目根 ${projectRoot}；实际路径 ${absolutePath}；原因 ${String((error as Error).message).slice(0, 160)}`,
		};
	}
}

async function checkFileEntries(entry: MechanicalEntry[], projectRoot: string): Promise<EntryResult[]> {
	const results: EntryResult[] = [];
	for (const e of entry) {
		if (e.类型 === "存在") {
			const violation = checkReadPath(e.主体, projectRoot);
			if (violation) {
				results.push({
					序号: e.序号,
					类型: e.类型,
					摘要: e.主体,
					结果: "安检拦截",
					说明: `${violation}（项目根 ${projectRoot}）`,
				});
				continue;
			}
			const abs = path.join(projectRoot, e.主体);
			const existence = pathExistsForAcceptance(projectRoot, abs);
			results.push({
				序号: e.序号,
				类型: e.类型,
				摘要: e.主体,
				结果: existence.exists ? "过" : "未过",
				说明: existence.description,
			});
		} else if (e.类型 === "包含") {
			const violation = checkReadPath(e.主体, projectRoot);
			if (violation) {
				results.push({
					序号: e.序号,
					类型: e.类型,
					摘要: `${e.主体} :: ${e.子串}`,
					结果: "安检拦截",
					说明: `${violation}（项目根 ${projectRoot}）`,
				});
				continue;
			}
			const abs = path.join(projectRoot, e.主体);
			const preflight = fileReadPreflight(projectRoot, abs);
			if (preflight) {
				results.push({
					序号: e.序号,
					类型: e.类型,
					摘要: `${e.主体} :: ${e.子串}`,
					结果: "未过",
					说明: preflight,
				});
				continue;
			}
			let ok = false;
			let description = "";
			try {
				const text = readFileSync(abs, "utf8");
				ok = text.includes(e.子串 ?? "");
				description = ok
					? `找到目标文本（项目根 ${projectRoot}；实际路径 ${abs}）`
					: `未找到目标文本（项目根 ${projectRoot}；实际路径 ${abs}）`;
			} catch (error) {
				const reason =
					(error as NodeJS.ErrnoException).code === "ENOENT"
						? "ENOENT，文件不存在"
						: String((error as Error).message).slice(0, 160);
				description = `读取失败：项目根 ${projectRoot}；实际路径 ${abs}；原因 ${reason}`;
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
	const inspected = new Map(entry.map((e) => [e.序号, inspectCommand(e.主体)] as const));
	for (const e of entry) {
		const check = inspected.get(e.序号)!;
		if (!check.verdict.过) {
			results.push({
				序号: e.序号,
				类型: e.类型,
				摘要: e.主体,
				结果: "安检拦截",
				说明: check.verdict.违规.join("；"),
			});
		}
	}
	const executable = entry.filter((e) => inspected.get(e.序号)!.verdict.过);
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
	const pythonEnv = sanitizedEnv();
	pythonEnv[PYTHON_CACHE_ENV] = createPythonCacheDir(workDir, "python-cache-");
	pythonEnv.GIT_CEILING_DIRECTORIES = path.dirname(workDir);
	for (const e of executable) {
		options?.signal?.throwIfAborted();
		const argv = inspected.get(e.序号)!.argv;
		const [head, ...args] = argv;
		let out: CardProcessResult;
		try {
			out = await (options?.verificationCommandRunner ?? runProc)(
				head,
				args,
				workDir,
				timeout,
				/^git(?:\.exe)?$/i.test(head) ? { ...pythonEnv, LC_ALL: "C" } : pythonEnv,
				options?.signal,
			);
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
		const missingGitContext = /^git(?:\.exe)?$/i.test(head) && !ok && /not a git repository/i.test(out.stderr);
		results.push({
			序号: e.序号,
			类型: e.类型,
			摘要: e.主体,
			结果: out.failureKind || missingGitContext ? "无法判" : ok ? "过" : "未过",
			说明: missingGitContext
				? `影子验收目录未复制 .git，缺少仓库上下文：${out.stderr.trim().slice(0, 160)}`
				: ok
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
	/**
	 * 受管执行必须显式传入该 attempt 的真实关联。先要求它等于卡面当前 attempt，
	 * 再实时核对执行根；history-only 读取不会进入此动作。
	 */
	executionKey?: ExecutionKey;
}

export interface AcceptedDeviation {
	/** 接受时绑定的卡片尝试；必须等于卡面当前 attempt。 */
	attempt: number;
	/** 当前 attempt verification 数组的 0 起稳定索引。 */
	verification_index: number;
	condition: string;
	basis: string;
}

/**
 * 机械结果的重复调用只做幂等：
 * - 完全相同的时间和内容不追加；
 * - 同一时间但内容不同，保留两段并附加序号，避免覆盖历史；
 * - 时间相同且已有条目时，新记录使用规范时间加序号。
 */
function nextVerdictTime(body: string, time: string, section: string): string {
	const sameTime: string[] = [];
	const lines = body.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const match = VERDICT_HEADING_PATTERN.exec(lines[index].trim());
		if (!match || match[1] !== time) continue;
		let end = index + 1;
		while (end < lines.length && !/^## /.test(lines[end].trim())) end++;
		sameTime.push(lines.slice(index, end).join("\n").trim());
	}
	if (sameTime.length > 0 && sameTime.includes(section.trim())) return time;
	return sameTime.length > 0 ? `${time} #${sameTime.length + 1}` : time;
}

/** 幂等身份只看 attempt 与验收事实；交付状态和排障路径是首次调用的派生信息。 */
function verdictIdentity(result: AcceptanceResult): string {
	const lines = [`- 结论: ${result.结论}`, `- 尝试: ${result.尝试}`];
	for (const item of result.自报未达项 ?? [])
		lines.push(
			`- [自报复核] #${item.verification_index} ${item.条件} → ${item.自报结论}（${item.证据 || "无证据"}）`,
		);
	for (const item of result.条目结果) {
		if (item.类型 === "自报") continue;
		lines.push(`- [${item.类型}] ${item.摘要} → ${item.结果}（${item.说明}）`);
	}
	if (result.人话句.length > 0) lines.push(`- 人话句 ${result.人话句.length} 条待主控审`);
	for (const sentence of result.人话句) lines.push(`- [人话句] ${JSON.stringify(sentence)}`);
	if (result.越界核查) lines.push(`- 越界核查: ${result.越界核查.结论}（${result.越界核查.汇总}）`);
	return lines.join("\n");
}

function storedVerdictIdentity(section: string): string {
	return section
		.split(/\r?\n/)
		.filter((line) => !VERDICT_HEADING_PATTERN.test(line.trim()))
		.filter((line) => !/^-\s*(交付|沙箱):/.test(line.trim()))
		.join("\n")
		.trim();
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
	const currentExecutionKey: ExecutionKey = { cardsDir, cardNo: card.card_no, attempt: card.frontmatter.attempt };
	const hasAttemptBaseline = existsSync(baselineSnapshotPath(cardsDir, card.card_no, card.frontmatter.attempt));
	// 两类凭据任一出现就说明当前 attempt 属于受管执行；基线缺失也必须先读 execution-context 后拒绝，
	// 不能因派发中断只剩执行上下文而退回真实旧卡的无基线兼容路径。
	const hasManagedAttemptEvidence = hasAttemptBaseline || existsSync(executionContextPath(currentExecutionKey));
	const executionKey = options.executionKey ?? (hasManagedAttemptEvidence ? currentExecutionKey : undefined);
	const execution = executionKey
		? await resolveExecutionContext(executionKey, {
				expectedCurrentAttempt: card.frontmatter.attempt,
				requireLiveExecutionRoot: true,
			})
		: undefined;
	if (execution && execution.key.cardNo !== card.card_no) {
		throw new PaoCardError("INVALID_CARD", "execution-context 的卡号与本次验收卡不一致", {
			卡号: card.card_no,
			关联卡号: execution.key.cardNo,
		});
	}
	const { mechanicalEntry, plainSentence } = parseAcceptance(card.frontmatter.acceptance);
	const time = options.时间 ?? nowString();
	// 只认当前 attempt 的有效回执；其他 attempt 的历史不能替本轮或新尝试作证。
	const latestReceipt = currentAttemptReceipt(card);

	if (mechanicalEntry.length === 0 && (latestReceipt?.verification?.length ?? 0) === 0) {
		const result: AcceptanceResult = {
			card_no: card.card_no,
			尝试: card.frontmatter.attempt,
			结论: "无法机械判",
			条目结果: [],
			人话句: plainSentence,
			汇总: `验收无可机械核对的条目（${plainSentence.length} 条人话句），走人工/审查口径（§12 边界）`,
			...(execution ? { 执行上下文: executionEvidence(execution) } : {}),
		};
		options.signal?.throwIfAborted();
		await appendVerdict(card, result, time);
		return { card: readCard(card.path), result };
	}

	const entryResults: EntryResult[] = [];
	let sandboxKeepPath: string | undefined;
	let contentEvidence: AcceptanceResult["代码内容"];
	let acceptanceDiff: BaselineDiff | undefined;
	let afterDiff: BaselineDiff | undefined;
	// 受管执行有机械条目，或有当前 attempt 的人工复核回执时，都必须固定本次成果内容；
	// 后者由 owner 逐项接受后交卷时继续比较，防止人工验收后代码被修改。
	if (execution && (mechanicalEntry.length > 0 || (latestReceipt?.verification?.length ?? 0) > 0)) {
		acceptanceDiff = await diffAgainstBaseline(
			baselineSnapshotPath(cardsDir, card.card_no, execution.key.attempt),
			options.signal,
		);
		contentEvidence = acceptanceEvidenceFromDiff(card.card_no, execution, acceptanceDiff);
	}
	if (mechanicalEntry.length > 0) {
		const projectRoot = execution?.canonicalExecutionRoot ?? (await resolveProjectRoot(cardsDir, options.signal));
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
	const currentReports = (latestReceipt?.verification ?? [])
		.map((report, verification_index) => ({ report, verification_index }))
		.filter(({ report }) => report.结论 === "fail" || report.结论 === "not_run");
	entryResults.sort((a, b) => a.序号 - b.序号);

	const hasFailed = entryResults.some((r) => r.结果 === "未过" || r.结果 === "安检拦截");
	const hasIndeterminable = entryResults.some((r) => r.结果 === "无法判");
	let verdict: AcceptanceVerdict;
	if (hasFailed) verdict = "未过";
	else if (hasIndeterminable) verdict = "无法机械判";
	else if (currentReports.length > 0) verdict = "全过停人工审";
	else if (plainSentence.length > 0) verdict = "全过停人工审";
	else verdict = "全过自动交付";

	const result: AcceptanceResult = {
		card_no: card.card_no,
		尝试: card.frontmatter.attempt,
		结论: verdict,
		条目结果: entryResults,
		人话句: plainSentence,
		自报未达项: currentReports.map(({ report, verification_index }) => ({
			尝试: card.frontmatter.attempt,
			verification_index,
			条件: report.条件,
			自报结论: report.结论 as "fail" | "not_run",
			证据: report.证据,
		})),
		汇总: "",
		...(execution ? { 执行上下文: executionEvidence(execution) } : {}),
	};
	if (contentEvidence && execution) {
		afterDiff = acceptanceDiff
			? await diffAgainstBaseline(
					baselineSnapshotPath(cardsDir, card.card_no, execution.key.attempt),
					options.signal,
				)
			: undefined;
		const after = afterDiff
			? acceptanceEvidenceFromDiff(card.card_no, execution, afterDiff)
			: await captureAcceptanceContent(cardsDir, card.card_no, execution, "after", options.signal);
		result.代码内容 = {
			基线Tree: contentEvidence.基线Tree,
			检查前Tree: contentEvidence.检查前Tree,
			检查后Tree: after.检查前Tree,
			检查前HEAD: contentEvidence.检查前HEAD,
			检查后HEAD: after.检查前HEAD,
			检查前内容摘要: contentEvidence.检查前内容摘要,
			检查后内容摘要: after.检查前内容摘要,
		};
		if (contentEvidence.检查前Tree !== after.检查前Tree || contentEvidence.检查前HEAD !== after.检查前HEAD) {
			verdict = "无法机械判";
			result.结论 = verdict;
			result.交付说明 = "验收检查期间真实代码内容发生变化，本次结果不能放行；须重新验收";
		}
	}

	// 自动交付：验收全部为机械条目且全过（§12.1 交付规则）；混有人话句或有败一律停给主控；
	// S5 包1 叠加自报门：checkpoint/blocked 不冒充完成、git 真值比对 changes、验收哈希重审门。
	// 这段同时覆盖旧调用链与受管执行链；旧卡没有内容树时仍按原行为交付。
	options.signal?.throwIfAborted();
	if (verdict === "全过自动交付") {
		const gate = await selfReportDeliveryGate(
			card,
			cardsDir,
			latestReceipt,
			options.signal,
			execution,
			afterDiff,
			hasAttemptBaseline,
		);
		if (gate.越界核查) result.越界核查 = gate.越界核查;
		if (gate.内容树 && result.代码内容) {
			result.代码内容.基线Tree = gate.内容树.基线Tree;
			result.代码内容.检查后Tree = gate.内容树.当前Tree;
		}
		if (gate.阻断) {
			result.交付说明 = `机械全过但${gate.阻断}，不自动交付，留 owner 处理`;
		} else if (card.frontmatter.status === "in_progress") {
			changeCardStatus(card, {
				操作者: options.operator,
				to: "delivered",
				依据: `机械验收全部通过（${entryResults.length} 条全过），§12 自动交付`,
				时间: time,
			});
			result.自动交付 = true;
			result.交付说明 = "已自动落已交付";
		} else {
			result.交付说明 = `机械全过但状态为 ${card.frontmatter.status}（非进行中），不自动交付，留主控处理`;
		}
	}

	if (result.交付说明?.includes("验收检查期间真实代码内容发生变化")) {
		result.自动交付 = undefined;
	}

	result.汇总 =
		verdict === "全过自动交付"
			? `机械条目 ${entryResults.length} 条全过${result.自动交付 ? "，已自动落已交付" : `，${result.交付说明 ?? "未自动交付"}`}`
			: verdict === "全过停人工审"
				? currentReports.length > 0
					? `机械条目 ${entryResults.length} 条全过；第 ${card.frontmatter.attempt} 次尝试有 ${currentReports.length} 条自报未达项，待 owner 逐项复核（不自动交付）`
					: `机械条目 ${entryResults.length} 条全过，另有 ${plainSentence.length} 条人话句，停给主控审（§12 不自动交付）`
				: verdict === "未过"
					? `机械验收 ${entryResults.filter((r) => r.结果 !== "过").length}/${entryResults.length} 条未过，输出结构化结果留 owner`
					: `存在无法机械判定的条目，留 owner（${entryResults.filter((r) => r.结果 === "无法判").length} 条无法判）`;
	if (sandboxKeepPath) result.沙箱保留路径 = sandboxKeepPath;

	options.signal?.throwIfAborted();
	await appendVerdict(card, result, time);
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
	execution?: ResolvedExecutionContext,
	knownDiff?: BaselineDiff,
	requiredAttemptBaseline = false,
): Promise<{ 阻断?: string; 越界核查?: BoundaryWriteCheck; 内容树?: { 基线Tree: string; 当前Tree: string } }> {
	if (latest?.任务态 === "checkpoint") return { 阻断: "最新回执为 checkpoint（到决策点须指引，不冒充完成）" };
	if (latest?.任务态 === "blocked") return { 阻断: "最新回执为 blocked（无法继续须用户输入，不走自动交付）" };
	let diff = knownDiff;
	if (!diff) {
		try {
			diff = await diffAgainstBaseline(
				baselineSnapshotPath(
					cardsDir,
					card.card_no,
					execution?.key.attempt ?? (requiredAttemptBaseline ? card.frontmatter.attempt : undefined),
				),
				signal,
			);
		} catch (error) {
			if (execution || requiredAttemptBaseline) throw error;
			diff = undefined;
		}
	}
	if (requiredAttemptBaseline && !diff?.基线可用) {
		return { 阻断: `当前尝试的内容基线不可用（${diff?.汇总 ?? "无法读取"}），不能放行` };
	}
	if (execution) {
		if (!diff?.基线可用) {
			return { 阻断: `受管执行的内容基线不可用（${diff?.汇总 ?? "无法读取"}），不能放行` };
		}
		if (!diff.项目根 || !samePath(diff.项目根, execution.projectRoot)) {
			return {
				阻断: `内容基线项目根 ${diff.项目根 ?? "(缺失)"} 与 execution-context ${execution.projectRoot} 不一致`,
			};
		}
		if (!diff.当前ContentRoot || !samePath(diff.当前ContentRoot, execution.canonicalExecutionRoot)) {
			return {
				阻断: `内容基线实际执行根 ${diff.当前ContentRoot ?? "(缺失)"} 与 execution-context ${execution.canonicalExecutionRoot} 不一致`,
			};
		}
	}
	if (diff?.基线可用 && diff.验收哈希) {
		const currentHash = createHash("sha256").update(card.frontmatter.acceptance, "utf8").digest("hex");
		if (currentHash !== diff.验收哈希) return { 阻断: "验收声明已变化（与认领时不符，原许可失效），须 owner 重审" };
	}
	const declarations = receiptDeclarations(latest);
	if (diff?.基线可用 && declarations) {
		const check = checkBoundaryWrite(diff, declarations, { 项目根: diff.项目根 });
		if (check.结论 === "虚报" || check.结论 === "越界" || check.结论 === "虚报+越界")
			return {
				阻断: `越界核查 ${check.结论}（改动与声明对不上）：${check.汇总}`,
				越界核查: check,
				...(diff.基线Tree && diff.当前Tree ? { 内容树: { 基线Tree: diff.基线Tree, 当前Tree: diff.当前Tree } } : {}),
			};
		return {
			越界核查: check,
			...(diff.基线Tree && diff.当前Tree ? { 内容树: { 基线Tree: diff.基线Tree, 当前Tree: diff.当前Tree } } : {}),
		};
	}
	return diff?.基线Tree && diff.当前Tree ? { 内容树: { 基线Tree: diff.基线Tree, 当前Tree: diff.当前Tree } } : {};
}

/** changes 一旦出现（包括 []）就优先，只有缺省时才回落 artifact_path。 */
function receiptDeclarations(receipt: Receipt | undefined): string[] | undefined {
	return receipt?.changes?.map((change) => change.路径) ?? receipt?.artifact_path;
}

function samePath(left: string, right: string): boolean {
	return (
		pathKey(path.resolve(left).replace(/\\/g, "/")).replace(/\/+$/, "") ===
		pathKey(path.resolve(right).replace(/\\/g, "/")).replace(/\/+$/, "")
	);
}

function executionEvidence(execution: ResolvedExecutionContext): NonNullable<AcceptanceResult["执行上下文"]> {
	return {
		cardsDir: execution.key.cardsDir,
		attempt: execution.key.attempt,
		projectRoot: execution.projectRoot,
		executionRoot: execution.canonicalExecutionRoot,
		repositoryRoot: execution.repositoryRoot,
		bindingDigest: execution.bindingDigest,
		worktreeBindingDigest: execution.worktree.bindingDigest,
		snapshotDigest: execution.snapshotDigest,
		...(execution.briefRef !== undefined ? { briefRef: execution.briefRef } : {}),
	};
}

async function captureAcceptanceContent(
	cardsDir: string,
	cardNo: number,
	execution: ResolvedExecutionContext,
	_phase: "before" | "after",
	signal?: AbortSignal,
): Promise<NonNullable<AcceptanceResult["代码内容"]>> {
	const diff = await diffAgainstBaseline(baselineSnapshotPath(cardsDir, cardNo, execution.key.attempt), signal);
	return acceptanceEvidenceFromDiff(cardNo, execution, diff);
}

function acceptanceEvidenceFromDiff(
	cardNo: number,
	execution: ResolvedExecutionContext,
	diff: BaselineDiff,
): NonNullable<AcceptanceResult["代码内容"]> {
	if (!diff.基线可用 || !diff.基线Tree || !diff.当前Tree || !diff.当前HEAD || !diff.内容摘要) {
		throw new PaoCardError(
			"INVALID_CARD",
			`受管执行缺少可核对的内容基线：${diff.汇总}${diff.原因 ? `（${diff.原因}）` : ""}`,
			{
				卡号: cardNo,
				尝试: execution.key.attempt,
				...(diff.原因 ? { 原因: diff.原因 } : {}),
			},
		);
	}
	if (!diff.当前ContentRoot || !samePath(diff.当前ContentRoot, execution.canonicalExecutionRoot)) {
		throw new PaoCardError(
			"INVALID_CARD",
			`内容树不是从 execution-context 的实际执行根读取：${diff.当前ContentRoot ?? "(缺失)"}`,
			{ 执行根: execution.canonicalExecutionRoot },
		);
	}
	return {
		基线Tree: diff.基线Tree,
		检查前Tree: diff.当前Tree,
		检查后Tree: diff.当前Tree,
		检查前HEAD: diff.当前HEAD,
		检查后HEAD: diff.当前HEAD,
		检查前内容摘要: diff.内容摘要,
		检查后内容摘要: diff.内容摘要,
	};
}

/** 人工改完成也核对机械条件和当前回执；保留 owner 明确说明依据的人工验收。 */
export async function reviewCardForDelivery(
	cardsDir: string,
	cardNo: number,
	options: VerifyCardOptions,
	basis?: string,
	acceptedDeviations?: AcceptedDeviation[],
): Promise<ParsedCard> {
	const card = loadCard(cardsDir, cardNo);
	const latest = currentAttemptReceipt(card);
	if (latest) {
		validateReceiptContent(card, {
			尝试号: latest.attempt,
			时间: latest.time,
			产物路径: latest.artifact_path,
			摘要: latest.summary,
		});
	}
	const gate = await selfReportDeliveryGate(card, cardsDir, latest, options.signal);
	if (gate.阻断) throw new PaoCardError("INVALID_TRANSITION", `拒绝标为已完成：${gate.阻断}`, { 卡号: cardNo });
	const checked = await verifyCard(cardsDir, cardNo, options);
	if (checked.result.结论 === "未过")
		throw new PaoCardError("INVALID_TRANSITION", `拒绝标为已完成：${checked.result.汇总}`, { 卡号: cardNo });
	const current = checked.result.自报未达项 ?? [];
	const accepted = acceptedDeviations ?? [];
	if (current.length > 0 || accepted.length > 0) {
		for (const deviation of accepted) {
			if (
				!Number.isInteger(deviation.attempt) ||
				!Number.isInteger(deviation.verification_index) ||
				deviation.verification_index < 0 ||
				!deviation.condition.trim() ||
				!deviation.basis.trim()
			)
				throw new PaoCardError(
					"INVALID_TRANSITION",
					"accepted_deviations 每项都必须填写 attempt、verification_index、condition 和 basis，不能用空项跳过未达条件",
					{ 卡号: cardNo },
				);
			if (deviation.attempt !== card.frontmatter.attempt)
				throw new PaoCardError(
					"INVALID_TRANSITION",
					`accepted_deviations 的 attempt 必须等于当前尝试 ${card.frontmatter.attempt}；收到 ${deviation.attempt}，旧尝试参数不能重放到新尝试`,
					{ 卡号: cardNo, 当前尝试: card.frontmatter.attempt, 收到尝试: deviation.attempt },
				);
		}
		for (const deviation of accepted) {
			if (
				!current.some(
					(item) => item.verification_index === deviation.verification_index && item.条件 === deviation.condition,
				)
			)
				throw new PaoCardError(
					"INVALID_TRANSITION",
					`接受项不属于当前尝试 ${card.frontmatter.attempt} 的自报未达索引与条件：#${deviation.verification_index} ${deviation.condition}`,
					{ 卡号: cardNo, 尝试: card.frontmatter.attempt },
				);
		}
		const acceptedIndexes = new Set(accepted.map((item) => item.verification_index));
		if (acceptedIndexes.size !== accepted.length)
			throw new PaoCardError("INVALID_TRANSITION", "accepted_deviations 不得重复同一 verification_index", {
				卡号: cardNo,
			});
		if (current.length !== accepted.length)
			throw new PaoCardError(
				"INVALID_TRANSITION",
				"accepted_deviations 必须与当前尝试自报未达条件的数量一致，漏项和多项都不能放行",
				{ 卡号: cardNo },
			);
		if (current.some((item) => !acceptedIndexes.has(item.verification_index)))
			throw new PaoCardError(
				"INVALID_TRANSITION",
				"尚有自报未达项未逐项接受；accepted_deviations 必须覆盖当前尝试全部条件",
				{
					卡号: cardNo,
					未覆盖: current
						.filter((item) => !acceptedIndexes.has(item.verification_index))
						.map((item) => `#${item.verification_index} ${item.条件}`),
				},
			);
	}
	if (!checked.result.自动交付) {
		if (!basis?.trim())
			throw new PaoCardError(
				"INVALID_TRANSITION",
				"尚有人工验收项：请核查成果并填写总验收依据 basis；accepted_deviations 的逐项依据不能代替总 basis",
				{ 卡号: cardNo },
			);
	}
	if (acceptedDeviations?.length) {
		const lines = [
			"",
			`## owner记录 ${options.时间 ?? nowString()}`,
			"- 事件: 接受自报未达项",
			`- owner: ${options.operator}`,
			`- 尝试: ${card.frontmatter.attempt}`,
		];
		for (const deviation of acceptedDeviations) {
			lines.push(
				`- 未达项 #${deviation.verification_index}: ${deviation.condition}；接受依据: ${deviation.basis.trim()}（绑定尝试 ${deviation.attempt}）`,
			);
		}
		const note = lines.join("\n");
		const body = checked.card.body.trim().length > 0 ? `${checked.card.body.trimEnd()}\n${note}\n` : `${note}\n`;
		writeFileAtomic(checked.card.path, serializeCard(checked.card.frontmatter, body));
	}
	return checked.card;
}

/** 把派生验收结果追加到卡正文；锁内重读，完全重复时保留原记录且不追加。 */
async function appendVerdict(card: ParsedCard, result: AcceptanceResult, time: string): Promise<void> {
	await withFileLock(card.path, () => {
		const fresh = readCard(card.path);
		const section = serializeVerdictSection(result, time);
		const existing = fresh.body.split(/\r?\n/);
		const identity = verdictIdentity(result);
		for (let index = 0; index < existing.length; index++) {
			const match = VERDICT_HEADING_PATTERN.exec(existing[index].trim());
			if (!match || match[1] !== time) continue;
			let end = index + 1;
			while (end < existing.length && !/^## /.test(existing[end].trim())) end++;
			const stored = existing.slice(index, end).join("\n").trim();
			if (storedVerdictIdentity(stored) === identity) return;
		}
		const headingTime = nextVerdictTime(fresh.body, time, section);
		const nextSection = serializeVerdictSection(result, headingTime);
		const body = fresh.body.trim().length > 0 ? `${fresh.body.trimEnd()}\n\n${nextSection}\n` : `${nextSection}\n`;
		writeFileAtomic(fresh.path, serializeCard(fresh.frontmatter, body));
	});
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
			verificationCommandRunner: options?.verificationCommandRunner,
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
		for (const item of result.自报未达项 ?? [])
			lines.push(
				`  自报未达项（尝试 ${item.尝试}，索引 ${item.verification_index}）：${item.条件} → ${item.自报结论}（${item.证据 ?? "无证据"}）`,
			);
		if (result.交付说明) lines.push(`  交付：${result.交付说明}`);
		// §19 通道①：机械验收自动落已交付时，下游就绪就地提示（无就绪卡零噪音）
		if (result.自动交付) {
			const note = renderUnlockNotice(findUnlockedCards(wakeupViews(listCards(cardsDir))));
			if (note) lines.push(note);
		}
		if (result.沙箱保留路径) lines.push(`  沙箱保留（排障）：${result.沙箱保留路径}`);
		lines.push(`结果已落 ${card.filename}（## 机械验收 派生段，卡协议字段未动）。`);
		if (result.结论 === "全过停人工审") {
			if ((result.自报未达项?.length ?? 0) > 0) {
				lines.push(
					"自报未达项不能自动放行：请 owner 逐项复核，再用 pao_change_status 转 delivered；必须填写总验收依据 basis，并在 accepted_deviations 为每项填写当前 attempt、verification_index、condition 与逐项 basis。",
				);
				lines.push(
					"accepted_deviations 每项格式：{ attempt: 当前尝试, verification_index: 0 起原始索引, condition: 原条件原文, basis: 接受依据 }；必须恰好全部覆盖。旧 attempt 参数不能重放。逐项 basis 不能代替总 basis。",
				);
			} else {
				lines.push(
					"混有人话句：机械部分全过也不自动交付，主控审后经 pao_change_status 落终态，并填写总验收依据 basis。",
				);
			}
		}
		if (result.结论 === "未过")
			lines.push(
				"未自动交付：真实机械失败、安检拦截、越界或声明哈希变化不能被 accepted_deviations 绕过；请 owner 修复问题后重新验收。",
			);
		if (result.结论 === "无法机械判")
			lines.push(
				"结果未知，成果待 owner 复核，不能视为成功；请核查现有成果，再通过 pao_change_status 转 delivered，并用总 basis 记录人工验收依据。",
			);
		return lines.join("\n");
	} catch (error) {
		if (error instanceof PaoCardError) throw new Error(`[${error.code}] ${error.message}`);
		throw error;
	}
}

export interface VerifierToolsOptions {
	verificationCommandRunner?: VerificationCommandRunner;
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
