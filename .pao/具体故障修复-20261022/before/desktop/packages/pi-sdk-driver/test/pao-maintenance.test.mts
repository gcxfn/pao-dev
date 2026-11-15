// 明确机械任务夹具；真实Node子进程，无模型。直接导入源码，不改冻结dist。
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startPaoMaintenance, parseMechanicalTask } from "../src/pao-maintenance.ts";
const base = resolve("D:/AI/workspace/临时文件夹/PAO-机械调度测试-20261004");
mkdirSync(base, { recursive: true });
function setup(t: test.TestContext) {
  const home = mkdtempSync(join(base, "home-"));
  t.after(() => {
    assert.ok(home.startsWith(base));
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}
function task(home: string, patch = {}) {
  return {
    id: "fixture",
    名: "机械测试",
    prompt: "这段文字不得作为命令执行",
    cron: "* * * * * *",
    工作目录: home,
    工具白名单: ["归档"],
    repeat: false,
    enabled: true,
    ...patch,
  };
}
async function until(fn: () => boolean) {
  // 容忍窗：结算对象是真实子进程，全量套件并发下可能超 5s（S10-A 登记的
  // session-lease/pao-maintenance 负载抖动族）；放宽只抬高超时上限，绿路径节奏不变。
  const end = Date.now() + 15_000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("等待真实机械子进程结算超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}
test("没有定时目录：零落盘、零子进程", (t) => {
  const home = setup(t);
  let launches = 0;
  const service = startPaoMaintenance({
    home,
    notify: assert.fail,
    spawnWorker() {
      launches++;
      throw new Error("不应启动");
    },
  });
  service.tick();
  service.stop();
  assert.equal(launches, 0);
  assert.deepEqual(readdirSync(home), []);
});
test("未知工具、无id、任意repeat均拒绝；未知任务不会解释prompt", (t) => {
  const home = setup(t);
  for (const patch of [
    { id: undefined },
    { 工具白名单: ["bash"] },
    { repeat: 3 },
    { 工具白名单: [] },
  ])
    assert.throws(() => parseMechanicalTask(task(home, patch)));
  mkdirSync(join(home, "定时"));
  writeFileSync(
    join(home, "定时", "坏任务.json"),
    JSON.stringify(task(home, { 工具白名单: ["派卡"] })),
  );
  const messages: string[] = [];
  let launches = 0;
  const service = startPaoMaintenance({
    home,
    notify: (m) => messages.push(m),
    spawnWorker() {
      launches++;
      throw new Error("不应启动");
    },
  });
  service.tick();
  service.stop();
  assert.equal(launches, 0);
  assert.equal(messages.length, 1);
  const errors = join(home, "定时", "留档", "配置错误");
  assert.match(
    readFileSync(join(errors, readdirSync(errors)[0]!), "utf8"),
    /未启动子进程、未执行prompt/,
  );
});
test("到期真实子进程完成；单次跨重启不重跑", async (t) => {
  const home = setup(t);
  mkdirSync(join(home, "定时"));
  writeFileSync(join(home, "定时", "fixture.json"), JSON.stringify(task(home)));
  let clock = Date.parse("2026-10-04T00:00:00Z");
  const notifications: string[] = [];
  let service = startPaoMaintenance({
    home,
    now: () => clock,
    notify: (m) => notifications.push(m),
  });
  t.after(() => service.stop());
  assert.equal(existsSync(join(home, "定时", "留档")), false);
  clock += 1000;
  service.tick();
  const dir = join(home, "定时", "留档", "fixture");
  const receipt = join(dir, readdirSync(dir)[0]!);
  await until(() => readFileSync(receipt, "utf8").includes("状态：机械白名单操作完成；"));
  assert.match(readFileSync(receipt, "utf8"), /prompt 仅作说明/);
  assert.deepEqual(notifications, []);
  service.stop();
  service = startPaoMaintenance({ home, now: () => clock, notify: (m) => notifications.push(m) });
  clock += 1000;
  service.tick();
  service.stop();
  assert.equal(readdirSync(dir).length, 1);
});

test("单个坏任务不阻塞有效任务，同id冲突双方都不执行", async (t) => {
  const home = setup(t);
  mkdirSync(join(home, "定时"));
  writeFileSync(join(home, "定时", "00坏.json"), "{broken");
  writeFileSync(join(home, "定时", "01有效.json"), JSON.stringify(task(home)));
  writeFileSync(join(home, "定时", "02冲突.json"), JSON.stringify(task(home, { id: "conflict" })));
  writeFileSync(join(home, "定时", "03冲突.json"), JSON.stringify(task(home, { id: "conflict" })));
  let clock = 0;
  const messages: string[] = [];
  const service = startPaoMaintenance({ home, now: () => clock, notify: (m) => messages.push(m) });
  t.after(() => service.stop());
  clock = 1000;
  service.tick();
  const folder = join(home, "定时", "留档", "fixture");
  const receipt = join(folder, readdirSync(folder)[0]!);
  await until(() => readFileSync(receipt, "utf8").includes('"success":true'));
  expectNoConflict();
  function expectNoConflict() {
    assert.equal(existsSync(join(home, "定时", "留档", "conflict")), false);
  }
  assert.equal(messages.length, 2);
});
test("真实机械worker等待执行前断IPC即退，主进程强杀也退出", async (t) => {
  const home = setup(t);
  const worker = fileURLToPath(
    new URL("../extensions/pao/maintenance-worker.mjs", import.meta.url),
  );
  const parentScript = join(home, "parent.mjs");
  writeFileSync(
    parentScript,
    `import {spawn} from 'node:child_process';\nconst child=spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:['ignore','ignore','ignore','ipc']});\nprocess.send(child.pid);\nsetInterval(()=>{},1000);`,
  );
  const parent = spawn(process.execPath, [parentScript], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const [pid] = (await once(parent, "message")) as [number];
  t.after(() => {
    if (parent.exitCode === null) parent.kill();
  });
  // Confirm this is the real worker waiting on its IPC gate, not an already exited process.
  process.kill(pid, 0);
  parent.kill();
  await once(parent, "exit");
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});
test("关闭调度器可靠终止已启动真实子进程，无独立会话误杀", async (t) => {
  const home = setup(t);
  mkdirSync(join(home, "定时"));
  writeFileSync(join(home, "定时", "fixture.json"), JSON.stringify(task(home)));
  let clock = 0;
  let spawned = 0;
  const fixture = join(home, "active.mjs");
  writeFileSync(
    fixture,
    "process.on('message',()=>{});process.on('disconnect',()=>process.exit(2));setInterval(()=>{},1000);",
  );
  const independent = spawn(process.execPath, [fixture], { stdio: "ignore" });
  t.after(() => independent.kill());
  let pid = 0;
  const service = startPaoMaintenance({
    home,
    now: () => clock,
    notify: () => {},
    spawnWorker() {
      spawned++;
      const child = spawn(process.execPath, [fixture], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      pid = child.pid!;
      return child;
    },
  });
  t.after(() => service.stop());
  clock = 1000;
  service.tick();
  clock = 2000;
  service.tick();
  assert.equal(spawned, 1);
  service.stop();
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  process.kill(independent.pid!, 0);
});
test("停用与关闭后的tick均不启动", (t) => {
  const home = setup(t);
  mkdirSync(join(home, "定时"));
  writeFileSync(join(home, "定时", "fixture.json"), JSON.stringify(task(home, { enabled: false })));
  let launches = 0;
  let clock = 0;
  const service = startPaoMaintenance({
    home,
    now: () => clock,
    notify: assert.fail,
    spawnWorker() {
      launches++;
      throw new Error("不应启动");
    },
  });
  clock = 1e9;
  service.tick();
  service.stop();
  writeFileSync(join(home, "定时", "fixture.json"), JSON.stringify(task(home)));
  service.tick();
  assert.equal(launches, 0);
  assert.equal(existsSync(join(home, "定时", "留档")), false);
});

test("归档只删除超出30份的已成功机械留档，保留失败和人工文件", async (t) => {
  const home = setup(t);
  const other = join(home, "定时", "留档", "other");
  mkdirSync(other, { recursive: true });
  for (let i = 0; i < 35; i++) {
    writeFileSync(
      join(other, `${new Date(1e12 + i * 1000).toISOString().replace(/:/g, "-")}.md`),
      '任务：other\n状态：机械白名单操作完成；明确测试夹具\n<!-- PAO机械结算:{"taskId":"other","success":true} -->\n',
    );
  }
  writeFileSync(join(other, "失败.md"), "失败夹具");
  writeFileSync(join(other, "人工记录.md"), "不得删除");
  const failed = join(home, "定时", "留档", "failed");
  mkdirSync(failed);
  for (let i = 0; i < 31; i++)
    writeFileSync(
      join(failed, `${new Date(1e12 + i * 1000).toISOString().replace(/:/g, "-")}.md`),
      '任务：failed\nprompt仅说明：状态：机械白名单操作完成；\n状态：失败\n<!-- PAO机械结算:{"taskId":"failed","success":false} -->\n',
    );
  writeFileSync(join(home, "定时", "fixture.json"), JSON.stringify(task(home)));
  let clock = 0;
  const service = startPaoMaintenance({ home, now: () => clock, notify: assert.fail });
  t.after(() => service.stop());
  clock = 1000;
  service.tick();
  const folder = join(home, "定时", "留档", "fixture");
  const receipt = join(folder, readdirSync(folder)[0]!);
  await until(() => readFileSync(receipt, "utf8").includes("状态：机械白名单操作完成；"));
  assert.equal(readdirSync(other).length, 32);
  assert.equal(readdirSync(failed).length, 31);
  assert.equal(readFileSync(join(other, "人工记录.md"), "utf8"), "不得删除");
});

test("实际worker归档正在删除时强杀父进程，后续删除停止", async (t) => {
  const home = setup(t);
  const other = join(home, "定时", "留档", "other");
  const runDir = join(home, "定时", "留档", "fixture");
  mkdirSync(other, { recursive: true });
  mkdirSync(runDir);
  for (let i = 0; i < 1000; i++)
    writeFileSync(
      join(other, `${new Date(1e12 + i * 1000).toISOString().replace(/:/g, "-")}.md`),
      '<!-- PAO机械结算:{"taskId":"other","success":true} -->\n',
    );
  const worker = fileURLToPath(
    new URL("../extensions/pao/maintenance-worker.mjs", import.meta.url),
  );
  const parentScript = join(home, "active-parent.mjs");
  writeFileSync(
    parentScript,
    `import {spawn} from 'node:child_process';\nconst child=spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,PAO_MECHANICAL_HOME:${JSON.stringify(home)},PAO_MECHANICAL_RUN_DIR:${JSON.stringify(runDir)},PAO_MECHANICAL_TASK:${JSON.stringify(JSON.stringify(task(home)))}}});\nprocess.send(child.pid);child.send('execute');setInterval(()=>{},1000);`,
  );
  const parent = spawn(process.execPath, [parentScript], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const [pid] = (await once(parent, "message")) as [number];
  t.after(() => {
    if (parent.exitCode === null) parent.kill();
  });
  await until(() => readdirSync(other).length < 1000);
  parent.kill();
  await once(parent, "exit");
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  const remaining = readdirSync(other).length;
  assert.ok(remaining > 30, `必须确实中断未完成删除，剩余=${remaining}`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(readdirSync(other).length, remaining);
});

// ── 增量扫描（每秒 tick 不再全量重读任务文件）────────────────────────
import { lstatSync, symlinkSync } from "node:fs";
import { createTaskFolderScanner, maintenancePath } from "../src/pao-maintenance.ts";

test("任务文件未变化时每秒扫描零重读，变化/新增/移除按需重读", (t) => {
  const home = setup(t);
  const folder = join(home, "定时");
  mkdirSync(folder);
  const write = (name: string, patch = {}) =>
    writeFileSync(
      join(folder, name),
      JSON.stringify(task(home, { id: name.replace(".json", ""), ...patch })),
    );
  write("a.json");
  write("b.json");
  const scanner = createTaskFolderScanner(folder, {
    readdirSync,
    lstatSync,
    readFileSync,
    checkPath: maintenancePath,
  });
  const first = scanner.scan();
  assert.equal(first.readCount, 2);
  assert.equal(first.entries.filter((entry) => entry.task).length, 2);

  const second = scanner.scan();
  assert.equal(second.readCount, 0); // 未变化：不重读、不重哈希
  assert.equal(second.entries.length, 2);

  // 内容变化（真实 mtime 前进）→ 重读且 revision 变化
  const beforeRevision = second.entries.find((entry) => entry.file === "a.json")!.revision;
  write("a.json", { cron: "5 5 5 5 5" });
  const third = scanner.scan();
  assert.equal(third.readCount, 1);
  assert.notEqual(third.entries.find((entry) => entry.file === "a.json")!.revision, beforeRevision);

  // 新增 → 只读新增；移除 → 条目消失
  write("c.json");
  const fourth = scanner.scan();
  assert.equal(fourth.readCount, 1);
  assert.equal(fourth.entries.length, 3);
  rmSync(join(folder, "b.json"));
  const fifth = scanner.scan();
  assert.equal(fifth.readCount, 0);
  assert.equal(fifth.entries.length, 2);
});

test("坏 JSON 与符号链接每轮都如实上报，不吃缓存", (t) => {
  const home = setup(t);
  const folder = join(home, "定时");
  mkdirSync(folder);
  writeFileSync(join(folder, "bad.json"), "{broken");
  const outside = join(home, "outside.json");
  writeFileSync(outside, JSON.stringify(task(home)));
  // Windows 无管理员/开发者模式时建不了符号链接（EPERM）：降级只验坏 JSON 路径。
  let symlinkCreated = true;
  try {
    symlinkSync(outside, join(folder, "link.json"));
  } catch (error) {
    if (!((error as NodeJS.ErrnoException).code === "EPERM")) throw error;
    symlinkCreated = false;
  }
  const scanner = createTaskFolderScanner(folder, {
    readdirSync,
    lstatSync,
    readFileSync,
    checkPath: maintenancePath,
  });
  for (let round = 0; round < 2; round++) {
    const scan = scanner.scan();
    const bad = scan.entries.find((entry) => entry.file === "bad.json")!;
    assert.ok(bad.error, "坏 JSON 必须持续上报错误");
    if (symlinkCreated) {
      const link = scan.entries.find((entry) => entry.file === "link.json")!;
      assert.ok(link.error, "符号链接必须持续被拒绝");
    }
  }
});

test("修好的任务文件重新进缓存，错误不粘滞", (t) => {
  const home = setup(t);
  const folder = join(home, "定时");
  mkdirSync(folder);
  writeFileSync(join(folder, "fix.json"), "{broken");
  const scanner = createTaskFolderScanner(folder, {
    readdirSync,
    lstatSync,
    readFileSync,
    checkPath: maintenancePath,
  });
  assert.ok(scanner.scan().entries[0]!.error);
  writeFileSync(join(folder, "fix.json"), JSON.stringify(task(home)));
  const scan = scanner.scan();
  assert.equal(scan.readCount, 1);
  assert.ok(scan.entries[0]!.task);
});
