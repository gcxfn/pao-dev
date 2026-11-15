/**
 * M1-04 真实 MCP 挂载配置(用户级 ~/.pi/agent/mcp.json):codebase-memory-mcp,
 * 本机无密钥服务器,缓存落 D:/cbm-cache。用户级理由:MCP 是跨项目日常能力
 * (代码图按项目分库),pao 会话可能开在任何目标项目,项目级配置无法覆盖;
 * 且该文件不含任何密钥,放用户级无泄露面。文件缺失时跳过(可重挂)。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MCP_JSON = join(homedir(), ".pi", "agent", "mcp.json");
const hasMcpJson = existsSync(MCP_JSON);

describe.skipIf(!hasMcpJson)("用户级 mcp.json 的 codebase-memory 挂载", () => {
	const config = hasMcpJson ? JSON.parse(readFileSync(MCP_JSON, "utf8")) : {};

	it("codebase-memory 以 stdio 挂载,命令指向本机可执行文件", () => {
		const server = config.mcpServers?.["codebase-memory"];
		expect(server).toBeTruthy();
		expect(server.command).toContain("codebase-memory-mcp.exe");
		expect(server.url).toBeUndefined();
	});

	it("缓存目录 env 指向 D:/cbm-cache;无任何密钥字段(不进仓库不入档)", () => {
		const server = config.mcpServers?.["codebase-memory"];
		expect(server.env?.CBM_CACHE_DIR?.replace(/\\/g, "/").toLowerCase()).toBe("d:/cbm-cache");
		const text = JSON.stringify(config).toLowerCase();
		for (const keyword of ["api_key", "apikey", "token", "secret", "password", "bearer"]) {
			expect(text).not.toContain(keyword);
		}
	});

	it("服务器可执行文件与缓存目录真实存在", () => {
		const server = config.mcpServers?.["codebase-memory"];
		expect(existsSync(server.command.replace(/\//g, "\\"))).toBe(true);
		expect(existsSync("D:/cbm-cache")).toBe(true);
	});
});
