import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { redactContext } from "../context/index.ts";
import { gitSpawnErrorText } from "../shared/git.ts";
import { collectInstanceDirectories } from "../status/workflow-instances.ts";
import { controlView, type FlowControl, readControl, readControlView } from "../workflow/control.ts";
import { loadFrozenRecipe } from "../workflow/minister.ts";
import type { DesktopReadIssue } from "./read-model.ts";

export interface DesktopFlow {
	路径: string;
	控制: FlowControl;
	/** 持久中文视图（K4 桌面视图信封保留，S9 内核包不迁） */
	进度: ReturnType<typeof controlView>;
	/** 写入控制正本时持久化的状态；同步兼容接口只抄这里，fresh 接口以进度为准。 */
	持久状态: FlowControl["状态"];
}
interface DesktopFlowCandidate {
	path: string;
	options: { cardsDir: string; workspaceDir: string };
	flow: FlowControl;
}

function inside(root: string, file: string): boolean {
	const delta = relative(root, file);
	return !isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`);
}

/**
 * 同步兼容读面：只核对持久正本，不捕获当前内容树，因此未经版本核对的历史 pass 只表示
 * “持久正本声明完成”。真实桌面展示应调用 readDesktopFlowsFresh。
 */
export function readDesktopFlows(project: string): { 工作流: DesktopFlow[]; 问题: DesktopReadIssue[] } {
	const root = realpathSync(project);
	const result: { 工作流: DesktopFlow[]; 问题: DesktopReadIssue[] } = { 工作流: [], 问题: [] };
	for (const candidate of discoverDesktopFlows(root, result.问题)) {
		result.工作流.push({
			路径: candidate.path,
			控制: candidate.flow,
			进度: controlView(candidate.flow),
			持久状态: candidate.flow.状态,
		});
	}
	return redactContext(result) as typeof result;
}

/**
 * 真实桌面读面：每个流程经共享控制入口核对一次当前内容树。缓存只在控制模块本次调用内
 * 存在，不做跨刷新常驻缓存，也不把历史 pass 当作当前有效。
 */
export async function readDesktopFlowsFresh(
	project: string,
	deadMinisters?: ReadonlySet<string>,
): Promise<{ 工作流: DesktopFlow[]; 问题: DesktopReadIssue[] }> {
	const root = realpathSync(project);
	const result: { 工作流: DesktopFlow[]; 问题: DesktopReadIssue[] } = { 工作流: [], 问题: [] };
	const candidates = discoverDesktopFlows(root, result.问题);
	for (const candidate of candidates) {
		try {
			const progress = await readControlView(candidate.flow, candidate.options, deadMinisters);
			result.工作流.push({
				路径: candidate.path,
				控制: candidate.flow,
				进度: progress,
				持久状态: candidate.flow.状态,
			});
		} catch (error) {
			result.问题.push({ 路径: candidate.path, 说明: String(error) });
		}
	}
	return redactContext(result) as typeof result;
}

function discoverDesktopFlows(root: string, issues: DesktopReadIssue[]): DesktopFlowCandidate[] {
	const result: DesktopFlowCandidate[] = [];
	const pao = join(root, ".pao");
	// 没有 .pao＝这个项目还没跑过工作流，不是读失败。
	if (!existsSync(pao)) return result;
	const directories = [pao, ...collectInstanceDirectories(pao, 4)];
	for (const directory of directories) {
		try {
			if (!inside(root, realpathSync(directory))) throw new Error("工作流目录越出项目");
			for (const name of readdirSync(directory).filter((name) => /^工作流实例-.+\.md$/.test(name))) {
				const path = join(directory, name);
				try {
					if (!inside(root, realpathSync(path))) throw new Error("工作流文件越出项目");
					const { frontmatter } = parseFrontmatter<{ 卡目录?: unknown }>(readFileSync(path, "utf8"));
					// 卡目录存在→realpath 核越界；不存在→resolve 归一后词法核越界——目录缺失不该让
					// 整实例读失败（越界仍按原口径报问题），真实目录由启动侧建（control startControl）
					const cardDir = typeof frontmatter.卡目录 === "string" ? resolve(frontmatter.卡目录) : undefined;
					if (
						cardDir === undefined ||
						!(existsSync(cardDir) ? inside(root, realpathSync(cardDir)) : inside(root, cardDir))
					)
						throw new Error("工作流卡目录缺失或越出项目；历史格式不可自动恢复");
					const options = { cardsDir: cardDir, workspaceDir: dirname(path) };
					const recipe = loadFrozenRecipe(basename(path).slice("工作流实例-".length, -3), options);
					const flow = readControl(recipe, options);
					result.push({ path, options, flow });
				} catch (error) {
					issues.push({ 路径: path, 说明: String(error) });
				}
			}
		} catch (error) {
			issues.push({ 路径: directory, 说明: String(error) });
		}
	}
	return result;
}

/** 真正执行只读 git diff；不运行仓库外部 diff 程序，不改索引。 */
export async function readDesktopDiff(
	project: string,
	baseline?: string,
): Promise<{ 基线: string; 差异: string; 未跟踪: string; 说明: string }> {
	if (baseline !== undefined && !/^[a-f0-9]{40,64}$/.test(baseline)) throw new Error("diff 基线不是固定提交");
	const run = promisify(execFile);
	const options = {
		cwd: realpathSync(project),
		windowsHide: true,
		timeout: 10_000,
		maxBuffer: 2 * 1024 * 1024,
		encoding: "utf8" as const,
	};
	const base = baseline ?? "HEAD";
	let diff: { stdout: string };
	let untracked: { stdout: string };
	try {
		diff = await run("git", ["diff", "--no-ext-diff", "--no-textconv", base, "--", ".", ":(exclude).pao"], options);
		untracked = await run("git", ["ls-files", "--others", "--exclude-standard"], options);
	} catch (error) {
		// git 起不来（未装/不在 PATH）时给可诊断文案；原文附尾不吞（gitSpawnErrorText 透传其余错误）
		throw new Error(gitSpawnErrorText(error));
	}
	return redactContext({
		基线: base,
		差异: diff.stdout,
		未跟踪: untracked.stdout,
		说明: baseline
			? "当前工作树相对节点冻结提交；包含该基线后的改动，不能自动归因单卡。未跟踪文件只列路径，需打开文件核验。"
			: "未提供任务启动基线：这里只展示当前工作树相对 HEAD，不能据此证明任务全部改动或已提交的结果。未跟踪文件只列路径。",
	}) as { 基线: string; 差异: string; 未跟踪: string; 说明: string };
}
