// 离线集成：真实文件扩展装载与资源声明，不请求模型，不打开用户凭证。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
  createEventBus,
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { registerDesktopOwner } from "@earendil-works/pi-coding-agent/pao/desktop";
import { createFacetHost, defineService } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DESKTOP_VIEW_REGISTER } from "@pi-gui/extension-ui";

test("PAO 桌面从真实文件扩展装载，声明资源位于该扩展目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "pao-desktop-load-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const bus = createEventBus();
  const declarations = [];
  bus.on(DESKTOP_VIEW_REGISTER, (event) => declarations.push(event.declaration));
  const source = fileURLToPath(new URL("./index.ts", import.meta.url));
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    eventBus: bus,
    additionalExtensionPaths: [source],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(declarations.length, 2);
  assert.deepEqual(declarations.map((entry) => entry.id).sort(), ["pao", "pao-flow"]);
  for (const declaration of declarations) {
    assert.equal(declaration.source, new URL("./index.ts", import.meta.url).href);
    await access(fileURLToPath(declaration.frontend));
  }
  loader.getExtensions().runtime.invalidate();
  bus.clear();
});

test("真实 SDK/文件扩展/Chord 共用原 owner，刷新和捕获准备不触发模型", async () => {
  const root = await mkdtemp(join(tmpdir(), "pao-desktop-service-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const previous = process.env.PAO_HOME;
  process.env.PAO_HOME = root;
  const bus = createEventBus();
  const declarations = [];
  bus.on(DESKTOP_VIEW_REGISTER, (event) => declarations.push(event.declaration));
  const settingsManager = SettingsManager.inMemory({ packages: [] });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    eventBus: bus,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    extensionFactories: [
      {
        name: "test-owner",
        factory: (pi) =>
          registerDesktopOwner(pi, {
            getMinisters: () => {
              if (failMinisters) throw new Error("明确注入的部长读取失败");
              return [];
            },
          }),
      },
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  let failMinisters = false;
  let session;
  let host;
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const manager = SessionManager.inMemory(root);
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      sessionManager: manager,
      modelRuntime: runtime,
      model: runtime.getModels()[0],
    }));
    await session.bindExtensions({});
    const boardHost = await createFacetHost({
      facets: [declarations.find((item) => item.id === "pao").backend()],
    });
    try {
      const board = boardHost.services.use(defineService("pao.desktop.v1"));
      assert.equal((await board.refresh(BACKGROUND_CONTEXT)).项目.session, manager.getSessionId());
    } finally {
      await boardHost.dispose();
    }
    host = await createFacetHost({
      facets: [declarations.find((item) => item.id === "pao-flow").backend()],
    });
    const service = host.services.use(defineService("pao.desktop.v1"));
    const state = await service.refresh(BACKGROUND_CONTEXT);
    assert.equal(state.项目.session, manager.getSessionId());
    failMinisters = true;
    const partial = await service.refresh(BACKGROUND_CONTEXT);
    assert.match(partial.部长错误, /部长读取失败/);
    failMinisters = false;
    const flowService = host.services.use(defineService("pao.desktop.flow.v1"));
    const editor = await flowService.refresh(BACKGROUND_CONTEXT);
    assert.deepEqual(
      editor,
      JSON.parse(JSON.stringify(editor)),
      "工作流返回值须可直接过严格JSON传输",
    );
    assert.deepEqual(state, JSON.parse(JSON.stringify(state)), "看板返回值须可直接过严格JSON传输");
    assert.equal(editor.session, manager.getSessionId());
    assert.equal(editor.catalog.templates.length, 3);
    assert.equal(editor.snapshot.session, manager.getSessionId());
    assert.equal(session.isStreaming, false);
    assert.equal(manager.getBranch().filter((entry) => entry.type === "message").length, 0);
  } finally {
    await host?.dispose();
    session?.dispose();
    loader.getExtensions().runtime.invalidate();
    bus.clear();
    if (previous === undefined) delete process.env.PAO_HOME;
    else process.env.PAO_HOME = previous;
  }
});
