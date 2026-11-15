import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	type BaselineDiff,
	baselineSnapshotPath,
	checkBoundaryWrite,
	diffAgainstBaseline,
	snapshotClaimBaseline,
} from "../../src/pao/cards/baseline.ts";
import { appendReceipt, changeCardStatus, createCard, readCard } from "../../src/pao/cards/index.ts";
import { executeCheckBoundaryWrite } from "../../src/pao/cards/tools.ts";

/**
 * §14 越界写检测（2026-10-02 定案）：checkBoundaryWrite 以 git 真值（diffAgainstBaseline
 * 减认领基线的输出）比对回执声明的产物清单——虚报（说了没做）与越界（做了没说）都结构化亮出。
 * 纯函数部分直接构造 BaselineDiff；工具层入口（executeCheckBoundaryWrite）用真实 git 仓库 fixture。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pao-boundary-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

/** 构造一份「基线可用」的 diff 真值（等价 diffAgainstBaseline 的输出形态） */
function diffOf(files: { 状态?: string; 文件: string }[], projectRoot = "D:/repo"): BaselineDiff {
	return {
		基线可用: true,
		worker改动: files.map((f) => ({ 状态: f.状态 ?? "??", 文件: f.文件 })),
		既有条目数: 3,
		项目根: projectRoot,
		汇总: "测试夹具",
	};
}

describe("checkBoundaryWrite 纯函数:虚报/越界/干净三态结构化", () => {
	it("干净:声明与真值精确相符,虚报越界皆空", () => {
		const check = checkBoundaryWrite(diffOf([{ 状态: "??", 文件: "产物.txt" }]), ["产物.txt"]);
		expect(check.结论).toBe("干净");
		expect(check.相符).toEqual(["?? 产物.txt"]);
		expect(check.虚报).toEqual([]);
		expect(check.越界).toEqual([]);
		expect(check.汇总).toContain("比对干净:1 项声明与 git 真值相符");
	});

	it("虚报:声明了但 git 真值没有(说了没做),亮出缺货清单", () => {
		const check = checkBoundaryWrite(diffOf([]), ["产物.txt", "幽灵.txt"]);
		expect(check.结论).toBe("虚报");
		expect(check.虚报.sort()).toEqual(["产物.txt", "幽灵.txt"]);
		expect(check.越界).toEqual([]);
		expect(check.汇总).toContain("虚报 2 项(声明未写)");
	});

	it("越界:git 真值有但回执没声明(做了没说),带状态码亮出", () => {
		const check = checkBoundaryWrite(diffOf([{ 状态: "M", 文件: "src/授权外.ts" }, { 文件: "私货.txt" }]), []);
		expect(check.结论).toBe("越界");
		expect(check.越界).toEqual(["M src/授权外.ts", "?? 私货.txt"]);
		expect(check.虚报).toEqual([]);
		expect(check.汇总).toContain("越界 2 处(写未声明)");
	});

	it("虚报+越界并存:两头都亮,结论如实并报", () => {
		const check = checkBoundaryWrite(diffOf([{ 文件: "私货.txt" }]), ["幽灵.txt"]);
		expect(check.结论).toBe("虚报+越界");
		expect(check.虚报).toEqual(["幽灵.txt"]);
		expect(check.越界).toEqual(["?? 私货.txt"]);
	});

	it("目录声明覆盖其下真值文件,目录外改动仍算越界", () => {
		const check = checkBoundaryWrite(diffOf([{ 文件: "src/a.ts" }, { 文件: "src/b.ts" }, { 文件: "根上.txt" }]), [
			"src/",
		]);
		expect(check.结论).toBe("越界");
		expect(check.相符.length).toBe(2);
		expect(check.越界).toEqual(["?? 根上.txt"]);
	});

	it("编排区(.pao)声明不经 git 核验:不算虚报,如实进不可核验", () => {
		const check = checkBoundaryWrite(diffOf([{ 文件: "产物.txt" }]), [".pao/基线/卡0001-基线.txt", "产物.txt"]);
		expect(check.结论).toBe("干净");
		expect(check.不可核验).toEqual([".pao/基线/卡0001-基线.txt"]);
		expect(check.虚报).toEqual([]);
		expect(check.汇总).toContain("检测面外声明 1 项不经 git 核验");
	});

	it("工作区外绝对路径声明:git 永远看不到,进不可核验不算虚报", () => {
		const check = checkBoundaryWrite(diffOf([]), ["E:/其他项目/产物.txt"], { 项目根: "D:/repo" });
		expect(check.结论).toBe("干净");
		expect(check.不可核验).toEqual(["E:/其他项目/产物.txt"]);
	});

	it("项目根内的绝对/反斜杠声明归一为相对路径后正常比对", () => {
		const check = checkBoundaryWrite(diffOf([{ 文件: "产物.txt" }], "D:/repo"), ["D:\\repo\\产物.txt"], {
			项目根: "D:/repo",
		});
		expect(check.结论).toBe("干净");
		expect(check.相符).toEqual(["?? 产物.txt"]);
	});

	it("重命名条目按新路径比对,声明新名不算虚报", () => {
		const check = checkBoundaryWrite(diffOf([{ 状态: "R", 文件: "新名.ts -> 旧名.ts" }]), ["新名.ts"]);
		expect(check.结论).toBe("干净");
		expect(check.相符).toEqual(["R 新名.ts -> 旧名.ts"]);
	});

	it("基线不可用:如实报无法核对,不猜不静默", () => {
		const check = checkBoundaryWrite(
			{ 基线可用: false, worker改动: [], 既有条目数: 0, 汇总: "基线快照不可读", 原因: "ENOENT" },
			["产物.txt"],
		);
		expect(check.结论).toBe("无法核对");
		expect(check.原因).toBe("ENOENT");
		expect(check.汇总).toContain("越界比对无法进行");
	});

	it("空声明+空真值:干净(无声明、无基线外改动)", () => {
		const check = checkBoundaryWrite(diffOf([]), []);
		expect(check.结论).toBe("干净");
		expect(check.汇总).toContain("无声明、无基线外改动");
	});
});

const winOnly = process.platform === "win32" ? it : it.skip;

describe("checkBoundaryWrite 平台侧", () => {
	winOnly("Windows 路径大小写不敏感:声明大小写与真值不同也算相符", () => {
		const check = checkBoundaryWrite(diffOf([{ 文件: "Src/产物.txt" }]), ["src/产物.txt"]);
		expect(check.结论).toBe("干净");
		expect(check.虚报).toEqual([]);
	});
});

// ── 工具层入口 executeCheckBoundaryWrite:交卷/验收侧可调用,基线缺、报如实 ──

function makeRepo(prefix = "pao-boundary-"): string {
	const repo = tempDir(prefix);
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	writeFileSync(join(repo, "已跟踪.txt"), "v2-用户改的\n");
	return repo;
}

describe("executeCheckBoundaryWrite 工具层入口(真实 git 仓库)", () => {
	it("缺省取最新回执的产物路径:声明与真值相符输出干净,用户既有改动不入账", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		await createCard(
			cardDir,
			{ 目标: "核查卡", 部门: "测试", 验收: "x", 创建: "2026-10-02 10:00" },
			{ counterPath: join(cardDir, "..", "卡号.txt") },
		);
		const claim = await snapshotClaimBaseline(cardDir, 1, { owner: "部长A" });
		expect(claim.可用).toBe(true);
		// 认领后尝试号升到 1,回执才挂得上(与真实流程一致)
		changeCardStatus(readCard(join(cardDir, "卡0001-核查卡.md")), {
			操作者: "部长A",
			to: "in_progress",
			时间: "2026-10-02 10:03",
		});

		// worker 只写声明内产物
		writeFileSync(join(repo, "产物.txt"), "worker 写入\n");
		const card = readCard(join(cardDir, "卡0001-核查卡.md"));
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 10:05", 结果: "完成", 产物路径: ["产物.txt"] });

		const text = await executeCheckBoundaryWrite({ cards_dir: cardDir, card_ref: 1 });
		expect(text).toContain("结论：干净");
		expect(text).toContain("比对基线：");
		expect(text).toContain("既有 1 条不计 worker 的账"); // 用户改的 已跟踪.txt 在基线里
		expect(text).toContain("声明来源：卡上最新回执的产物路径");
		expect(text).toContain("相符：?? 产物.txt");
	});

	it("显式给产物路径可覆盖回执:虚报如实亮出", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		await createCard(
			cardDir,
			{ 目标: "虚报卡", 部门: "测试", 验收: "x", 创建: "2026-10-02 10:00" },
			{ counterPath: join(cardDir, "..", "卡号.txt") },
		);
		await snapshotClaimBaseline(cardDir, 1);
		const text = await executeCheckBoundaryWrite({ cards_dir: cardDir, card_ref: 1, artifact_path: ["幽灵.txt"] });
		expect(text).toContain("结论：虚报");
		expect(text).toContain("虚报（声明未写）：幽灵.txt");
		expect(text).toContain("声明来源：调用方显式给出");
	});

	it("无认领快照(基线文件缺失):如实报无法核对,不猜", async () => {
		const dir = tempDir();
		const cardDir = join(dir, "卡");
		mkdirSync(cardDir, { recursive: true });
		await createCard(
			cardDir,
			{ 目标: "无基线卡", 部门: "测试", 验收: "x", 创建: "2026-10-02 10:00" },
			{ counterPath: join(cardDir, "..", "卡号.txt") },
		);
		expect(existsSync(baselineSnapshotPath(cardDir, 1))).toBe(false);
		const text = await executeCheckBoundaryWrite({ cards_dir: cardDir, card_ref: 1 });
		expect(text).toContain("比对基线不可用");
		expect(text).toContain("结论：无法核对");
	});
});

// ── 派发链自写系统文件豁免（2026-10-05 修，集中清单 baseline.isDispatchSystemPath） ──
describe("派发链自写文件豁免:基线/黑板/账不算 worker 越界", () => {
	/** 建 git 仓库（真实 git fixture） */
	function makeCleanRepo(): string {
		const repo = tempDir();
		writeFileSync(join(repo, "根.txt"), "v1\n");
		git(repo, ["init"]);
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "--no-gpg-sign", "-m", "clean"]);
		return repo;
	}

	it("自定布局(卡目录不在 .pao 下):基线快照/黑板.md/四指标账.txt 被豁免,文件级声明对上,结论干净", async () => {
		const repo = makeCleanRepo();
		// 自定布局：卡目录在仓库根的 卡/，派发链自写文件随之落在仓库根（不在 .pao 内）
		const cardDir = join(repo, "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, 1, { owner: "主控", 时间: "2026-10-05 10:00" });
		expect(baseline.可用).toBe(true);
		// 认领后派发链自写：黑板 + 四指标账（基线快照已由认领自动落盘）
		writeFileSync(join(repo, "黑板.md"), "# 任务黑板\n");
		writeFileSync(join(repo, "四指标账.txt"), "# 四指标账\n");
		// worker 真实产出（全新目录，文件级声明）
		mkdirSync(join(repo, "产出"), { recursive: true });
		writeFileSync(join(repo, "产出", "hello.txt"), "hello\n");

		const diff = await diffAgainstBaseline(baseline.快照路径!);
		expect(diff.基线可用).toBe(true);
		// 豁免后 worker 账上只剩真实产出；基线快照/黑板/账都不算越界
		expect(diff.worker改动).toEqual([{ 状态: "??", 文件: "产出/hello.txt" }]);
		const check = checkBoundaryWrite(diff, ["产出/hello.txt"], { 项目根: diff.项目根 });
		expect(check.结论).toBe("干净");
		expect(check.越界).toEqual([]);
		expect(check.虚报).toEqual([]);
	});

	it("标准布局(.pao 下)回归不破:.pao 豁免照旧,系统文件也不冒头", async () => {
		const repo = makeCleanRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, 2, { owner: "主控", 时间: "2026-10-05 10:00" });
		writeFileSync(join(repo, ".pao", "黑板.md"), "# 任务黑板\n");
		writeFileSync(join(repo, ".pao", "四指标账.txt"), "# 四指标账\n");
		writeFileSync(join(repo, "产物.txt"), "worker 的\n");

		const diff = await diffAgainstBaseline(baseline.快照路径!);
		expect(diff.worker改动).toEqual([{ 状态: "??", 文件: "产物.txt" }]);
	});

	it("声明里含派发链自写文件:算检测面外,不算虚报", () => {
		const check = checkBoundaryWrite(diffOf([{ 文件: "产出/a.txt" }]), [
			"产出/a.txt",
			"黑板.md",
			"四指标账.txt",
			"基线/卡0001-基线.txt",
		]);
		expect(check.结论).toBe("干净");
		expect(check.虚报).toEqual([]);
		expect(check.不可核验.sort()).toEqual(["四指标账.txt", "基线/卡0001-基线.txt", "黑板.md"]);
	});

	it("豁免收窄到真实落点:产出目录里 worker 的同名文件不算系统文件(不被静默丢出交卷)", async () => {
		const repo = makeCleanRepo();
		const cardDir = join(repo, "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, 3, { owner: "主控", 时间: "2026-10-05 11:00" });
		expect(baseline.可用).toBe(true);
		// worker 产物里撞系统文件名：产出/黑板.md、产出/卡1-基线.txt、非基线目录的快照名
		mkdirSync(join(repo, "产出"), { recursive: true });
		writeFileSync(join(repo, "产出", "黑板.md"), "worker 的黑板\n");
		writeFileSync(join(repo, "产出", "卡1-基线.txt"), "worker 的快照\n");
		mkdirSync(join(repo, "工作区"), { recursive: true });
		writeFileSync(join(repo, "工作区", "四指标账.txt"), "worker 的账\n");

		const diff = await diffAgainstBaseline(baseline.快照路径!);
		// 三个同名文件都保留在 worker 账上——豁免只认根层与 基线/ 直接子级
		expect(diff.worker改动.map((e) => e.文件).sort()).toEqual([
			"产出/卡1-基线.txt",
			"产出/黑板.md",
			"工作区/四指标账.txt",
		]);
	});
});
