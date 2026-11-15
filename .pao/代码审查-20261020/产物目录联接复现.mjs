/**
 * 用途：验证项目内 Windows 目录联接（junction）指向项目外时：
 * 1. 内核 artifactOf 是否把目标误标为项目产物；
 * 2. 桌面正文读取是否拒绝项目外真实路径；
 * 3. UI 如何处理 存在: true。
 * 输入：当前工作树的 PAO 与 desktop 源码；
 *       夹具放在 D:\AI\workspace\临时文件夹\知识审查-20261020 的唯一子目录。
 * 输出：内核判定、读取守卫结果、UI 消费源码位置。
 *
 * 运行（从 D:\AI\workspace\pao-dev 开始）：
 * & 'C:\Program Files\nodejs\node.exe' --experimental-strip-types `
 *   '.pao\代码审查-20261020\产物目录联接复现.mjs'
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const 脚本目录 = dirname(fileURLToPath(import.meta.url));
const 工作区根 = resolve(脚本目录, "..", "..");
const artifactPath = join(
	工作区根,
	"PAO",
	"packages",
	"coding-agent",
	"src",
	"pao",
	"desktop",
	"plans.ts",
);
const workspacePath = join(
	工作区根,
	"desktop",
	"apps",
	"desktop",
	"electron",
	"platform",
	"files",
	"workspace-paths.ts",
);
const uiPath = join(
	工作区根,
	"desktop",
	"apps",
	"desktop",
	"src",
	"features",
	"workflow-cards",
	"workflow-cards-view.tsx",
);
const { artifactOf } = await import(pathToFileURL(artifactPath).href);
const { resolveExistingWorkspacePath } = await import(pathToFileURL(workspacePath).href);

if (process.platform !== "win32") {
	throw new Error(`本复现使用 Windows junction，当前平台是 ${process.platform}`);
}

function inside(root, target) {
	const delta = relative(root, target);
	return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== "..");
}

function 找行(file, needle) {
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	const index = lines.findIndex((line) => line.includes(needle));
	if (index < 0) throw new Error(`找不到 UI 证据行：${needle}`);
	return { 行号: index + 1, 源码: lines[index].trim() };
}

const 夹具根 = resolve(工作区根, "..", "临时文件夹", "知识审查-20261020");
mkdirSync(夹具根, { recursive: true });
const 临时根 = mkdtempSync(join(夹具根, "产物目录联接-"));
try {
	const project = join(临时根, "project");
	const outside = join(临时根, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	const secret = join(outside, "secret.txt");
	writeFileSync(secret, "这是项目外文件。\n", "utf8");
	symlinkSync(outside, join(project, "link"), "junction");

	const 产物判定 = artifactOf(project, "link/secret.txt", 1, "卡0001", true);
	const realProject = realpathSync(project);
	const realTarget = realpathSync(join(project, "link", "secret.txt"));

	let 正文读取;
	try {
		const resolved = await resolveExistingWorkspacePath(project, "link/secret.txt");
		正文读取 = { 被拒绝: false, 路径: resolved };
	} catch (error) {
		正文读取 = { 被拒绝: true, 错误: error instanceof Error ? error.message : String(error) };
	}

	console.log(
		JSON.stringify(
			{
				内核产物判定: 产物判定,
				真实项目根: realProject,
				真实目标: realTarget,
				真实目标在项目根内: inside(realProject, realTarget),
				桌面正文读取: 正文读取,
				UI消费: {
					列表状态展示: 找行(uiPath, 'artifact.exists ? t("On disk")'),
					正文路径选择: 找行(uiPath, "const artifactPath = artifact?.exists ? artifact.relativePath"),
					正文读取请求: 找行(uiPath, ".readWorkspaceFile(workspaceId, artifactPath)"),
					读取失败提示: 找行(uiPath, 't("Cannot read the file body: {message}"'),
				},
				判定说明: {
					展示缺陷:
						"内核返回 存在: true 后，UI 显示 On disk，并把该相对路径交给正文预览。",
					读取越界:
						"正文读取层对项目根和目标两侧取真实路径后拒绝越界，因此项目外文件没有被打开读取。",
				},
			},
			null,
			2,
		),
	);
} finally {
	rmSync(临时根, { recursive: true, force: true });
}
