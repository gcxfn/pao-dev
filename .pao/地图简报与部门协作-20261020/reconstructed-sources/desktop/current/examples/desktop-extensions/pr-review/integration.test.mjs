import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createFacetHost, defineService } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { DESKTOP_VIEW_REGISTER } from "@pi-gui/extension-ui";

// This is an offline integration test, not a real GitHub or model review.
// Only gh's metadata response is a fixture; Pi, its file loader, Chord, and Git run normally.
test(
  "the actual file-based extension keeps a rejected Pi preflight Requested, then restores Interrupted",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pr-review-admission-"));
    const cwd = join(directory, "checkout");
    const agentDir = join(directory, "agent");
    const bin = join(directory, "bin");
    await Promise.all([cwd, agentDir, bin].map((path) => mkdir(path)));
    const execute = promisify(execFile);
    const git = async (...args) =>
      (await execute("git", args, { cwd, encoding: "utf8" })).stdout.trim();
    await git("init", "-q");
    await writeFile(join(cwd, "search.ts"), "export const limit = 10;\n");
    await git("add", "search.ts");
    const commit = () =>
      git(
        "-c",
        "user.name=Example Test",
        "-c",
        "user.email=example@localhost",
        "commit",
        "-qm",
        "fixture",
      );
    await commit();
    const base = await git("rev-parse", "HEAD");
    await writeFile(join(cwd, "search.ts"), "export const limit = 20;\n");
    await git("add", "search.ts");
    await commit();
    const head = await git("rev-parse", "HEAD");
    const metadata = {
      number: 42,
      url: "https://github.com/example/fixture/pull/42",
      title: "Fixture PR",
      headRefName: "fixture",
      headRefOid: head,
      baseRefOid: base,
    };
    // The process-local fixture executable cannot contact GitHub or read user credentials.
    // 替身通过示例自己的入口交给产品代码：环境变量 `PR_REVIEW_GH_EXECUTABLE` 里给出
    // 「程序路径 + 前置参数」。这样不必再改 PATH、也不必猜扩展名：Windows 上无扩展名脚本
    // 会被 CreateProcess 跳过，而 .cmd/.bat 会被 node 的 execFile 拒成 `spawn EINVAL`（均已实测）。
    // 不设置该变量时产品仍按 PATH 找 `gh`，所以这里不能再往 PATH 里塞任何东西。
    const fixture = `process.stdout.write(${JSON.stringify(JSON.stringify(metadata))});`;
    const fakeGh = join(bin, "fake-gh.mjs");
    await writeFile(fakeGh, fixture);
    // `--` 是前置参数的第一位：Node 20+ 的 argv 是 [exe, 脚本, ...参数]，少了 `--`，
    // `gh pr view` 里的 `pr` 会被当成脚本名去加载（实测 `Cannot find module '...\checkout\pr'`）。
    // 产品拼出的命令是 `node -- <fake-gh.cjs> pr view --json ...`，所以 `pr` 只是普通参数。
    const launcher = join(bin, "fake-gh.cjs");
    await writeFile(
      launcher,
      [
        '"use strict";',
        `const { pathToFileURL } = require("node:url");`,
        `import(${JSON.stringify(pathToFileURL(fakeGh).href)}).catch((error) => {`,
        "  process.stderr.write(String((error && error.stack) || error));",
        "  process.exitCode = 1;",
        "});",
        "",
      ].join("\n"),
    );

    const previousGh = process.env.PR_REVIEW_GH_EXECUTABLE;
    process.env.PR_REVIEW_GH_EXECUTABLE = JSON.stringify([process.execPath, "--", launcher]);
    const bus = createEventBus();
    const declarations = [];
    bus.on(DESKTOP_VIEW_REGISTER, (event) => {
      declarations.push(event.declaration);
      event.accept?.();
    });
    const settingsManager = SettingsManager.inMemory({});
    const source = fileURLToPath(new URL("./index.ts", import.meta.url));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      eventBus: bus,
      additionalExtensionPaths: [source],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    let session;
    let facetHost;
    try {
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      assert.equal(declarations.length, 1);
      assert.equal(declarations[0].source, new URL("./index.ts", import.meta.url).href);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      // Unknown provider makes real Pi authentication preflight reject, without network.
      const model = {
        ...modelRuntime.getModels()[0],
        provider: "example-no-auth",
        id: "offline-fixture",
      };
      assert.ok(model.name, "installed Pi must expose static model metadata");
      const manager = SessionManager.inMemory(cwd);
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model,
        sessionManager: manager,
        resourceLoader: loader,
        settingsManager,
      }));
      let rejectPreflight;
      const rejected = new Promise((resolve) => {
        rejectPreflight = resolve;
      });
      await session.bindExtensions({
        onError: (error) => {
          if (error.event === "send_user_message") rejectPreflight(error);
        },
      });
      facetHost = await createFacetHost({ facets: [declarations[0].backend()] });
      const service = facetHost.services.use(defineService("pi-gui.examples.pr-review.v1"));
      const result = await service.request({ requestId: "offline-admission" }, BACKGROUND_CONTEXT);
      assert.deepEqual(result, { reviewId: "offline-admission" });
      const error = await rejected;
      assert.match(error.error, /No API key|provider/i);
      assert.equal(service.state.value.review.status, "requested");
      assert.equal(session.isStreaming, false);
      assert.equal(
        manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "pi-gui.pr-review.v1")
          .at(-1).data.status,
        "requested",
      );
      // Same released lifecycle event used after rebinding a reloaded extension.
      await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      assert.equal(service.state.value.review.status, "interrupted");
      assert.equal(service.state.value.review.recorded, false);
    } finally {
      await facetHost?.dispose();
      session?.dispose();
      loader.getExtensions().runtime.invalidate();
      bus.clear();
      if (previousGh === undefined) delete process.env.PR_REVIEW_GH_EXECUTABLE;
      else process.env.PR_REVIEW_GH_EXECUTABLE = previousGh;
    }
  },
);
