// .pao/协作机制重构-20261023/benchmark-host-entry.ts
import { join as join6 } from "node:path";

// desktop/apps/desktop/electron/platform/worktrees/pao-worktree-host.ts
import { createHash } from "node:crypto";
import { execFile as execFile2 } from "node:child_process";
import { mkdtemp, readdir as readdir2, realpath as realpath3, rm, rmdir, stat, unlink as unlink2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename as basename3, dirname as dirname4, isAbsolute as isAbsolute2, join as join3, resolve as resolve3 } from "node:path";
import { promisify as promisify2 } from "node:util";

// desktop/apps/desktop/electron/persistence/atomic-file-write.ts
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
var writeQueueByPath = /* @__PURE__ */ new Map();
async function writeFileAtomicQueued(filePath, contents, validateExisting, options) {
  await enqueueWrite(filePath, async () => {
    const existing = await readJsonWithBackup(filePath);
    if (existing.corrupted && !existing.recovered) {
      throw new Error(
        `Cannot overwrite invalid saved data at ${filePath}; repair or restore it first.`
      );
    }
    const validated = existing.value === void 0 ? void 0 : validateExisting(existing.value);
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const preservedPath = validated === void 0 ? void 0 : options?.preserveExistingAs(validated);
    if (preservedPath && existing.contents !== void 0) {
      const preserved = await open(preservedPath, "wx");
      try {
        await preserved.writeFile(existing.contents);
        await preserved.sync();
      } finally {
        await preserved.close();
      }
      await fsyncDir(dir);
    }
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await promoteToTarget(tmpPath, filePath, existing.corrupted);
    } catch (error) {
      await cleanupTempFile(tmpPath);
      throw error;
    }
    await fsyncDir(dir);
  });
}
async function readJsonWithBackup(filePath) {
  const primary = await tryReadParse(filePath);
  if (primary.status === "ok") {
    return { value: primary.value, contents: primary.contents, corrupted: false, recovered: false };
  }
  const backup = await tryReadParse(`${filePath}.bak`);
  if (backup.status === "ok") {
    return {
      value: backup.value,
      contents: backup.contents,
      corrupted: primary.status === "corrupt",
      recovered: true
    };
  }
  return {
    value: void 0,
    corrupted: primary.status === "corrupt" || backup.status === "corrupt",
    recovered: false
  };
}
async function tryReadParse(filePath) {
  let raw;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    throw error;
  }
  try {
    return { status: "ok", value: JSON.parse(raw.toString("utf8")), contents: raw };
  } catch {
    return { status: "corrupt" };
  }
}
async function promoteToTarget(tmpPath, filePath, preserveCorrupt) {
  if (!preserveCorrupt) {
    try {
      await copyFile(filePath, `${filePath}.bak`);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    await renameReplace(tmpPath, filePath);
    return;
  }
  try {
    await renameReplace(filePath, `${filePath}.corrupt.${randomUUID()}`);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  await renameReplace(tmpPath, filePath);
}
async function renameReplace(src, dest) {
  try {
    await rename(src, dest);
    return;
  } catch (error) {
    if (!isReplaceRenameError(error)) {
      throw error;
    }
  }
  await cleanupTempFile(dest);
  await rename(src, dest);
}
async function fsyncDir(dir) {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
  } finally {
    await handle?.close();
  }
}
function isMissingFileError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isReplaceRenameError(error) {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "EEXIST" || error.code === "EPERM");
}
async function cleanupTempFile(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}
async function enqueueWrite(filePath, write) {
  const previous = writeQueueByPath.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => void 0).then(write);
  writeQueueByPath.set(filePath, next);
  try {
    await next;
  } finally {
    if (writeQueueByPath.get(filePath) === next) {
      writeQueueByPath.delete(filePath);
    }
  }
}

// desktop/apps/desktop/electron/platform/worktrees/app-worktree-roots.ts
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname as dirname2, isAbsolute, join, relative, resolve, sep } from "node:path";
function appWorktreeRootMatcher(profileRoot) {
  return async (path) => {
    const candidate = await canonicalize(path);
    const roots = await Promise.all(
      [profileRoot, join(homedir(), ".pi", "worktrees")].map(canonicalize)
    );
    return roots.some((root) => isStrictlyWithin(root, candidate));
  };
}
function isStrictlyWithin(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}
async function canonicalize(path) {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname2(absolute);
    return parent === absolute ? absolute : join(await canonicalize(parent), basename(absolute));
  }
}

// desktop/apps/desktop/electron/platform/worktrees/worktree-manager.ts
import { execFile } from "node:child_process";
import { mkdir as mkdir2, readdir, realpath as realpath2 } from "node:fs/promises";
import { basename as basename2, dirname as dirname3, join as join2, resolve as resolve2 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var GitWorktreeManager = class {
  constructor(options) {
    this.options = options;
  }
  options;
  async listWorktrees(workspace) {
    return this.options.catalogStorage.worktrees.listWorktrees(workspace.workspaceId);
  }
  /**
   * Rebuild one folder's worktree rows. Refreshes run one at a time so two
   * folders never both claim the same app worktree. `claimPath` hands a
   * worktree the folder just created to that folder, whoever listed it first.
   */
  async refreshWorktrees(workspace, options = {}) {
    const run = this.refreshQueue.then(() => this.refreshWorktreesNow(workspace, options));
    this.refreshQueue = run.catch(() => void 0);
    return run;
  }
  refreshQueue = Promise.resolve();
  async refreshWorktreesNow(workspace, options) {
    const repoRoot = await resolveRepositoryRoot(workspace.path);
    if (options.claimPath) {
      await this.releaseClaimsElsewhere(workspace.workspaceId, options.claimPath);
    }
    const existing = await this.options.catalogStorage.worktrees.listWorktrees(
      workspace.workspaceId
    );
    const discovered = await this.ownLinkedWorktrees(
      workspace,
      await listGitWorktrees(repoRoot, workspace, existing.worktrees)
    );
    await this.options.catalogStorage.worktrees.replaceWorkspaceWorktrees(
      workspace.workspaceId,
      discovered
    );
    return { worktrees: discovered.map((entry) => ({ ...entry })) };
  }
  async releaseClaimsElsewhere(workspaceId, path) {
    const catalog = await this.options.catalogStorage.worktrees.listWorktrees();
    const claimants = new Set(
      catalog.worktrees.filter((entry) => entry.path === path && entry.workspaceId !== workspaceId).map((entry) => entry.workspaceId)
    );
    for (const claimant of claimants) {
      await this.options.catalogStorage.worktrees.replaceWorkspaceWorktrees(
        claimant,
        catalog.worktrees.filter((entry) => entry.workspaceId === claimant && entry.path !== path)
      );
    }
  }
  /**
   * Keep the workspace's own row and the app worktrees no other folder has
   * claimed, so each app worktree nests under exactly one folder.
   */
  async ownLinkedWorktrees(workspace, discovered) {
    const catalog = await this.options.catalogStorage.worktrees.listWorktrees();
    const claimedElsewhere = new Set(
      catalog.worktrees.filter((entry) => entry.kind === "linked" && entry.workspaceId !== workspace.workspaceId).map((entry) => entry.path)
    );
    const isAppWorktreePath = this.options.isAppWorktreePath;
    const owned = [];
    for (const entry of discovered) {
      if (entry.kind === "primary" || !claimedElsewhere.has(entry.path) && (!isAppWorktreePath || await isAppWorktreePath(entry.path))) {
        owned.push(entry);
      }
    }
    return owned;
  }
  async inspectWorkspace(workspace) {
    return inspectGitWorkspace(workspace.path);
  }
  async createWorktree(workspace, input) {
    const repoRoot = await resolveRepositoryRoot(workspace.path);
    const normalizedPath = input.path.trim();
    if (!normalizedPath) {
      throw new Error("Worktree path cannot be empty.");
    }
    const worktreePath = resolve2(normalizedPath);
    await mkdir2(dirname3(worktreePath), { recursive: true });
    const args = ["-C", repoRoot, "worktree", "add"];
    if (input.branchName) {
      args.push("-b", input.branchName);
    }
    args.push(worktreePath, input.startPoint?.trim() || "HEAD");
    await runGit(args);
    const canonicalWorktreePath = await canonicalPath(worktreePath);
    const snapshot = await this.refreshWorktrees(workspace, { claimPath: canonicalWorktreePath });
    const created = snapshot.worktrees.find((entry) => entry.worktreeId === canonicalWorktreePath);
    if (!created) {
      throw new Error(
        `Worktree ${canonicalWorktreePath} was created but is missing from the catalog.`
      );
    }
    if (input.displayName?.trim()) {
      const next = { ...created, displayName: input.displayName.trim() };
      await this.options.catalogStorage.worktrees.upsertWorktree(next);
      return next;
    }
    return created;
  }
  async removeWorktree(workspace, worktreeId, options = {}) {
    const repoRoot = await resolveRepositoryRoot(workspace.path);
    const resolvedId = await canonicalPath(worktreeId);
    const existing = await this.options.catalogStorage.worktrees.getWorktree(resolvedId);
    const targetPath = await canonicalPath(existing?.path ? existing.path : resolvedId);
    if (existing?.kind === "primary" || !existing && targetPath === await canonicalPath(workspace.path)) {
      throw new Error("The primary workspace cannot be removed as a git worktree.");
    }
    if (this.options.isAppWorktreePath && !await this.isRemovableAppWorktree(targetPath)) {
      throw new Error("Only worktrees created by pi-gui can be removed here.");
    }
    try {
      await runGit([
        "-C",
        repoRoot,
        "worktree",
        "remove",
        ...options.force ? ["--force"] : [],
        targetPath
      ]);
    } catch (error) {
      const refreshed = await this.refreshWorktrees(workspace);
      if (!refreshed.worktrees.some((entry) => entry.worktreeId === targetPath)) {
        await deleteAppWorktreeBranch(repoRoot, existing?.branchName);
        return;
      }
      throw error;
    }
    await this.refreshWorktrees(workspace);
    await deleteAppWorktreeBranch(repoRoot, existing?.branchName);
  }
  /**
   * Location alone does not prove pi-gui made a checkout, so removal also needs
   * the `pi/*` branch every app worktree is created on (as the startup prune does).
   */
  async isRemovableAppWorktree(path) {
    if (!await this.options.isAppWorktreePath?.(path)) {
      return false;
    }
    const info = await inspectLinkedWorktree(path).catch(() => void 0);
    return Boolean(info?.branchName?.startsWith("pi/"));
  }
  /**
   * Roll back a worktree that this app just created (fix: transactional thread
   * creation). Force-removes the worktree and deletes its branch — both are
   * brand-new artifacts owned by the failed call, so nothing pre-existing is
   * touched. Best-effort: never throws.
   */
  async destroyWorktree(workspace, input) {
    let repoRoot;
    try {
      repoRoot = await resolveRepositoryRoot(workspace.path);
    } catch {
      return;
    }
    const targetPath = await canonicalPath(input.path);
    try {
      await runGit(["-C", repoRoot, "worktree", "remove", "--force", targetPath]);
    } catch {
    }
    if (input.branchName) {
      try {
        await runGit(["-C", repoRoot, "branch", "-D", input.branchName]);
      } catch {
      }
    }
    await this.refreshWorktrees(workspace).catch(() => void 0);
  }
  /**
   * Startup reconcile pass: remove git worktrees under the app's worktree root
   * that no longer have a catalog/session reference. Only merged `pi/*` branches
   * are eligible. Never force-removes a dirty worktree (a non-`--force`
   * `git worktree remove` refuses when the tree is modified), so user work is
   * never destroyed — protected worktrees are skipped and reported instead.
   */
  async pruneOrphanedWorktrees(input) {
    const worktreeRoot = await canonicalPath(input.worktreeRoot);
    const removed = [];
    const skipped = [];
    const candidates = await listAppWorktreeCandidates(worktreeRoot);
    for (const candidatePath of candidates) {
      if (input.referencedPaths.has(candidatePath)) {
        continue;
      }
      let repoRoot;
      let branchName;
      try {
        const info = await inspectLinkedWorktree(candidatePath);
        if (!info) {
          skipped.push(candidatePath);
          continue;
        }
        repoRoot = info.repoRoot;
        branchName = info.branchName;
      } catch {
        skipped.push(candidatePath);
        continue;
      }
      if (!branchName?.startsWith("pi/") || !await isBranchMergedIntoHead(repoRoot, branchName)) {
        skipped.push(candidatePath);
        continue;
      }
      try {
        await runGit(["-C", repoRoot, "worktree", "remove", candidatePath]);
        removed.push(candidatePath);
        await deleteAppWorktreeBranch(repoRoot, branchName);
      } catch (error) {
        skipped.push(candidatePath);
        console.warn(`pi-gui: kept orphaned worktree ${candidatePath}: ${errorMessage(error)}`);
      }
    }
    return { removed, skipped };
  }
};
async function deleteAppWorktreeBranch(repoRoot, branchName) {
  if (!branchName || !branchName.startsWith("pi/")) {
    return;
  }
  try {
    await runGit(["-C", repoRoot, "branch", "-d", branchName]);
  } catch (error) {
    console.warn(
      `pi-gui: kept branch ${branchName} after worktree removal: ${errorMessage(error)}`
    );
  }
}
async function isBranchMergedIntoHead(repoRoot, branchName) {
  try {
    await runGit([
      "-C",
      repoRoot,
      "merge-base",
      "--is-ancestor",
      `refs/heads/${branchName}`,
      "HEAD"
    ]);
    return true;
  } catch {
    return false;
  }
}
async function listAppWorktreeCandidates(worktreeRoot) {
  let repoDirs;
  try {
    repoDirs = (await readdir(worktreeRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const candidates = [];
  for (const repoDir of repoDirs) {
    let folders;
    try {
      folders = (await readdir(join2(worktreeRoot, repoDir), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const folder of folders) {
      candidates.push(await canonicalPath(join2(worktreeRoot, repoDir, folder)));
    }
  }
  return candidates;
}
async function inspectLinkedWorktree(worktreePath) {
  const output = await runGit(["-C", worktreePath, "worktree", "list", "--porcelain"]);
  const blocks = output.split(/\n\s*\n/).filter((block) => block.trim());
  let repoRoot;
  let branchName;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim());
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!worktreeLine) {
      continue;
    }
    const entryPath = await canonicalPath(worktreeLine.slice("worktree ".length).trim());
    if (repoRoot === void 0) {
      repoRoot = entryPath;
    }
    if (entryPath === worktreePath) {
      const branchLine = lines.find((line) => line.startsWith("branch "));
      if (branchLine) {
        branchName = normalizeBranchName(branchLine.slice("branch ".length).trim());
      }
    }
  }
  if (!repoRoot || repoRoot === worktreePath) {
    return void 0;
  }
  return { repoRoot, ...branchName ? { branchName } : {} };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function resolveRepositoryRoot(workspacePath) {
  const output = await runGit(["-C", workspacePath, "rev-parse", "--show-toplevel"]);
  return canonicalPath(output.trim());
}
async function inspectGitWorkspace(workspacePath) {
  const canonicalPathValue = await canonicalPath(workspacePath);
  const commonDirPath = (await runGit(["-C", workspacePath, "rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  return {
    canonicalPath: canonicalPathValue,
    commonDir: await canonicalPath(commonDirPath)
  };
}
async function listGitWorktrees(repoRoot, workspace, existingEntries) {
  const output = await runGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const existing = new Map(existingEntries.map((entry) => [entry.worktreeId, entry]));
  const discovered = /* @__PURE__ */ new Map();
  for (const block of output.split(/\n\s*\n/)) {
    const entry = await parseWorktreeBlock(block, workspace, existing);
    if (entry) {
      discovered.set(entry.worktreeId, mergeWorktreeEntry(entry, existing.get(entry.worktreeId)));
    }
  }
  const workspacePath = await canonicalPath(workspace.path);
  if (!discovered.has(workspacePath)) {
    const primaryPath = workspacePath;
    discovered.set(
      primaryPath,
      mergeWorktreeEntry(
        {
          worktreeId: primaryPath,
          workspaceId: workspace.workspaceId,
          path: primaryPath,
          displayName: workspace.displayName?.trim() || basename2(primaryPath) || primaryPath,
          kind: "primary",
          status: "ready",
          createdAt: nowIso(),
          updatedAt: nowIso()
        },
        existing.get(primaryPath)
      )
    );
  }
  return [...discovered.values()].sort(compareWorktreeEntries);
}
async function parseWorktreeBlock(block, workspace, existing) {
  const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return void 0;
  }
  const worktreeLine = lines.find((line) => line.startsWith("worktree "));
  if (!worktreeLine) {
    return void 0;
  }
  const path = await canonicalPath(worktreeLine.slice("worktree ".length).trim());
  const workspacePath = await canonicalPath(workspace.path);
  const kind = path === workspacePath ? "primary" : "linked";
  const headLine = lines.find((line) => line.startsWith("HEAD "));
  const branchLine = lines.find((line) => line.startsWith("branch "));
  const status = lines.includes("prunable") ? "missing" : "ready";
  const displayName = existing.get(path)?.displayName?.trim() || defaultWorktreeDisplayName(workspace, path, kind);
  const entry = {
    worktreeId: path,
    workspaceId: workspace.workspaceId,
    path,
    displayName,
    kind,
    status,
    ...headLine ? { headSha: headLine.slice("HEAD ".length).trim() } : {},
    ...branchLine ? { branchName: normalizeBranchName(branchLine.slice("branch ".length).trim()) } : {},
    createdAt: existing.get(path)?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    ...existing.get(path)?.pinned !== void 0 ? { pinned: existing.get(path)?.pinned } : {}
  };
  return entry;
}
function mergeWorktreeEntry(nextEntry, existingEntry) {
  const updatedAt = existingEntry && hasSameWorktreeIdentity(existingEntry, nextEntry) ? existingEntry.updatedAt : nextEntry.updatedAt;
  return {
    ...nextEntry,
    displayName: existingEntry?.displayName?.trim() || nextEntry.displayName,
    createdAt: existingEntry?.createdAt ?? nextEntry.createdAt,
    updatedAt,
    pinned: existingEntry?.pinned ?? nextEntry.pinned
  };
}
function hasSameWorktreeIdentity(left, right) {
  return left.workspaceId === right.workspaceId && left.path === right.path && left.kind === right.kind && left.status === right.status && left.branchName === right.branchName && left.headSha === right.headSha;
}
function compareWorktreeEntries(left, right) {
  if (left.kind !== right.kind) {
    return left.kind === "primary" ? -1 : 1;
  }
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  return left.displayName.localeCompare(right.displayName);
}
function defaultWorktreeDisplayName(workspace, path, kind) {
  if (kind === "primary") {
    return workspace.displayName?.trim() || basename2(path) || path;
  }
  return basename2(path) || path;
}
function normalizeBranchName(value) {
  const branch = value.replace(/^refs\/heads\//, "").trim();
  return branch.length > 0 && branch !== "detached" ? branch : void 0;
}
async function runGit(args) {
  const { stdout } = await execFileAsync("git", [...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
async function canonicalPath(pathValue) {
  const resolved = resolve2(pathValue);
  try {
    return await realpath2(resolved);
  } catch {
    return resolved;
  }
}

// desktop/apps/desktop/electron/platform/worktrees/pao-worktree-host.ts
var execFileAsync2 = promisify2(execFile2);
var BASELINE_TIMEOUT_MS = 6e4;
var BASELINE_VERIFY_TIMEOUT_MS = 6e4;
var PaoDesktopWorktreeHost = class {
  constructor(options) {
    this.options = options;
    this.worktreeRoot = join3(options.userDataDir, "worktrees");
    this.statePath = join3(options.userDataDir, "pao-worktree-host.json");
    this.isAppWorktreePath = appWorktreeRootMatcher(this.worktreeRoot);
    this.manager = options.worktreeManager ?? new GitWorktreeManager({
      catalogStorage: options.catalogStorage,
      isAppWorktreePath: this.isAppWorktreePath
    });
  }
  options;
  worktreeRoot;
  isAppWorktreePath;
  manager;
  worktreeRuntime;
  statePath;
  createRequests = /* @__PURE__ */ new Map();
  cleanupRequests = /* @__PURE__ */ new Map();
  createInFlight = /* @__PURE__ */ new Map();
  stateLoaded;
  stateWrite = Promise.resolve();
  creationQueue = [];
  creationActive = false;
  /** 在桌面主进程完成 ESM 加载后，把同一内核实例提供的锁能力接入已注入的宿主。 */
  configurePaoWorktreeRuntime(runtime) {
    if (this.worktreeRuntime && this.worktreeRuntime !== runtime) {
      throw new Error("PAO worktree runtime is already configured with a different module.");
    }
    this.worktreeRuntime = runtime;
  }
  async capability(projectRoot) {
    try {
      await inspectSource(projectRoot);
      const capture = await this.options.checkpoints.capture(
        projectRoot,
        void 0,
        BASELINE_VERIFY_TIMEOUT_MS
      );
      if (capture.state === "available" && capture.coverage.state === "complete") {
        return { ok: true, create: true, cleanup: true, baseline: "recoverable-complete" };
      }
      return {
        ok: false,
        reason: capture.state === "available" ? `\u65E0\u6CD5\u5EFA\u7ACB\u5B8C\u6574\u57FA\u7EBF\uFF1A${capture.coverage.notes.join("\uFF1B") || "\u5B58\u5728\u672A\u7EB3\u5165\u5185\u5BB9"}` : `\u65E0\u6CD5\u5EFA\u7ACB\u53EF\u6062\u590D\u57FA\u7EBF\uFF1A${capture.message}`
      };
    } catch (error) {
      return { ok: false, reason: errorMessage2(error) };
    }
  }
  async create(input) {
    await this.loadState();
    const projectRoot = await canonicalDirectory(input.projectRoot, "\u9879\u76EE\u6839");
    const displayName = normalizedDisplayName(input.displayName);
    const fingerprint = requestFingerprint([
      requestIdPart(input.requestId),
      projectRoot,
      displayName ?? ""
    ]);
    const previous = this.createRequests.get(input.requestId);
    if (previous) {
      verifyCreateFingerprint(previous, fingerprint);
      return this.resolveCreateRecord(previous);
    }
    const pending = this.createInFlight.get(input.requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new Error("\u540C\u4E00 request_id \u5DF2\u7528\u4E8E\u4E0D\u540C\u7684\u521B\u5EFA\u5DE5\u4F5C\u76EE\u5F55\u8BF7\u6C42\u3002");
      return pending.promise;
    }
    const task = this.withCreationSlot(async () => {
      const repeated = this.createRequests.get(input.requestId);
      if (repeated) {
        verifyCreateFingerprint(repeated, fingerprint);
        return this.resolveCreateRecord(repeated);
      }
      const prepared = await this.prepareCreate(projectRoot, displayName, fingerprint);
      this.createRequests.set(input.requestId, prepared);
      await this.persistState("pending");
      const binding = await this.createNow(prepared);
      this.createRequests.set(input.requestId, {
        ...prepared,
        status: "completed",
        binding
      });
      await this.persistState("completed");
      return binding;
    });
    this.createInFlight.set(input.requestId, { fingerprint, promise: task });
    try {
      return await task;
    } finally {
      if (this.createInFlight.get(input.requestId)?.promise === task) {
        this.createInFlight.delete(input.requestId);
      }
    }
  }
  async inspect(input) {
    const taskRoot = await canonicalDirectory(input.projectRoot, "\u9879\u76EE\u6839");
    const source = await inspectSource(taskRoot);
    const workspace = { workspaceId: source.repositoryRoot, path: taskRoot };
    const snapshot = await this.manager.refreshWorktrees(workspace);
    const entries = snapshot.worktrees.filter(
      (entry) => (input.worktreeId ? entry.kind === "linked" && entry.worktreeId === input.worktreeId : entry.kind === "primary") || entry.workspaceId === source.repositoryRoot && Boolean(entry.worktreeId) && !input.worktreeId
    );
    return Promise.all(entries.map((entry) => this.inspectEntry(taskRoot, entry)));
  }
  async resolveForDispatch(input) {
    await this.loadState();
    requestIdPart(input.requestId);
    const taskRoot = await canonicalDirectory(input.projectRoot, "\u9879\u76EE\u6839");
    const source = await inspectSource(taskRoot);
    if (input.target.kind === "primary") {
      const binding2 = primaryBinding(taskRoot, source);
      verifyExpectedVersion(binding2, input.expectedInputVersion);
      return binding2;
    }
    const binding = await this.resolveManaged(taskRoot, input.target.worktreeId);
    verifyExpectedVersion(binding, input.expectedInputVersion);
    return binding;
  }
  async requestCleanup(input) {
    await this.loadState();
    requestIdPart(input.requestId);
    const fingerprint = requestFingerprint([
      input.requestId,
      await canonicalDirectory(input.projectRoot, "\u9879\u76EE\u6839"),
      input.worktreeId,
      input.reason.trim(),
      String(input.executionActive)
    ]);
    const previous = this.cleanupRequests.get(input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("\u540C\u4E00 request_id \u5DF2\u7528\u4E8E\u4E0D\u540C\u7684\u5DE5\u4F5C\u76EE\u5F55\u6E05\u7406\u8BF7\u6C42\u3002");
      return previous.result;
    }
    const remember = async (result) => {
      this.cleanupRequests.set(input.requestId, { fingerprint, result });
      await this.persistState();
      return result;
    };
    try {
      const taskRoot = await canonicalDirectory(input.projectRoot, "\u9879\u76EE\u6839");
      if (input.executionActive !== false) {
        return await remember(retained("\u4EFB\u52A1\u6267\u884C\u72B6\u6001\u4E0D\u662F\u5DF2\u505C\u6B62\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u3002"));
      }
      const existing = await this.options.catalogStorage.worktrees.getWorktree(input.worktreeId);
      if (!existing || existing.kind !== "linked")
        return await remember(retained("\u4E0D\u662F\u5E94\u7528\u767B\u8BB0\u7684\u72EC\u7ACB\u5DE5\u4F5C\u76EE\u5F55\u3002"));
      if (existing.workspaceId !== await catalogRepositoryId(taskRoot, this.options.catalogStorage)) {
        return await remember(retained("\u5DE5\u4F5C\u76EE\u5F55\u767B\u8BB0\u4E0D\u5C5E\u4E8E\u5F53\u524D\u9879\u76EE\u3002"));
      }
      const targetPath = await canonicalDirectory(existing.path, "\u5DE5\u4F5C\u76EE\u5F55");
      if (!await this.isAppWorktreePath(targetPath))
        return await remember(retained("\u8DEF\u5F84\u4E0D\u5728\u5E94\u7528\u5DE5\u4F5C\u76EE\u5F55\u6839\u5185\u3002"));
      if (resolve3(existing.path) !== targetPath)
        return await remember(retained("\u767B\u8BB0\u8DEF\u5F84\u4E0E\u771F\u5B9E\u8DEF\u5F84\u4E0D\u4E00\u81F4\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u3002"));
      const proof = await inspectLinkedWorktree2(targetPath);
      if (proof.isPrimary) return await remember(retained("\u4E3B\u76EE\u5F55\u4E0D\u80FD\u6309\u72EC\u7ACB\u5DE5\u4F5C\u76EE\u5F55\u6E05\u7406\u3002"));
      if (await canonicalDirectory(proof.repositoryRoot, "\u6E90\u4ED3\u5E93") !== taskRoot)
        return await remember(retained("\u5DE5\u4F5C\u76EE\u5F55\u5C5E\u4E8E\u5176\u4ED6\u4ED3\u5E93\u3002"));
      if (await canonicalDirectory(proof.commonGitDir, "\u516C\u5171 Git \u76EE\u5F55") !== await canonicalDirectory((await inspectSource(taskRoot)).commonGitDir, "\u516C\u5171 Git \u76EE\u5F55"))
        return await remember(retained("\u5DE5\u4F5C\u76EE\u5F55\u7684\u4ED3\u5E93\u8EAB\u4EFD\u4E0E\u5F53\u524D\u9879\u76EE\u4E0D\u4E00\u81F4\u3002"));
      if (proof.branchName !== existing.branchName || !proof.branchName.startsWith("pi/"))
        return await remember(retained("\u5DE5\u4F5C\u76EE\u5F55\u5206\u652F\u4E0E\u767B\u8BB0\u4E0D\u4E00\u81F4\uFF0C\u6216\u4E0D\u662F\u5E94\u7528\u521B\u5EFA\u7684 pi/ \u5206\u652F\u3002"));
      const changes = await gitStatus(
        targetPath,
        this.worktreeRuntime?.listReleasedExecutionArtifacts(targetPath) ?? this.options.listReleasedExecutionArtifacts?.(targetPath) ?? []
      );
      if (changes.dirty) return await remember(retained("\u5DE5\u4F5C\u76EE\u5F55\u4ECD\u6709\u672A\u4FDD\u5B58\u6539\u52A8\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u3002"));
      if (changes.untracked)
        return await remember(retained("\u5DE5\u4F5C\u76EE\u5F55\u4ECD\u6709\u5E94\u7528\u8FD0\u884C\u5143\u6570\u636E\u4EE5\u5916\u7684\u672A\u8DDF\u8E2A\u6587\u4EF6\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u3002"));
      if (!await isMerged(taskRoot, proof.branchName))
        return await remember(retained("\u5DE5\u4F5C\u76EE\u5F55\u5206\u652F\u5C1A\u672A\u5408\u5165\u5F53\u524D\u9879\u76EE\uFF0C\u5DF2\u4FDD\u7559\u5206\u652F\u548C\u76EE\u5F55\u3002"));
      const guard = await this.acquireCleanupGuard({
        taskRoot,
        executionRoot: targetPath,
        holder: `desktop-worktree-cleanup:${input.requestId}`,
        signal: input.signal
      });
      let guardReleased = false;
      try {
        if (guard.occupancy !== "idle")
          return await remember(
            retained(
              guard.occupancy === "unknown" ? "\u6267\u884C\u5360\u7528\u72B6\u6001\u672A\u77E5\uFF0C\u5DF2\u4FDD\u7559\u5DE5\u4F5C\u76EE\u5F55\u548C\u6E05\u7406\u5B88\u536B\u3002" : "\u53E6\u4E00\u4F1A\u8BDD\u6216\u8FDB\u7A0B\u6B63\u5728\u4F7F\u7528\u8FD9\u4E2A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u3002"
            )
          );
        await this.assertExecutionIdle(targetPath);
        if (this.options.activeExecution) {
          const live = await this.options.activeExecution(taskRoot, targetPath);
          if (live !== false)
            return await remember(retained("\u5F53\u524D\u4ECD\u6709\u4EFB\u52A1\u4F7F\u7528\u8FD9\u4E2A\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u3002"));
        }
        await this.assertExecutionIdle(targetPath);
        const prepareRunMetadataForRemoval = this.worktreeRuntime?.prepareExecutionRootForRemoval ?? this.options.prepareRunMetadataForRemoval;
        if (prepareRunMetadataForRemoval) {
          await prepareRunMetadataForRemoval({
            guard,
            archiveRoot: join3(
              taskRoot,
              "worker-evidence",
              "\u5DE5\u4F5C\u6811\u8FD0\u884C\u8BC1\u636E",
              executionIdentity(targetPath)
            )
          });
        }
        await this.assertExecutionIdle(targetPath);
        const remainingChanges = await gitStatus(targetPath);
        if (remainingChanges.dirty || remainingChanges.untracked)
          return await remember(
            retained(
              remainingChanges.dirty ? "\u5DE5\u4F5C\u76EE\u5F55\u4ECD\u6709\u672A\u4FDD\u5B58\u6539\u52A8\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u3002" : "\u5DE5\u4F5C\u76EE\u5F55\u4ECD\u6709\u672A\u8DDF\u8E2A\u6587\u4EF6\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u3002"
            )
          );
        await git(taskRoot, ["worktree", "remove", targetPath]);
        await this.manager.refreshWorktrees({ workspaceId: proof.repositoryRoot, path: taskRoot });
        if (await pathExists(targetPath))
          return await remember(retained("Git \u5DF2\u5B8C\u6210\u79FB\u9664\u547D\u4EE4\uFF0C\u4F46\u5DE5\u4F5C\u76EE\u5F55\u4ECD\u5B58\u5728\uFF1B\u672A\u62A5\u544A\u91CA\u653E\u6210\u529F\u3002"));
        await guard.release();
        guardReleased = true;
        const result = { ok: true, released: true, branchDeleted: false };
        return await remember(result);
      } finally {
        if (!guardReleased) retainCleanupGuard(guard);
      }
    } catch (error) {
      const result = retained(errorMessage2(error));
      this.cleanupRequests.set(input.requestId, { fingerprint, result });
      try {
        await this.persistState();
      } catch (persistError) {
        throw new Error(`\u5DE5\u4F5C\u76EE\u5F55\u6E05\u7406\u88AB\u4FDD\u7559\uFF0C\u4E14\u5E42\u7B49\u8BB0\u5F55\u5199\u5165\u5931\u8D25\uFF1A${errorMessage2(persistError)}`, {
          cause: error
        });
      }
      return result;
    }
  }
  async acquireCleanupGuard(input) {
    if (this.worktreeRuntime) return this.worktreeRuntime.acquireExecutionRootGuard(input);
    if (this.options.acquireCleanupGuard) return this.options.acquireCleanupGuard(input);
    throw new Error("\u5F53\u524D\u5BBF\u4E3B\u672A\u63A5\u5165\u8DE8\u8FDB\u7A0B\u6267\u884C\u6839\u6E05\u7406\u5B88\u536B\uFF0C\u62D2\u7EDD\u4EC5\u51ED\u672C\u8FDB\u7A0B\u5185\u5B58\u72B6\u6001\u5220\u9664\u5DE5\u4F5C\u76EE\u5F55\u3002");
  }
  async assertExecutionIdle(executionRoot) {
    const executionOccupancy = this.worktreeRuntime?.detectExecutionOccupancy ?? this.options.executionOccupancy;
    if (!executionOccupancy) throw new Error("\u5F53\u524D\u5BBF\u4E3B\u6CA1\u6709\u8DE8\u8FDB\u7A0B\u6267\u884C\u5360\u7528\u68C0\u67E5\uFF0C\u62D2\u7EDD\u5220\u9664\u5DE5\u4F5C\u76EE\u5F55\u3002");
    const occupancy = await executionOccupancy(executionRoot);
    if (occupancy !== "idle")
      throw new Error(
        occupancy === "unknown" ? "\u6267\u884C\u5360\u7528\u72B6\u6001\u672A\u77E5\uFF0C\u62D2\u7EDD\u5220\u9664\u5DE5\u4F5C\u76EE\u5F55\u3002" : "\u6267\u884C\u6839\u4ECD\u6709\u6D3B\u52A8\u4EFB\u52A1\uFF0C\u62D2\u7EDD\u5220\u9664\u5DE5\u4F5C\u76EE\u5F55\u3002"
      );
  }
  async prepareCreate(taskRoot, displayName, fingerprint) {
    const source = await inspectSource(taskRoot);
    const captured = await this.options.checkpoints.capture(
      taskRoot,
      void 0,
      BASELINE_TIMEOUT_MS
    );
    const baseline = await requireCompleteCapture(
      taskRoot,
      source,
      captured,
      this.options.checkpoints.repositoryPath,
      captured.coverage.notes
    );
    const folder = `pao-${fingerprint.slice(0, 24)}`;
    return {
      status: "pending",
      fingerprint,
      taskRoot,
      displayName: displayName ?? "",
      target: {
        path: join3(
          this.worktreeRoot,
          safeSegment(basename3(source.repositoryRoot) || "repo"),
          folder
        ),
        branchName: `pi/${folder}`,
        sourceHead: source.sourceHead,
        treeId: baseline.treeId,
        snapshotRepositoryPath: baseline.snapshotRepositoryPath
      },
      baseline
    };
  }
  async resolveCreateRecord(record) {
    if (record.status === "completed" && record.binding) {
      await this.verifyPersistedBinding(record.binding);
      return record.binding;
    }
    const binding = await this.recoverPending(record);
    const requestId = [...this.createRequests].find(([, candidate]) => candidate === record)?.[0];
    if (!requestId) throw new Error("\u627E\u4E0D\u5230\u5F85\u5B8C\u6210\u5DE5\u4F5C\u76EE\u5F55\u7684\u53D7\u7406\u6807\u8BC6\u3002");
    this.createRequests.set(requestId, { ...record, status: "completed", binding });
    await this.persistState("completed");
    return binding;
  }
  async recoverPending(record) {
    if (record.status !== "pending" || record.binding)
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u53D7\u7406\u8BB0\u5F55\u72B6\u6001\u4E0D\u4E00\u81F4\uFF0C\u62D2\u7EDD\u8986\u76D6\u3002");
    if (!await pathExists(record.target.path))
      throw new Error(
        `\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u5904\u4E8E\u5F85\u5B8C\u6210\u72B6\u6001\uFF0C\u4F46\u76EE\u6807\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1B\u8BF7\u4FDD\u7559\u53D7\u7406\u8BB0\u5F55\u5E76\u4EBA\u5DE5\u76D8\u70B9\uFF1A${record.target.path}`
      );
    const proof = await inspectLinkedWorktree2(record.target.path);
    if (proof.isPrimary || proof.repositoryRoot !== record.taskRoot || proof.branchName !== record.target.branchName)
      throw new Error("\u5F85\u5B8C\u6210\u5DE5\u4F5C\u76EE\u5F55\u7684 Git \u8EAB\u4EFD\u4E0E\u53D7\u7406\u8BB0\u5F55\u4E0D\u4E00\u81F4\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u5F85\u76D8\u70B9\u3002");
    const entry = await this.options.catalogStorage.worktrees.getWorktree(record.target.path);
    if (!entry || entry.kind !== "linked")
      throw new Error("\u5F85\u5B8C\u6210\u5DE5\u4F5C\u76EE\u5F55\u5C1A\u672A\u767B\u8BB0\u5230\u5E94\u7528\u76EE\u5F55\uFF0C\u5DF2\u4FDD\u7559\u73B0\u573A\u5F85\u76D8\u70B9\u3002");
    const recovered = await this.options.checkpoints.capture(
      record.target.path,
      void 0,
      BASELINE_VERIFY_TIMEOUT_MS
    );
    try {
      await requireUnchangedCapture(record.target.path, record.baseline, recovered);
    } catch (error) {
      throw new Error(
        `\u5F85\u5B8C\u6210\u5DE5\u4F5C\u76EE\u5F55\u7684\u5185\u5BB9\u5C1A\u672A\u5B8C\u6574\u843D\u5730\uFF1B\u5DF2\u4FDD\u7559\u73B0\u573A\u5F85\u76D8\u70B9\u3002${errorMessage2(error)}`
      );
    }
    await requireBaselineRecoverable(record.baseline);
    const binding = {
      kind: "managed",
      worktreeId: entry.worktreeId,
      taskRoot: record.taskRoot,
      executionRoot: entry.path,
      commonGitDir: proof.commonGitDir,
      branchName: record.target.branchName,
      inputVersion: record.baseline.treeId,
      bindingDigest: "",
      baseline: record.baseline
    };
    return { ...binding, bindingDigest: bindingDigest(binding) };
  }
  async createNow(record) {
    const {
      taskRoot,
      displayName,
      baseline: sourceBaseline,
      target: { path: targetPath, branchName }
    } = record;
    const source = await inspectSource(taskRoot);
    if (source.sourceHead !== sourceBaseline.sourceHead)
      throw new Error("\u6765\u6E90\u4ED3\u5E93\u5728\u521B\u5EFA\u5DE5\u4F5C\u76EE\u5F55\u53D7\u7406\u540E\u53D1\u751F\u4E86\u53D8\u5316\u3002");
    const sourceAgain = await this.options.checkpoints.capture(
      taskRoot,
      void 0,
      BASELINE_VERIFY_TIMEOUT_MS
    );
    await requireUnchangedCapture(taskRoot, sourceBaseline, sourceAgain);
    let createdPath;
    const workspace = { workspaceId: source.repositoryRoot, path: taskRoot };
    try {
      const entry = await this.manager.createWorktree(workspace, {
        path: targetPath,
        branchName,
        startPoint: "HEAD",
        ...displayName ? { displayName } : {}
      });
      createdPath = entry.path;
      await this.options.afterWorktreeCreated?.(createdPath);
      await resetCleanWorktree(
        createdPath,
        sourceBaseline.treeId,
        this.options.checkpoints.repositoryPath
      );
      const rebuilt = await this.options.checkpoints.capture(
        createdPath,
        void 0,
        BASELINE_VERIFY_TIMEOUT_MS
      );
      await requireUnchangedCapture(createdPath, sourceBaseline, rebuilt);
      await requireBaselineRecoverable(sourceBaseline);
      const currentSource = await inspectSource(taskRoot);
      if (currentSource.sourceHead !== sourceBaseline.sourceHead)
        throw new Error("\u6E90\u9879\u76EE HEAD \u5728\u521B\u5EFA\u5DE5\u4F5C\u76EE\u5F55\u671F\u95F4\u53D1\u751F\u53D8\u5316\u3002");
      const sourceFinal = await this.options.checkpoints.capture(
        taskRoot,
        void 0,
        BASELINE_VERIFY_TIMEOUT_MS
      );
      await requireUnchangedCapture(taskRoot, sourceBaseline, sourceFinal);
      const createdProof = await inspectLinkedWorktree2(createdPath);
      if (createdProof.repositoryRoot !== taskRoot || createdProof.commonGitDir !== source.commonGitDir || createdProof.branchName !== branchName)
        throw new Error("\u521B\u5EFA\u540E\u7684 Git \u5DE5\u4F5C\u76EE\u5F55\u8EAB\u4EFD\u4E0E\u9884\u671F\u4E0D\u4E00\u81F4\u3002");
      const binding = {
        kind: "managed",
        worktreeId: entry.worktreeId,
        taskRoot,
        executionRoot: entry.path,
        commonGitDir: source.commonGitDir,
        branchName,
        inputVersion: sourceBaseline.treeId,
        bindingDigest: "",
        baseline: sourceBaseline
      };
      return { ...binding, bindingDigest: bindingDigest(binding) };
    } catch (error) {
      const retainedPath = createdPath ?? targetPath;
      throw new Error(
        `\u521B\u5EFA\u72EC\u7ACB\u5DE5\u4F5C\u76EE\u5F55\u672A\u5B8C\u6210\uFF1B\u8BF7\u6838\u5BF9\u4FDD\u7559\u73B0\u573A ${retainedPath} \u4E0E\u5206\u652F ${branchName}\uFF1A${errorMessage2(error)}`,
        { cause: error }
      );
    }
  }
  async inspectEntry(taskRoot, entry) {
    const proof = await inspectLinkedWorktree2(entry.path).catch(() => void 0);
    const changes = proof ? await gitStatus(entry.path).catch(() => void 0) : void 0;
    const active = this.options.activeExecution ? await Promise.resolve(this.options.activeExecution(taskRoot, entry.path)).catch(
      () => "unknown"
    ) : "unknown";
    return {
      kind: entry.kind === "primary" ? "primary" : "managed",
      taskRoot,
      executionRoot: proof ? await canonicalPathBestEffort(entry.path) : entry.path,
      commonGitDir: proof?.commonGitDir ?? "",
      inputVersion: proof?.head ?? entry.headSha ?? "unknown",
      ...entry.kind === "linked" ? { worktreeId: entry.worktreeId } : {},
      ...proof?.branchName ? { branchName: proof.branchName } : {},
      dirty: changes?.dirty ?? "unknown",
      untracked: changes?.untracked ?? "unknown",
      ...proof && proof.branchName ? await isMerged(taskRoot, proof.branchName).then(
        (merged) => ({ mergedIntoTaskHead: merged }),
        () => ({})
      ) : {},
      active
    };
  }
  async resolveManaged(taskRoot, worktreeId) {
    const entry = await this.options.catalogStorage.worktrees.getWorktree(worktreeId);
    if (!entry || entry.kind !== "linked") throw new Error("\u4E0D\u662F\u5E94\u7528\u767B\u8BB0\u7684\u72EC\u7ACB\u5DE5\u4F5C\u76EE\u5F55\u3002");
    if (entry.workspaceId !== await catalogRepositoryId(taskRoot, this.options.catalogStorage))
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u767B\u8BB0\u4E0D\u5C5E\u4E8E\u5F53\u524D\u9879\u76EE\u3002");
    if (!await this.isAppWorktreePath(entry.path)) throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5728\u5E94\u7528\u76EE\u5F55\u6839\u5185\u3002");
    const executionRoot = await canonicalDirectory(entry.path, "\u5DE5\u4F5C\u76EE\u5F55");
    const source = await inspectSource(taskRoot);
    const proof = await inspectLinkedWorktree2(executionRoot);
    if (proof.isPrimary || proof.repositoryRoot !== taskRoot)
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u5C5E\u4E8E\u5176\u4ED6\u4ED3\u5E93\u6216\u662F\u4E3B\u76EE\u5F55\u3002");
    if (proof.commonGitDir !== source.commonGitDir)
      throw new Error("\u516C\u5171 Git \u76EE\u5F55\u4E0E\u5F53\u524D\u9879\u76EE\u4E0D\u4E00\u81F4\u3002");
    if (!proof.branchName.startsWith("pi/") || proof.branchName !== entry.branchName)
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u5206\u652F\u4E0E\u767B\u8BB0\u4E0D\u4E00\u81F4\u3002");
    const baseline = await this.baselineForEntry(entry, source);
    const gitObjects = await inspectGitObjectState(executionRoot);
    const worktreeChanged = gitObjects.indexDigest !== baseline.treeId || gitObjects.worktreeDigest.trim() !== "";
    const binding = {
      kind: "managed",
      worktreeId: entry.worktreeId,
      taskRoot,
      executionRoot,
      commonGitDir: source.commonGitDir,
      branchName: proof.branchName,
      inputVersion: baseline.inputVersion,
      bindingDigest: "",
      baseline,
      ...worktreeChanged ? {} : { currentTreeId: baseline.treeId }
    };
    return { ...binding, bindingDigest: bindingDigest(binding) };
  }
  async baselineForEntry(entry, source) {
    const record = [...this.createRequests.values()].find(
      (request) => request.status === "completed" && request.binding?.kind === "managed" && request.binding.worktreeId === entry.worktreeId
    );
    if (!record || record.binding?.kind !== "managed")
      throw new Error("\u627E\u4E0D\u5230\u8FD9\u4E2A\u5DE5\u4F5C\u76EE\u5F55\u7684\u53EF\u6062\u590D\u57FA\u7EBF\u8BC1\u660E\uFF0C\u4E0D\u80FD\u7528\u4E8E\u6D3E\u53D1\u3002");
    if (record.binding.taskRoot !== source.repositoryRoot)
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u57FA\u7EBF\u8BC1\u660E\u4E0D\u5C5E\u4E8E\u5F53\u524D\u9879\u76EE\u3002");
    return record.binding.baseline;
  }
  loadState() {
    this.stateLoaded ??= (async () => {
      const saved = await readJsonWithBackup(this.statePath);
      if (saved.corrupted && !saved.recovered)
        throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u5BBF\u4E3B\u8BB0\u5F55\u635F\u574F\uFF1B\u5DF2\u4FDD\u7559\u539F\u6587\u4EF6\uFF0C\u62D2\u7EDD\u8986\u76D6\u3002");
      if (saved.value === void 0) return;
      const value = decodeHostState(saved.value);
      for (const [requestId, record] of Object.entries(value.creates))
        this.createRequests.set(requestId, record);
      for (const [requestId, record] of Object.entries(value.cleanups))
        this.cleanupRequests.set(requestId, record);
    })();
    return this.stateLoaded;
  }
  persistState(phase) {
    const next = this.stateWrite.catch(() => void 0).then(async () => {
      const state = {
        version: 2,
        creates: Object.fromEntries(
          [...this.createRequests].map(([requestId, record]) => [requestId, record])
        ),
        cleanups: Object.fromEntries(this.cleanupRequests)
      };
      decodeHostState(state);
      await writeFileAtomicQueued(this.statePath, `${JSON.stringify(state)}
`, (value) => {
        decodeHostState(value);
        return value;
      });
      if (phase) await this.options.persistStateHook?.(phase);
    });
    this.stateWrite = next;
    return next;
  }
  async withCreationSlot(task) {
    if (this.creationActive) {
      await new Promise((resolveQueue) => this.creationQueue.push(resolveQueue));
    }
    this.creationActive = true;
    try {
      return await task();
    } finally {
      this.creationActive = false;
      this.creationQueue.shift()?.();
    }
  }
  async verifyPersistedBinding(binding) {
    if (binding.kind === "primary") throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u8BB0\u5F55\u4E0D\u80FD\u6307\u5411\u4E3B\u76EE\u5F55\u3002");
    const entry = await this.options.catalogStorage.worktrees.getWorktree(binding.worktreeId);
    if (!entry || entry.kind !== "linked") throw new Error("\u5DF2\u767B\u8BB0\u7684\u5DE5\u4F5C\u76EE\u5F55\u8BB0\u5F55\u4E0D\u5B58\u5728\u3002");
    if (entry.path !== binding.executionRoot)
      throw new Error("\u5DF2\u767B\u8BB0\u5DE5\u4F5C\u76EE\u5F55\u8DEF\u5F84\u4E0E\u5E42\u7B49\u8BB0\u5F55\u4E0D\u4E00\u81F4\u3002");
    const proof = await inspectLinkedWorktree2(entry.path);
    if (proof.isPrimary || proof.repositoryRoot !== binding.taskRoot || proof.commonGitDir !== binding.commonGitDir || proof.branchName !== binding.branchName)
      throw new Error("\u5DF2\u767B\u8BB0\u5DE5\u4F5C\u76EE\u5F55\u7684\u771F\u5B9E Git \u8EAB\u4EFD\u4E0E\u5E42\u7B49\u8BB0\u5F55\u4E0D\u4E00\u81F4\u3002");
  }
};
function primaryBinding(taskRoot, source) {
  const binding = {
    kind: "primary",
    taskRoot,
    executionRoot: taskRoot,
    commonGitDir: source.commonGitDir,
    inputVersion: source.sourceHead,
    bindingDigest: ""
  };
  return { ...binding, bindingDigest: bindingDigest(binding) };
}
function bindingDigest(binding) {
  const record = { ...binding, bindingDigest: void 0 };
  return `sha256:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}
function requestIdPart(value) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("request_id \u4E0D\u80FD\u4E3A\u7A7A\u3002");
  return trimmed;
}
function normalizedDisplayName(value) {
  const trimmed = value?.trim();
  return trimmed || void 0;
}
function requestFingerprint(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function verifyCreateFingerprint(previous, fingerprint) {
  if (previous.fingerprint !== fingerprint)
    throw new Error("\u540C\u4E00 request_id \u5DF2\u7528\u4E8E\u4E0D\u540C\u7684\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u8BF7\u6C42\u3002");
}
function verifyExpectedVersion(binding, expected) {
  if (expected !== void 0 && binding.inputVersion !== expected)
    throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u8F93\u5165\u7248\u672C\u5DF2\u53D8\u5316\uFF0C\u4E0D\u80FD\u7EE7\u7EED\u6D3E\u53D1\u3002");
}
async function requireCompleteCapture(root, source, capture, snapshotRepositoryPath, notes) {
  if (capture.state !== "available") throw new Error(`\u65E0\u6CD5\u5EFA\u7ACB\u53EF\u6062\u590D\u57FA\u7EBF\uFF1A${capture.message}`);
  if (capture.coverage.state !== "complete")
    throw new Error(`\u57FA\u7EBF\u8986\u76D6\u4E0D\u5B8C\u6574\uFF1A${capture.coverage.notes.join("\uFF1B") || "\u5B58\u5728\u672A\u5305\u542B\u5185\u5BB9"}`);
  const includedPaths = await listTreePaths(snapshotRepositoryPath, capture.treeOid);
  return {
    sourceRoot: root,
    sourceHead: source.sourceHead,
    treeId: capture.treeOid,
    snapshotRepositoryPath,
    inputVersion: capture.treeOid,
    capturedAt: capture.capturedAt,
    fileCount: capture.fileCount,
    byteCount: capture.byteCount,
    coverage: "complete",
    includedPaths,
    excludedPaths: [],
    notes: [...notes]
  };
}
async function requireUnchangedCapture(root, baseline, capture) {
  await requireTree(root, baseline.treeId, capture);
}
async function requireBaselineRecoverable(baseline) {
  if ((await git(baseline.snapshotRepositoryPath, ["cat-file", "-t", baseline.treeId])).trim() !== "tree")
    throw new Error("\u72EC\u7ACB\u5FEB\u7167\u4ED3\u4E2D\u7684\u57FA\u7EBF tree \u4E0D\u53EF\u6062\u590D\u3002");
  const paths = await listTreePaths(baseline.snapshotRepositoryPath, baseline.treeId);
  if (JSON.stringify(paths) !== JSON.stringify(baseline.includedPaths))
    throw new Error("\u72EC\u7ACB\u5FEB\u7167\u4ED3\u4E2D\u7684\u57FA\u7EBF\u6587\u4EF6\u6E05\u5355\u4E0E\u53D7\u7406\u8BB0\u5F55\u4E0D\u4E00\u81F4\u3002");
}
async function requireTree(root, expectedTree, capture) {
  if (capture.state !== "available" || capture.coverage.state !== "complete")
    throw new Error("\u65E0\u6CD5\u6838\u5BF9\u5DE5\u4F5C\u76EE\u5F55\u7684\u5B8C\u6574\u57FA\u7EBF\u3002");
  if (capture.treeOid !== expectedTree) throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u5185\u5BB9\u4E0E\u6765\u6E90\u57FA\u7EBF\u4E0D\u4E00\u81F4\u3002");
  void root;
}
async function inspectSource(projectRoot) {
  const repositoryRoot = await canonicalDirectory(
    (await git(projectRoot, ["rev-parse", "--show-toplevel"])).trim(),
    "\u6E90\u4ED3\u5E93"
  );
  if (repositoryRoot !== await canonicalDirectory(projectRoot, "\u9879\u76EE\u6839"))
    throw new Error("\u9879\u76EE\u6839\u5FC5\u987B\u662F Git \u4ED3\u5E93\u6839\uFF0C\u4E0D\u80FD\u662F\u5B50\u76EE\u5F55\u3002");
  const commonGitDir = await canonicalDirectory(
    (await git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
    "\u516C\u5171 Git \u76EE\u5F55"
  );
  const sourceHead = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error("\u5F53\u524D\u4ED3\u5E93\u6CA1\u6709\u53EF\u7528\u7684\u63D0\u4EA4\u3002");
  return { repositoryRoot, commonGitDir, sourceHead };
}
async function inspectLinkedWorktree2(path) {
  const output = await git(path, ["worktree", "list", "--porcelain"]);
  const blocks = output.split(/\r?\n\s*\r?\n/).filter(Boolean);
  const primaryLine = blocks[0]?.split(/\r?\n/).find((line) => line.startsWith("worktree "));
  if (!primaryLine) throw new Error("Git \u6CA1\u6709\u8FD4\u56DE\u4E3B\u5DE5\u4F5C\u76EE\u5F55\u3002");
  const repositoryRoot = await canonicalDirectory(primaryLine.slice("worktree ".length), "\u4E3B\u4ED3\u5E93");
  const commonGitDir = await canonicalDirectory(
    (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
    "\u516C\u5171 Git \u76EE\u5F55"
  );
  for (const [index, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/);
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) continue;
    const entryPath = await canonicalDirectory(pathLine.slice("worktree ".length), "\u5DE5\u4F5C\u76EE\u5F55");
    if (entryPath !== await canonicalDirectory(path, "\u5DE5\u4F5C\u76EE\u5F55")) continue;
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "";
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7);
    return {
      repositoryRoot,
      commonGitDir,
      branchName: branch?.replace(/^refs\/heads\//, "") ?? "",
      head,
      isPrimary: index === 0
    };
  }
  throw new Error("\u8DEF\u5F84\u4E0D\u662F\u8FD9\u4E2A\u4ED3\u5E93\u7684\u5DF2\u767B\u8BB0\u5DE5\u4F5C\u76EE\u5F55\u3002");
}
async function resetCleanWorktree(path, treeId, repository) {
  const type = (await git(repository, ["cat-file", "-t", treeId])).trim();
  if (type !== "tree") throw new Error("\u57FA\u7EBF\u5FEB\u7167\u5BF9\u8C61\u4E0D\u53EF\u6062\u590D\u3002");
  const scratch = await mkdtemp(join3(tmpdir(), "pao-worktree-index-"));
  try {
    const environment = {
      GIT_INDEX_FILE: join3(scratch, "index"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join3(repository, "objects")
    };
    const current = await git(path, ["ls-files", "-z"]);
    const tracked = current.split("\0").filter(Boolean);
    await git(path, ["read-tree", treeId], environment);
    await git(path, ["-c", "core.autocrlf=false", "checkout-index", "--all", "--force"], environment);
    const baselineOutput = await git(repository, ["ls-tree", "-r", "-z", "--name-only", treeId]);
    const baseline = new Set(baselineOutput.split("\0").filter(Boolean));
    for (const relativePath of tracked) {
      if (baseline.has(relativePath)) continue;
      const absolutePath = resolve3(path, relativePath);
      if (relativePath.split(/[\\/]/).includes("..")) throw new Error("\u57FA\u7EBF\u5FEB\u7167\u5305\u542B\u4E0D\u5B89\u5168\u8DEF\u5F84\u3002");
      await unlink2(absolutePath).catch((error) => {
        if (!isMissingFileError2(error)) throw error;
      });
    }
    await removeEmptyParentDirectories(path, tracked);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
async function removeEmptyParentDirectories(root, trackedPaths) {
  const directories = new Set(trackedPaths.map((path) => dirname4(join3(root, path))));
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    let current = directory;
    while (current !== root && current !== dirname4(current)) {
      try {
        if ((await readdir2(current)).length > 0) break;
        await rmdir(current);
      } catch (error) {
        if (isMissingFileError2(error)) break;
        throw error;
      }
      current = dirname4(current);
    }
  }
}
async function listTreePaths(repository, treeId) {
  const text = await git(repository, ["ls-tree", "-r", "--name-only", treeId]);
  return text.split(/\r?\n/).filter(Boolean);
}
async function gitStatus(path, allowedUntracked = []) {
  const output = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = output.split("\0").filter(Boolean);
  const allowed = new Set(allowedUntracked.map((value) => resolve3(value)));
  return {
    dirty: entries.some((entry) => entry.slice(0, 2) !== "??"),
    untracked: entries.some(
      (entry) => entry.slice(0, 2) === "??" && !allowed.has(resolve3(path, entry.slice(3)))
    )
  };
}
async function isMerged(repository, branch) {
  try {
    await git(repository, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, "HEAD"]);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1 && !("signal" in error && error.signal)) {
      return false;
    }
    throw error;
  }
}
async function inspectGitObjectState(root) {
  const [indexDigest, worktreeDigest] = await Promise.all([
    git(root, ["write-tree"]).then(stripLine),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]).then(
      (output) => createHash("sha256").update(output).digest("hex")
    )
  ]);
  return { indexDigest, worktreeDigest };
}
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFileError2(error)) return false;
    throw error;
  }
}
async function catalogRepositoryId(taskRoot, storage) {
  const snapshot = await storage.worktrees.listWorktrees();
  const aliases = new Set(
    snapshot.worktrees.filter((entry) => entry.kind === "primary" && entry.path === taskRoot).map((entry) => entry.workspaceId)
  );
  return aliases.values().next().value ?? (await inspectSource(taskRoot)).repositoryRoot;
}
function retained(reason) {
  return { ok: false, retained: true, reason };
}
function retainCleanupGuard(guard) {
  void guard;
}
function executionIdentity(executionRoot) {
  return createHash("sha256").update(resolve3(executionRoot)).digest("hex");
}
async function canonicalDirectory(path, field) {
  if (!isAbsolute2(path)) throw new Error(`${field}\u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84\u3002`);
  const canonical = await realpath3(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${field}\u4E0D\u662F\u76EE\u5F55\u3002`);
  return resolve3(canonical);
}
async function canonicalPathBestEffort(path) {
  return canonicalDirectory(path, "\u8DEF\u5F84").catch(() => path);
}
function safeSegment(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}
async function git(cwd, args, extraEnvironment = {}) {
  const { stdout } = await execFileAsync2("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...extraEnvironment }
  });
  return stdout;
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
function stripLine(value) {
  return value.replace(/\r?\n$/, "");
}
function isMissingFileError2(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function decodeHostState(value) {
  if (!isRecord(value) || value.version !== 2) throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u5BBF\u4E3B\u8BB0\u5F55\u7248\u672C\u65E0\u6548\u3002");
  if (!isRecord(value.creates) || !isRecord(value.cleanups))
    throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u5BBF\u4E3B\u8BB0\u5F55\u7F3A\u5C11 creates \u6216 cleanups\u3002");
  const creates = {};
  for (const [requestId, raw] of Object.entries(value.creates)) {
    requestIdPart(requestId);
    if (!isRecord(raw) || typeof raw.fingerprint !== "string")
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u5E42\u7B49\u8BB0\u5F55\u683C\u5F0F\u65E0\u6548\u3002");
    if (raw.status !== "pending" && raw.status !== "completed")
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u53D7\u7406\u72B6\u6001\u65E0\u6548\u3002");
    if (typeof raw.taskRoot !== "string" || !raw.taskRoot.trim())
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u53D7\u7406\u8BB0\u5F55\u7F3A\u5C11 taskRoot\u3002");
    if (raw.displayName !== void 0 && typeof raw.displayName !== "string")
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA displayName \u683C\u5F0F\u65E0\u6548\u3002");
    const displayName = typeof raw.displayName === "string" ? raw.displayName : "";
    if (!isRecord(raw.target)) throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u53D7\u7406\u8BB0\u5F55\u7F3A\u5C11\u76EE\u6807\u3002");
    const targetFields = [
      "path",
      "branchName",
      "sourceHead",
      "treeId",
      "snapshotRepositoryPath"
    ];
    for (const field of targetFields) {
      if (typeof raw.target[field] !== "string" || !raw.target[field].trim())
        throw new Error(`\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u76EE\u6807 ${field} \u683C\u5F0F\u65E0\u6548\u3002`);
    }
    const baseline = decodeBaseline(raw.baseline);
    if (baseline.sourceHead !== raw.target.sourceHead || baseline.treeId !== raw.target.treeId || baseline.snapshotRepositoryPath !== raw.target.snapshotRepositoryPath)
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA\u76EE\u6807\u4E0E\u6765\u6E90\u57FA\u7EBF\u4E0D\u4E00\u81F4\u3002");
    if (raw.fingerprint !== requestFingerprint([requestId, raw.taskRoot, displayName]))
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u521B\u5EFA request fingerprint \u6821\u9A8C\u5931\u8D25\u3002");
    const binding = raw.status === "completed" ? decodeBinding(raw.binding) : raw.binding === void 0 ? void 0 : (() => {
      throw new Error("\u5F85\u5B8C\u6210\u5DE5\u4F5C\u76EE\u5F55\u53D7\u7406\u8BB0\u5F55\u4E0D\u80FD\u5305\u542B binding\u3002");
    })();
    if (binding && (binding.kind !== "managed" || binding.taskRoot !== raw.taskRoot || binding.executionRoot !== raw.target.path || binding.branchName !== raw.target.branchName))
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u5B8C\u6210\u8BB0\u5F55\u4E0E\u53D7\u7406\u76EE\u6807\u4E0D\u4E00\u81F4\u3002");
    creates[requestId] = {
      status: raw.status,
      fingerprint: raw.fingerprint,
      taskRoot: raw.taskRoot,
      displayName,
      target: {
        path: raw.target.path,
        branchName: raw.target.branchName,
        sourceHead: raw.target.sourceHead,
        treeId: raw.target.treeId,
        snapshotRepositoryPath: raw.target.snapshotRepositoryPath
      },
      baseline,
      ...binding ? { binding } : {}
    };
  }
  const cleanups = {};
  for (const [requestId, raw] of Object.entries(value.cleanups)) {
    requestIdPart(requestId);
    if (!isRecord(raw) || typeof raw.fingerprint !== "string" || !isRecord(raw.result))
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u6E05\u7406\u5E42\u7B49\u8BB0\u5F55\u683C\u5F0F\u65E0\u6548\u3002");
    const result = raw.result;
    if (result.ok === true) {
      if (typeof result.released !== "boolean")
        throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u6E05\u7406\u6210\u529F\u8BB0\u5F55\u7F3A\u5C11 released\u3002");
      if (result.branchDeleted !== void 0 && typeof result.branchDeleted !== "boolean")
        throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u6E05\u7406 branchDeleted \u683C\u5F0F\u65E0\u6548\u3002");
      cleanups[requestId] = {
        fingerprint: raw.fingerprint,
        result: {
          ok: true,
          released: result.released,
          ...result.branchDeleted !== void 0 ? { branchDeleted: result.branchDeleted } : {}
        }
      };
    } else if (result.ok === false) {
      if (result.retained !== true || typeof result.reason !== "string" || !result.reason.trim())
        throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u6E05\u7406\u4FDD\u7559\u8BB0\u5F55\u683C\u5F0F\u65E0\u6548\u3002");
      cleanups[requestId] = {
        fingerprint: raw.fingerprint,
        result: { ok: false, retained: true, reason: result.reason }
      };
    } else {
      throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u6E05\u7406\u7ED3\u679C\u7F3A\u5C11 ok\u3002");
    }
  }
  return { version: 2, creates, cleanups };
}
function decodeBinding(value) {
  if (!isRecord(value)) throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u7ED1\u5B9A\u4E0D\u662F\u5BF9\u8C61\u3002");
  const required = requiredBindingStrings(value);
  if (value.kind === "primary") {
    const binding2 = primaryBinding(required.taskRoot, {
      repositoryRoot: required.taskRoot,
      commonGitDir: required.commonGitDir,
      sourceHead: required.inputVersion
    });
    if (required.bindingDigest !== binding2.bindingDigest)
      throw new Error("\u4E3B\u76EE\u5F55\u7ED1\u5B9A\u6458\u8981\u6821\u9A8C\u5931\u8D25\u3002");
    return binding2;
  }
  if (value.kind !== "managed") throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u7ED1\u5B9A kind \u65E0\u6548\u3002");
  if (typeof value.worktreeId !== "string" || !value.worktreeId.trim())
    throw new Error("\u53D7\u7BA1\u5DE5\u4F5C\u76EE\u5F55\u7ED1\u5B9A\u7F3A\u5C11 worktreeId\u3002");
  if (typeof value.branchName !== "string" || !value.branchName.startsWith("pi/"))
    throw new Error("\u53D7\u7BA1\u5DE5\u4F5C\u76EE\u5F55\u7ED1\u5B9A branchName \u65E0\u6548\u3002");
  const baseline = decodeBaseline(value.baseline);
  if (baseline.inputVersion !== required.inputVersion)
    throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u7ED1\u5B9A\u4E0E\u57FA\u7EBF inputVersion \u4E0D\u4E00\u81F4\u3002");
  if (value.currentTreeId !== void 0 && typeof value.currentTreeId !== "string")
    throw new Error("currentTreeId \u683C\u5F0F\u65E0\u6548\u3002");
  const binding = {
    kind: "managed",
    worktreeId: value.worktreeId,
    taskRoot: required.taskRoot,
    executionRoot: required.executionRoot,
    commonGitDir: required.commonGitDir,
    branchName: value.branchName,
    inputVersion: required.inputVersion,
    bindingDigest: "",
    baseline,
    ...typeof value.currentTreeId === "string" ? { currentTreeId: value.currentTreeId } : {}
  };
  const expected = bindingDigest(binding);
  if (required.bindingDigest !== expected) throw new Error("\u53D7\u7BA1\u5DE5\u4F5C\u76EE\u5F55\u7ED1\u5B9A\u6458\u8981\u6821\u9A8C\u5931\u8D25\u3002");
  return { ...binding, bindingDigest: expected };
}
function requiredBindingStrings(value) {
  const fields = [
    "taskRoot",
    "executionRoot",
    "commonGitDir",
    "inputVersion",
    "bindingDigest"
  ];
  const result = Object.fromEntries(
    fields.map((field) => {
      const item = value[field];
      if (typeof item !== "string") throw new Error(`\u5DE5\u4F5C\u76EE\u5F55\u7ED1\u5B9A ${field} \u683C\u5F0F\u65E0\u6548\u3002`);
      return [field, item];
    })
  );
  if (!result.taskRoot.trim() || !result.executionRoot.trim() || !result.inputVersion.trim())
    throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u7ED1\u5B9A\u7F3A\u5C11\u5FC5\u8981\u8DEF\u5F84\u6216\u8F93\u5165\u7248\u672C\u3002");
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(result.bindingDigest))
    throw new Error("\u5DE5\u4F5C\u76EE\u5F55 bindingDigest \u683C\u5F0F\u65E0\u6548\u3002");
  if (!result.bindingDigest.startsWith("sha256:"))
    result.bindingDigest = `sha256:${result.bindingDigest}`;
  return result;
}
function decodeBaseline(value) {
  if (!isRecord(value)) throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u57FA\u7EBF\u4E0D\u662F\u5BF9\u8C61\u3002");
  const stringFields = [
    "sourceRoot",
    "sourceHead",
    "treeId",
    "snapshotRepositoryPath",
    "inputVersion",
    "capturedAt"
  ];
  for (const field of stringFields) {
    if (typeof value[field] !== "string" || !value[field].trim())
      throw new Error(`\u5DE5\u4F5C\u76EE\u5F55\u57FA\u7EBF ${field} \u683C\u5F0F\u65E0\u6548\u3002`);
  }
  if (!Number.isSafeInteger(value.fileCount) || value.fileCount < 0 || !Number.isSafeInteger(value.byteCount) || value.byteCount < 0)
    throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u57FA\u7EBF\u6587\u4EF6\u6216\u5B57\u8282\u8BA1\u6570\u65E0\u6548\u3002");
  if (value.coverage !== "complete") throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u57FA\u7EBF\u8986\u76D6\u4E0D\u662F complete\u3002");
  const lists = ["includedPaths", "excludedPaths", "notes"];
  for (const field of lists) {
    if (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === "string"))
      throw new Error(`\u5DE5\u4F5C\u76EE\u5F55\u57FA\u7EBF ${field} \u683C\u5F0F\u65E0\u6548\u3002`);
  }
  return {
    sourceRoot: value.sourceRoot,
    sourceHead: value.sourceHead,
    treeId: value.treeId,
    snapshotRepositoryPath: value.snapshotRepositoryPath,
    inputVersion: value.inputVersion,
    capturedAt: value.capturedAt,
    fileCount: value.fileCount,
    byteCount: value.byteCount,
    coverage: "complete",
    includedPaths: [...value.includedPaths],
    excludedPaths: [...value.excludedPaths],
    notes: [...value.notes]
  };
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// desktop/apps/desktop/electron/workbench/checkpoint-store.ts
import { execFile as execFile3 } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir as mkdir3,
  mkdtemp as mkdtemp2,
  open as open2,
  readlink,
  realpath as realpath4,
  rename as rename2,
  rm as rm2,
  unlink as unlink3,
  writeFile
} from "node:fs/promises";
import { dirname as dirname5, isAbsolute as isAbsolute3, join as join4, relative as relative2, resolve as resolve4, sep as sep2 } from "node:path";

// desktop/apps/desktop/electron/platform/files/git-environment.ts
function isolatedGitEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...extra };
}

// desktop/apps/desktop/electron/workbench/checkpoint-store.ts
var DEFAULT_LIMITS = {
  timeoutMs: 2e3,
  maxFiles: 1e4,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024
};
var DEFAULT_RETENTION = {
  maxRecordsPerTask: 50,
  maxRecords: 500,
  pruneGraceMs: 60 * 60 * 1e3,
  maintenanceIntervalMs: 60 * 60 * 1e3
};
var MAINTENANCE_BOUNDARIES = 200;
var RACY_WINDOW_MS = 2e3;
var MAX_CACHED_CHECKOUTS = 16;
var WARM_TIMEOUT_MS = 6e4;
var WARM_RETRY_MS = 15 * 60 * 1e3;
var SNAPSHOT_REF_PREFIX = "refs/pi-gui/snapshots/";
var TurnCheckpointStore = class {
  repositoryPath;
  directory;
  metadataPath;
  limits;
  retention;
  records = /* @__PURE__ */ new Map();
  loaded;
  gitReady;
  /** Boundaries serialize per checkout; unrelated checkouts capture concurrently. */
  checkoutQueues = /* @__PURE__ */ new Map();
  /** The latest boundary of each task, so its lookups never return an older turn. */
  taskBoundaries = /* @__PURE__ */ new Map();
  writing = Promise.resolve();
  queuedWrite;
  /** Last successful inventory per checkout root; cleared whenever objects may be pruned. */
  inventories = /* @__PURE__ */ new Map();
  inventoryGeneration = 0;
  warming = /* @__PURE__ */ new Set();
  warmRetryAfter = /* @__PURE__ */ new Map();
  activeCaptures = /* @__PURE__ */ new Set();
  maintenanceRun;
  /** The first pass also waits one interval, keeping gc away from startup. */
  lastMaintenanceAt = Date.now();
  boundariesSinceMaintenance = 0;
  droppedSinceMaintenance = 0;
  constructor(userDataDir, limits = {}, retention = {}) {
    this.directory = join4(userDataDir, "turn-checkpoints");
    this.repositoryPath = join4(this.directory, "objects.git");
    this.metadataPath = join4(this.directory, "checkpoints.json");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.retention = { ...DEFAULT_RETENTION, ...retention };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error("Checkpoint capture limits must be positive safe integers.");
    }
    if (Object.values(this.retention).some((value) => !Number.isSafeInteger(value) || value < 0) || this.retention.maxRecordsPerTask < 1 || this.retention.maxRecords < 1) {
      throw new Error("Checkpoint retention limits must be safe integers.");
    }
  }
  /**
   * The adapter awaits this before a tool can run. A transition shares exactly one tree.
   * Only boundaries in the same checkout wait for each other, and the capture budget starts
   * when this boundary's own capture starts.
   */
  recordBoundary(boundary, signal) {
    const operation = checkoutRoot(boundary.workspace.path).then(
      (checkoutPath) => this.enqueue(checkoutPath, () => this.recordInQueue(boundary, checkoutPath, signal))
    );
    const task = targetKey(boundary.sessionRef);
    const settled = operation.then(
      () => void 0,
      () => void 0
    );
    this.taskBoundaries.set(task, settled);
    settled.then(
      () => {
        if (this.taskBoundaries.get(task) === settled) this.taskBoundaries.delete(task);
      },
      () => void 0
    );
    return operation;
  }
  async recordInQueue(boundary, checkoutPath, signal) {
    await this.load();
    const { opening, closing } = boundary;
    if (!opening && !closing) return;
    if (opening && (this.records.has(opening.checkpointId) || opening.checkpointId === closing?.checkpointId)) {
      throw new Error("Checkpoint opening identity was already used.");
    }
    if (closing) {
      const existing = this.records.get(closing.checkpointId);
      if (existing && existing.outcome !== "open")
        throw new Error("Checkpoint interval was already finalized.");
    }
    const makeRecord = (anchor) => ({
      checkpointId: anchor.checkpointId,
      target: { ...boundary.sessionRef },
      checkoutId: boundary.workspace.workspaceId,
      checkoutPath,
      runtimeGeneration: boundary.runtimeGeneration,
      runId: boundary.runId,
      startedAt: anchor.startedAt,
      updatedAt: boundary.timestamp,
      beforeEntryId: anchor.beforeEntryId,
      userEntryIds: [],
      assistantEntryIds: [],
      lastEntryId: null,
      outcome: "open",
      before: unavailableCapture("capture-pending", "The before capture did not finish."),
      after: null,
      overlaps: []
    });
    for (const anchor of [opening, closing]) {
      if (!anchor) continue;
      const existing = this.records.get(anchor.checkpointId);
      if (existing && (!sameTarget(existing.target, boundary.sessionRef) || existing.checkoutId !== boundary.workspace.workspaceId || existing.runtimeGeneration !== boundary.runtimeGeneration || existing.runId !== boundary.runId))
        throw new Error("Checkpoint identity belongs to another runtime interval.");
    }
    if (closing && !this.records.has(closing.checkpointId)) {
      this.records.set(closing.checkpointId, makeRecord(closing));
    }
    if (opening && !this.records.has(opening.checkpointId)) {
      let next = makeRecord(opening);
      for (const [id, active] of this.records) {
        if (active.outcome !== "open" || id === closing?.checkpointId || active.checkoutPath !== checkoutPath)
          continue;
        next = { ...next, overlaps: [...next.overlaps, id] };
        this.records.set(id, {
          ...active,
          overlaps: [.../* @__PURE__ */ new Set([...active.overlaps, next.checkpointId])]
        });
      }
      this.records.set(next.checkpointId, next);
    }
    const capture = await this.capture(boundary.workspace.path, signal);
    const safeCapture = signal.aborted ? unavailableCapture(
      "capture-aborted",
      "The capture was interrupted or exceeded its time limit."
    ) : capture;
    if (safeCapture.state === "unavailable" && safeCapture.code === "capture-aborted")
      this.warmInventory(checkoutPath);
    if (closing) {
      const current = this.records.get(closing.checkpointId);
      this.records.set(closing.checkpointId, {
        ...current,
        outcome: closing.outcome,
        updatedAt: boundary.timestamp,
        userEntryIds: [...closing.userEntryIds],
        assistantEntryIds: [...closing.assistantEntryIds],
        lastEntryId: closing.lastEntryId,
        after: closing.captureError ? unavailableCapture("capture-boundary-failed", closing.captureError) : safeCapture
      });
    }
    if (opening) {
      const current = this.records.get(opening.checkpointId);
      this.records.set(opening.checkpointId, { ...current, before: safeCapture });
    }
    const dropped = this.enforceRetention();
    await this.persist();
    this.boundariesSinceMaintenance += 1;
    this.droppedSinceMaintenance += dropped;
    this.scheduleMaintenance();
  }
  async list(target) {
    await this.taskBoundaries.get(targetKey(target));
    await this.load();
    return structuredClone(
      [...this.records.values()].filter((record) => sameTarget(record.target, target))
    );
  }
  /**
   * Deletes refs that no retained interval needs and lets Git prune their objects. Refs and
   * objects younger than the grace period survive, so a concurrent capture keeps its tree.
   */
  maintain() {
    this.maintenanceRun ??= this.runMaintenance().finally(() => {
      this.maintenanceRun = void 0;
    });
    return this.maintenanceRun;
  }
  async resolve(input) {
    try {
      await this.taskBoundaries.get(targetKey(input.target));
      await this.load();
    } catch {
      return unavailableReview(
        "checkpoint-storage-unavailable",
        "Checkpoint metadata could not be read; existing data was retained."
      );
    }
    const record = input.checkpointId ? this.records.get(input.checkpointId) : [...this.records.values()].filter(
      (candidate) => sameTarget(candidate.target, input.target) && candidate.checkoutId === input.checkoutId && candidate.outcome !== "open"
    ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!record || !sameTarget(record.target, input.target) || record.checkoutId !== input.checkoutId) {
      return unavailableReview(
        "checkpoint-unavailable",
        "No captured turn exists for this task and checkout."
      );
    }
    return resolveRecord(this.repositoryPath, record);
  }
  /** Every finished turn of a task whose before and after captures are both usable. */
  async listTurns(target) {
    const records = await this.list(target);
    return records.flatMap((record) => {
      const resolved = resolveRecord(this.repositoryPath, record);
      if (resolved.state !== "available") return [];
      const entryIds = [
        ...record.userEntryIds,
        ...record.assistantEntryIds,
        ...record.lastEntryId ? [record.lastEntryId] : []
      ];
      return [{ ...resolved, entryIds: [...new Set(entryIds)] }];
    });
  }
  async capture(workspacePath, parentSignal, timeoutMs = this.limits.timeoutMs) {
    const run = this.captureCheckout(workspacePath, parentSignal, timeoutMs);
    this.activeCaptures.add(run);
    try {
      return await run;
    } finally {
      this.activeCaptures.delete(run);
    }
  }
  /**
   * A checkout too large to read within one boundary's budget never gets an inventory from
   * boundaries alone. Build it off the capture path so later boundaries read only changes.
   */
  warmInventory(checkoutPath) {
    if (this.inventories.has(checkoutPath) || this.warming.has(checkoutPath) || (this.warmRetryAfter.get(checkoutPath) ?? 0) > Date.now())
      return;
    this.warming.add(checkoutPath);
    const timer = setTimeout(() => {
      this.capture(checkoutPath, void 0, WARM_TIMEOUT_MS).then((capture) => {
        if (capture.state === "available") this.warmRetryAfter.delete(checkoutPath);
        else this.warmRetryAfter.set(checkoutPath, Date.now() + WARM_RETRY_MS);
      }).finally(() => this.warming.delete(checkoutPath)).catch(() => void 0);
    }, 0);
    timer.unref?.();
  }
  async captureCheckout(workspacePath, parentSignal, timeoutMs) {
    const started = Date.now();
    const generation = this.inventoryGeneration;
    const timeout = AbortSignal.timeout(timeoutMs);
    const failure = new AbortController();
    const signal = AbortSignal.any([
      failure.signal,
      timeout,
      ...parentSignal ? [parentSignal] : []
    ]);
    const snapshotId = randomUUID2();
    const indexPath = join4(this.directory, "indexes", `${snapshotId}.index`);
    let spoolPath;
    let byteCount = 0;
    let fileCount = 0;
    try {
      signal.throwIfAborted();
      await this.prepareGit(signal);
      await mkdir3(dirname5(indexPath), { recursive: true });
      const root = await realpath4(workspacePath);
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new CaptureError("checkout-changing", "The checkout root changed during capture.");
      const repositoryRoot = stripLine2(await git2(root, ["rev-parse", "--show-toplevel"], signal));
      if (await realpath4(repositoryRoot) !== root)
        throw new CaptureError(
          "checkout-root-required",
          "Turn captures require the Git checkout root."
        );
      const [trackedOutput, otherOutput] = await Promise.all([
        git2(root, ["ls-files", "--stage", "-v", "-z"], signal),
        git2(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal)
      ]);
      const paths = /* @__PURE__ */ new Set();
      for (const entry of nulRecords(trackedOutput)) {
        const match = /^([A-Za-z?]) ([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(entry);
        if (!match)
          throw new CaptureError(
            "inventory-invalid",
            "Git returned an unreadable tracked-file inventory."
          );
        if (match[1].toUpperCase() === "S")
          throw new CaptureError(
            "sparse-checkout",
            "Sparse checkout paths are not yet supported by turn captures."
          );
        if (match[2] === "160000")
          throw new CaptureError(
            "submodule",
            "Submodule contents are excluded; this turn capture is unavailable."
          );
        if (match[4] !== "0")
          throw new CaptureError(
            "conflicted-checkout",
            "Resolve Git index conflicts before capturing a complete turn."
          );
        paths.add(match[5]);
      }
      let skippedNestedRepository = false;
      for (const path of nulRecords(otherOutput)) {
        if (path.endsWith("/")) skippedNestedRepository = true;
        else paths.add(path);
      }
      if (paths.size > this.limits.maxFiles)
        throw new CaptureError(
          "file-limit",
          `The checkout exceeds the ${this.limits.maxFiles}-file capture limit.`
        );
      const entries = [...paths];
      const previous = this.inventories.get(root);
      const directories = /* @__PURE__ */ new Map();
      spoolPath = await mkdtemp2(join4(this.directory, "capture-"));
      const captureDirectory = spoolPath;
      const stored = [];
      const spooled = [];
      let cursor = 0;
      const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
        while (cursor < entries.length) {
          signal.throwIfAborted();
          const ordinal = cursor++;
          const path = entries[ordinal];
          const file = await inspectSnapshotFile(
            root,
            rootStat,
            path,
            signal,
            (size) => {
              if (size > this.limits.maxFileBytes || byteCount + size > this.limits.maxBytes) {
                throw new CaptureError(
                  "byte-limit",
                  "The checkout exceeds the bounded turn-capture size limit."
                );
              }
              byteCount += size;
            },
            previous?.files.get(path),
            directories
          );
          if (!file) continue;
          fileCount += 1;
          if (file.kind === "stored") {
            stored.push({ path, file: file.file });
            continue;
          }
          const name = `blob-${ordinal}`;
          await writeFile(join4(captureDirectory, name), file.bytes, {
            flag: "wx",
            mode: 384,
            signal
          });
          signal.throwIfAborted();
          spooled.push({ path, mode: file.mode, name, version: file.version });
        }
      });
      try {
        await Promise.all(workers);
      } catch (error) {
        failure.abort();
        await Promise.allSettled(workers);
        throw error;
      }
      signal.throwIfAborted();
      let objectIds = [];
      if (spooled.length) {
        const objectOutput = await git2(
          captureDirectory,
          ["--git-dir", this.repositoryPath, "hash-object", "--stdin-paths", "--no-filters", "-w"],
          signal,
          Buffer.from(spooled.map((entry) => `${entry.name}
`).join(""))
        );
        signal.throwIfAborted();
        objectIds = objectOutput.length ? stripLine2(objectOutput).split(/\r?\n/) : [];
      }
      if (objectIds.length !== spooled.length || objectIds.some((oid) => !/^[a-f0-9]{40}$/.test(oid))) {
        throw new CaptureError(
          "object-invalid",
          "Git returned an invalid snapshot object inventory."
        );
      }
      await rm2(captureDirectory, { recursive: true, force: true });
      spoolPath = void 0;
      signal.throwIfAborted();
      const files = /* @__PURE__ */ new Map();
      for (const entry of stored) files.set(entry.path, entry.file);
      spooled.forEach((entry, index) => {
        if (Math.max(entry.version.mtimeMs, entry.version.ctimeMs) < started - RACY_WINDOW_MS)
          files.set(entry.path, {
            ...fileVersion(entry.version),
            gitMode: entry.mode,
            oid: objectIds[index]
          });
      });
      let treeOid;
      if (previous && spooled.length === 0 && stored.length === previous.entryCount) {
        treeOid = previous.treeOid;
      } else {
        const indexEntries = [
          ...stored.map((entry) => `${entry.file.gitMode} ${entry.file.oid}	${entry.path}\0`),
          ...spooled.map((entry, index) => `${entry.mode} ${objectIds[index]}	${entry.path}\0`)
        ];
        const indexEnvironment = { GIT_INDEX_FILE: indexPath };
        await git2(
          this.repositoryPath,
          ["read-tree", "--empty"],
          signal,
          void 0,
          indexEnvironment
        );
        await git2(
          this.repositoryPath,
          ["update-index", "-z", "--index-info"],
          signal,
          Buffer.from(indexEntries.join("")),
          indexEnvironment
        );
        treeOid = stripLine2(
          await git2(this.repositoryPath, ["write-tree"], signal, void 0, indexEnvironment)
        );
        if (!/^[a-f0-9]{40}$/.test(treeOid))
          throw new CaptureError("tree-invalid", "Git returned an invalid snapshot tree.");
        signal.throwIfAborted();
        await git2(
          this.repositoryPath,
          ["update-ref", `${SNAPSHOT_REF_PREFIX}${Date.now()}-${snapshotId}`, treeOid],
          signal
        );
      }
      signal.throwIfAborted();
      if (generation === this.inventoryGeneration) {
        this.inventories.delete(root);
        this.inventories.set(root, { treeOid, entryCount: fileCount, files });
        for (const key of this.inventories.keys()) {
          if (this.inventories.size <= MAX_CACHED_CHECKOUTS) break;
          this.inventories.delete(key);
        }
      }
      return {
        state: "available",
        treeOid,
        capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
        coverage: skippedNestedRepository ? { state: "partial", notes: [NESTED_REPOSITORY_NOTE] } : { state: "complete", notes: [] },
        fileCount,
        byteCount,
        durationMs: Date.now() - started
      };
    } catch (error) {
      failure.abort();
      const result = timeout.aborted || parentSignal?.aborted ? unavailableCapture(
        "capture-aborted",
        "The capture was interrupted or exceeded its time limit."
      ) : error instanceof CaptureError ? unavailableCapture(error.code, error.message) : unavailableCapture(
        "capture-failed",
        "The checkout could not be captured completely; no partial diff will be shown."
      );
      return { ...result, fileCount, byteCount, durationMs: Date.now() - started };
    } finally {
      if (spoolPath) await rm2(spoolPath, { recursive: true, force: true });
      await Promise.all(
        [indexPath, `${indexPath}.lock`].map(async (path) => {
          try {
            await unlink3(path);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        })
      );
    }
  }
  prepareGit(signal) {
    this.gitReady ??= (async () => {
      await mkdir3(this.directory, { recursive: true, mode: 448 });
      try {
        const existing = await lstat(this.repositoryPath);
        if (!existing.isDirectory() || existing.isSymbolicLink())
          throw new Error("Invalid checkpoint repository.");
      } catch (error) {
        if (!isMissing(error)) throw error;
        const initializingPath = join4(this.directory, `objects.git.initializing.${randomUUID2()}`);
        await git2(
          this.directory,
          ["init", "--bare", "--template=", "--object-format=sha1", initializingPath],
          signal
        );
        if (stripLine2(await git2(initializingPath, ["rev-parse", "--is-bare-repository"], signal)) !== "true") {
          throw new Error("Checkpoint repository initialization did not finish.");
        }
        signal.throwIfAborted();
        await rename2(initializingPath, this.repositoryPath);
      }
      if (stripLine2(await git2(this.repositoryPath, ["rev-parse", "--is-bare-repository"], signal)) !== "true")
        throw new Error("Checkpoint repository must be bare.");
    })().catch((error) => {
      this.gitReady = void 0;
      throw error;
    });
    return this.gitReady;
  }
  load() {
    this.loaded ??= (async () => {
      const result = await readJsonWithBackup(this.metadataPath);
      if (result.corrupted && !result.recovered)
        throw new Error("Invalid checkpoint metadata; original data retained.");
      const metadata = result.value === void 0 ? { version: 1, records: [] } : decodeMetadata(result.value);
      let interrupted = false;
      for (const record of metadata.records) {
        if (record.outcome === "open") {
          interrupted = true;
          this.records.set(record.checkpointId, {
            ...record,
            outcome: "interrupted",
            after: unavailableCapture(
              "runtime-interrupted",
              "The app exited before this interval's final capture."
            )
          });
        } else this.records.set(record.checkpointId, record);
      }
      if (interrupted) await this.persist();
    })().catch((error) => {
      this.records.clear();
      this.loaded = void 0;
      throw error;
    });
    return this.loaded;
  }
  /** Concurrent callers share one pending write; it serializes the records current at start. */
  persist() {
    if (this.queuedWrite) return this.queuedWrite;
    const write = this.writing.catch(() => void 0).then(() => {
      this.queuedWrite = void 0;
      const metadata = { version: 1, records: [...this.records.values()] };
      decodeMetadata(metadata);
      return writeFileAtomicQueued(
        this.metadataPath,
        `${JSON.stringify(metadata)}
`,
        decodeMetadata
      );
    });
    this.queuedWrite = write;
    this.writing = write;
    return write;
  }
  enqueue(checkout, action) {
    const previous = this.checkoutQueues.get(checkout) ?? Promise.resolve();
    const result = previous.then(action);
    const settled = result.then(
      () => void 0,
      () => void 0
    );
    this.checkoutQueues.set(checkout, settled);
    settled.then(
      () => {
        if (this.checkoutQueues.get(checkout) === settled) this.checkoutQueues.delete(checkout);
      },
      () => void 0
    );
    return result;
  }
  /** Keeps the newest finalized intervals per task and overall. Returns the number dropped. */
  enforceRetention() {
    const finalized = [...this.records.values()].filter((record) => record.outcome !== "open").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const perTask = /* @__PURE__ */ new Map();
    let kept = 0;
    let dropped = 0;
    for (const record of finalized) {
      const key = targetKey(record.target);
      const count = (perTask.get(key) ?? 0) + 1;
      perTask.set(key, count);
      if (count > this.retention.maxRecordsPerTask || kept >= this.retention.maxRecords) {
        this.records.delete(record.checkpointId);
        dropped += 1;
      } else kept += 1;
    }
    return dropped;
  }
  scheduleMaintenance() {
    if (this.maintenanceRun || this.droppedSinceMaintenance === 0 && this.boundariesSinceMaintenance < MAINTENANCE_BOUNDARIES || Date.now() - this.lastMaintenanceAt < this.retention.maintenanceIntervalMs)
      return;
    const timer = setTimeout(() => {
      this.maintain().catch(
        (error) => console.warn("[turn-checkpoints] maintenance failed", error)
      );
    }, 0);
    timer.unref?.();
  }
  async runMaintenance() {
    await this.load();
    this.lastMaintenanceAt = Date.now();
    this.boundariesSinceMaintenance = 0;
    this.droppedSinceMaintenance = 0;
    this.inventoryGeneration += 1;
    this.inventories.clear();
    await Promise.allSettled([...this.activeCaptures, ...this.checkoutQueues.values()]);
    const signal = AbortSignal.timeout(30 * 6e4);
    await this.prepareGit(signal);
    const live = /* @__PURE__ */ new Set();
    for (const record of this.records.values()) {
      for (const capture of [record.before, record.after]) {
        if (capture?.state === "available") live.add(capture.treeOid);
      }
    }
    const cutoff = Date.now() - this.retention.pruneGraceMs;
    const refs = stripLine2(
      await git2(
        this.repositoryPath,
        ["for-each-ref", "--format=%(objectname) %(refname)", SNAPSHOT_REF_PREFIX],
        signal
      )
    ).split("\n").filter(Boolean).map((line) => {
      const [oid = "", name = ""] = line.split(" ");
      const created = /^(\d+)-/.exec(name.slice(SNAPSHOT_REF_PREFIX.length));
      return { oid, name, young: created ? Number(created[1]) > cutoff : false };
    });
    const kept = new Set(refs.filter((ref) => ref.young).map((ref) => ref.oid));
    const deletions = [];
    for (const ref of refs) {
      if (ref.young) continue;
      if (live.has(ref.oid) && !kept.has(ref.oid)) kept.add(ref.oid);
      else deletions.push(`delete ${ref.name} ${ref.oid}
`);
    }
    if (deletions.length)
      await git2(
        this.repositoryPath,
        ["update-ref", "--stdin"],
        signal,
        Buffer.from(deletions.join(""))
      );
    const expiry = this.retention.pruneGraceMs === 0 ? "now" : `${Math.ceil(this.retention.pruneGraceMs / 1e3)}.seconds.ago`;
    await git2(this.repositoryPath, ["gc", "--quiet", `--prune=${expiry}`], signal);
  }
};
var CaptureError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};
async function inspectSnapshotFile(root, rootStat, path, signal, reserve, stored, directories) {
  const parts = path.split("/");
  if (isAbsolute3(path) || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || path.includes("\0") || sep2 === "\\" && path.includes("\\"))
    throw new CaptureError("unsafe-path", "The checkout contains an unsafe capture path.");
  const absolute = resolve4(root, path);
  if (relative2(root, absolute).startsWith(`..${sep2}`))
    throw new CaptureError("unsafe-path", "A capture path escapes the checkout.");
  const ancestors = [{ path: root, stat: rootStat }];
  let parent = root;
  for (const component of parts.slice(0, -1)) {
    parent = join4(parent, component);
    const stat2 = await directoryStat(directories, parent);
    if (!stat2) return null;
    ancestors.push({ path: parent, stat: stat2 });
  }
  let before;
  try {
    before = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  signal.throwIfAborted();
  if (stored && sameVersion(before, stored)) {
    reserve(before.size);
    return { kind: "stored", file: stored };
  }
  const verifyAncestors = async () => {
    for (const ancestor of ancestors) {
      const current = await lstat(ancestor.path);
      if (!current.isDirectory() || !sameIdentity(ancestor.stat, current))
        throw new CaptureError("checkout-changing", "A parent directory changed during capture.");
    }
  };
  if (before.isSymbolicLink()) {
    const bytes = await readlink(absolute, { encoding: "buffer" });
    reserve(bytes.length);
    await verifyAncestors();
    if (!sameVersion(before, await lstat(absolute)))
      throw new CaptureError("checkout-changing", "A symlink changed during capture.");
    return { kind: "read", mode: "120000", bytes, version: before };
  }
  if (!before.isFile())
    throw new CaptureError(
      "unsupported-file",
      "Special files and nested repositories are excluded from turn captures."
    );
  reserve(before.size);
  const handle = await open2(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  );
  try {
    if (!sameVersion(before, await handle.stat()))
      throw new CaptureError("checkout-changing", "A file changed before it could be captured.");
    await verifyAncestors();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(
        bytes,
        offset,
        Math.min(64 * 1024, bytes.length - offset),
        offset
      );
      if (read.bytesRead === 0)
        throw new CaptureError("checkout-changing", "A file was truncated during capture.");
      offset += read.bytesRead;
    }
    signal.throwIfAborted();
    if (!sameVersion(before, await handle.stat()) || !sameVersion(before, await lstat(absolute)))
      throw new CaptureError("checkout-changing", "A file changed during capture.");
    await verifyAncestors();
    return {
      kind: "read",
      mode: before.mode & 73 ? "100755" : "100644",
      bytes,
      version: before
    };
  } finally {
    await handle.close();
  }
}
function directoryStat(directories, path) {
  let pending = directories.get(path);
  if (!pending) {
    pending = lstat(path).then(
      (stat2) => {
        if (!stat2.isDirectory() || stat2.isSymbolicLink())
          throw new CaptureError(
            "unsafe-symlink",
            "A tracked path now passes through a symlink or non-directory."
          );
        return stat2;
      },
      (error) => {
        if (isMissing(error)) return null;
        throw error;
      }
    );
    directories.set(path, pending);
  }
  return pending;
}
function fileVersion(stat2) {
  return {
    dev: stat2.dev,
    ino: stat2.ino,
    mode: stat2.mode,
    size: stat2.size,
    mtimeMs: stat2.mtimeMs,
    ctimeMs: stat2.ctimeMs
  };
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameVersion(left, right) {
  return sameIdentity(left, right) && left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function git2(cwd, args, signal, input, extraEnv = {}) {
  return new Promise((accept, reject) => {
    const child = execFile3(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        ...args
      ],
      {
        cwd,
        // Keep normal global/system exclude configuration, but never inherited Git repository overrides.
        env: isolatedGitEnvironment(extraEnv),
        encoding: "buffer",
        signal,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout) => error ? reject(error) : accept(stdout)
    );
    child.stdin?.on("error", () => void 0);
    child.stdin?.end(input);
  });
}
function stripLine2(buffer) {
  return buffer.toString("utf8").replace(/\r?\n$/, "");
}
function nulRecords(buffer) {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text).equals(buffer) || text && !text.endsWith("\0"))
    throw new CaptureError(
      "inventory-encoding",
      "Git paths cannot be represented safely by the app."
    );
  return text ? text.slice(0, -1).split("\0") : [];
}
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function checkoutRoot(path) {
  try {
    return await realpath4(path);
  } catch {
    return resolve4(path);
  }
}
function targetKey(target) {
  return JSON.stringify([target.workspaceId, target.sessionId]);
}
function sameTarget(left, right) {
  return left.workspaceId === right.workspaceId && left.sessionId === right.sessionId;
}
var NESTED_REPOSITORY_NOTE = "Nested Git repositories inside this checkout are not included in turn captures.";
function unavailableCapture(code, message) {
  return {
    state: "unavailable",
    code,
    message,
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    coverage: { state: "partial", notes: [message] },
    fileCount: 0,
    byteCount: 0,
    durationMs: 0
  };
}
function resolveRecord(repositoryPath, record) {
  if (record.outcome === "open" || record.before.state !== "available" || record.after?.state !== "available") {
    const failed = record.before.state === "unavailable" ? record.before : record.after;
    return unavailableReview(
      "checkpoint-incomplete",
      failed?.state === "unavailable" ? failed.message : "This turn does not have complete before and after captures."
    );
  }
  const notes = [...record.before.coverage.notes, ...record.after.coverage.notes];
  if (record.outcome !== "completed")
    notes.push(`This interval ended ${record.outcome}; it is not a completed turn.`);
  if (record.overlaps.length)
    notes.push(
      `Other runs overlapped this interval in the same checkout (${record.overlaps.length}). Changes cannot be attributed to this agent alone.`
    );
  return {
    state: "available",
    checkpointId: record.checkpointId,
    checkoutId: record.checkoutId,
    repositoryPath,
    beforeTreeOid: record.before.treeOid,
    afterTreeOid: record.after.treeOid,
    capturedAt: record.after.capturedAt,
    coverage: { state: notes.length ? "partial" : "complete", notes: [...new Set(notes)] }
  };
}
function unavailableReview(code, message) {
  return { state: "unavailable", code, message };
}
function decodeMetadata(value) {
  const root = metadataRecord(value, ["version", "records"]);
  if (root.version !== 1 || !Array.isArray(root.records))
    throw new Error("Unsupported checkpoint metadata; original data retained.");
  const records = root.records.map((value2) => {
    const record = metadataRecord(value2, [
      "checkpointId",
      "target",
      "checkoutId",
      "checkoutPath",
      "runtimeGeneration",
      "runId",
      "startedAt",
      "updatedAt",
      "beforeEntryId",
      "userEntryIds",
      "assistantEntryIds",
      "lastEntryId",
      "outcome",
      "before",
      "after",
      "overlaps"
    ]);
    const target = metadataRecord(record.target, ["workspaceId", "sessionId"]);
    const outcome = record.outcome;
    if (outcome !== "open" && outcome !== "completed" && outcome !== "stopped" && outcome !== "failed" && outcome !== "interrupted")
      throw new Error("Invalid checkpoint outcome.");
    return {
      checkpointId: metadataText(record.checkpointId),
      target: {
        workspaceId: metadataText(target.workspaceId),
        sessionId: metadataText(target.sessionId)
      },
      checkoutId: metadataText(record.checkoutId),
      checkoutPath: metadataText(record.checkoutPath),
      runtimeGeneration: metadataText(record.runtimeGeneration),
      runId: metadataText(record.runId),
      startedAt: metadataText(record.startedAt),
      updatedAt: metadataText(record.updatedAt),
      beforeEntryId: record.beforeEntryId === null ? null : metadataText(record.beforeEntryId),
      lastEntryId: record.lastEntryId === null ? null : metadataText(record.lastEntryId),
      userEntryIds: metadataTexts(record.userEntryIds),
      assistantEntryIds: metadataTexts(record.assistantEntryIds),
      overlaps: metadataTexts(record.overlaps),
      outcome,
      before: decodeCapture(record.before),
      after: record.after === null ? null : decodeCapture(record.after)
    };
  });
  if (new Set(records.map((record) => record.checkpointId)).size !== records.length)
    throw new Error("Duplicate checkpoint identity.");
  return { version: 1, records };
}
function decodeCapture(value) {
  const record = metadataRecord(value, [
    "state",
    "treeOid",
    "capturedAt",
    "coverage",
    "fileCount",
    "byteCount",
    "durationMs",
    "code",
    "message"
  ]);
  const coverage = metadataRecord(record.coverage, ["state", "notes"]);
  if (coverage.state !== "complete" && coverage.state !== "partial")
    throw new Error("Invalid checkpoint coverage.");
  const parsedCoverage = {
    state: coverage.state,
    notes: metadataTexts(coverage.notes)
  };
  const common = {
    capturedAt: metadataText(record.capturedAt),
    coverage: parsedCoverage,
    fileCount: metadataNumber(record.fileCount),
    byteCount: metadataNumber(record.byteCount),
    durationMs: metadataNumber(record.durationMs)
  };
  if (record.state === "unavailable")
    return {
      state: "unavailable",
      code: metadataText(record.code),
      message: metadataText(record.message),
      ...common
    };
  if (record.state !== "available" || typeof record.treeOid !== "string" || !/^[a-f0-9]{40}$/.test(record.treeOid) || !Number.isSafeInteger(record.fileCount) || Number(record.fileCount) < 0 || !Number.isSafeInteger(record.byteCount) || Number(record.byteCount) < 0)
    throw new Error("Invalid checkpoint capture.");
  return { state: "available", treeOid: record.treeOid, ...common };
}
function metadataRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Invalid checkpoint metadata; original data retained.");
  return value;
}
function metadataText(value) {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("Invalid checkpoint reference.");
  return value;
}
function metadataTexts(value) {
  if (!Array.isArray(value)) throw new Error("Invalid checkpoint references.");
  return value.map(metadataText);
}
function metadataNumber(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid checkpoint metric.");
  return value;
}

// desktop/packages/catalogs/src/node/catalog-codec.ts
function createEmptyState() {
  return {
    version: 2,
    workspaces: [],
    sessions: [],
    worktrees: [],
    sessionFiles: {}
  };
}
function parseState(raw, filePath) {
  const parsed = JSON.parse(raw);
  if (!isRecord2(parsed) || parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(`Unsupported catalog file format in ${filePath}.`);
  }
  const workspaces = parsed.version === 1 && parsed.workspaces === void 0 ? [] : parsed.workspaces;
  const sessions = parsed.version === 1 && parsed.sessions === void 0 ? [] : parsed.sessions;
  const worktrees = parsed.version === 1 && parsed.worktrees === void 0 ? [] : parsed.worktrees;
  const sessionFiles = parsed.version === 1 && parsed.sessionFiles === void 0 ? {} : parsed.sessionFiles;
  if (!isEntryArray(workspaces, isWorkspaceEntry) || !isEntryArray(sessions, isSessionEntry) || !isEntryArray(worktrees, isWorktreeEntry) || !isStringRecord(sessionFiles)) {
    throw new Error(
      `Invalid catalog file contents in ${filePath}; original file was left unchanged.`
    );
  }
  return {
    version: 2,
    workspaces: workspaces.map(cloneWorkspaceEntry),
    sessions: sessions.map(cloneSessionEntry),
    worktrees: worktrees.map(cloneWorktreeEntry),
    sessionFiles: { ...sessionFiles }
  };
}
function isStringRecord(value) {
  return isRecord2(value) && Object.values(value).every((entry) => typeof entry === "string");
}
function isEntryArray(value, check) {
  return Array.isArray(value) && value.every(check);
}
function hasStrings(value, keys) {
  return keys.every((key) => typeof value[key] === "string");
}
function hasOptionalStrings(value, keys) {
  return keys.every((key) => value[key] === void 0 || typeof value[key] === "string");
}
function isWorkspaceEntry(value) {
  return isRecord2(value) && hasStrings(value, ["workspaceId", "path", "displayName", "lastOpenedAt"]) && typeof value.sortOrder === "number" && Number.isFinite(value.sortOrder) && (value.pinned === void 0 || typeof value.pinned === "boolean");
}
function isSessionEntry(value) {
  return isRecord2(value) && hasStrings(value, ["workspaceId", "title", "updatedAt"]) && hasOptionalStrings(value, ["archivedAt", "previewSnippet", "sessionFilePath"]) && isRecord2(value.sessionRef) && hasStrings(value.sessionRef, ["workspaceId", "sessionId"]) && value.sessionRef.workspaceId === value.workspaceId && (value.status === "idle" || value.status === "running" || value.status === "failed");
}
function isWorktreeEntry(value) {
  return isRecord2(value) && hasStrings(value, [
    "worktreeId",
    "workspaceId",
    "path",
    "displayName",
    "createdAt",
    "updatedAt"
  ]) && hasOptionalStrings(value, ["branchName", "headSha"]) && (value.pinned === void 0 || typeof value.pinned === "boolean") && (value.kind === "primary" || value.kind === "linked") && (value.status === "ready" || value.status === "missing" || value.status === "error");
}
function cloneWorkspaceEntry(entry) {
  return { ...entry };
}
function cloneSessionEntry(entry) {
  return {
    ...entry,
    sessionRef: { ...entry.sessionRef }
  };
}
function cloneWorktreeEntry(entry) {
  return { ...entry };
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// desktop/packages/catalogs/src/node/file-errors.ts
function isMissingFileError3(error) {
  return typeof error === "object" && error !== null && !Array.isArray(error) && "code" in error && typeof error.code === "string" && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

// desktop/packages/catalogs/src/node/json-catalog-store.ts
import { readFile as readFile2 } from "node:fs/promises";
import { join as join5, resolve as resolve5 } from "node:path";
import { homedir as homedir2 } from "node:os";

// desktop/packages/catalogs/src/node/atomic-write.ts
import { randomBytes } from "node:crypto";
import { mkdir as mkdir4, open as open3, rename as rename3, rm as rm3 } from "node:fs/promises";
import { dirname as dirname6 } from "node:path";
var TMP_SUFFIX = ".tmp";
var tmpCounter = 0;
async function writeFileAtomic(filePath, data) {
  const dir = dirname6(filePath);
  await mkdir4(dir, { recursive: true });
  tmpCounter = tmpCounter + 1 >>> 0;
  const tmpPath = `${filePath}.${process.pid}.${tmpCounter}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`;
  const handle = await open3(tmpPath, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameRetrying(tmpPath, filePath);
  } catch (error) {
    await rm3(tmpPath, { force: true }).catch(() => {
    });
    throw error;
  }
  await syncDirectory(dir);
}
var RENAME_RETRIES = 3;
var RENAME_BACKOFF_MS = 25;
async function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename3(from, to);
      return;
    } catch (error) {
      const code = error.code;
      if (attempt >= RENAME_RETRIES || code !== "EPERM" && code !== "EBUSY") throw error;
      await new Promise((resolve6) => setTimeout(resolve6, RENAME_BACKOFF_MS * (attempt + 1)));
    }
  }
}
async function writeJsonFileAtomic(filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}
`);
}
async function syncDirectory(dir) {
  let handle;
  try {
    handle = await open3(dir, "r");
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
  } finally {
    await handle.close();
  }
}

// desktop/packages/session-driver/dist/identity.js
function sessionKey(sessionRef) {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}

// desktop/packages/catalogs/src/node/json-catalog-store.ts
var coordinatorsByPath = /* @__PURE__ */ new Map();
var JsonCatalogStore = class {
  filePath;
  coordinator;
  state;
  stateGeneration = -1;
  loadPromise;
  loadGeneration = -1;
  constructor(options = {}) {
    this.filePath = options.catalogFilePath ? resolve5(options.catalogFilePath) : defaultCatalogFilePath();
    this.coordinator = coordinatorForPath(this.filePath);
  }
  workspaces = {
    listWorkspaces: async () => {
      const state = await this.getState();
      return {
        workspaces: [...state.workspaces].sort(compareWorkspaceEntries).map(cloneWorkspaceEntry)
      };
    },
    getWorkspace: async (workspaceId) => {
      const state = await this.getState();
      const entry = state.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
      return entry ? cloneWorkspaceEntry(entry) : void 0;
    },
    upsertWorkspace: async (entry) => {
      await this.mutateState((state) => {
        const index = state.workspaces.findIndex(
          (workspace) => workspace.workspaceId === entry.workspaceId
        );
        const next = cloneWorkspaceEntry(entry);
        if (index >= 0) {
          state.workspaces[index] = next;
        } else {
          state.workspaces.push(next);
        }
      });
    },
    deleteWorkspace: async (workspaceId) => {
      await this.mutateState((state) => {
        state.workspaces = state.workspaces.filter(
          (workspace) => workspace.workspaceId !== workspaceId
        );
        state.sessions = state.sessions.filter((session) => session.workspaceId !== workspaceId);
        state.worktrees = state.worktrees.filter(
          (worktree) => !(worktree.workspaceId === workspaceId && worktree.kind === "primary")
        );
        for (const key of Object.keys(state.sessionFiles)) {
          if (key.startsWith(`${workspaceId}:`)) {
            delete state.sessionFiles[key];
          }
        }
      });
    }
  };
  worktrees = {
    listWorktrees: async (workspaceId) => {
      const state = await this.getState();
      return {
        worktrees: [...state.worktrees].filter((entry) => workspaceId ? entry.workspaceId === workspaceId : true).sort(compareWorktreeEntries2).map(cloneWorktreeEntry)
      };
    },
    getWorktree: async (worktreeId) => {
      const state = await this.getState();
      const entry = state.worktrees.find((worktree) => worktree.worktreeId === worktreeId);
      return entry ? cloneWorktreeEntry(entry) : void 0;
    },
    upsertWorktree: async (entry) => {
      await this.mutateState((state) => {
        const index = state.worktrees.findIndex(
          (worktree) => worktree.worktreeId === entry.worktreeId
        );
        const next = cloneWorktreeEntry(entry);
        if (index >= 0) {
          state.worktrees[index] = next;
        } else {
          state.worktrees.push(next);
        }
      });
    },
    deleteWorktree: async (worktreeId) => {
      await this.mutateState((state) => {
        state.worktrees = state.worktrees.filter((worktree) => worktree.worktreeId !== worktreeId);
      });
    },
    replaceWorkspaceWorktrees: async (workspaceId, entries) => {
      await this.mutateState((state) => {
        const nextEntries = entries.map(cloneWorktreeEntry);
        const existingEntries = state.worktrees.filter((worktree) => worktree.workspaceId === workspaceId).sort(compareWorktreeEntries2);
        if (areWorktreeListsEqual(existingEntries, nextEntries)) {
          return false;
        }
        state.worktrees = [
          ...state.worktrees.filter((worktree) => worktree.workspaceId !== workspaceId),
          ...nextEntries
        ];
      });
    }
  };
  sessions = {
    listSessions: async (workspaceId) => {
      const state = await this.getState();
      const sessions = state.sessions.filter((entry) => workspaceId ? entry.workspaceId === workspaceId : true).sort(compareSessionEntries).map(cloneSessionEntry);
      return { sessions };
    },
    getSession: async (sessionRef) => {
      const state = await this.getState();
      const entry = state.sessions.find(
        (session) => sessionKey(session.sessionRef) === sessionKey(sessionRef)
      );
      return entry ? cloneSessionEntry(entry) : void 0;
    },
    upsertSession: async (entry) => {
      await this.mutateState((state) => {
        const index = state.sessions.findIndex(
          (session) => sessionKey(session.sessionRef) === sessionKey(entry.sessionRef)
        );
        if (index >= 0 && areSessionEntriesEqual(state.sessions[index], entry)) {
          return false;
        }
        const next = cloneSessionEntry(entry);
        if (index >= 0) {
          state.sessions[index] = next;
        } else {
          state.sessions.push(next);
        }
      });
    },
    deleteSession: async (sessionRef) => {
      await this.mutateState((state) => {
        const key = sessionKey(sessionRef);
        state.sessions = state.sessions.filter((session) => sessionKey(session.sessionRef) !== key);
        delete state.sessionFiles[key];
      });
    }
  };
  async getSessionFile(sessionRef) {
    const state = await this.getState();
    return state.sessionFiles[sessionKey(sessionRef)];
  }
  async setSessionFile(sessionRef, sessionFile) {
    await this.mutateState((state) => {
      const key = sessionKey(sessionRef);
      if (state.sessionFiles[key] === sessionFile) return false;
      state.sessionFiles[key] = sessionFile;
    });
  }
  async deleteSessionFile(sessionRef) {
    await this.mutateState((state) => {
      delete state.sessionFiles[sessionKey(sessionRef)];
    });
  }
  async replaceWorkspaceSessions(workspaceId, entries, sessionFiles) {
    await this.mutateState((state) => {
      const nextEntries = entries.map(cloneSessionEntry);
      const nextKeys = new Set(nextEntries.map((entry) => sessionKey(entry.sessionRef)));
      state.sessions = [
        ...state.sessions.filter((session) => session.workspaceId !== workspaceId),
        ...nextEntries
      ];
      for (const key of Object.keys(state.sessionFiles)) {
        if (key.startsWith(`${workspaceId}:`) && !nextKeys.has(key)) {
          delete state.sessionFiles[key];
        }
      }
      for (const [key, filePath] of Object.entries(sessionFiles)) {
        state.sessionFiles[key] = filePath;
      }
    });
  }
  async getState() {
    const generation = this.coordinator.generation;
    if (this.state && this.stateGeneration === generation) {
      return this.state;
    }
    if (!this.loadPromise || this.loadGeneration !== generation) {
      this.loadPromise = this.loadState();
      this.loadGeneration = generation;
    }
    const loadPromise = this.loadPromise;
    try {
      const state = await loadPromise;
      if (this.loadPromise === loadPromise && this.coordinator.generation === generation) {
        this.cacheState(state, generation);
      }
      return state;
    } catch (error) {
      if (this.loadPromise === loadPromise) {
        this.clearStateCache();
      }
      throw error;
    }
  }
  async loadState() {
    try {
      const raw = await readFile2(this.filePath, "utf8");
      return parseState(raw, this.filePath);
    } catch (error) {
      if (isMissingFileError3(error)) {
        return createEmptyState();
      }
      throw error;
    }
  }
  async mutateState(mutator) {
    const operation = this.coordinator.mutationQueue.then(async () => {
      this.clearStateCache();
      const nextState = await this.loadState();
      if (mutator(nextState) === false) {
        this.cacheState(nextState, this.coordinator.generation);
        return;
      }
      await writeJsonFileAtomic(this.filePath, nextState);
      this.coordinator.generation += 1;
      this.cacheState(nextState, this.coordinator.generation);
    });
    this.coordinator.mutationQueue = operation.then(
      () => void 0,
      () => void 0
    );
    await operation;
  }
  cacheState(state, generation) {
    this.state = state;
    this.stateGeneration = generation;
    this.loadPromise = void 0;
    this.loadGeneration = -1;
  }
  clearStateCache() {
    this.state = void 0;
    this.stateGeneration = -1;
    this.loadPromise = void 0;
    this.loadGeneration = -1;
  }
};
function coordinatorForPath(filePath) {
  const existing = coordinatorsByPath.get(filePath);
  if (existing) {
    return existing;
  }
  const coordinator = {
    mutationQueue: Promise.resolve(),
    generation: 0
  };
  coordinatorsByPath.set(filePath, coordinator);
  return coordinator;
}
function defaultCatalogFilePath() {
  return join5(homedir2(), ".pi-gui", "catalogs.json");
}
function compareWorkspaceEntries(left, right) {
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
}
function compareSessionEntries(left, right) {
  const archiveRank = rankSessionArchiveState(left) - rankSessionArchiveState(right);
  if (archiveRank !== 0) return archiveRank;
  const statusRank = rankSessionStatus(left.status) - rankSessionStatus(right.status);
  if (statusRank !== 0) return statusRank;
  return right.updatedAt.localeCompare(left.updatedAt);
}
function compareWorktreeEntries2(left, right) {
  if (left.kind !== right.kind) {
    return left.kind === "primary" ? -1 : 1;
  }
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
  return left.displayName.localeCompare(right.displayName);
}
function areWorktreeListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const sortedRight = [...right].sort(compareWorktreeEntries2);
  return left.every((entry, index) => areWorktreeEntriesEqual(entry, sortedRight[index]));
}
function areSessionEntriesEqual(left, right) {
  return left.sessionRef.workspaceId === right.sessionRef.workspaceId && left.sessionRef.sessionId === right.sessionRef.sessionId && left.workspaceId === right.workspaceId && left.title === right.title && left.updatedAt === right.updatedAt && left.archivedAt === right.archivedAt && left.previewSnippet === right.previewSnippet && left.sessionFilePath === right.sessionFilePath && left.status === right.status;
}
function areWorktreeEntriesEqual(left, right) {
  if (!right) {
    return false;
  }
  return left.worktreeId === right.worktreeId && left.workspaceId === right.workspaceId && left.path === right.path && left.displayName === right.displayName && left.kind === right.kind && left.status === right.status && left.branchName === right.branchName && left.headSha === right.headSha && left.pinned === right.pinned && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt;
}
function rankSessionStatus(status) {
  if (status === "running") return 0;
  if (status === "idle") return 1;
  return 2;
}
function rankSessionArchiveState(session) {
  return session.archivedAt ? 1 : 0;
}

// .pao/协作机制重构-20261023/benchmark-host-entry.ts
function createBenchmarkWorktreeHost(userDataDir, runtime) {
  const host = new PaoDesktopWorktreeHost({
    userDataDir,
    catalogStorage: new JsonCatalogStore({ catalogFilePath: join6(userDataDir, "catalogs.json") }),
    checkpoints: new TurnCheckpointStore(userDataDir)
  });
  host.configurePaoWorktreeRuntime(runtime);
  return host;
}
export {
  createBenchmarkWorktreeHost
};
