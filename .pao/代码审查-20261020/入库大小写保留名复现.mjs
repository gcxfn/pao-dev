/**
 * 用途：验证 Windows 上 new_filename 的大小写变体能否绕过保留文件名检查。
 * 输入：当前 PAO 工作树中的 knowledge/ingest.ts；
 *       夹具放在 D:\AI\workspace\临时文件夹\知识审查-20261020 的唯一子目录。
 * 输出：分别打印「已有子索引」和「尚无子索引」两种隔离结果。
 *
 * 运行（从 D:\AI\workspace\pao-dev 开始）：
 * & 'C:\Program Files\nodejs\node.exe' --experimental-strip-types `
 *   '.pao\代码审查-20261020\入库大小写保留名复现.mjs'
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const 脚本目录 = dirname(fileURLToPath(import.meta.url));
const 工作区根 = resolve(脚本目录, "..", "..");
const ingestPath = join(
	工作区根,
	"PAO",
	"packages",
	"coding-agent",
	"src",
	"pao",
	"knowledge",
	"ingest.ts",
);
const { ingestEntry } = await import(pathToFileURL(ingestPath).href);

if (process.platform !== "win32") {
	throw new Error(`本复现依赖 Windows 大小写不敏感的文件名行为，当前平台是 ${process.platform}`);
}

const 夹具根 = resolve(工作区根, "..", "临时文件夹", "知识审查-20261020");
mkdirSync(夹具根, { recursive: true });
const 临时根 = mkdtempSync(join(夹具根, "入库大小写保留名-"));

async function 捕获错误(operation) {
	try {
		const value = await operation();
		return { 抛出: false, 值: value };
	} catch (error) {
		return { 抛出: true, 错误: error instanceof Error ? error.message : String(error) };
	}
}

function 文件名快照(directory) {
	return readdirSync(directory).sort();
}

try {
	console.log("== 场景一：类型区已有正常的 子索引.md ==");
	{
		const libRoot = join(临时根, "已有索引");
		const typeDir = join(libRoot, "教训");
		const pendingDir = join(libRoot, "待验证");
		const candidate = join(pendingDir, "候选.md");
		const indexPath = join(typeDir, "子索引.md");
		mkdirSync(typeDir, { recursive: true });
		mkdirSync(pendingDir, { recursive: true });
		const 候选原文 = "候选正文，不能出现在已有索引中 2026-10-20\n";
		const 原索引 = "# 教训 子索引\n\n- [原有条目](原有条目.md) — 原有索引内容\n";
		writeFileSync(candidate, 候选原文, "utf8");
		writeFileSync(indexPath, 原索引, "utf8");

		const 结果 = await 捕获错误(() =>
			ingestEntry({
				libRoot,
				candidatePath: candidate,
				type: "教训",
				newFileName: "子索引.MD",
			}),
		);
		const 索引后 = readFileSync(indexPath, "utf8");
		console.log(
			JSON.stringify(
				{
					结果,
					候选仍存在: existsSync(candidate),
					索引逐字未变: 索引后 === 原索引,
					目录内容: 文件名快照(typeDir),
				},
				null,
				2,
			),
		);
	}

	console.log("\n== 场景二：类型区尚未建立 子索引.md ==");
	{
		const libRoot = join(临时根, "缺索引");
		const typeDir = join(libRoot, "教训");
		const pendingDir = join(libRoot, "待验证");
		const candidate = join(pendingDir, "候选.md");
		mkdirSync(typeDir, { recursive: true });
		mkdirSync(pendingDir, { recursive: true });
		const 候选原文 = "候选正文，含必须保留的业务内容 2026-10-20\n";
		writeFileSync(candidate, 候选原文, "utf8");

		const 结果 = await 捕获错误(() =>
			ingestEntry({
				libRoot,
				candidatePath: candidate,
				type: "教训",
				newFileName: "子索引.MD",
			}),
		);
		const 落盘路径 = join(typeDir, "子索引.md");
		const 落盘文本 = existsSync(落盘路径) ? readFileSync(落盘路径, "utf8") : null;
		console.log(
			JSON.stringify(
				{
					结果,
					候选仍存在: existsSync(candidate),
					子索引已生成: 落盘文本 !== null,
					候选业务正文仍保留: 落盘文本?.includes("必须保留的业务内容") ?? false,
					子索引内容: 落盘文本,
					目录内容: 文件名快照(typeDir),
				},
				null,
				2,
			),
		);
	}
} finally {
	rmSync(临时根, { recursive: true, force: true });
}
