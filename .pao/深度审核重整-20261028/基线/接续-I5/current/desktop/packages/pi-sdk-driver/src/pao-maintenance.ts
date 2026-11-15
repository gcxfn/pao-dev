import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CronExpressionParser } from "cron-parser";

export interface MechanicalTask {
  id: string;
  名: string;
  prompt: string;
  cron: string;
  工作目录: string;
  工具白名单: string[];
  repeat: boolean;
  enabled: boolean;
}
const allowed = new Set(["巡检", "归档", "保温"]);
export function parseMechanicalTask(value: unknown): MechanicalTask {
  const task = value as MechanicalTask;
  if (
    !task ||
    typeof task !== "object" ||
    typeof task.id !== "string" ||
    !/^[\p{L}\p{N}_-]{1,80}$/u.test(task.id) ||
    typeof task.名 !== "string" ||
    !task.名.trim() ||
    typeof task.prompt !== "string" ||
    typeof task.cron !== "string" ||
    typeof task.工作目录 !== "string" ||
    !isAbsolute(task.工作目录) ||
    typeof task.repeat !== "boolean" ||
    typeof task.enabled !== "boolean" ||
    !Array.isArray(task.工具白名单) ||
    task.工具白名单.length !== 1 ||
    !allowed.has(task.工具白名单[0]!)
  ) {
    throw new Error(
      "任务字段无效或未支持：工具白名单须且仅须为巡检、归档、保温之一；repeat/enabled须布尔值。prompt仅说明，不会解释执行任意任务。",
    );
  }
  CronExpressionParser.parse(task.cron);
  return task;
}

export function maintenancePath(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const real = realpathSync(path);
  const rel = relative(realRoot, real);
  if (rel.startsWith("..") || isAbsolute(rel) || lstatSync(path).isSymbolicLink())
    throw new Error(`机械维护路径越界或符号链接：${path}`);
  return real;
}

// ── 任务夹增量扫描（P3 性能：每秒 tick 不再全量重读）──────────────────
//
// 每轮仍 readdir＋每文件 lstat（新文件/移除/换成符号链接立即可见），
// 但 mtimeMs+size 未变的文件直接复用上次解析结果与 revision，
// 不再每秒重读、重解析、重哈希全部任务 JSON。
// 信任边界说明：换内容且伪造相同 mtime+size 才能骗过缓存；lstat 每轮照做，
// 符号链接替换（越界向量）不依赖 mtime 一定被发现。个人单用户工具接受此界。

export interface TaskScanEntry {
  readonly file: string;
  readonly task?: MechanicalTask;
  readonly revision?: string;
  readonly error?: unknown;
}

export interface TaskFolderScanner {
  scan(): { entries: TaskScanEntry[]; readCount: number };
}

export function createTaskFolderScanner(
  folder: string,
  deps: {
    readdirSync: (path: string) => string[];
    lstatSync: (path: string) => { isSymbolicLink(): boolean; mtimeMs: number; size: number };
    readFileSync: (path: string, encoding: "utf8") => string;
    checkPath: (root: string, path: string) => string;
  },
): TaskFolderScanner {
  const cache = new Map<
    string,
    { mtimeMs: number; size: number; task: MechanicalTask; revision: string }
  >();
  return {
    scan() {
      const entries: TaskScanEntry[] = [];
      let readCount = 0;
      const names = deps
        .readdirSync(folder)
        .filter((name) => name.endsWith(".json"))
        .sort();
      for (const file of names) {
        const path = join(folder, file);
        try {
          const stats = deps.lstatSync(path);
          const cached = stats.isSymbolicLink() ? undefined : cache.get(file);
          if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
            entries.push({ file, task: cached.task, revision: cached.revision });
            continue;
          }
          const raw = deps.readFileSync(deps.checkPath(folder, path), "utf8");
          readCount++;
          const task = parseMechanicalTask(JSON.parse(raw));
          const revision = createHash("sha256").update(raw).digest("hex");
          cache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, task, revision });
          entries.push({ file, task, revision });
        } catch (error) {
          cache.delete(file);
          entries.push({ file, error });
        }
      }
      const seen = new Set(names);
      for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
      return { entries, readCount };
    },
  };
}

/** 单桌面进程、单机械子进程。留档是执行历史，不另建调度数据库；停机时间不补跑。 */
export function startPaoMaintenance(options: {
  home?: string;
  notify: (message: string) => void;
  now?: () => number;
  intervalMs?: number;
  spawnWorker?: (task: MechanicalTask, home: string, runDir: string) => ChildProcess;
}) {
  let stopped = false;
  let child: ChildProcess | undefined;
  let activeReceipt: string | undefined;
  const states = new Map<string, { revision: string; next: number }>();
  const reported = new Set<string>();
  const now = options.now ?? Date.now;
  const notify = (message: string) => {
    options.notify(`PAO 机械维护：${message}`);
  };
  const reportOnce = (message: string) => {
    if (!reported.has(message)) {
      reported.add(message);
      notify(message);
    }
  };
  const launch =
    options.spawnWorker ??
    ((task, home, runDir) =>
      spawn(
        process.execPath,
        [fileURLToPath(new URL("../extensions/pao/maintenance-worker.mjs", import.meta.url))],
        {
          cwd: task.工作目录,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            PAO_MECHANICAL_HOME: home,
            PAO_MECHANICAL_TASK: JSON.stringify(task),
            PAO_MECHANICAL_RUN_DIR: runDir,
          },
        },
      ));
  // 扫描器带会话级 mtime 缓存：只建一次，跨 tick 复用（每 tick 重建会丢缓存）。
  const scanner = options.home
    ? createTaskFolderScanner(join(options.home, "定时"), {
        readdirSync,
        lstatSync,
        readFileSync,
        checkPath: maintenancePath,
      })
    : undefined;
  function tick() {
    if (stopped || !options.home || !scanner) return;
    const folder = join(options.home, "定时");
    if (!existsSync(folder)) return;
    try {
      maintenancePath(options.home, folder);
      const seen = new Set<string>();
      const conflicting = new Set<string>();
      const tasks: { task: MechanicalTask; revision: string }[] = [];
      const reportTaskFileError = (file: string, error: unknown) => {
        const message = `${file} 未执行：${String(error)}`;
        if (!reported.has(message)) {
          const archive = join(folder, "留档");
          if (!existsSync(archive)) mkdirSync(archive);
          maintenancePath(folder, archive);
          const errors = join(archive, "配置错误");
          if (!existsSync(errors)) mkdirSync(errors);
          maintenancePath(archive, errors);
          writeFileSync(
            join(
              errors,
              `${now()}-${createHash("sha256").update(file).digest("hex").slice(0, 12)}.md`,
            ),
            `# 机械维护配置失败\n\n${message}\n未启动子进程、未执行prompt。\n`,
            { flag: "wx" },
          );
        }
        reportOnce(message);
      };
      for (const entry of scanner.scan().entries) {
        if (entry.error || !entry.task || !entry.revision) {
          // scan 契约：要么 task+revision 齐全，要么必有 error，无需再兜底造错。
          reportTaskFileError(entry.file, entry.error);
          continue;
        }
        const { task, revision } = entry;
        try {
          if (seen.has(task.id)) {
            conflicting.add(task.id);
            throw new Error(`任务 id 重复：${task.id}`);
          }
          seen.add(task.id);
          tasks.push({ task, revision });
        } catch (error) {
          reportTaskFileError(entry.file, error);
        }
      }
      for (const id of states.keys()) if (!seen.has(id)) states.delete(id);
      for (const { task, revision } of tasks) {
        if (conflicting.has(task.id)) {
          states.delete(task.id);
          continue;
        }
        if (!task.enabled) {
          states.delete(task.id);
          continue;
        }
        const time = now();
        let state = states.get(task.id);
        if (!state || state.revision !== revision) {
          state = {
            revision,
            next: CronExpressionParser.parse(task.cron, { currentDate: new Date(time) })
              .next()
              .getTime(),
          };
          states.set(task.id, state);
        }
        if (child || time < state.next) continue;
        const scheduled = state.next;
        state.next = CronExpressionParser.parse(task.cron, { currentDate: new Date(time) })
          .next()
          .getTime();
        // A one-shot leaves a receipt even on failure; explicit re-enabling needs a new id.
        const archive = join(folder, "留档");
        if (!existsSync(archive)) mkdirSync(archive);
        maintenancePath(folder, archive);
        const runDir = join(archive, task.id);
        if (!existsSync(runDir)) mkdirSync(runDir);
        maintenancePath(archive, runDir);
        if (!task.repeat && readdirSync(runDir).some((name) => name.endsWith(".md"))) continue;
        const receipt = join(runDir, `${new Date(scheduled).toISOString().replace(/:/g, "-")}.md`);
        try {
          writeFileSync(
            receipt,
            `# ${task.名}\n\n任务：${task.id}\n计划时间：${new Date(scheduled).toISOString()}\n操作：${task.工具白名单[0]}\nprompt 仅作说明，未执行其自然语言指令：${task.prompt}\n\n状态：已领取，尚未证明完成。若桌面异常退出且无结算，结果未知。\n`,
            { flag: "wx" },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        try {
          realpathSync(task.工作目录);
          child = launch(task, realpathSync(options.home), runDir);
          activeReceipt = receipt;
          const running = child;
          let output = "";
          let receivedReport = false;
          let settled = false;
          const deadline = setTimeout(() => {
            running.kill();
          }, 30_000);
          deadline.unref();
          const settle = (message: string, failed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (child === running) {
              child = undefined;
              activeReceipt = undefined;
            }
            try {
              appendFileSync(
                receipt,
                `\n${message}\n${output}\n<!-- PAO机械结算:${JSON.stringify({ taskId: task.id, success: !failed })} -->\n`,
              );
            } catch (error) {
              notify(`${task.名} 结算留档失败，结果不可据此证明：${String(error)}`);
            }
            if (failed) notify(`${task.名} ${message}；留档：${receipt}`);
          };
          running.stderr?.on("data", (data: Buffer) => {
            output = (output + data.toString()).slice(-16_384);
          });
          running.on("message", (message) => {
            if (typeof message === "string") {
              receivedReport = true;
              output = message.slice(0, 65_536);
            }
          });
          running.once("error", (error) => {
            running.kill();
            settle(`状态：失败，${String(error)}`, true);
          });
          running.once("exit", (code, signal) =>
            settle(
              code === 0 && receivedReport && !stopped
                ? "状态：机械白名单操作完成；任意 prompt 任务未验证。"
                : `状态：失败/取消（code=${code} signal=${signal}）`,
              code !== 0 || !receivedReport || stopped,
            ),
          );
          running.send("execute");
        } catch (error) {
          child?.kill();
          child = undefined;
          activeReceipt = undefined;
          appendFileSync(receipt, `\n状态：启动失败 ${String(error)}\n`);
          notify(`${task.名} 启动失败：${String(error)}`);
        }
      }
    } catch (error) {
      reportOnce(`扫描/留档失败，未继续派发：${String(error)}`);
    }
  }
  const timer = setInterval(tick, options.intervalMs ?? 1000);
  timer.unref();
  tick();
  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (child) {
        try {
          if (activeReceipt)
            appendFileSync(activeReceipt, "\n桌面关闭：请求停止机械子进程；不视为成功。\n");
        } catch (error) {
          notify(`关闭留档失败：${String(error)}`);
        }
        // The worker has no descendants and exits on IPC disconnect, including parent crash.
        if (child.connected) child.disconnect();
        child.kill();
      }
    },
  };
}
