import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { redactContext } from "../context/index.ts";
import { gitSpawnErrorText } from "../shared/git.ts";
import { controlView, type FlowControl, readControl } from "../workflow/control.ts";
import { loadFrozenRecipe } from "../workflow/minister.ts";
import type { DesktopReadIssue } from "./read-model.ts";

export interface DesktopFlow {
	路径: string;
	控制: FlowControl;
	/** 持久中文视图（K4 桌面视图信封保留，S9 内核包不迁） */
	进度: ReturnType<typeof controlView>;
}
function inside(root: string, file: string): boolean {
	const delta = relative(root, file);
	return !isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`);
}
export function readDesktopFlows(project: string): { 工作流: DesktopFlow[]; 问题: DesktopReadIssue[] } {
	const root = realpathSync(project);
	const result: { 工作流: DesktopFlow[]; 问题: DesktopReadIssue[] } = { 工作流: [], 问题: [] };
	const pao = join(root, ".pao");
	let directories: string[];
	try {
		directories = [
			pao,
			...readdirSync(pao, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(pao, entry.name)),
		];
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			result.问题.push({ 路径: pao, 说明: String(error) });
		return result;
	}
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
					result.工作流.push({ 路径: path, 控制: flow, 进度: controlView(flow) });
				} catch (error) {
					result.问题.push({ 路径: path, 说明: String(error) });
				}
			}
		} catch (error) {
			result.问题.push({ 路径: directory, 说明: String(error) });
		}
	}
	return redactContext(result) as typeof result;
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
