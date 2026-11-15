import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { JsonAgentSessionEvent } from "../src/modes/json-event.ts";
import { RpcClient, type RpcEventListener } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-background-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient background_work 事件", () => {
	test("接收并原样交给类型化监听器", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (buffer.includes("\\n")) {
		const index = buffer.indexOf("\\n");
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		const command = JSON.parse(line);
		process.stdout.write(JSON.stringify({ type: "background_work", running: 1, unread: 0 }) + "\\n");
		process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { commands: [] } }) + "\\n");
	}
});
process.stdin.resume();
`),
		});
		const events: JsonAgentSessionEvent[] = [];
		const listener: RpcEventListener = (event) => events.push(event);
		client.onEvent(listener);
		await client.start();
		await client.getCommands();
		await vi.waitFor(() => {
			expect(events).toContainEqual({ type: "background_work", running: 1, unread: 0 });
		});
		const background = events.find((event) => event.type === "background_work");
		expect(background).toEqual({ type: "background_work", running: 1, unread: 0 });
		if (background?.type === "background_work") {
			expect(background.running).toBe(1);
			expect(background.unread).toBe(0);
		}
		await client.stop();
	});
});
