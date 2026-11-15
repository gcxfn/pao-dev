import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
	bindMinister,
	controlPath,
	decideNode,
	endDecomposition,
	pauseControl,
	readControl,
	readControlReport,
	reworkControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "pao-review-version-"));
	roots.push(root);
	writeFileSync(join(root, "source.txt"), "v1\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
	git("init");
	git("add", "source.txt");
	git("-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "baseline");
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "版本验收",
			参数: [],
			节点: [
				{ 名字: "开发", 部门: "开发", 目标: "修改", 验收: "完成" },
				{
					名字: "审核",
					部门: "审核",
					目标: "审核",
					验收: "完成",
					审核: true,
					部门标准: "正确性",
					depends_on: ["开发"],
					回边: [{ 目标: "开发", 上限: 2, 超限动作: "停滞" }],
				},
			],
		})}---\n`,
		join(root, "版本验收.md"),
	);
	const options = { cardsDir: join(root, ".pao", "卡"), ownerSessionId: "owner" };
	await startControl(recipe, {}, options);
	const identity = (name: string) => ({
		实例: readControl(recipe, options).实例,
		节点: name,
		轮次: 1,
		部长会话: name,
	});
	for (const name of ["开发", "审核"]) {
		await bindMinister(recipe, options, name, name);
		await endDecomposition(recipe, options, identity(name), "本测试模拟零卡静态审核，不代表真实工人运行");
	}
	const pass = () =>
		decideNode(recipe, options, identity("审核"), {
			结果: "pass",
			理由: "未验证运行；本测试只验证版本约束",
			引用: ["source.txt:1"],
		});
	return { root, recipe, options, identity, pass };
}

describe("审核判定的真实成果版本与受控返工", () => {
	it("项目 Git 已不可用时仍可持久化显式暂停，不丢失用户停止意图", async () => {
		const s = await setup();
		await s.pass();
		rmSync(join(s.root, ".git"), { recursive: true, force: true });
		await pauseControl(s.recipe, s.options, "用户停止");
		expect(readControl(s.recipe, s.options).暂停).toBe("用户停止");
	});
	it("修改已审成果使通过失效，重新独立提交判定后才恢复完成", async () => {
		const s = await setup();
		await s.pass();
		expect((await readControlReport(readControl(s.recipe, s.options), s.options)).status).toBe("completed");
		writeFileSync(join(s.root, "source.txt"), "v2\n");
		const stale = await readControlReport(readControl(s.recipe, s.options), s.options);
		expect(stale.status).not.toBe("completed");
		expect(stale.nodes[1].hold).toContain("成果内容已变化");
		await s.pass();
		expect((await readControlReport(readControl(s.recipe, s.options), s.options)).status).toBe("completed");
		expect(readControl(s.recipe, s.options).记录.some((entry) => entry.事件 === "审核判定失效")).toBe(true);
	});
	it("其他项目根的通过证明不能放行", async () => {
		const s = await setup();
		await s.pass();
		const flow = readControl(s.recipe, s.options);
		flow.节点[1].判定!.projectRoot = join(s.root, "other");
		writeFileSync(controlPath(s.recipe, s.options), `---\n${stringify(flow)}---\n`);
		expect((await readControlReport(readControl(s.recipe, s.options), s.options)).nodes[1].hold).toContain(
			"其他项目根",
		);
	});
	it("零卡静态审核必须明确未验证运行，不能冒充运行证据", async () => {
		const s = await setup();
		await expect(
			decideNode(s.recipe, s.options, s.identity("审核"), {
				结果: "pass",
				理由: "阅读静态材料后通过",
				引用: ["source.txt:1"],
			}),
		).rejects.toThrow("未验证运行");
	});
	it("声明回边可在无人值守时返工，保留旧判定与轮次历史", async () => {
		const s = await setup();
		await s.pass();
		await reworkControl(s.recipe, s.options, s.identity("审核"), "新增公开需求变体检查未通过", "开发");
		const flow = readControl(s.recipe, s.options);
		expect(flow.节点.map((node) => node.轮次)).toEqual([2, 2]);
		expect(flow.节点[1].历史[0].判定?.结果).toBe("pass");
		expect(flow.回边次数["审核→开发"]).toBe(1);
	});
	it("未声明回边、旧轮次和暂停均不能被返工接口绕过", async () => {
		const s = await setup();
		await s.pass();
		await expect(reworkControl(s.recipe, s.options, s.identity("审核"), "检查失败", "不存在")).rejects.toThrow(
			"没有声明回边",
		);
		await expect(
			reworkControl(s.recipe, s.options, { ...s.identity("审核"), 轮次: 9 }, "检查失败", "开发"),
		).rejects.toThrow("旧轮次");
		await pauseControl(s.recipe, s.options, "用户暂停");
		await expect(reworkControl(s.recipe, s.options, s.identity("审核"), "检查失败", "开发")).rejects.toThrow("暂停");
		expect(readControl(s.recipe, s.options).暂停).toBe("用户暂停");
	});
});
