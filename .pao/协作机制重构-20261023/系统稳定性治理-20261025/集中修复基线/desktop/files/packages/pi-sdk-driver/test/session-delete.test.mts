import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionRef } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";

/**
 * 真删除（波3 §1 一次性主控对话）：deleteSession unlink 会话文件＋删 catalog 条目，
 * 与 archiveSession 的「仅从列表移除、文件保留」相对照；删除只点名目标会话，
 * 同工作区的其他会话文件不动。
 */

async function fixture(t: TestContext): Promise<{
  readonly driver: PiSdkDriver;
  readonly workspaceId: string;
  readonly create: (title: string) => Promise<SessionRef>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-session-delete-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], compaction: { enabled: false }, cacheWarming: "off" }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "session-delete-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
  });
  const workspaceId = "session-delete-workspace";
  t.after(async () => {
    await driver.disposeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
  const create = async (title: string) => {
    const snapshot = await driver.createSession(
      { workspaceId, path: cwd },
      {
        title,
        initialModel: { provider: "session-delete-test", modelId: "scripted" },
      },
    );
    return snapshot.ref;
  };
  return { driver, workspaceId, create };
}

async function fileExists(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await test("deleteSession removes the file and the catalog entry; archive keeps the file", async (t) => {
  const { driver, workspaceId, create } = await fixture(t);
  const doomed = await create("一次性主控对话");
  const keeper = await create("普通会话");
  const doomedFile = await driver.getSessionFilePath(doomed);
  const keeperFile = await driver.getSessionFilePath(keeper);
  assert.ok(doomedFile, "doomed session must track a file");
  assert.ok(keeperFile, "keeper session must track a file");
  assert.notEqual(doomedFile, keeperFile);

  // 对照组：archive 只改列表标记，文件仍在（删除语义不得并入归档）。
  const archived = await create("归档对照");
  const archivedFile = await driver.getSessionFilePath(archived);
  await driver.archiveSession(archived);
  assert.equal(await fileExists(archivedFile), true, "archive keeps the session file");

  await driver.deleteSession(doomed);
  assert.equal(await fileExists(doomedFile), false, "delete unlinks the session file");
  assert.equal(await fileExists(keeperFile), true, "delete leaves other sessions untouched");
  assert.equal(await fileExists(archivedFile), true, "delete leaves archived sessions untouched");

  const listed = (await driver.listSessions(workspaceId)).sessions.map(
    (row) => row.sessionRef.sessionId,
  );
  assert.ok(!listed.includes(doomed.sessionId), "catalog entry removed");
  assert.ok(listed.includes(keeper.sessionId), "keeper still listed");
  assert.ok(listed.includes(archived.sessionId), "archived still listed");
});
