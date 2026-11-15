// 协作落卡并发争抢子进程（审查第 8 项）：同一父卡、同一目标部门、两个独立进程同时递交。
// 输入：卡目录、部门注册表路径、目标文本；输出：本进程拿到的裁决与回执文本。不连供应商、不联网。
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { registerCollab } from "../../src/pao/collab/index.ts";

const cardsDir = process.argv[2] ?? "";
const registryPath = process.argv[3] ?? "";
const goal = process.argv[4] ?? "并发递交";
// 起跑时刻(毫秒 epoch):两个进程在同一时刻递交,否则先启动的进程会先完成,测不出争抢
const 起跑时刻 = Number(process.argv[5] ?? 0);
while (Date.now() < 起跑时刻) await new Promise((resolve) => setTimeout(resolve, 5));

const tools: ToolDefinition[] = [];
const pi = {
	registerTool: (tool: ToolDefinition) => tools.push(tool),
	registerCommand: () => undefined,
	sendMessage: () => undefined,
} as unknown as ExtensionAPI;
registerCollab(pi, { resolveCardsDir: () => cardsDir, resolveRegistryPath: () => registryPath });

const tool = tools.find((entry) => entry.name === "pao_collab_relay");
if (!tool) {
	process.stderr.write("未注册 pao_collab_relay\n");
	process.exit(2);
}
const result = await tool.execute(
	"t1",
	{ goal, dept: "后端", acceptance: "并发验收", parent: "卡#1" },
	undefined,
	undefined,
	{} as never,
);
const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
const 裁决 = (result.details as { 裁决?: string } | undefined)?.裁决 ?? "未知";
process.stdout.write(`${JSON.stringify({ 裁决, text })}\n`);
