// 用途：用现有 esbuild 从当前桌面源码生成基准宿主；--check 在临时位置重建并核对受管副本，不覆盖它。
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../desktop/node_modules/esbuild/lib/main.js";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const entryPath = join(scriptDir, "benchmark-host-entry.ts");
const defaultOutputPath = join(scriptDir, "benchmark-worktree-host.mjs");
const managedBundlePath = join(scriptDir, "benchmark-sdk-host", "benchmark-worktree-host.mjs");
const temporaryParent = resolve(
  scriptDir,
  "..",
  "..",
  "..",
  "临时文件夹",
  "PAO集中修复-20261025",
);

export async function buildBenchmarkHost(outputPath, { entry = entryPath } = {}) {
  const result = await build({
    entryPoints: [resolve(entry)],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    metafile: true,
  });
  return {
    inputs: Object.keys(result.metafile.inputs),
    outputs: result.metafile.outputs,
  };
}

export async function checkManagedBundle(
  managedPath = managedBundlePath,
  {
    entry = entryPath,
    tempParent = temporaryParent,
  } = {},
) {
  mkdirSync(tempParent, { recursive: true });
  const temporaryRoot = mkdtempSync(join(tempParent, "pao-benchmark-host-check-"));
  const temporaryOutput = join(temporaryRoot, "benchmark-worktree-host.mjs");
  let failure;
  try {
    const metadata = await buildBenchmarkHost(temporaryOutput, { entry });
    const expected = readFileSync(resolve(managedPath));
    const actual = readFileSync(temporaryOutput);
    if (!actual.equals(expected)) {
      throw new Error(
        `[benchmark-host] 受管 bundle 与当前源码、依赖和构建参数不一致：${resolve(managedPath)}。` +
          "按当前源码重建正式 bundle 后再交付；--check 未改写受管文件。",
      );
    }
    return { ...metadata, managed: resolve(managedPath), bytes: actual.length };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      rmSync(temporaryRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (cleanupError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, cleanupError],
          "基准宿主检查失败，且临时目录清理失败",
          { cause: failure },
        );
      }
      throw new AggregateError(
        [cleanupError],
        "基准宿主检查完成，但临时目录清理失败",
        { cause: cleanupError },
      );
    }
  }
}

async function main() {
  if (process.argv.includes("--check")) {
    const result = await checkManagedBundle();
    console.log(
      JSON.stringify({
        checked: result.managed,
        bytes: result.bytes,
        inputs: result.inputs.length,
      }),
    );
    return;
  }
  const result = await buildBenchmarkHost(defaultOutputPath);
  console.log(JSON.stringify({ inputs: result.inputs, outputs: result.outputs }));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}

export { defaultOutputPath, entryPath, managedBundlePath, scriptDir };
