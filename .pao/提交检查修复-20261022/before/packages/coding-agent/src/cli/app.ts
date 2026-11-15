/** 本地桌面启动入口：复用已构建壳及当前锁版 SDK，不安装内核。（CLI 宿主层；自 pao/app.ts 迁入，桌面仓布局知识不进内核） */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPackageDir, VERSION } from "../config.ts";
import { pathKey } from "../pao/shared/path-key.ts";
import { MANAGED_PARENT_ENV } from "../pao/worker/parent-lifecycle.ts";
import { killTree } from "../utils/kill-tree.ts";

export interface DesktopInspection {
	compatible: boolean;
	desktopRoot: string;
	entry: string;
	executable: string;
	kernel: string;
	version: string;
	problems: string[];
}
export function inspectLocalDesktop(
	desktopRoot = process.env.PAO_DESKTOP_DIR ?? resolve(getPackageDir(), "../../../desktop"),
	kernel = getPackageDir(),
): DesktopInspection {
	const root = resolve(desktopRoot);
	const entry = join(root, "apps", "desktop", "out", "main", "main.js");
	const electron = join(root, "node_modules", "electron");
	const problems: string[] = [];
	let executable = "";
	try {
		executable = join(electron, "dist", readFileSync(join(electron, "path.txt"), "utf8").trim());
		if (!statSync(executable).isFile()) throw new Error("Electron 可执行文件不存在");
	} catch (error) {
		problems.push(`本地 Electron 不可用：${String(error)}`);
	}
	for (const file of [
		entry,
		join(kernel, "dist", "index.js"),
		join(root, "packages", "pi-sdk-driver", "dist", "index.js"),
	])
		if (!existsSync(file)) problems.push(`缺少构建产物：${file}`);
	try {
		const linked = realpathSync(
			join(root, "packages", "pi-sdk-driver", "node_modules", "@earendil-works", "pi-coding-agent"),
		);
		if (pathKey(linked) !== pathKey(realpathSync(kernel)))
			problems.push("桌面 SDK 未链接当前 PAO 内核，拒绝以第二内核启动");
		const pkg = JSON.parse(readFileSync(join(linked, "package.json"), "utf8")) as {
			version?: string;
			piConfig?: { name?: string };
		};
		if (pkg.version !== VERSION || pkg.piConfig?.name !== "pao")
			problems.push(`锁版或 fork 身份不符，期望 PAO ${VERSION}`);
	} catch (error) {
		problems.push(`本地 SDK 链接不可核对：${String(error)}`);
	}
	return {
		compatible: problems.length === 0,
		desktopRoot: root,
		entry,
		executable,
		kernel: resolve(kernel),
		version: VERSION,
		problems,
	};
}

export async function runDesktopApp(args: string[]): Promise<number | "terminal"> {
	if (args.length === 1 && args[0] === "--terminal") return "terminal";
	if (args.some((arg) => arg !== "--check"))
		throw new Error("用法：pao app [--check | --terminal]；桌面路径可用 PAO_DESKTOP_DIR 指定");
	const report = inspectLocalDesktop();
	if (args.includes("--check")) {
		console.log(JSON.stringify(report, null, 2));
		return report.compatible ? 0 : 1;
	}
	if (!report.compatible) throw new Error(`${report.problems.join("\n")}\n可运行 pao app --terminal 退回终端。`);
	const env: NodeJS.ProcessEnv = { ...process.env, [MANAGED_PARENT_ENV]: "1" };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = spawn(report.executable, [join(report.desktopRoot, "apps", "desktop")], {
		cwd: process.cwd(),
		env,
		// 此子进程是用户显式启动的 GUI；SW_HIDE 会压住 Electron 的首次 show。
		windowsHide: false,
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
	return new Promise<number>((resolveExit, reject) => {
		const createdBefore = Date.now();
		let stopping = false;
		const stop = () => {
			if (stopping || !child.pid) return;
			stopping = true;
			void killTree(child.pid, 2000, createdBefore).catch((error) => {
				console.error(`桌面停止失败，进程 ${child.pid} 需核查：${String(error)}`);
				process.exitCode = 1;
			});
		};
		const clean = () => {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		child.once("error", (error) => {
			clean();
			reject(error);
		});
		child.once("close", (code) => {
			clean();
			resolveExit(code ?? (stopping ? 130 : 1));
		});
	});
}
