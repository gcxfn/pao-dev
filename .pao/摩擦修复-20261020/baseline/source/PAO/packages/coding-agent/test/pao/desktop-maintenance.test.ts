import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readMechanicalMaintenance } from "../../src/pao/desktop/maintenance.ts";

const base = resolve("D:/AI/workspace/临时文件夹/PAO-机械巡检测试-20261004");
mkdirSync(base, { recursive: true });
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(base, "home-"));
	homes.push(home);
	mkdirSync(join(home, "部门", "测试", "教训"), { recursive: true });
	writeFileSync(join(home, "部门", "注册表.md"), "| 名字 | 标签 | 库路径 |\n| 测试 | 测试 | 部门/测试 |\n");
	writeFileSync(join(home, "部门", "测试", "教训", "旧条目.md"), "# 缺日期夹具\n原正文不得变\n");
	return home;
}
test("机械巡检复用规则但零写入，不创建子索引和巡库卡", async () => {
	const home = fixture();
	const dir = join(home, "部门", "测试", "教训");
	const before = readFileSync(join(dir, "旧条目.md"), "utf8");
	const report = await readMechanicalMaintenance(home, "巡检");
	expect(report).toContain("缺最后核验日期");
	expect(report).toContain("entriesWithoutRow");
	expect(readdirSync(dir)).toEqual(["旧条目.md"]);
	expect(readFileSync(join(dir, "旧条目.md"), "utf8")).toBe(before);
	expect(readdirSync(home)).toEqual(["部门"]);
});
test("保温只读且明确不宣称嵌入或语义索引刷新；登记路径越界拒绝", async () => {
	const home = fixture();
	expect(await readMechanicalMaintenance(home, "保温")).toContain("不宣称持久语义索引已刷新");
	writeFileSync(join(home, "部门", "注册表.md"), "| 逃逸 | 测试 | ../ |\n");
	await expect(readMechanicalMaintenance(home, "巡检")).rejects.toThrow(/越界/);
});
