import { type JsonRpcMessage, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import {
	McpOAuthCredentialStore,
	McpServerConnection,
	type McpTransportFactory,
} from "../src/extensions/mcp/runtime.ts";

function createConnection(createTransport: McpTransportFactory): McpServerConnection {
	return new McpServerConnection({
		entry: { name: "failure", config: { command: "unused" }, source: "test" },
		cwd: process.cwd(),
		createTransport,
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		onTools: () => {},
	});
}

/**
 * 内存 transport 配对加真实 McpClient 协议，不启动 MCP 子进程。
 * tools/list 可由调用方暂停，用来观察连接装配尚未完成时的并发状态。
 */
function createMemoryTransport(options: { listToolsGate?: Promise<void> } = {}) {
	const pair = createInMemoryTransportPair();
	const methods: string[] = [];
	let listToolsStarted!: () => void;
	const listTools = new Promise<void>((resolve) => {
		listToolsStarted = resolve;
	});

	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		methods.push(message.method);
		void (async () => {
			if (message.method === "tools/list") {
				listToolsStarted();
				await options.listToolsGate;
			}
			const result =
				message.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "memory", version: "1.0.0" },
						}
					: message.method === "tools/list"
						? { tools: [] }
						: { content: [{ type: "text", text: "ok" }] };
			await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
		})();
	});
	void pair.server.start();
	return { transport: pair.client, server: pair.server, methods, listTools };
}

describe("MCP connection shutdown failures", () => {
	it("启动和关闭双重失败时保留两条原错误身份与服务身份", async () => {
		const initializeError = new Error("initialize rejected");
		const closeError = new Error("transport close rejected");
		const { transport } = createMemoryTransport();
		const send = transport.send.bind(transport);
		transport.send = async (message: JsonRpcMessage) => {
			if ("method" in message && message.method === "initialize") throw initializeError;
			await send(message);
		};
		const close = transport.close.bind(transport);
		const closeReceivers: unknown[] = [];
		let allowClose = false;
		const closeSpy = vi.spyOn(transport, "close").mockImplementation(async function (this: typeof transport) {
			closeReceivers.push(this);
			if (!allowClose) throw closeError;
			await close();
		});
		let opened = 0;
		const created: unknown[] = [];
		const connection = createConnection(() => {
			opened++;
			created.push(transport);
			return transport;
		});

		const failure = await connection.getClient().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain('MCP server "failure"');
		const startupCause = (failure as Error).cause;
		expect(startupCause).toBeInstanceOf(AggregateError);
		const [initializeFailure, cleanupFailure] = (startupCause as AggregateError).errors;
		expect(initializeFailure).toBe(initializeError);
		expect(cleanupFailure).toBe(closeError);
		expect(connection.entry.name).toBe("failure");
		expect(opened).toBe(1);
		expect(closeSpy).toHaveBeenCalledTimes(2);

		await expect(connection.getClient()).rejects.toThrow('MCP server "failure" still has a connection');
		expect(opened).toBe(1);
		expect(closeSpy).toHaveBeenCalledTimes(2);

		allowClose = true;
		await expect(connection.close()).resolves.toBeUndefined();
		// client 再次尝试同一个 transport，适配器随后也直接完成同一对象的关闭。
		expect(closeSpy).toHaveBeenCalledTimes(4);
		expect(opened).toBe(1);
		expect(created).toHaveLength(1);
		expect(created[0]).toBe(transport);
		expect(closeReceivers).toHaveLength(4);
		for (const receiver of closeReceivers) expect(receiver).toBe(transport);
	});

	it("dropClient 经 reconnect 关闭拒绝后保留原错误身份并允许再次 close", async () => {
		const closeError = new Error("reconnect close rejected");
		const { transport } = createMemoryTransport();
		const close = transport.close.bind(transport);
		let closeCalls = 0;
		const closeSpy = vi.spyOn(transport, "close").mockImplementation(async () => {
			closeCalls++;
			if (closeCalls === 1) throw closeError;
			await close();
		});
		const connection = createConnection(() => transport);
		const connectedClient = await connection.getClient();

		await expect(connection.reconnect()).rejects.toBe(closeError);
		// 底层 client 先关闭并抛错，适配器随后仍直接关闭同一 transport。
		expect(closeSpy).toHaveBeenCalledTimes(3);
		expect(connectedClient.connectionState).toBe("closed");
		await expect(connection.getClient()).rejects.toThrow('MCP server "failure" still has a connection');

		await expect(connection.close()).resolves.toBeUndefined();
		// reconnect 的第二次关闭取得本轮资源身份后，由后续 close() 再尝试一次。
		expect(closeSpy).toHaveBeenCalledTimes(4);
	});

	it("getClient 并发等待同一 tools/list 启动过程，不提前暴露 connected client", async () => {
		let releaseListTools!: () => void;
		const listToolsGate = new Promise<void>((resolve) => {
			releaseListTools = resolve;
		});
		const memory = createMemoryTransport({ listToolsGate });
		let opened = 0;
		const connection = createConnection(() => {
			opened++;
			return memory.transport;
		});

		const first = connection.getClient();
		await memory.listTools;
		let firstSettled = false;
		void first.then(() => {
			firstSettled = true;
		});
		const second = connection.getClient();
		await Promise.resolve();

		expect(second).toBe(first);
		expect(firstSettled).toBe(false);
		expect(connection.state).toBe("connecting");
		expect(opened).toBe(1);

		releaseListTools();
		const [firstClient, secondClient] = await Promise.all([first, second]);
		expect(firstClient).toBe(secondClient);
		expect(connection.state).toBe("connected");
		expect(memory.methods).toEqual(["initialize", "tools/list"]);
		await connection.close();
	});
});
