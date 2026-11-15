import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const releaseDir =
  "D:/AI/workspace/pao-dev/desktop/apps/desktop/release/win-unpacked";
const executablePath = join(releaseDir, "PAO.exe");
const cliEntry = join(
  releaseDir,
  "resources",
  "app.asar",
  "node_modules",
  "@pao",
  "coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
const workspace =
  "C:/Users/ASUS/AppData/Local/Temp/pi-gui-workspace-6vrWhT/s4-17-packaged-memory";
const fixtureRoot =
  "C:/Users/ASUS/AppData/Local/Temp/pao-s4-17-packaged-memory-1AFMt5";
const providerPath = join(fixtureRoot, "packaged-memory-offline-provider.ts");
const providerLogPath = join(fixtureRoot, "provider-events.jsonl");
const beforeLength = (await stat(providerLogPath)).size;
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.endsWith("_API_KEY")) delete env[key];
}
for (const key of [
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "NODE_PATH",
  "PI_PACKAGE_DIR",
]) {
  delete env[key];
}
Object.assign(env, {
  HOME: dirname(workspace),
  USERPROFILE: dirname(workspace),
  PI_CODING_AGENT_DIR: join(fixtureRoot, "agent"),
  PAO_CODING_AGENT_DIR: join(fixtureRoot, "agent"),
  PAO_HOME: join(fixtureRoot, "pao-home"),
  PAO_DISABLE_BUILTIN_EXTENSION: "0",
  PI_OFFLINE: "1",
  PI_NO_LOCAL_LLM: "1",
  GBRAIN_TOKEN: "LOCAL_TEST_ZERO_COST",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  PACKAGED_MEMORY_PROVIDER_PHASE: "write",
  PACKAGED_MEMORY_PROVIDER_LOG: providerLogPath,
});

const startedAt = Date.now();
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      executablePath,
      [
        cliEntry,
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "-e",
        providerPath,
        "-e",
        "builtin:pao",
        "--provider",
        "packaged-memory-s4-17-offline",
        "--model",
        "offline-scripted",
        "--session-dir",
        join(fixtureRoot, "sessions"),
        "-p",
        "S4-17_WRITE_MEMORY",
      ],
      {
        cwd: workspace,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error("probe timed out"), { stdout, stderr }));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(Object.assign(new Error(`exit=${String(code)} signal=${String(signal)}`), {
          code,
          signal,
          stdout,
          stderr,
        }));
      }
    });
  });
  const afterLength = (await stat(providerLogPath)).size;
  console.log(
    JSON.stringify({
      status: "ok",
      elapsedMs: Date.now() - startedAt,
      providerLogDeltaBytes: afterLength - beforeLength,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  );
} catch (error) {
  const afterLength = (await stat(providerLogPath)).size;
  console.log(
    JSON.stringify({
      status: "error",
      elapsedMs: Date.now() - startedAt,
      providerLogDeltaBytes: afterLength - beforeLength,
      error: {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        code: error?.code,
        signal: error?.signal,
        killed: error?.killed,
      },
      stdout: error?.stdout,
      stderr: error?.stderr,
    }),
  );
  process.exitCode = 2;
}
console.log(
  JSON.stringify({
    providerTail: (await readFile(providerLogPath, "utf8")).slice(-4_000),
  }),
);
