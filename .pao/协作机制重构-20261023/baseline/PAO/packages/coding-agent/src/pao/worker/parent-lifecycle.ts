import { killTree } from "../../utils/kill-tree.ts";

export const MANAGED_PARENT_ENV = "PAO_MANAGED_PARENT";
let installed = false;

/** Node IPC 的断开表示启动本进程的父控制方已消失，不依赖可能被复用的 PID。 */
export function installManagedParentLifecycle(): void {
	if (process.env[MANAGED_PARENT_ENV] !== "1" || installed) return;
	if (!process.channel || !process.connected) throw new Error("受管进程缺少父控制通道，拒绝启动");
	installed = true;
	const createdBefore = Date.now();
	let stopping = false;
	// 两条父亡路径共用同一自树杀,先到者停,后到者不重复杀:
	// - disconnect:父进程消失(正常停止链/强杀/崩溃)→通道 EOF;
	// - SIGHUP(仅 Windows):控制台窗口被关闭。pi 各模式在 Windows 不装 SIGHUP(见
	//   interactive-mode/print-mode 的平台分支),受管进程若也不装,JS 会被控制台默认处理
	//   直接终止(0xC000013A),自树杀来不及跑,分离式工具后代泄漏——挂上监听才有宽限窗口。
	const stopOwnTree = (announce: string): void => {
		if (stopping) return;
		stopping = true;
		try {
			process.stderr.write(announce);
		} catch {
			/* 管道已随父进程关闭:证据落不进 stderr 不追,树照停 */
		}
		void killTree(process.pid, 2000, createdBefore).catch((error: unknown) => {
			process.stderr.write(`PAO 父亡停止失败：${String(error)}\n`);
			process.exit(1);
		});
	};
	process.once("disconnect", () => stopOwnTree("PAO 父控制通道已断开，停止本受管进程树。\n"));
	if (process.platform === "win32") {
		process.once("SIGHUP", () => stopOwnTree("PAO 控制台窗口已关闭，停止本受管进程树。\n"));
	}
	process.channel.unref();
}
