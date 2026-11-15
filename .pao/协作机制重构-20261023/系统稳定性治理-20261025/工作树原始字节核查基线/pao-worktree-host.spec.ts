import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import { PaoDesktopWorktreeHost } from "../../electron/platform/worktrees/pao-worktree-host";
import { appWorktreeRootMatcher } from "../../electron/platform/worktrees/app-worktree-roots";
import { GitWorktreeManager } from "../../electron/platform/worktrees/worktree-manager";
import { TurnCheckpointStore } from "../../electron/workbench/checkpoint-store";

const execFileAsync = promisify(execFile);

interface ExecutionLocks {
  readonly acquireExecutionLock: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").acquireExecutionLock;
  readonly acquireExecutionRootGuard: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").acquireExecutionRootGuard;
  readonly detectExecutionOccupancy: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").detectExecutionOccupancy;
  readonly listReleasedExecutionArtifacts: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").listReleasedExecutionArtifacts;
  readonly prepareExecutionRootForRemoval: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").prepareExecutionRootForRemoval;
  readonly releaseDispatchLock: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js").releaseDispatchLock;
  readonly WorkerRunner: typeof import("../../../../../PAO/packages/coding-agent/dist/pao/worker/runner.js").WorkerRunner;
}

async function loadLocks(): Promise<ExecutionLocks> {
  const [lock, runner] = await Promise.all([
    import("../../../../../PAO/packages/coding-agent/dist/pao/worker/lock.js"),
    import("../../../../../PAO/packages/coding-agent/dist/pao/worker/runner.js"),
  ]);
  return {
    acquireExecutionLock: lock.acquireExecutionLock,
    acquireExecutionRootGuard: lock.acquireExecutionRootGuard,
    detectExecutionOccupancy: lock.detectExecutionOccupancy,
    listReleasedExecutionArtifacts: lock.listReleasedExecutionArtifacts,
    prepareExecutionRootForRemoval: lock.prepareExecutionRootForRemoval,
    releaseDispatchLock: lock.releaseDispatchLock,
    WorkerRunner: runner.WorkerRunner,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function makeRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "tracked.txt"), "head\n");
  await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await git(repo, "add", "tracked.txt", "binary.bin");
  await git(repo, "commit", "-qm", "seed");
  return repo;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pao-worktree-host-"));
  const repo = await makeRepo(root);
  const userDataDir = join(root, "user-data");
  const catalog = new JsonCatalogStore({
    catalogFilePath: join(userDataDir, "catalogs.json"),
  });
  const checkpoints = new TurnCheckpointStore(userDataDir, {
    timeoutMs: 20_000,
    maxFiles: 100,
    maxBytes: 8 * 1024 * 1024,
    maxFileBytes: 4 * 1024 * 1024,
  });
  const worktreeRoot = join(userDataDir, "worktrees");
  const worktreeManager = new GitWorktreeManager({
    catalogStorage: catalog,
    isAppWorktreePath: appWorktreeRootMatcher(worktreeRoot),
  });
  const makeHost = async (
    activeExecution?: () => boolean | "unknown",
    lockIntegration = false,
    persistStateHook?: (phase: "pending" | "completed") => Promise<void>,
    afterWorktreeCreated?: (executionRoot: string) => Promise<void>,
  ) => {
    const locks = lockIntegration ? await loadLocks() : undefined;
    return new PaoDesktopWorktreeHost({
      userDataDir,
      catalogStorage: catalog,
      checkpoints,
      worktreeManager,
      ...(activeExecution ? { activeExecution } : {}),
      ...(persistStateHook ? { persistStateHook } : {}),
      ...(afterWorktreeCreated ? { afterWorktreeCreated } : {}),
      ...(lockIntegration
        ? {
            executionOccupancy: locks!.detectExecutionOccupancy,
            acquireCleanupGuard: locks!.acquireExecutionRootGuard,
            listReleasedExecutionArtifacts: locks!.listReleasedExecutionArtifacts,
            prepareRunMetadataForRemoval: locks!.prepareExecutionRootForRemoval,
          }
        : {}),
    });
  };
  return { root, repo, userDataDir, catalog, checkpoints, makeHost };
}

async function sha(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

test("桌面宿主的实际恢复基线可由内核直接派发真实离线进程", async () => {
  const { root, repo, makeHost } = await fixture();
  const { createCard } =
    await import("../../../../../PAO/packages/coding-agent/dist/pao/cards/cardfile.js");
  const { executeDispatch, appendDispatchReceipt } =
    await import("../../../../../PAO/packages/coding-agent/dist/pao/worker/dispatch-core.js");
  const { WorkerRunner } = await loadLocks();
  const runner = new WorkerRunner({ 证据目录: join(root, "evidence") });
  try {
    const cardsDir = join(repo, ".pao", "卡");
    await mkdir(cardsDir, { recursive: true });
    await createCard(cardsDir, {
      目标: "桌面宿主派发",
      部门: "测试",
      验收: "离线进程成功",
      创建: "2026-10-21 10:00",
    });
    const host = await makeHost(undefined, true);
    const binding = await host.create({ requestId: "real-kernel-dispatch", projectRoot: repo });
    if (binding.kind !== "managed") throw new Error("未创建受管工作树");
    expect(binding.bindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const statePath = join(root, "user-data", "pao-worktree-host.json");
    const legacyState = JSON.parse(await readFile(statePath, "utf8"));
    legacyState.creates["real-kernel-dispatch"].binding.bindingDigest = binding.bindingDigest.slice(
      "sha256:".length,
    );
    await writeFile(statePath, JSON.stringify(legacyState));
    const legacyBytes = await readFile(statePath, "utf8");
    const reopened = await makeHost(undefined, true);
    expect(
      (
        await reopened.resolveForDispatch({
          requestId: "legacy-read",
          projectRoot: repo,
          target: { kind: "managed", worktreeId: binding.worktreeId },
        })
      ).bindingDigest,
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await readFile(statePath, "utf8")).toBe(legacyBytes);
    const script = join(root, "worker.cjs");
    await writeFile(
      script,
      'require("node:fs").writeFileSync("result.txt", "真实工作树产物"); console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify({result:"success",artifact_path:["result.txt"],summary:"离线完成"})}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:0}}}));',
    );
    const result = await executeDispatch(
      { cardsDir, card_no: "1", operator: "主控", time: "2026-10-21 10:00" },
      {
        运行器: runner,
        paoHome: join(root, "home"),
        workflowCheck: () => undefined,
        worktreeHost: reopened,
        worktreeTarget: { kind: "managed", worktreeId: binding.worktreeId },
        公共参数: { 命令: process.execPath, 参数: [script] },
      },
      async (claim, receipt) => {
        await appendDispatchReceipt(claim.card, receipt);
        return receipt;
      },
    );
    expect(result).toMatchObject({ 可派: true, result: { status: "success", attempt: 1 } });
    expect(await readFile(join(binding.executionRoot, "result.txt"), "utf8")).toBe(
      "真实工作树产物",
    );
    expect(existsSync(join(repo, "result.txt"))).toBe(false);
  } finally {
    await runner.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("materializes a dirty binary and untracked baseline without mutating the source", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    const dirty = Buffer.from([0, 255, 0, 8, 9]);
    await writeFile(join(repo, "tracked.txt"), "dirty tracked\n");
    await writeFile(join(repo, "binary.bin"), dirty);
    await writeFile(join(repo, "untracked.bin"), Buffer.from([9, 8, 0, 7]));
    const sourceHead = await git(repo, "rev-parse", "HEAD");
    const sourceStatus = await git(repo, "status", "--porcelain=v1", "-z");
    const sourceTracked = await sha(join(repo, "tracked.txt"));
    const sourceBinary = await sha(join(repo, "binary.bin"));

    const host = await makeHost();
    const binding = await host.create({
      requestId: "create-dirty",
      projectRoot: repo,
      displayName: "dirty",
    });
    expect(binding.kind).toBe("managed");
    if (binding.kind !== "managed") throw new Error("expected managed binding");

    expect(await readFile(join(binding.executionRoot, "tracked.txt"), "utf8")).toMatch(
      /^dirty tracked\r?\n$/,
    );
    expect(await sha(join(binding.executionRoot, "binary.bin"))).toBe(sourceBinary);
    expect(await sha(join(binding.executionRoot, "untracked.bin"))).toBe(
      await sha(join(repo, "untracked.bin")),
    );
    expect(await git(repo, "rev-parse", "HEAD")).toBe(sourceHead);
    expect(await git(repo, "status", "--porcelain=v1", "-z")).toBe(sourceStatus);
    expect(await sha(join(repo, "tracked.txt"))).toBe(sourceTracked);
    expect(await sha(join(repo, "binary.bin"))).toBe(sourceBinary);
  } finally {
    if (process.env.PAO_KEEP_WORKTREE_FAILURE === "1") {
      console.log(`保留工作树测试现场：${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("managed baseline replay preserves LF bytes when repository autocrlf is true", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    await git(repo, "config", "core.autocrlf", "true");

    const binding = await (await makeHost()).create({
      requestId: "preserve-checkout-bytes",
      projectRoot: repo,
    });
    if (binding.kind !== "managed") throw new Error("expected managed binding");

    expect(await readFile(join(binding.executionRoot, "tracked.txt"))).toEqual(
      Buffer.from("head\n"),
    );
    expect(await git(repo, "config", "--get", "core.autocrlf")).toBe("true");
    expect(await git(binding.executionRoot, "config", "--get", "core.autocrlf")).toBe("true");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed baseline replay rejects checkout filters that change captured bytes", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    await writeFile(join(repo, ".gitattributes"), "tracked.txt text eol=crlf\n");
    await git(repo, "add", ".gitattributes");
    await git(repo, "commit", "-qm", "checkout filter");

    await expect(
      (await makeHost()).create({
        requestId: "reject-checkout-filter",
        projectRoot: repo,
      }),
    ).rejects.toThrow(/工作目录内容与来源基线不一致|内容尚未完整落地/);
  } finally {
    const entries = (await git(repo, "worktree", "list", "--porcelain")).split(/\r?\n/);
    const linkedPath = entries
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice(9))
      .find((path) => resolve(path) !== resolve(repo));
    if (linkedPath) await git(repo, "worktree", "remove", "--force", linkedPath);
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses an identical create request and rejects a changed input", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    const host = await makeHost();
    const request = { requestId: "stable", projectRoot: repo, displayName: "same" };
    const first = await host.create(request);
    const second = await host.create(request);
    expect(second).toEqual(first);
    await expect(host.create({ ...request, displayName: "different" })).rejects.toThrow(
      /相同|不同的/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists baseline and resolves it after a host restart", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    const created = await (await makeHost()).create({ requestId: "restart", projectRoot: repo });
    if (created.kind !== "managed") throw new Error("expected managed binding");
    const restarted = await makeHost();
    const resolved = await restarted.resolveForDispatch({
      requestId: "dispatch-restart",
      projectRoot: repo,
      target: { kind: "managed", worktreeId: created.worktreeId },
      expectedInputVersion: created.inputVersion,
    });
    expect(resolved).toMatchObject({
      kind: "managed",
      worktreeId: created.worktreeId,
      baseline: created.baseline,
    });
    expect(
      (await restarted.inspect({ projectRoot: repo, worktreeId: created.worktreeId }))[0],
    ).toMatchObject({ kind: "managed", dirty: false, untracked: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers a created worktree after the completed record fails without rebuilding", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    let failedOnce = false;
    const first = await makeHost(undefined, false, async (phase) => {
      if (phase !== "completed" || failedOnce) return;
      failedOnce = true;
      throw new Error("注入：完成记录写失败");
    });
    await expect(
      first.create({ requestId: "pending-window", projectRoot: repo, displayName: "pending" }),
    ).rejects.toThrow(/完成记录写失败/);

    const worktrees = await git(repo, "worktree", "list", "--porcelain");
    const branches = await git(repo, "branch", "--list", "pi/*");
    expect(worktrees.match(/^worktree /gm)).toHaveLength(2);
    expect(branches.trim().split(/\r?\n/)).toHaveLength(1);

    const restarted = await makeHost();
    const recovered = await restarted.create({
      requestId: "pending-window",
      projectRoot: repo,
      displayName: "pending",
    });
    if (recovered.kind !== "managed") throw new Error("expected managed binding");
    expect(recovered.executionRoot).toContain("pao-");
    expect(await readFile(join(recovered.executionRoot, "tracked.txt"), "utf8")).toMatch(
      /^head\r?\n$/,
    );
    expect(await git(repo, "worktree", "list", "--porcelain")).toBe(worktrees);
    expect(await git(repo, "branch", "--list", "pi/*")).toBe(branches);
    const state = JSON.parse(
      await readFile(join(root, "user-data", "pao-worktree-host.json"), "utf8"),
    ) as { version: number; creates: Record<string, { status: string; binding?: unknown }> };
    expect(state.version).toBe(2);
    expect(state.creates["pending-window"]).toMatchObject({
      status: "completed",
      binding: expect.objectContaining({ kind: "managed" }),
    });
  } finally {
    if (process.env.PAO_KEEP_WORKTREE_FAILURE === "1") {
      console.log(`保留工作树测试现场：${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("does not mark a half-created pending worktree complete and never rebuilds it", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    await writeFile(join(repo, "tracked.txt"), "dirty before half create\n");
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 4, 2, 0, 8]));
    await writeFile(join(repo, "untracked.bin"), Buffer.from([7, 0, 5]));
    const first = await makeHost(undefined, false, undefined, async () => {
      throw new Error("注入：建树后、基线落地前失败");
    });
    await expect(
      first.create({ requestId: "pending-half", projectRoot: repo, displayName: "half" }),
    ).rejects.toThrow(/建树后、基线落地前失败/);

    const worktrees = await git(repo, "worktree", "list", "--porcelain");
    const branches = await git(repo, "branch", "--list", "pi/*");
    expect(worktrees.match(/^worktree /gm)).toHaveLength(2);
    expect(branches.trim().split(/\r?\n/)).toHaveLength(1);

    const restarted = await makeHost();
    await expect(
      restarted.create({
        requestId: "pending-half",
        projectRoot: repo,
        displayName: "half",
      }),
    ).rejects.toThrow(/内容尚未完整落地|保留现场待盘点/);
    expect(await git(repo, "worktree", "list", "--porcelain")).toBe(worktrees);
    expect(await git(repo, "branch", "--list", "pi/*")).toBe(branches);
    const state = JSON.parse(
      await readFile(join(root, "user-data", "pao-worktree-host.json"), "utf8"),
    ) as { creates: Record<string, { status: string; binding?: unknown }> };
    expect(state.creates["pending-half"]).toEqual(expect.objectContaining({ status: "pending" }));
    expect(state.creates["pending-half"]?.binding).toBeUndefined();
  } finally {
    if (process.env.PAO_KEEP_WORKTREE_FAILURE === "1") {
      console.log(`保留半完成工作树测试现场：${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects cleanup while active, dirty, untracked, or unmerged and keeps the branch", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    const created = await (
      await makeHost()
    ).create({ requestId: "cleanup-safe", projectRoot: repo });
    if (created.kind !== "managed") throw new Error("expected managed binding");

    await expect(
      (await makeHost(() => true)).requestCleanup({
        requestId: "active",
        projectRoot: repo,
        worktreeId: created.worktreeId,
        reason: "test",
        executionActive: false,
      }),
    ).resolves.toMatchObject({ ok: false, retained: true });

    await writeFile(join(created.executionRoot, "tracked.txt"), "dirty\n");
    await expect(
      (await makeHost()).requestCleanup({
        requestId: "dirty",
        projectRoot: repo,
        worktreeId: created.worktreeId,
        reason: "test",
        executionActive: false,
      }),
    ).resolves.toMatchObject({ ok: false, retained: true });
    await git(created.executionRoot, "checkout", "--", "tracked.txt");

    await writeFile(join(created.executionRoot, "untracked.txt"), "keep\n");
    await expect(
      (await makeHost()).requestCleanup({
        requestId: "untracked",
        projectRoot: repo,
        worktreeId: created.worktreeId,
        reason: "test",
        executionActive: false,
      }),
    ).resolves.toMatchObject({ ok: false, retained: true });
    await unlink(join(created.executionRoot, "untracked.txt"));

    await writeFile(join(created.executionRoot, "work.txt"), "committed work\n");
    await git(created.executionRoot, "add", "work.txt");
    await git(created.executionRoot, "commit", "-qm", "worktree work");
    await expect(
      (await makeHost()).requestCleanup({
        requestId: "unmerged",
        projectRoot: repo,
        worktreeId: created.worktreeId,
        reason: "test",
        executionActive: false,
      }),
    ).resolves.toMatchObject({ ok: false, retained: true });
    expect((await git(repo, "branch", "--list", created.branchName)).trim()).not.toBe("");
    await expect(stat(created.executionRoot)).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup request identity is retained even for a safe rejection", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    const created = await (await makeHost()).create({ requestId: "cleanup-id", projectRoot: repo });
    if (created.kind !== "managed") throw new Error("expected managed binding");
    const host = await makeHost();
    const request = {
      requestId: "cleanup-id",
      projectRoot: repo,
      worktreeId: created.worktreeId,
      reason: "first",
      executionActive: "unknown" as const,
    };
    expect(await host.requestCleanup(request)).toMatchObject({ ok: false, retained: true });
    await expect(host.requestCleanup({ ...request, reason: "different" })).rejects.toThrow(
      /相同 request_id|不同的工作目录清理请求/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a clean merged worktree without deleting its branch", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    const created = await (
      await makeHost()
    ).create({ requestId: "cleanup-merged", projectRoot: repo });
    if (created.kind !== "managed") throw new Error("expected managed binding");
    expect(created.branchName).toBeDefined();
    const result = await (
      await makeHost(undefined, true)
    ).requestCleanup({
      requestId: "cleanup-merged",
      projectRoot: repo,
      worktreeId: created.worktreeId,
      reason: "merged",
      executionActive: false,
    });
    expect(result).toEqual({ ok: true, released: true, branchDeleted: false });
    await expect(stat(created.executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await git(repo, "branch", "--list", created.branchName)).trim()).not.toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains a worktree when another execution lease holds the root", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    const created = await (
      await makeHost()
    ).create({ requestId: "cleanup-external", projectRoot: repo });
    if (created.kind !== "managed") throw new Error("expected managed binding");
    const { acquireExecutionLock, detectExecutionOccupancy, releaseDispatchLock, WorkerRunner } =
      await loadLocks();
    const worker = new WorkerRunner();
    const lock = await acquireExecutionLock({
      root: created.executionRoot,
      holder: "other-session",
    });
    try {
      await expect(detectExecutionOccupancy(created.executionRoot)).resolves.toBe("active");
      const result = await (
        await makeHost(undefined, true)
      ).requestCleanup({
        requestId: "cleanup-external",
        projectRoot: repo,
        worktreeId: created.worktreeId,
        reason: "external active",
        executionActive: false,
      });
      expect(result).toMatchObject({ ok: false, retained: true });
      await expect(stat(created.executionRoot)).resolves.toBeDefined();
      expect((await git(repo, "branch", "--list", created.branchName)).trim()).not.toBe("");
    } finally {
      await releaseDispatchLock(lock, worker.confirmStopped("other-session"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an approved lease cannot start while cleanup owns the root guard", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    const created = await (await makeHost()).create({ requestId: "guard-race", projectRoot: repo });
    if (created.kind !== "managed") throw new Error("expected managed binding");
    const { acquireExecutionRootGuard } = await loadLocks();
    const guard = await acquireExecutionRootGuard({
      taskRoot: repo,
      executionRoot: created.executionRoot,
      holder: "cleanup-in-progress",
    });
    await expect(
      acquireExecutionRootGuard({
        taskRoot: repo,
        executionRoot: created.executionRoot,
        holder: "new-dispatch",
      }),
    ).rejects.toThrow(/已有清理或占用守卫/);
    await guard.release();
    const nextGuard = await acquireExecutionRootGuard({
      taskRoot: repo,
      executionRoot: created.executionRoot,
      holder: "after-cleanup",
    });
    await nextGuard.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normally finished worktree releases its own untracked runtime metadata and directory", async () => {
  const { root, repo, makeHost } = await fixture();
  try {
    const created = await (
      await makeHost()
    ).create({ requestId: "cleanup-runtime", projectRoot: repo });
    if (created.kind !== "managed") throw new Error("expected managed binding");
    await mkdir(join(created.executionRoot, ".pao"), { recursive: true });
    writeFileSync(join(created.executionRoot, ".pao", "执行锁"), "", "utf8");
    writeFileSync(
      join(created.executionRoot, ".pao", "派发日志.jsonl"),
      '{"event":"test"}\n',
      "utf8",
    );
    writeFileSync(join(created.executionRoot, ".pao", "用户证据.txt"), "保留\n", "utf8");

    const withoutCleanup = await makeHost().then((host) =>
      host.requestCleanup({
        requestId: "runtime-blocked",
        projectRoot: repo,
        worktreeId: created.worktreeId,
        reason: "untracked runtime",
        executionActive: false,
      }),
    );
    expect(withoutCleanup).toMatchObject({ ok: false, retained: true });
    await expect(stat(created.executionRoot)).resolves.toBeDefined();

    await unlink(join(created.executionRoot, ".pao", "用户证据.txt"));
    const released = await (
      await makeHost(undefined, true)
    ).requestCleanup({
      requestId: "runtime-released",
      projectRoot: repo,
      worktreeId: created.worktreeId,
      reason: "finished",
      executionActive: false,
    });
    expect(released).toEqual({ ok: true, released: true, branchDeleted: false });
    await expect(stat(created.executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(join(repo, "worker-evidence", "工作树运行证据"))).toBe(true);
    expect((await git(repo, "branch", "--list", created.branchName)).trim()).not.toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single-root inspection reports unknown rather than fake clean state", async () => {
  const { createSingleRootWorktreeHost } =
    await import("../../node_modules/@earendil-works/pi-coding-agent/dist/pao/index.js");
  const host = createSingleRootWorktreeHost("C:\\task", "version-1");
  expect(await host.inspect({ projectRoot: "C:\\task" })).toEqual([
    expect.objectContaining({ dirty: "unknown", untracked: "unknown", active: "unknown" }),
  ]);
});
