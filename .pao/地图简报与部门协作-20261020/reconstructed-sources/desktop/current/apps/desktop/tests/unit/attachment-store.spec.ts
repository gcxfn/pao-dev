import { mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { AttachmentStore } from "../../electron/persistence/attachment-store";
import { writeFileAtomicQueued } from "../../electron/persistence/atomic-file-write";

test("Chinese workspace keys survive write, restart and isolated removal", async () => {
  const parent = test.info().outputPath("profiles");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "attachments-"));
  const key = `D:\\项目\\${"中文目录".repeat(24)}:session-one`;
  const other = key.replace("session-one", "session-two");
  const store = new AttachmentStore(root);
  await store.write(key, []);
  await store.write(other, []);
  const reopened = new AttachmentStore(root);
  expect((await reopened.read(key)).attachments).toEqual([]);
  expect(new Set(await reopened.listKeys())).toEqual(new Set([key, other]));
  await reopened.remove(key);
  expect((await reopened.read(key)).attachments).toBeUndefined();
  expect((await reopened.read(other)).attachments).toEqual([]);
  expect((await readdir(join(root, "attachments"))).every((name) => name.length < 120)).toBe(true);
});

test("legacy attachments stay readable and retained after a new write", async () => {
  const root = test.info().outputPath("profile");
  await mkdir(join(root, "attachments"), { recursive: true });
  const key = "workspace:old-session";
  const old = join(root, "attachments", `${encodeURIComponent(key)}.json`);
  await writeFile(old, "[]\n");
  const store = new AttachmentStore(root);
  expect((await store.read(key)).attachments).toEqual([]);
  await store.write(key, []);
  expect(await readFile(old, "utf8")).toBe("[]\n");
  expect(await store.listKeys()).toEqual([key]);
});

test("reproduces the old filename overflow on Windows", async () => {
  test.skip(process.platform !== "win32", "Windows filename regression");
  const root = test.info().outputPath("old-store");
  await mkdir(root, { recursive: true });
  const name = "x".repeat(230) + ".json";
  await expect(writeFileAtomicQueued(join(root, name), "[]", (value) => value)).rejects.toThrow();
});

test("corrupt legacy attachments cannot be silently migrated or deleted", async () => {
  const root = test.info().outputPath("legacy-corrupt");
  await mkdir(join(root, "attachments"), { recursive: true });
  const old = join(root, "attachments", "session.json");
  await writeFile(old, "[null]");
  const store = new AttachmentStore(root);
  await expect(store.read("session")).rejects.toThrow(/Invalid saved attachment/);
  await expect(store.write("session", [])).rejects.toThrow(/Invalid saved attachment/);
  await expect(store.remove("session")).rejects.toThrow(/Invalid saved attachment/);
  expect(await readFile(old, "utf8")).toBe("[null]");
  expect(await readdir(join(root, "attachments"))).toEqual(["session.json"]);
});

test("v2 index stores image bytes in per-session blobs, not inline base64", async () => {
  const root = test.info().outputPath("blob-store");
  const store = new AttachmentStore(root);
  const key = "workspace:blob-session";
  const dataUrl = `data:image/png;base64,${"A".repeat(48 * 1024)}`;
  const images = [1, 2, 3].map((index) => ({
    id: `img-${index}-${"0".repeat(4)}`,
    kind: "image" as const,
    name: `shot-${index}.png`,
    mimeType: "image/png",
    data: dataUrl,
  }));

  await store.write(key, images);

  // 索引文件不含图片数据：大小远小于三张 48KB 图的 base64。
  const indexFile = join(
    root,
    "attachments",
    `sha256-${createHash("sha256").update(key).digest("hex")}.json`,
  );
  const indexRaw = await readFile(indexFile, "utf8");
  expect(indexRaw).not.toContain("base64");
  expect(indexRaw.length).toBeLessThan(2048);

  // 附件字节落在该会话独立的 blob 目录；读回与写入逐字段一致。
  const blobDir = join(
    root,
    "attachments",
    "blobs",
    `sha256-${createHash("sha256").update(key).digest("hex")}`,
  );
  const blobNames = (await readdir(blobDir)).sort();
  expect(blobNames).toEqual(images.map((image) => `${image.id}.bin`).sort());
  expect((await store.read(key)).attachments).toEqual(images);
});

test("adding an attachment never rewrites existing blobs", async () => {
  const root = test.info().outputPath("blob-append");
  const store = new AttachmentStore(root);
  const key = "workspace:append-session";
  const first = {
    id: "first-image",
    kind: "image" as const,
    name: "one.png",
    mimeType: "image/png",
    data: `data:image/png;base64,${"B".repeat(64 * 1024)}`,
  };
  await store.write(key, [first]);
  const blobDir = join(
    root,
    "attachments",
    "blobs",
    `sha256-${createHash("sha256").update(key).digest("hex")}`,
  );
  const firstBlob = join(blobDir, "first-image.bin");
  const before = await stat(firstBlob);

  await new Promise((resolve) => setTimeout(resolve, 12));
  await store.write(key, [
    first,
    {
      id: "second-image",
      kind: "image" as const,
      name: "two.png",
      mimeType: "image/png",
      data: `data:image/png;base64,${"C".repeat(32 * 1024)}`,
    },
  ]);

  const after = await stat(firstBlob);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect((await readdir(blobDir)).sort()).toEqual(["first-image.bin", "second-image.bin"]);
});

test("legacy inline v1 entries stay readable and migrate on the next write", async () => {
  const root = test.info().outputPath("legacy-inline");
  await mkdir(join(root, "attachments"), { recursive: true });
  const key = "workspace:inline-session";
  const indexFile = join(
    root,
    "attachments",
    `sha256-${createHash("sha256").update(key).digest("hex")}.json`,
  );
  const inline = {
    id: "legacy-image",
    kind: "image",
    name: "old.png",
    mimeType: "image/png",
    data: "data:image/png;base64,TU5P",
  };
  await writeFile(
    indexFile,
    `${JSON.stringify({ version: 1, sessionKey: key, attachments: [inline] }, null, 2)}\n`,
  );

  const store = new AttachmentStore(root);
  expect((await store.read(key)).attachments).toEqual([inline]);

  await store.write(key, [inline]);
  const migrated = await readFile(indexFile, "utf8");
  expect((JSON.parse(migrated) as { version: number }).version).toBe(2);
  expect(migrated).not.toContain("base64");
  expect((await store.read(key)).attachments).toEqual([inline]);
});

test("remove prunes the session index and its blob dir but leaves other sessions intact", async () => {
  const root = test.info().outputPath("blob-remove");
  const store = new AttachmentStore(root);
  const one = "workspace:session-one";
  const two = "workspace:session-two";
  const image = (id: string) => ({
    id,
    kind: "image" as const,
    name: `${id}.png`,
    mimeType: "image/png",
    data: "data:image/png;base64,RElG",
  });
  await store.write(one, [image("one-image")]);
  await store.write(two, [image("two-image")]);

  await store.remove(one);
  expect((await store.read(one)).attachments).toBeUndefined();
  expect((await store.read(two)).attachments?.map((entry) => entry.id)).toEqual(["two-image"]);
  const blobsRoot = join(root, "attachments", "blobs");
  expect(await readdir(blobsRoot)).toEqual([
    `sha256-${createHash("sha256").update(two).digest("hex")}`,
  ]);
});

// 审查修复轮 R1：个别 blob 丢失（杀毒/云同步/清盘）只隔离该附件并计数，
// 不再整库抛错封锁持久化；索引 JSON 本身损坏仍是硬失败。
test("a missing blob quarantines only that attachment instead of failing the whole store", async () => {
  const root = test.info().outputPath("blob-missing");
  const store = new AttachmentStore(root);
  const key = "workspace:missing-blob";
  const image = (id: string) => ({
    id,
    kind: "image" as const,
    name: `${id}.png`,
    mimeType: "image/png",
    data: `data:image/png;base64,${id.repeat(8)}`,
  });
  await store.write(key, [image("gone-image"), image("kept-image")]);
  const blobDir = join(
    root,
    "attachments",
    "blobs",
    `sha256-${createHash("sha256").update(key).digest("hex")}`,
  );
  await unlink(join(blobDir, "gone-image.bin"));

  const result = await store.read(key);
  expect(result.skipped).toBe(1);
  expect(result.attachments?.map((entry) => entry.id)).toEqual(["kept-image"]);
  // 后续写路径不被缺失的旧 blob 卡死（隔离后的索引可正常重写）。
  await store.write(key, [image("kept-image")]);
  expect((await store.read(key)).attachments?.map((entry) => entry.id)).toEqual(["kept-image"]);
});

test("a corrupt v2 index still fails closed", async () => {
  const root = test.info().outputPath("index-corrupt");
  await mkdir(join(root, "attachments"), { recursive: true });
  const key = "workspace:corrupt-index";
  const indexFile = join(
    root,
    "attachments",
    `sha256-${createHash("sha256").update(key).digest("hex")}.json`,
  );
  await writeFile(indexFile, "{damaged");

  const store = new AttachmentStore(root);
  await expect(store.read(key)).rejects.toThrow(/Invalid saved attachments/);
});

// 审查修复轮 R3：blobPath 的 id 验形是挡「攻陷渲染层借附件 id 做路径拼接」的唯一边界，
// 各种路径穿越形状必须在落盘前被拒。
const pathTraversalIds = ["../x", "a/b", "..", "C:\\x", "", "中文id"];
pathTraversalIds.forEach((id, index) => {
  test(`attachment id ${JSON.stringify(id)} is rejected before any blob write`, async () => {
    const root = test.info().outputPath(`blob-id-shape-${index}`);
    const store = new AttachmentStore(root);
    const image = {
      id,
      kind: "image" as const,
      name: "evil.png",
      mimeType: "image/png",
      data: "data:image/png;base64,RElG",
    };
    await expect(store.write("workspace:evil", [image])).rejects.toThrow(/Invalid attachment id/);
    // 验形在首个 blob 落盘前拦截：连 attachments 目录都不应被创建。
    await expect(stat(join(root, "attachments"))).rejects.toThrow(/ENOENT/);
  });
});

// 审查修复轮 R4：附件被移除/清空后，索引写成功即回收未被引用的 .bin。
test("writing fewer attachments prunes unreferenced blobs", async () => {
  const root = test.info().outputPath("blob-gc");
  const store = new AttachmentStore(root);
  const key = "workspace:gc-session";
  const image = (id: string) => ({
    id,
    kind: "image" as const,
    name: `${id}.png`,
    mimeType: "image/png",
    data: `data:image/png;base64,${id.repeat(8)}`,
  });
  await store.write(key, [image("keep-image"), image("drop-image")]);
  const blobDir = join(
    root,
    "attachments",
    "blobs",
    `sha256-${createHash("sha256").update(key).digest("hex")}`,
  );
  expect((await readdir(blobDir)).sort()).toEqual(["drop-image.bin", "keep-image.bin"]);

  await store.write(key, [image("keep-image")]);

  expect(await readdir(blobDir)).toEqual(["keep-image.bin"]);
  // 清空持久化列表（附件发出后 composer 清空）同样清光 blob。
  await store.write(key, []);
  expect(await readdir(blobDir)).toEqual([]);
});
