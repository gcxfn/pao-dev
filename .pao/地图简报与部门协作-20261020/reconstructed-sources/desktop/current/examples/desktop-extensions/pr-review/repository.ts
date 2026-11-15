import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { ReviewTarget } from "./contract";

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40,64}$/;

/**
 * 可选的 `gh` 启动配置（环境变量）。取值只有两种形态：
 * - 不设置：按 PATH 找 `gh`（默认行为与兼容契约，完全不变）。
 * - JSON 字符串数组：`["program", "前置参数", ...]`。`gh` 自己的参数追加在数组之后。
 *   例：`["C:\\Program Files\\nodejs\\node.exe", "--", "C:\\tmp\\fake-gh.cjs"]`。
 *   用数组而不是空白分隔的一行，是因为 Windows 的程序路径普遍带空格
 *   （`C:\Program Files\...`），按空白切分必然切坏。
 * 存在的理由：Windows 上没有任何办法靠「往 PATH 里放个文件」冒充 `gh`——无扩展名脚本被
 * CreateProcess 跳过，`.cmd/.bat` 被 node 的 execFile 拒成 `spawn EINVAL`。测试需要把
 * 「本平台真能启动的进程 + 它的前置参数」直接交给产品，而不是靠 PATH 和扩展名去猜。
 */
export const GH_EXECUTABLE_ENV = "PR_REVIEW_GH_EXECUTABLE";

export interface GhCommand {
  readonly program: string;
  readonly prefix: readonly string[];
}

export function ghCommand(env: NodeJS.ProcessEnv = process.env): GhCommand {
  const raw = env[GH_EXECUTABLE_ENV]?.trim();
  if (!raw) return { program: "gh", prefix: [] };
  if (!raw.startsWith("["))
    throw new Error(
      `${GH_EXECUTABLE_ENV} 须为 JSON 字符串数组，例如 ["node", "--", "fake-gh.cjs"]。`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${GH_EXECUTABLE_ENV} 不是合法 JSON：${String(error).slice(0, 200)}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== "string" || item.length === 0)
  )
    throw new Error(`${GH_EXECUTABLE_ENV} 须为非空的字符串数组。`);
  const [program, ...prefix] = parsed as string[];
  return { program, prefix };
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new Error(`GitHub returned an invalid ${name}.`);
  return value;
}

export function relativeFile(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2048 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/[\0\r\n]/.test(value)
  );
}

export class ReviewRepository {
  constructor(
    readonly cwd: string,
    private readonly signal: AbortSignal,
  ) {}

  private async run(
    program: string,
    args: readonly string[],
    maxBuffer = 1024 * 1024,
    prefix: readonly string[] = [],
  ): Promise<string> {
    this.signal.throwIfAborted();
    try {
      const { stdout } = await execute(program, [...prefix, ...args], {
        cwd: this.cwd,
        signal: this.signal,
        timeout: 20_000,
        maxBuffer,
        encoding: "utf8",
        // Reads must not take the index lock a concurrent git commit needs.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
      return stdout;
    } catch (error) {
      this.signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${program} could not read this PR: ${message.slice(0, 600)}`);
    }
  }

  async current(): Promise<ReviewTarget> {
    const checkout = await realpath(
      (await this.run("git", ["rev-parse", "--show-toplevel"])).trim(),
    );
    const gh = ghCommand();
    const raw: unknown = JSON.parse(
      await this.run(
        gh.program,
        ["pr", "view", "--json", "number,url,title,headRefName,headRefOid,baseRefOid"],
        undefined,
        gh.prefix,
      ),
    );
    if (!raw || typeof raw !== "object") throw new Error("GitHub returned no PR metadata.");
    const info = raw as Record<string, unknown>;
    const url = new URL(text(info.url, "PR URL"));
    if (url.protocol !== "https:" || !/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname))
      throw new Error("GitHub returned an invalid PR URL.");
    const number = info.number;
    if (!Number.isSafeInteger(number) || Number(number) < 1) throw new Error("Invalid PR number.");
    const head = text(info.headRefOid, "head revision");
    const base = text(info.baseRefOid, "base revision");
    if (!SHA.test(head) || !SHA.test(base)) throw new Error("Invalid PR commit identity.");
    const localHead = (await this.run("git", ["rev-parse", "HEAD"])).trim();
    const mergeBase = (await this.run("git", ["merge-base", base, head])).trim();
    if (!SHA.test(mergeBase) || !SHA.test(localHead))
      throw new Error("Invalid local commit identity.");
    const files = (await this.run("git", ["diff", "--name-only", "-z", mergeBase, head, "--"]))
      .split("\0")
      .filter(Boolean);
    if (files.length > 200 || files.some((file) => !relativeFile(file)))
      throw new Error(
        "This example supports at most 200 changed files with ordinary relative paths.",
      );
    const dirty = Boolean(
      await this.run("git", ["status", "--porcelain", "--untracked-files=normal"]),
    );
    return {
      checkout,
      repository: `${url.host}/${url.pathname.split("/").slice(1, 3).join("/")}`,
      number: Number(number),
      url: url.href,
      title: text(info.title, "title"),
      branch: text(info.headRefName, "branch"),
      head,
      base,
      mergeBase,
      localHead,
      dirty,
      files,
    };
  }

  async read(target: ReviewTarget, kind: "diff" | "file", path: string): Promise<string> {
    if (!relativeFile(path)) throw new Error("Use a repository-relative file path.");
    if (kind === "diff") {
      if (!target.files.includes(path)) throw new Error("The file is not changed in this PR.");
      return this.run("git", [
        "--literal-pathspecs",
        "-C",
        target.checkout,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=5",
        target.mergeBase,
        target.head,
        "--",
        path,
      ]);
    }
    return this.run("git", ["-C", target.checkout, "show", `${target.head}:${path}`]);
  }
}
