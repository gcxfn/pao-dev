import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createWriteToolDefinition, type WriteOperations } from "../src/core/tools/write.ts";
import { createTestExtensionToolContext } from "./extension-tool-context.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "pao-windows-script-"));
	roots.push(root);
	return root;
}

async function write(path: string, content: string, root: string): Promise<void> {
	await createWriteToolDefinition(root).execute(
		"write-test",
		{ path, content },
		undefined,
		undefined,
		await createTestExtensionToolContext(root),
	);
}

async function edit(path: string, root: string): Promise<string> {
	await createEditToolDefinition(root).execute(
		"edit-test",
		{
			path,
			edits: [{ oldText: "Write-Output '旧'", newText: "Write-Output '新'" }],
		},
		undefined,
		undefined,
		await createTestExtensionToolContext(root),
	);
	return readFileSync(join(root, path), "utf8");
}

describe("Windows PowerShell 脚本编码", () => {
	it.skipIf(process.platform !== "win32").each(["脚本.ps1", "脚本.PS1", "脚本.Ps1"])(
		"本地 write 给 %s 写入单个 UTF-8 BOM",
		async (name) => {
			const root = workspace();
			await write(name, "Write-Output '旧'\r\n", root);
			const bytes = readFileSync(join(root, name));
			expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
			expect(bytes.toString("utf8")).toBe("\uFEFFWrite-Output '旧'\r\n");
		},
	);

	it.skipIf(process.platform !== "win32")("内容已有 BOM 时 write 不叠加，edit 改写后仍只有一个 BOM", async () => {
		const root = workspace();
		const name = "已有BOM.ps1";
		await write(name, "\uFEFFWrite-Output '旧'\r\n", root);
		expect(readFileSync(join(root, name), "utf8")).toBe("\uFEFFWrite-Output '旧'\r\n");
		expect(await edit(name, root)).toBe("\uFEFFWrite-Output '新'\r\n");
		expect(readFileSync(join(root, name)).subarray(0, 6).toString("hex")).toBe("efbbbf577269");
	});

	it("普通文件保持无 BOM，已有自定义 WriteOperations 原样接收内容", async () => {
		const root = workspace();
		await write("普通.txt", "纯文本\r\n", root);
		expect(readFileSync(join(root, "普通.txt")).subarray(0, 3).toString("hex")).not.toBe("efbbbf");
		if (process.platform !== "win32") {
			await write("非Windows.ps1", "Write-Output '原样'\r\n", root);
			expect(readFileSync(join(root, "非Windows.ps1")).subarray(0, 3).toString("hex")).not.toBe("efbbbf");
		}

		const calls: { path: string; content: string }[] = [];
		const operations: WriteOperations = {
			mkdir: async () => {},
			writeFile: async (path, content) => {
				calls.push({ path, content });
			},
		};
		await createWriteToolDefinition(root, { operations }).execute(
			"custom-write",
			{ path: "远端.ps1", content: "Write-Output '原样'" },
			undefined,
			undefined,
			await createTestExtensionToolContext(root),
		);
		expect(calls).toEqual([{ path: join(root, "远端.ps1"), content: "Write-Output '原样'" }]);
	});

	it.skipIf(process.platform !== "win32")("Windows PowerShell 5.1 实际执行中文路径脚本", async () => {
		const root = workspace();
		const folder = join(root, "中文目录");
		mkdirSync(folder);
		await write(
			"中文目录\\中文脚本.ps1",
			"$结果 = '中文解析成功'\r\n" +
				"$输出 = Join-Path $PSScriptRoot '执行结果.txt'\r\n" +
				"[IO.File]::WriteAllText($输出, $结果, (New-Object System.Text.UTF8Encoding($false)))\r\n",
			root,
		);

		const powershell = join(
			process.env.SystemRoot ?? "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		);
		expect(existsSync(powershell), `Windows PowerShell 5.1 不存在：${powershell}`).toBe(true);
		const result = spawnSync(
			powershell,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(folder, "中文脚本.ps1"),
			],
			{ encoding: "utf8", windowsHide: true, timeout: 15000 },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(join(folder, "执行结果.txt"), "utf8")).toBe("中文解析成功");
	});
});
