import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withGithubDownloadRetry } from "./github-download-retry.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const toolsDir = path.join(repoDir, "tools");
const cacheRoot = path.join(repoDir, ".cache");

function createPackagingEnv() {
  // electron-builder wraps pnpm.cmd in a temporary .bat file written as UTF-8 but
  // executed by cmd.exe under the ANSI (GBK) code page: any non-ASCII byte in the
  // resolved pnpm path is corrupted and the collector dies with mojibake
  // "The system cannot find the path specified." The repo itself lives under a
  // non-ASCII directory (桌面端), so the repo-local shim is NOT safe here — prefer
  // the ASCII global npm dir (%APPDATA%\npm) ahead of it (2026-10-05 D6 fix).
  const globalNpmDir = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : undefined;
  const pathPrefix = [
    ...(globalNpmDir && /^[A-Za-z0-9:\\/. _-]+$/.test(globalNpmDir) ? [globalNpmDir] : []),
    toolsDir,
    path.join(repoDir, "node_modules", ".bin"),
  ];
  const envPath = [...pathPrefix, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  const electronBuilderCache =
    process.env.ELECTRON_BUILDER_CACHE ?? path.join(cacheRoot, "electron-builder");
  const localAppData = process.env.LOCALAPPDATA ?? path.join(cacheRoot, "localappdata");
  mkdirSync(electronBuilderCache, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    ...process.env,
    PATH: envPath,
    ELECTRON_BUILDER_CACHE: electronBuilderCache,
    LOCALAPPDATA: localAppData,
    COREPACK_ENABLE_STRICT: "0",
  };
}

function spawnElectronBuilder(electronBuilderArgs) {
  // 不能经 `pnpm exec electron-builder`：pnpm exec 会把仓库 .bin（含中文路径的 pnpm
  // shim）重写到 PATH 最前，electron-builder 的 node-module-collector 便 which 到中文
  // pnpm.CMD，写进临时 bat 后被 cmd 以 GBK 读坏（collector 报「系统找不到指定的路径」）。
  // 直接用 node 跑 cli.js，PATH 全程由 createPackagingEnv 掌控（ASCII npm 目录置顶）。
  const cliEntry = path.join(repoDir, "node_modules", "electron-builder", "cli.js");
  if (!existsSync(cliEntry)) {
    throw new Error(`electron-builder cli 入口不存在：${cliEntry}`);
  }
  const result = spawnSync(process.execPath, [cliEntry, ...electronBuilderArgs], {
    cwd: desktopDir,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    env: createPackagingEnv(),
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
  return {
    ok: result.status === 0 && !result.error,
    status: result.status ?? (result.signal ? 1 : 0),
    output,
    error: result.error,
  };
}

export async function runElectronBuilder(electronBuilderArgs) {
  const result = await withGithubDownloadRetry(() => spawnElectronBuilder(electronBuilderArgs));
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const electronBuilderArgs = process.argv.slice(2);
  if (electronBuilderArgs.length === 0) {
    throw new Error("Usage: run-electron-builder.mjs <electron-builder args...>");
  }
  process.exit(await runElectronBuilder(electronBuilderArgs));
}
