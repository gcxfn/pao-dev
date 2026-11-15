import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 按 pid 树杀进程（进程管理通用原语，core 工具与 pao 进程管理共用；自 pao/worker/kill.ts 迁入）。
 *
 * Windows 用 `taskkill /PID <pid> /T /F`:
 * - /T 杀整棵进程树(含 worker 私自再派的孙进程)——Node 的 proc.kill() 只杀直接子进程,不够;
 * - /F 强制终止——pi 子进程未必响应 WM_CLOSE;
 * - 按 pid 定位而非进程名,天然满足「只处理登记在案的进程,不按名字全局清理」。
 * POSIX 无树杀原语:SIGTERM 宽限后 SIGKILL 兜底,孙进程可能残留(见交付说明限制)。
 */

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitPidGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await delay(100);
	}
	return !alive(pid);
}

/** 成员身份＝pid＋创建时刻（毫秒）：跨跳传递种子时按双配对鉴别，防 pid 复用误杀。 */
type ProcessIdentity = { pid: number; created: number };

function parseSurvivors(stdout: string): ProcessIdentity[] {
	// stdout 成员清单格式为 pid:创建时刻毫秒 逗号串；按 pid 去重（种子 pid 与根 pid 相同时 $selected 会把根行收两次，同一成员重复出现）。
	const byPid = new Map<number, number>();
	for (const token of String(stdout ?? "").split(/[\s,]+/)) {
		const [pid, created] = token.split(":");
		const p = Number.parseInt(pid ?? "", 10);
		const c = Number.parseInt(created ?? "", 10);
		if (Number.isInteger(p) && p > 0 && Number.isInteger(c) && c > 0) byPid.set(p, c);
	}
	return Array.from(byPid, ([pid, created]) => ({ pid, created }));
}

/**
 * Snapshot before killing ancestors: MSYS shell descendants may outlive their root.
 * survivorRoots: 上一跳报告的成员（pid＋首跳快照创建时刻）——中游已死时深层孤儿只能以存活成员自身
 * 为附加根走达；二跳按创建时刻双配对鉴别，不匹配＝pid 已被复用＝丢弃该种子。
 */
async function stopWindowsTree(
	pid: number,
	createdBefore: number,
	survivorRoots: ProcessIdentity[],
	timeoutMs: number,
): Promise<void> {
	// One short-lived helper holds the snapshot and checks CreationDate immediately before each kill.
	// Never target by image name, and never accept only the root's disappearance as tree completion.
	const seedSurvivors =
		survivorRoots.length > 0
			? survivorRoots
					.map(
						(s) => `$p=@(${s.pid},${s.created})
$row=$rows | Where-Object { [int]$_.ProcessId -eq $p[0] } | Select-Object -First 1
if ($row -and ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds() -ne [long]$p[1]) { [Console]::Error.WriteLine(('Survivor seed dropped, PID reused: '+$p[0])) } else {
  [void]$ids.Add([int]$p[0])
  if ($row) { $selected.Add($row) }
}
`,
					)
					.join("")
			: "";
	const script = `
$ErrorActionPreference='Stop'
$rows=@(Get-CimInstance Win32_Process | Where-Object ProcessId -ne $PID)
$root=$rows | Where-Object ProcessId -eq ${pid} | Select-Object -First 1
if ($root -and ([DateTimeOffset]$root.CreationDate).ToUnixTimeMilliseconds() -gt ${createdBefore}) { throw 'Root PID identity changed' }
$selected=New-Object 'System.Collections.Generic.List[object]'
$ids=New-Object 'System.Collections.Generic.HashSet[int]'
[void]$ids.Add(${pid})
if ($root) { $selected.Add($root) }
${seedSurvivors}do {
  $added=$false
  foreach ($row in $rows) {
    if ($ids.Contains([int]$row.ParentProcessId) -and -not $ids.Contains([int]$row.ProcessId)) {
      [void]$ids.Add([int]$row.ProcessId); $selected.Add($row); $added=$true
    }
  }
} while ($added)
for ($i=$selected.Count-1; $i -ge 0; $i--) {
  $old=$selected[$i]
  $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$old.ProcessId)
  if (-not $current) { continue }
  if ($current.CreationDate -ne $old.CreationDate) { throw 'Tree member PID identity changed' }
  & "$env:SystemRoot\\System32\\taskkill.exe" /PID $old.ProcessId /T /F | Out-Null
}
# 收尾检查前先写出整份已尝试成员（pid:创建时刻）：收尾瞬间被超时杀时种子已进 stdout，二跳续杀面只增不减
Write-Output (($selected | ForEach-Object { '{0}:{1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }) -join ',')
$remaining=@(Get-CimInstance Win32_Process)
$survivors=@(foreach ($old in $selected) { if ($remaining | Where-Object { $_.ProcessId -eq $old.ProcessId -and $_.CreationDate -eq $old.CreationDate }) { $old.ProcessId } })
if ($survivors.Count -gt 0) { throw ('Tree member still alive: '+($survivors -join ',')) }
`;
	await new Promise<void>((resolve, reject) => {
		execFile(
			join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					// 已尝试成员清单随 stdout 带回：空选不等于树已灭，二跳要拿它们当附加根续杀
					(error as NodeJS.ErrnoException & { survivors?: ProcessIdentity[] }).survivors = parseSurvivors(stdout);
					reject(error);
				} else resolve();
			},
		);
	});
}

/** 树杀指定 pid,返回停止方式描述。进程已退出时静默成功。 */
export async function killTree(pid: number, graceMs = 2000, createdBefore = Date.now()): Promise<string> {
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`不能停止无效进程 pid=${pid}`);
	if (process.platform === "win32") {
		// 严格树杀在高负载下可能单次失败（WMI/进程表枚举慢致 PS 超时、taskkill 瞬时拒绝访问）。
		// 杀序最深层优先：PS 中途被超时杀死时活残余仍在近根侧，重试可从根走达续杀；
		// 深层 taskkill 静默失败时杀循环会推进杀到根，此时首跳随 stdout 报回成员（pid＋创建时刻成对），
		// 二跳双配对后作附加 BFS 根续杀——不匹配＝pid 已被复用＝丢弃种子，防误杀无辜；
		// 收尾检查前预写整份已尝试成员，收尾瞬间被超时杀也留得下续杀种子。
		// 空选不等于树已灭，残余必须续杀或最终报错（宁报错不假报树已灭）。
		// 预算封顶：首跳 60s＋间隔 0.5s＋二跳 30s ≈ 90.5s，重试不放大最坏停止时延。
		let lastError: unknown;
		let survivors: ProcessIdentity[] = [];
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await stopWindowsTree(pid, createdBefore, survivors, attempt === 0 ? 60000 : 30000);
				return `taskkill /PID ${pid} /T /F`;
			} catch (error) {
				lastError = error;
				survivors = (error as { survivors?: ProcessIdentity[] }).survivors ?? [];
				if (attempt === 0) await delay(500);
			}
		}
		throw lastError;
	}
	if (!alive(pid)) return `已退出 pid=${pid}`;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return `SIGTERM(已退出) pid=${pid}`;
	}
	if (await waitPidGone(pid, graceMs)) return `SIGTERM pid=${pid}`;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* 已退出 */
	}
	if (!(await waitPidGone(pid, 5000))) throw new Error(`SIGKILL 后进程仍存在 pid=${pid}`);
	return `SIGTERM→SIGKILL pid=${pid}`;
}
