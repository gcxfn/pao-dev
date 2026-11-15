/** 隔离迁移预演：真实文件与控制入口；不启动模型，不修改正式历史实例。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
	controlPath,
	controlView,
	prepareDirectNode,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { emitRecipeMarkdown } from "../../src/pao/workflow/distill.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pao-migration-preview-"));
	roots.push(root);
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "旧配方",
			参数: [],
			节点: [
				{ 名字: "开发", 部门: "开发部", 目标: "处理明确需求", 验收: "人工确认", 人工确认: true },
				{
					名字: "审查",
					部门: "审查部",
					目标: "只读核查",
					验收: "人工确认",
					depends_on: ["开发"],
					只读: true,
					审核: true,
					部门标准: "正确",
					回边: [{ 目标: "开发", 上限: 2, 超限动作: "停滞" }],
				},
			],
		})}---\n`,
		join(root, "旧配方.md"),
	);
	const options = { cardsDir: join(root, ".pao", "卡"), ownerSessionId: "old-owner" };
	return { root, recipe, options };
}
describe("迁移预演：兼容、显式转换与拒绝恢复", () => {
	it("缺执行方式的旧 v2 可读，仍等部长；查询与错误直派均不改原件", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		const path = controlPath(s.recipe, s.options);
		const before = readFileSync(path, "utf8");
		const flow = readControl(s.recipe, s.options);
		expect(flow.owner).toBe("old-owner");
		expect(flow.冻结配方.节点[0].执行方式).toBeUndefined();
		expect(controlView(flow).节点[0].挂起).toContain("部长");
		await expect(prepareDirectNode(s.recipe, s.options, "开发")).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe(before);
	});
	it("显式转换另建新实例；旧 owner、人工门、审核声明与回边保留", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		const path = controlPath(s.recipe, s.options);
		const before = readFileSync(path, "utf8");
		const converted = structuredClone(s.recipe);
		converted.名字 = "显式转换预览";
		converted.节点[0].执行方式 = "直接";
		const parsed = parseRecipe(emitRecipeMarkdown(converted), join(s.root, "显式转换预览.md"));
		const options = { ...s.options, cardsDir: join(s.root, "新实例", ".pao", "卡"), ownerSessionId: "new-owner" };
		await startControl(parsed, {}, options);
		const next = readControl(parsed, options);
		expect(next.实例).not.toBe(readControl(s.recipe, s.options).实例);
		expect(next.冻结配方.节点[0]).toMatchObject({ 执行方式: "直接", 人工确认: true });
		expect(next.冻结配方.节点[1]).toMatchObject({
			审核: true,
			只读: true,
			回边: [{ 目标: "开发", 上限: 2, 超限动作: "停滞" }],
		});
		expect(readFileSync(path, "utf8")).toBe(before);
	});
	it("未知版本或损坏轮次保留原件并拒绝恢复；重复启动不覆盖旧实例", async () => {
		const s = fixture();
		await startControl(s.recipe, {}, s.options);
		const path = controlPath(s.recipe, s.options);
		const original = readFileSync(path, "utf8");
		await expect(startControl(s.recipe, {}, s.options)).rejects.toThrow("实例已存在");
		expect(readFileSync(path, "utf8")).toBe(original);
		for (const broken of [original.replace("版本: 2", "版本: 99"), original.replace("轮次: 1", "轮次: 0")]) {
			writeFileSync(path, broken);
			expect(() => readControl(s.recipe, s.options)).toThrow();
			expect(readFileSync(path, "utf8")).toBe(broken);
		}
	});
});
