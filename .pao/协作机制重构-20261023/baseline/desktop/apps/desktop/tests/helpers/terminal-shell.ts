/**
 * 终端测试里要键入命令时的跨平台写法。
 *
 * 集成终端默认 shell 取 `process.env.ComSpec`（Windows 上就是 cmd.exe）或
 * `/bin/zsh`、`/bin/bash`，见 `electron/platform/terminal-service.ts` 的
 * `resolveShell()`。cmd.exe 没有 `printf`/`export`/`$PWD` 这些 POSIX 内建，
 * 反过来 sh 上没有 `for %I in (...)`，所以命令按平台生成两套，spec 只调这里。
 *
 * 另一个约束：xterm 会把键入的命令原样回显，如果键入内容里已经包含断言要找的
 * 连续字符串（例如直接 `echo WORKBENCH_READY`），那么即使命令根本没执行、只回显
 * 了一下，断言也会通过。所以两边都把字符串从中间断开：Windows 用 `^`（cmd 解析
 * 时吃掉它），POSIX 用 `printf '前半%sn' '后半'`。
 */

export const isWindowsShell = process.platform === "win32";

function splitInHalf(text: string): readonly [string, string] {
  if (text.length < 2) return [text, ""];
  const middle = Math.floor(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

/** 输出一整行 `text`：`echo WORKBEN^CH_READY` / `printf 'WORKBEN%sn' 'CH_READY'`。 */
export function echoCommand(text: string): string {
  const [head, tail] = splitInHalf(text);
  if (!tail) return `echo ${text}`;
  if (isWindowsShell) return `echo ${head}^${tail}`;
  return `printf '${head}%s\\n' '${tail}'`;
}

/** 输出 `prefix` 加当前目录名：`TASK_CWD=pao-dev`。 */
export function cwdBasenameCommand(prefix: string): string {
  if (isWindowsShell) return `for %I in ("%CD%") do @echo ${prefix}%~nxI`;
  return `printf '${prefix}%s\\n' "\${PWD##*/}"`;
}

/** 输出当前目录：cmd 的 `cd` 会打印路径，sh 用 `pwd`。 */
export function printCwdCommand(): string {
  return isWindowsShell ? "cd" : "pwd";
}

/** 依次执行多条命令；cmd 用 `&` 串联，sh 用 `;`。 */
export function shellCommands(commands: readonly string[]): string {
  return commands.join(isWindowsShell ? " & " : "; ");
}

/** 给当前 shell 会话设置环境变量；cmd 用引号包住 `NAME=value`，否则值会带上行尾空格。 */
export function setEnvCommand(name: string, value: string): string {
  return isWindowsShell ? `set "${name}=${value}"` : `export ${name}=${value}`;
}

/** 输出 `prefix` 加环境变量当前值；键入内容里不含最终拼接结果。 */
export function echoEnvCommand(prefix: string, name: string): string {
  const [head, tail] = splitInHalf(prefix);
  if (isWindowsShell) return tail ? `echo ${head}^${tail}%${name}%` : `echo ${prefix}%${name}%`;
  return `printf '${head}%s%s\\n' '${tail}' "$${name}"`;
}

/** 写进 `node -e` 脚本里的字符串引号：cmd 的外层是双引号，脚本内就得用单引号。 */
export const scriptQuote = isWindowsShell ? "'" : '"';

/** 用 node 跑一段内联脚本；cmd 用双引号包住，sh 用单引号包住。 */
export function nodeEvalCommand(script: string): string {
  return isWindowsShell ? `node -e "${script}"` : `node -e '${script}'`;
}

/** 给终端前台进程发 EOF：sh 是 Ctrl+D，cmd 要先 Ctrl+Z 再回车。 */
export const terminalEofKeys: readonly string[] = isWindowsShell
  ? ["Control+Z", "Enter"]
  : ["Control+D"];
