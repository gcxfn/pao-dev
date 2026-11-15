import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";
import type { ComposerAttachment } from "../../contracts/desktop-state";

/** 索引版本：v1＝图片 data 内嵌 JSON；v2＝图片字节落 blobs/<会话摘要>/<附件id>.bin，索引只存引用。 */
const INDEX_VERSION = 2;

/** read() 的结果：附件列表＋因 blob 缺失被隔离跳过的附件数（其余附件完整返回）。 */
export interface ReadAttachmentsResult {
  readonly attachments: ComposerAttachment[] | undefined;
  readonly skipped: number;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * 每会话附件索引 + 图片 blob 文件。v2 起 JSON 索引不再内嵌 base64：
 * 追加/删除附件只重写小索引，图片字节写一次不再被后续保存反复重写
 * （v1 的全量重写让 state 随附件数平方级放大 IO）。v1 文件保持可读，下次写入时迁移。
 */
export class AttachmentStore {
  private readonly rootDir: string;

  constructor(userDataDir: string) {
    this.rootDir = join(userDataDir, "attachments");
  }

  async read(sessionKey: string): Promise<ReadAttachmentsResult> {
    let result = await readJsonWithBackup(this.filePath(sessionKey));
    if (result.value === undefined && !result.corrupted) {
      const legacy = this.legacyPath(sessionKey);
      if (legacy) result = await readJsonWithBackup(legacy);
      if (result.value !== undefined) {
        return { attachments: decodeAttachments(result.value), skipped: 0 };
      }
    }
    if (result.corrupted && !result.recovered) {
      throw new Error(
        `Invalid saved attachments at ${this.filePath(sessionKey)}; original data was retained.`,
      );
    }
    if (result.corrupted) {
      console.error(
        `[attachment-store] corrupt entry for "${sessionKey}" in ${this.rootDir}` +
          (result.recovered ? " — recovered from backup" : " — no usable backup"),
      );
    }
    if (result.value === undefined) {
      return { attachments: undefined, skipped: 0 };
    }
    const { version, attachments } = decodeStoredAttachments(result.value, sessionKey);
    if (version !== INDEX_VERSION) {
      return { attachments: decodeAttachments(attachments), skipped: 0 };
    }
    const hydrated = await this.hydrateBlobAttachments(sessionKey, attachments);
    return { attachments: hydrated.attachments, skipped: hydrated.skipped };
  }

  async write(sessionKey: string, data: readonly ComposerAttachment[]): Promise<void> {
    decodeAttachments(data);
    // Validate any old-format data before creating the new identity; retain the old file.
    await this.validateStoredData(sessionKey);
    // 先写 blob 再写索引：中途崩溃只会留下孤儿 blob（无害，随会话清理），
    // 不会留下引用了缺失 blob 的索引（那种状态 read 会失败关闭）。
    await this.writeBlobs(sessionKey, data);
    await writeFileAtomicQueued(
      this.filePath(sessionKey),
      `${JSON.stringify({ version: INDEX_VERSION, sessionKey, attachments: toStoredAttachments(data) }, null, 2)}\n`,
      (value) => decodeStoredAttachments(value, sessionKey),
    );
    // 索引落盘成功后再回收孤儿 blob：附件被移除/清空后旧 .bin 不再永久占盘。
    await this.pruneOrphanBlobs(sessionKey, data);
  }

  async listKeys(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }

    const keys: string[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) {
        continue;
      }
      if (/^sha256-[a-f0-9]{64}\.json$/.test(name)) {
        const result = await readJsonWithBackup(join(this.rootDir, name));
        const stored = decodeStoredAttachments(result.value);
        if (this.filePath(stored.sessionKey) !== join(this.rootDir, name)) {
          throw new Error(`Attachment identity does not match filename: ${name}`);
        }
        keys.push(stored.sessionKey);
        continue;
      }
      try {
        keys.push(decodeURIComponent(name.slice(0, -".json".length)));
      } catch (error) {
        // A single malformed filename must not abort the whole listing; that
        // would silently disable attachment pruning for every key.
        console.error(
          `[attachment-store] skipping malformed filename "${name}" in ${this.rootDir}`,
          error,
        );
      }
    }
    return [...new Set(keys)];
  }

  async remove(sessionKey: string): Promise<void> {
    const legacy = this.legacyPath(sessionKey);
    if (legacy) {
      const old = await readJsonWithBackup(legacy);
      if (old.corrupted) throw new Error(`Cannot prune corrupt saved attachments at ${legacy}`);
      if (old.value !== undefined) decodeAttachments(old.value);
    }
    // Never prune an entry whose contents we cannot understand.
    if ((await readJsonWithBackup(this.filePath(sessionKey))).corrupted) {
      throw new Error(
        `Cannot prune corrupt saved attachments at ${this.filePath(sessionKey)}; original data was retained.`,
      );
    }
    await this.validateStoredData(sessionKey);
    await this.unlinkIfPresent(this.filePath(sessionKey));
    await this.unlinkIfPresent(`${this.filePath(sessionKey)}.bak`);
    await rm(this.blobDir(sessionKey), { recursive: true, force: true });
    if (legacy) {
      await this.unlinkIfPresent(`${legacy}.bak`);
      await this.unlinkIfPresent(legacy);
    }
  }

  /**
   * 写前/删前校验既有数据可解析（shape 级，不读 blob 文件——那是 read 的 hydrate 职责，
   * 每次保存都全量 hydrate 一遍旧附件正是要避免的 IO）。损坏则保留旧文件不动。
   */
  private async validateStoredData(sessionKey: string): Promise<void> {
    let result = await readJsonWithBackup(this.filePath(sessionKey));
    if (result.value === undefined && !result.corrupted) {
      const legacy = this.legacyPath(sessionKey);
      if (legacy) {
        const legacyResult = await readJsonWithBackup(legacy);
        if (legacyResult.value !== undefined) {
          // 旧格式是裸数组，直接按完整附件校验。
          decodeAttachments(legacyResult.value);
          return;
        }
        result = legacyResult;
      }
    }
    if (result.corrupted && !result.recovered) {
      throw new Error(
        `Invalid saved attachments at ${this.filePath(sessionKey)}; original data was retained.`,
      );
    }
    if (result.value === undefined) {
      return;
    }
    const { version, attachments } = decodeStoredAttachments(result.value, sessionKey);
    if (version !== INDEX_VERSION) {
      decodeAttachments(attachments);
      return;
    }
    // v2 索引：blob 条目只验元数据；inline/file 条目按完整附件校验（含未知字段拒绝）。
    for (const entry of decodeStoredShape(attachments)) {
      if (entry.kind !== "blob") {
        decodeAttachments([entry.value]);
      }
    }
  }

  /** 索引写成功后删除该会话 blob 目录中未被新数据引用的 .bin；失败只记日志，不阻塞主写路径。 */
  private async pruneOrphanBlobs(
    sessionKey: string,
    data: readonly ComposerAttachment[],
  ): Promise<void> {
    const dir = this.blobDir(sessionKey);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.error(`[attachment-store] blob gc skipped for "${sessionKey}"`, error);
      }
      return;
    }
    const referenced = new Set(
      data
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => `${attachment.id}.bin`),
    );
    for (const name of entries) {
      if (!name.endsWith(".bin") || referenced.has(name)) {
        continue;
      }
      try {
        await unlink(join(dir, name));
      } catch (error) {
        if (!isMissingFileError(error)) {
          console.error(`[attachment-store] failed to prune orphan blob ${name}`, error);
        }
      }
    }
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }

  private filePath(sessionKey: string): string {
    return join(this.rootDir, `sha256-${this.keyDigest(sessionKey)}.json`);
  }

  private blobDir(sessionKey: string): string {
    return join(this.rootDir, "blobs", `sha256-${this.keyDigest(sessionKey)}`);
  }

  private keyDigest(sessionKey: string): string {
    return createHash("sha256").update(sessionKey).digest("hex");
  }

  /** 附件 id（uuid）直接作 blob 文件名：先验形再落盘，杜绝路径拼接注入。 */
  private blobPath(sessionKey: string, attachmentId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(attachmentId)) {
      throw new Error(`Invalid attachment id for blob storage: ${attachmentId.slice(0, 60)}`);
    }
    return join(this.blobDir(sessionKey), `${attachmentId}.bin`);
  }

  private async writeBlobs(sessionKey: string, data: readonly ComposerAttachment[]): Promise<void> {
    for (const attachment of data) {
      if (attachment.kind !== "image") continue;
      const blobPath = this.blobPath(sessionKey, attachment.id);
      try {
        // 存在性判断用 stat：不需要 blob 内容，别为跳过重写而整读一遍图片字节。
        await stat(blobPath);
        continue; // 已存在（uuid 不可变）：写一次，后续保存不重写。
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      await mkdir(join(this.rootDir, "blobs"), { recursive: true });
      await mkdir(this.blobDir(sessionKey), { recursive: true });
      // 临时文件 + rename：崩溃不留半个 blob（半个 blob 会被 read 静默当作完整数据）。
      const tmpPath = `${blobPath}.${process.pid}.tmp`;
      await writeFile(tmpPath, attachment.data, "utf8");
      try {
        await rename(tmpPath, blobPath);
      } catch (error) {
        await this.unlinkIfPresent(tmpPath);
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "EEXIST" || error.code === "EPERM")
        ))
          throw error;
        // Windows 上并发写同名 blob 的 replace 竞态：对方已写成，本方放弃即可。
      }
    }
  }

  private async hydrateBlobAttachments(
    sessionKey: string,
    stored: readonly unknown[],
  ): Promise<{ readonly attachments: ComposerAttachment[]; readonly skipped: number }> {
    const hydrated: ComposerAttachment[] = [];
    let skipped = 0;
    for (const entry of decodeStoredShape(stored)) {
      if (entry.kind === "blob") {
        let data: string;
        try {
          data = await readFile(this.blobPath(sessionKey, entry.id), "utf8");
        } catch (error) {
          if (isMissingFileError(error)) {
            // 个别 blob 被外部因素（杀毒/云同步/清盘）删走时只隔离该附件并计数，
            // 不让它拖垮整个会话乃至全局持久化；索引 JSON 本身损坏仍走上方硬失败。
            skipped += 1;
            continue;
          }
          throw error;
        }
        hydrated.push({
          id: entry.id,
          kind: "image",
          name: entry.name,
          mimeType: entry.mimeType,
          data,
        });
        continue;
      }
      hydrated.push(...decodeAttachments([entry.value]));
    }
    if (skipped > 0) {
      console.error(
        `[attachment-store] quarantined ${skipped} attachment(s) with missing blobs` +
          ` for "${sessionKey}" in ${this.rootDir}`,
      );
    }
    return { attachments: hydrated, skipped };
  }

  private legacyPath(sessionKey: string): string | undefined {
    const name = `${encodeURIComponent(sessionKey)}.json`;
    // Longer components could never have been created by the old Windows store.
    return name.length <= 251 ? join(this.rootDir, name) : undefined;
  }
}

/** 索引里的图片条目：v1 内联 data / v2 blob 引用（文件附件两版同形）。 */
type StoredEntry =
  | { readonly kind: "inline" | "file"; readonly value: Record<string, unknown> }
  | {
      readonly kind: "blob";
      readonly id: string;
      readonly name: string;
      readonly mimeType: string;
    };

function decodeStoredShape(value: unknown): StoredEntry[] {
  if (!Array.isArray(value))
    throw new Error("Invalid saved attachments: expected an array; original data was retained.");
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`Invalid saved attachment at index ${index}.`);
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.mimeType !== "string"
    )
      throw new Error(`Invalid saved attachment metadata at index ${index}.`);
    if (item.kind === "file") return { kind: "file" as const, value: item };
    if ((item.kind === "image" || item.kind === undefined) && typeof item.data === "string")
      return { kind: "inline" as const, value: item };
    if (item.kind === "image" && typeof item.blob === "string")
      return { kind: "blob" as const, id: item.id, name: item.name, mimeType: item.mimeType };
    throw new Error(
      `Invalid saved attachment payload at index ${index}; original data was retained.`,
    );
  });
}

function decodeStoredAttachments(
  value: unknown,
  expectedKey?: string,
): {
  version: number;
  sessionKey: string;
  attachments: readonly unknown[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid saved attachment envelope; original data was retained.");
  }
  const item = value as Record<string, unknown>;
  if (
    (item.version !== 1 && item.version !== INDEX_VERSION) ||
    typeof item.sessionKey !== "string" ||
    !Array.isArray(item.attachments) ||
    (expectedKey !== undefined && item.sessionKey !== expectedKey) ||
    Object.keys(item).some((key) => !["version", "sessionKey", "attachments"].includes(key))
  ) {
    throw new Error("Invalid saved attachment identity; original data was retained.");
  }
  decodeStoredShape(item.attachments);
  return { version: item.version, sessionKey: item.sessionKey, attachments: item.attachments };
}

/** ComposerAttachment → 索引存储形（图片转 blob 引用）。调用方负责先写 blob 文件。 */
function toStoredAttachments(data: readonly ComposerAttachment[]): unknown[] {
  return data.map((attachment) => {
    if (attachment.kind !== "image") return attachment;
    return {
      id: attachment.id,
      kind: "image",
      name: attachment.name,
      mimeType: attachment.mimeType,
      blob: `${attachment.id}.bin`,
    };
  });
}

export function decodeAttachments(value: unknown): ComposerAttachment[] {
  if (!Array.isArray(value))
    throw new Error("Invalid saved attachments: expected an array; original data was retained.");
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`Invalid saved attachment at index ${index}.`);
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.mimeType !== "string"
    ) {
      throw new Error(`Invalid saved attachment metadata at index ${index}.`);
    }
    const allowedKeys =
      item.kind === "file"
        ? ["id", "kind", "name", "mimeType", "fsPath", "sizeBytes"]
        : ["id", "kind", "name", "mimeType", "data"];
    if (Object.keys(item).some((key) => !allowedKeys.includes(key)))
      throw new Error(
        `Invalid saved attachment at index ${index}: unsupported field; original data was retained.`,
      );
    const base = { id: item.id, name: item.name, mimeType: item.mimeType };
    if ((item.kind === "image" || item.kind === undefined) && typeof item.data === "string")
      return { ...base, kind: "image", data: item.data };
    if (
      item.kind === "file" &&
      typeof item.fsPath === "string" &&
      (item.sizeBytes === undefined ||
        (typeof item.sizeBytes === "number" &&
          Number.isFinite(item.sizeBytes) &&
          item.sizeBytes >= 0))
    )
      return {
        ...base,
        kind: "file",
        fsPath: item.fsPath,
        ...(typeof item.sizeBytes === "number" ? { sizeBytes: item.sizeBytes } : {}),
      };
    throw new Error(
      `Invalid saved attachment payload at index ${index}; original data was retained.`,
    );
  });
}
