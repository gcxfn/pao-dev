// 用途：桌面受管机械子进程；输入仅继承的任务JSON；输出IPC报告。没有模型/命令执行入口。
import { readdirSync, realpathSync, lstatSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { setImmediate } from "node:timers/promises";

async function checkpoint() {
  await setImmediate();
  if (!process.connected) throw new Error("父进程已退出，停止机械操作");
}

if (!process.connected) throw new Error("机械子进程必须由桌面 IPC 管理");
process.once("disconnect", () => process.exit(2));
// Parent installs result/exit observers before releasing this one-shot execution gate.
process.once("message", async (message) => {
  if (message !== "execute") throw new Error("未知机械启动消息");
  const task = JSON.parse(process.env.PAO_MECHANICAL_TASK ?? "null");
  const home = realpathSync(process.env.PAO_MECHANICAL_HOME);
  const runDir = realpathSync(process.env.PAO_MECHANICAL_RUN_DIR);
  const archive = realpathSync(join(home, "定时", "留档"));
  const rel = relative(archive, runDir);
  if (rel.startsWith("..") || isAbsolute(rel) || rel !== task.id) throw new Error("留档目录越界");
  const operation = task.工具白名单?.length === 1 ? task.工具白名单[0] : undefined;
  try {
    let report;
    if (operation === "归档") {
      // Only our own finished receipts are eligible. Unknown/manual Markdown is never removed.
      let count = 0;
      for (const taskId of readdirSync(archive)) {
        await checkpoint();
        if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(taskId) || taskId === "配置错误") continue;
        const directory = join(archive, taskId);
        if (lstatSync(directory).isSymbolicLink()) throw new Error("拒绝留档目录符号链接");
        if (!lstatSync(directory).isDirectory()) continue;
        const files = readdirSync(directory)
          .filter((name) => /^\d{4}-\d{2}-\d{2}T[\d.-]+Z\.md$/.test(name))
          .sort();
        const completed = [];
        for (const name of files) {
          await checkpoint();
          const path = join(directory, name);
          if (lstatSync(path).isSymbolicLink()) throw new Error("拒绝留档符号链接");
          const body = await readFile(path, "utf8");
          await checkpoint();
          const terminal = /^<!-- PAO机械结算:(.*) -->$/.exec(
            body.trimEnd().split("\n").at(-1) ?? "",
          );
          if (!terminal) continue;
          const result = JSON.parse(terminal[1]);
          if (result.taskId === taskId && result.success === true) completed.push(name);
        }
        const removed = completed.slice(0, -30);
        for (const name of removed) {
          await checkpoint();
          await unlink(join(directory, name));
        }
        count += removed.length;
      }
      report = `仅修剪机械任务成功留档，每个任务保留最近30份；失败/未知/人工文件保留。删除${count}份。`;
    } else if (operation === "巡检" || operation === "保温") {
      const { readMechanicalMaintenance } =
        await import("@earendil-works/pi-coding-agent/pao/desktop");
      report = await readMechanicalMaintenance(home, operation, checkpoint);
    } else throw new Error("未支持的机械工具；prompt不会交给模型执行");
    if (process.connected) process.send(report, () => process.exit(0));
    else process.exit(2);
  } catch (error) {
    console.error(String(error));
    process.exit(1);
  }
});
