// 本地进程测试夹具：不调用模型；输出仅包含本次创建的进程身份。
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installManagedParentLifecycle } from "../../src/pao/worker/parent-lifecycle.ts";

const [role, marker] = process.argv.slice(2);
if (role === "writer") {
	setInterval(() => appendFileSync(marker, "tick\n"), 50);
} else if (role === "worker") {
	installManagedParentLifecycle();
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "writer", marker], {
		stdio: "ignore",
		env: { ...process.env, PAO_MANAGED_PARENT: "0" },
	});
	child.once("spawn", () => process.stdout.write(`${JSON.stringify({ worker: process.pid, writer: child.pid })}\n`));
	setInterval(() => {}, 1000);
} else if (role === "probe") {
	// 上报生命周期监听注册情况:Windows 控制台关闭(SIGHUP)自停 + 父亡 IPC disconnect 自停
	installManagedParentLifecycle();
	process.stdout.write(
		`${JSON.stringify({ sighup: process.listenerCount("SIGHUP"), disconnect: process.listenerCount("disconnect") })}\n`,
	);
	setInterval(() => {}, 1000);
} else {
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", marker], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		env: { ...process.env, PAO_MANAGED_PARENT: "1" },
	});
	child.stdout?.pipe(process.stdout);
	child.stderr?.pipe(process.stderr);
	setInterval(() => {}, 1000);
}
