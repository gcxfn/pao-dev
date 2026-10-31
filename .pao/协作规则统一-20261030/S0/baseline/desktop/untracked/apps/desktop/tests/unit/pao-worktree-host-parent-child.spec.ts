import { execFile } from "node:child_process";
import { realpath, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { ManagedWorktreeBinding } from "@earendil-works/pi-coding-agent/pao";

const execFileAsync = promisify(execFile);
const configuredPaoHome = process.env.PAO_HOME?.trim();
if (!configuredPaoHome || !isAbsolute(configuredPaoHome)) {
  throw new Error("父子工作树集成测试要求显式设置绝对路径 PAO_HOME。");
}

const paoHome = resolve(configuredPaoHome);
const paoEntryUrl = pathToFileURL(
  resolve(__dirname, "../../../../../PAO/packages/coding-agent/dist/pao/index.js"),
).href;
const desktopAppRoot = resolve(__dirname, "../..");
const jitiEntryUrl = pathToFileURL(createRequire(__filename).resolve("jiti")).href;

test("桌面父宿主创建的工作树可由真实 Node 子进程默认工厂解析", async () => {
  test.setTimeout(120_000);
  const fixtureParent = dirname(paoHome);
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, "i2-2a-parent-child-"));
  try {
    const environment = await createIsolatedEnvironment(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "assets"), { recursive: true });
    await git(environment, repo, "init", "-q");
    await git(environment, repo, "config", "user.email", "test@example.com");
    await git(environment, repo, "config", "user.name", "I2-2a Test");
    await git(environment, repo, "config", "core.autocrlf", "false");
    await writeFile(join(repo, "src", "tracked.txt"), "head\n");
    await writeFile(join(repo, "assets", "tracked.bin"), Buffer.from([0, 1, 2, 3, 255]));
    await git(environment, repo, "add", "src/tracked.txt", "assets/tracked.bin");
    await git(environment, repo, "commit", "-qm", "seed");

    await writeFile(join(repo, "src", "tracked.txt"), "dirty tracked\n");
    await writeFile(join(repo, "assets", "dirty.bin"), Buffer.from([9, 0, 8, 7]));
    await writeFile(join(repo, "src", "untracked.txt"), "untracked\n");

    const stateRoot = join(root, "user-data");
    const catalogPath = join(stateRoot, "catalogs.json");
    const statePath = join(stateRoot, "pao-worktree-host.json");
    const parentScript = join(root, "create-with-desktop-host.mjs");
    await writeFile(
      parentScript,
      [
        "const payload = JSON.parse(process.argv[2]);",
        "const jitiModule = await import(payload.jitiEntryUrl);",
        "const createJiti = jitiModule.createJiti ?? jitiModule.default?.createJiti;",
        'if (typeof createJiti !== "function") throw new Error("无法载入 jiti。");',
        "const jiti = createJiti(import.meta.url, {",
        "  tsconfigPaths: payload.tsconfigPathsPath,",
        "});",
        "const { PaoDesktopWorktreeHost } = await jiti.import(payload.hostModulePath);",
        "const { GitWorktreeManager } = await jiti.import(payload.managerModulePath);",
        "const { appWorktreeRootMatcher } = await jiti.import(payload.rootMatcherModulePath);",
        "const { TurnCheckpointStore } = await jiti.import(payload.checkpointModulePath);",
        "const { JsonCatalogStore } = await jiti.import(payload.catalogModulePath);",
        "const catalog = new JsonCatalogStore({ catalogFilePath: payload.catalogPath });",
        "const stateRoot = payload.stateRoot;",
        "const manager = new GitWorktreeManager({",
        "  catalogStorage: catalog,",
        "  isAppWorktreePath: appWorktreeRootMatcher(payload.worktreeRoot),",
        "});",
        "const checkpoints = new TurnCheckpointStore(stateRoot, {",
        "  timeoutMs: 30_000,",
        "  maxFiles: 100,",
        "  maxBytes: 16 * 1024 * 1024,",
        "  maxFileBytes: 8 * 1024 * 1024,",
        "});",
        "const host = new PaoDesktopWorktreeHost({",
        "  userDataDir: stateRoot,",
        "  catalogStorage: catalog,",
        "  checkpoints,",
        "  worktreeManager: manager,",
        "});",
        "const created = await host.create({",
        '  requestId: "desktop-parent-create",',
        "  projectRoot: payload.projectRoot,",
        '  displayName: "父进程工作树",',
        "});",
        "process.stdout.write(JSON.stringify({ pid: process.pid, created }));",
      ].join("\n"),
      "utf8",
    );

    let parentOutput: string;
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          parentScript,
          JSON.stringify({
            jitiEntryUrl,
            tsconfigPathsPath: join(desktopAppRoot, "tsconfig.paths.json"),
            hostModulePath: join(
              desktopAppRoot,
              "electron/platform/worktrees/pao-worktree-host.ts",
            ),
            managerModulePath: join(
              desktopAppRoot,
              "electron/platform/worktrees/worktree-manager.ts",
            ),
            rootMatcherModulePath: join(
              desktopAppRoot,
              "electron/platform/worktrees/app-worktree-roots.ts",
            ),
            checkpointModulePath: join(desktopAppRoot, "electron/workbench/checkpoint-store.ts"),
            catalogModulePath: resolve(desktopAppRoot, "../../packages/catalogs/src/node/index.ts"),
            stateRoot,
            catalogPath,
            worktreeRoot: join(stateRoot, "worktrees"),
            projectRoot: repo,
          }),
        ],
        {
          cwd: root,
          env: environment,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 90_000,
          windowsHide: true,
        },
      );
      parentOutput = result.stdout;
    } catch (error) {
      const detail = error as {
        readonly stdout?: string;
        readonly stderr?: string;
      };
      throw new Error(
        `真实 Node 桌面父进程创建失败。stdout=${detail.stdout ?? ""} stderr=${detail.stderr ?? ""}`,
        { cause: error },
      );
    }

    const parent = JSON.parse(parentOutput) as {
      readonly pid: number;
      readonly created: ManagedWorktreeBinding;
    };
    expect(parent.pid).not.toBe(process.pid);
    const created = parent.created;
    expect(created.kind).toBe("managed");

    const executionRoot = await realpath(created.executionRoot);
    expect(created.worktreeId).toBe(executionRoot);
    expect(created.inputVersion).toBe(created.baseline.treeId);
    expect(created.branchName).toMatch(/^pi\//);
    expect(await readFile(join(executionRoot, "src", "tracked.txt"), "utf8")).toBe(
      "dirty tracked\n",
    );
    expect(await readFile(join(executionRoot, "assets", "dirty.bin"))).toEqual(
      Buffer.from([9, 0, 8, 7]),
    );
    expect(await readFile(join(executionRoot, "src", "untracked.txt"), "utf8")).toBe("untracked\n");

    const catalogState = JSON.parse(await readFile(catalogPath, "utf8")) as {
      readonly worktrees: readonly {
        readonly worktreeId: string;
        readonly workspaceId: string;
        readonly path: string;
        readonly branchName?: string;
        readonly kind: string;
      }[];
    };
    const catalogEntry = catalogState.worktrees.find(
      (entry) => entry.worktreeId === created.worktreeId,
    );
    expect(catalogEntry).toMatchObject({
      worktreeId: executionRoot,
      path: executionRoot,
      branchName: created.branchName,
      kind: "linked",
    });
    expect(catalogEntry?.workspaceId).toBeTruthy();

    const stateBeforeChild = await readFile(statePath);
    const catalogBeforeChild = await readFile(catalogPath);
    const childScript = join(root, "resolve-in-child.mjs");
    await writeFile(
      childScript,
      [
        'import { execFile } from "node:child_process";',
        'import { promisify } from "node:util";',
        "const execFileAsync = promisify(execFile);",
        "const payload = JSON.parse(process.argv[2]);",
        "const module = await import(payload.paoEntryUrl);",
        "const host = module.createLocalPaoWorktreeHost({",
        "  stateRoot: payload.stateRoot,",
        "  projectRoot: payload.projectRoot,",
        "});",
        "const binding = await host.resolveForDispatch({",
        '  requestId: "child-resolve",',
        "  projectRoot: payload.projectRoot,",
        '  target: { kind: "managed", worktreeId: payload.worktreeId },',
        "  expectedInputVersion: payload.inputVersion,",
        "});",
        "async function git(...args) {",
        '  const { stdout } = await execFileAsync("git", ["-C", binding.executionRoot, ...args], {',
        '    encoding: "utf8",',
        "    windowsHide: true,",
        "  });",
        "  return stdout.trim();",
        "}",
        "const gitProof = {",
        '  topLevel: await git("rev-parse", "--show-toplevel"),',
        '  commonDir: await git("rev-parse", "--path-format=absolute", "--git-common-dir"),',
        '  branchName: await git("symbolic-ref", "--short", "HEAD"),',
        "};",
        "process.stdout.write(JSON.stringify({ pid: process.pid, parentPid: process.ppid, binding, gitProof }));",
      ].join("\n"),
      "utf8",
    );

    let childOutput: string;
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          childScript,
          JSON.stringify({
            paoEntryUrl,
            stateRoot,
            projectRoot: repo,
            worktreeId: created.worktreeId,
            inputVersion: created.inputVersion,
          }),
        ],
        {
          cwd: root,
          env: environment,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 90_000,
          windowsHide: true,
        },
      );
      childOutput = result.stdout;
    } catch (error) {
      const detail = error as {
        readonly stdout?: string;
        readonly stderr?: string;
      };
      throw new Error(
        `真实 Node 子进程解析失败。stdout=${detail.stdout ?? ""} stderr=${detail.stderr ?? ""}`,
        { cause: error },
      );
    }

    const child = JSON.parse(childOutput) as {
      readonly pid: number;
      readonly parentPid: number;
      readonly binding: typeof created;
      readonly gitProof: {
        readonly topLevel: string;
        readonly commonDir: string;
        readonly branchName: string;
      };
    };
    expect(child.pid).not.toBe(process.pid);
    expect(child.parentPid).toBe(process.pid);
    expect(child.binding).toMatchObject({
      kind: "managed",
      worktreeId: created.worktreeId,
      taskRoot: created.taskRoot,
      executionRoot,
      commonGitDir: created.commonGitDir,
      inputVersion: created.inputVersion,
      bindingDigest: created.bindingDigest,
      branchName: created.branchName,
      baseline: created.baseline,
    });
    expect({
      topLevel: resolve(child.gitProof.topLevel),
      commonDir: resolve(child.gitProof.commonDir),
      branchName: child.gitProof.branchName,
    }).toEqual({
      topLevel: resolve(executionRoot),
      commonDir: resolve(created.commonGitDir),
      branchName: created.branchName,
    });
    expect(
      await git(
        environment,
        created.baseline.snapshotRepositoryPath,
        "cat-file",
        "-t",
        created.baseline.treeId,
      ),
    ).toBe("tree");
    expect(await readFile(statePath)).toEqual(stateBeforeChild);
    expect(await readFile(catalogPath)).toEqual(catalogBeforeChild);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createIsolatedEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const paths = {
    home: join(root, "config-home"),
    temp: join(root, "temp"),
    appData: join(root, "app-data"),
    localAppData: join(root, "local-app-data"),
    xdgConfig: join(root, "xdg-config"),
    xdgCache: join(root, "xdg-cache"),
    xdgData: join(root, "xdg-data"),
    gitConfig: join(root, "global.gitconfig"),
  };
  await Promise.all(
    Object.entries(paths)
      .filter(([key]) => key !== "gitConfig")
      .map(([, path]) => mkdir(path, { recursive: true })),
  );
  await writeFile(paths.gitConfig, "", "utf8");

  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return {
    ...environment,
    HOME: paths.home,
    USERPROFILE: paths.home,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_DATA_HOME: paths.xdgData,
    PAO_HOME: paoHome,
    PAO_WORKTREE_STATE_ROOT: join(root, "user-data"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function git(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  ...args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  return stdout.trim();
}
