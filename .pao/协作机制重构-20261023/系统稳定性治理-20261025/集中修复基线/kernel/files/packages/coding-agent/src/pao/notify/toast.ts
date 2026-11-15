/**
 * §23 长活通知·Windows toast:人走开后值得回来的时刻用系统 toast 叫人——后台化的人机契约。
 *
 * 三类事件(架构 §23):①后台扇出全部完成/有失败(§20)②工作流挂起等人工门(§11)
 * ③定时任务失败(§16)——v1 无定时任务,③无源如实记档(头注释此行即档)。
 * 实现:PowerShell 原生 ToastNotification(零依赖);标题/正文经环境变量传入脚本,
 * 不拼命令字符串——无注入面。TUI 内 notify＋footer 照旧(在场场景),toast 只补人不在场。
 * 开关:保温.json「toast 通知」(host/config toastEnabled)——缺省开,嫌烦显式关。
 * 通知是尽力而为:非 win32 平台 no-op;spawn 失败/超时静默吞(通知失败不炸业务,不留噪音)。
 */
import { spawn } from "node:child_process";

/** toast 脚本(固定文本,读 env PAO_TOAST_TITLE/PAO_TOAST_BODY——无字符串拼接注入面) */
export function buildToastScript(): string {
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
		"$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
		"$texts = $xml.GetElementsByTagName('text')",
		"$null = $texts.Item(0).AppendChild($xml.CreateTextNode($env:PAO_TOAST_TITLE))",
		"$null = $texts.Item(1).AppendChild($xml.CreateTextNode($env:PAO_TOAST_BODY))",
		"$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
		// PowerShell AUMID:通知中心显示来源为 Windows PowerShell(免注册自家 AppId 的零依赖惯例)
		"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
	].join("\n");
}

/** spawn 注入面(测试替身) */
export type ToastSpawner = (
	title: string,
	body: string,
	script: string,
) => { on: (event: string, handler: () => void) => void; kill: () => void };

const defaultSpawner: ToastSpawner = (title, body, script) => {
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		env: { ...process.env, PAO_TOAST_TITLE: title, PAO_TOAST_BODY: body },
		stdio: "ignore",
	});
	return {
		on: (event, handler) => {
			if (event === "close") child.on("close", handler);
		},
		kill: () => child.kill(),
	};
};

/**
 * 发一条 Windows toast(§23)。fire-and-forget:返回的 promise 永远 resolve(失败静默),
 * 调用方无须 await;3 秒兜底 kill——通知卡死不拖业务。开关关/非 win32:零 spawn 直接返回。
 */
export function sendToast(
	title: string,
	body: string,
	options: { enabled?: boolean; spawner?: ToastSpawner; timeoutMs?: number } = {},
): Promise<void> {
	const { enabled = true, spawner = defaultSpawner, timeoutMs = 3_000 } = options;
	// PAO_TOAST_OFF=1:环境级总闸(测试与不想看到任何弹出的会话用;与保温.json 开关叠加取严)
	if (!enabled || process.env.PAO_TOAST_OFF === "1" || process.platform !== "win32") return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const child = spawner(title, body, buildToastScript());
		const done = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// 已退出
			}
			done();
		}, timeoutMs);
		child.on("close", done);
	});
}
