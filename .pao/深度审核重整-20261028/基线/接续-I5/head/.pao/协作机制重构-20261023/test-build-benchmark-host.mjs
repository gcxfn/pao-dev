// 用途：验证受管 bundle 的无覆盖重建检查；使用临时真实 TS 文件，不改正式 SDK 副本。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import {
  buildBenchmarkHost,
  checkManagedBundle,
  managedBundlePath,
} from "./build-benchmark-host.mjs";

const fs = createRequire(import.meta.url)("node:fs");
const workspaceRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const temporaryParent = path.join(
  workspaceRoot,
  "临时文件夹",
  "PAO集中修复-20261025",
);
mkdirSync(temporaryParent, { recursive: true });
const temporaryRoot = mkdtempSync(
  path.join(temporaryParent, "pao-benchmark-host-test-"),
);

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("fixture: expected a rejected bundle check");
}

try {
  const entry = path.join(temporaryRoot, "entry.ts");
  const managed = path.join(temporaryRoot, "managed-host.mjs");
  writeFileSync(
    entry,
    'export const marker: string = "source-v1";\nconsole.log(marker);\n',
  );
  await buildBenchmarkHost(managed, { entry });
  const before = {
    bytes: readFileSync(managed),
    mtimeMs: statSync(managed).mtimeMs,
  };
  assert.equal((await checkManagedBundle(managed, { entry })).bytes, before.bytes.length);

  writeFileSync(
    entry,
    'export const marker: string = "source-v2";\nconsole.log(marker);\n',
  );
  await assert.rejects(
    () => checkManagedBundle(managed, { entry }),
    /受管 bundle 与当前源码、依赖和构建参数不一致/,
  );
  assert.deepEqual(readFileSync(managed), before.bytes);
  assert.equal(statSync(managed).mtimeMs, before.mtimeMs);

  await buildBenchmarkHost(managed, { entry });
  const rebuilt = digest(managed);
  const verified = await checkManagedBundle(managed, { entry });
  assert.equal(digest(managed), rebuilt);
  assert.equal(verified.bytes, statSync(managed).size);

  const formalBefore = {
    digest: digest(managedBundlePath),
    mtimeMs: statSync(managedBundlePath).mtimeMs,
  };
  try {
    await checkManagedBundle();
  } catch (error) {
    assert.match(
      error.message,
      /受管 bundle 与当前源码、依赖和构建参数不一致/,
    );
  }
  assert.equal(digest(managedBundlePath), formalBefore.digest);
  assert.equal(statSync(managedBundlePath).mtimeMs, formalBefore.mtimeMs);

  const checkParent = path.join(temporaryRoot, "check-parent");
  const cleanupError = new Error("fixture cleanup failure");
  const originalRmSync = fs.rmSync;
  try {
    fs.rmSync = (target, options) => {
      if (
        path.dirname(String(target)) === checkParent &&
        path.basename(String(target)).startsWith("pao-benchmark-host-check-")
      ) {
        throw cleanupError;
      }
      return originalRmSync(target, options);
    };
    syncBuiltinESMExports();
    const cleanupRejection = await captureRejection(
      checkManagedBundle(path.join(temporaryRoot, "missing-managed.mjs"), {
        entry,
        tempParent: checkParent,
      }),
    );
    assert.ok(cleanupRejection instanceof AggregateError);
    assert.equal(cleanupRejection.errors.length, 2);
    assert.equal(cleanupRejection.errors[0].code, "ENOENT");
    assert.strictEqual(cleanupRejection.errors[1], cleanupError);
    assert.strictEqual(cleanupRejection.cause, cleanupRejection.errors[0]);
    assert.match(cleanupRejection.message, /检查失败，且临时目录清理失败/);
    assert.equal(readdirSync(checkParent).length, 1);
  } finally {
    fs.rmSync = originalRmSync;
    syncBuiltinESMExports();
  }

  console.log(
    "benchmark host 定向测试通过：改源未重建被拒、构建/清理双故障均保留、检查不改写正式 bundle",
  );
} finally {
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
