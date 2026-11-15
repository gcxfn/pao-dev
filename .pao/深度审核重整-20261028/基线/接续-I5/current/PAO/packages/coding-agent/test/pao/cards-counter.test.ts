import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { formatCardNumber, nextCardNumber, parseCardRef } from "../../src/pao/cards/counter.ts";
import { PaoCardError } from "../../src/pao/cards/errors.ts";
import { writeFileAtomic } from "../../src/pao/shared/atomic.ts";
import { FileLockError, withFileLock } from "../../src/pao/shared/lock.ts";

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("writeFileAtomic 原子写", () => {
	test("新建与覆盖已存在文件，不留临时文件（Windows rename 覆盖语义）", () => {
		const dir = makeTempDir("pao-atomic-");
		const target = join(dir, "卡0001-测试.md");

		writeFileAtomic(target, "第一版");
		expect(readFileSync(target, "utf8")).toBe("第一版");

		writeFileAtomic(target, "第二版");
		expect(readFileSync(target, "utf8")).toBe("第二版");

		const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	test("并发原子写同一文件：终内容为某一次的完整内容，不出现交错拼接", async () => {
		const dir = makeTempDir("pao-atomic-");
		const target = join(dir, "data.md");
		const payloads = Array.from({ length: 10 }, (_, i) => `内容-${"甲乙丙丁戊己庚辛壬癸"[i]}-${"x".repeat(200)}`);
		await Promise.all(
			payloads.map(
				(text) =>
					new Promise<void>((resolve) => {
						setTimeout(() => {
							writeFileAtomic(target, text);
							resolve();
						}, Math.random() * 20);
					}),
			),
		);
		const final = readFileSync(target, "utf8");
		expect(payloads).toContain(final);
	});
});

describe("withFileLock 跨进程文件锁", () => {
	test("同一锁路径互斥：临界区不并发进入", async () => {
		const dir = makeTempDir("pao-lock-");
		const target = join(dir, "resource.txt");
		writeFileAtomic(target, "0");

		let inside = 0;
		let maxInside = 0;
		await Promise.all(
			Array.from({ length: 5 }, () =>
				withFileLock(target, async () => {
					inside += 1;
					maxInside = Math.max(maxInside, inside);
					await sleep(20);
					inside -= 1;
				}),
			),
		);
		expect(maxInside).toBe(1);
	});

	test("重试耗尽抛结构化 LOCK_TIMEOUT 错误", async () => {
		const dir = makeTempDir("pao-lock-");
		const target = join(dir, "held.txt");
		writeFileAtomic(target, "0");
		const release = await import("proper-lockfile").then((m) => m.default.lock(target, { realpath: false }));
		try {
			await expect(withFileLock(target, () => {}, { retries: 1, retryDelay: 10 })).rejects.toThrow(FileLockError);
		} finally {
			await release();
		}
	});
});

describe("nextCardNumber 发号器", () => {
	test("顺序发号：从 0001 递增，计数器文件内容同步", async () => {
		const dir = makeTempDir("pao-counter-");
		const counterPath = join(dir, "卡号.txt");
		expect(await nextCardNumber(counterPath)).toBe(1);
		expect(await nextCardNumber(counterPath)).toBe(2);
		expect(await nextCardNumber(counterPath)).toBe(3);
		expect(readFileSync(counterPath, "utf8").trim()).toBe("3");
	});

	test("跨进程并发：10 进程各发 5 号，共 50 号不重号且连续", async () => {
		const dir = makeTempDir("pao-counter-proc-");
		const counterPath = join(dir, "卡号.txt");
		// 测试期生成的临时 worker（非仓库文件）：经 Node 类型剥离直接加载 TS 源模块（Node >= 22.18 默认开启）
		const counterModule = fileURLToPath(new URL("../../src/pao/cards/counter.ts", import.meta.url));
		const workerPath = join(dir, "worker.mts");
		writeFileSync(
			workerPath,
			[
				`import { nextCardNumber } from ${JSON.stringify(pathToFileURL(counterModule).href)};`,
				"const [counterPath, count] = process.argv.slice(2);",
				"const numbers = [];",
				"for (let i = 0; i < Number(count); i++) numbers.push(await nextCardNumber(counterPath));",
				'console.log("PAO_NUMBERS:" + JSON.stringify(numbers));',
			].join("\n"),
			"utf8",
		);

		const results = await Promise.all(
			Array.from(
				{ length: 10 },
				() =>
					new Promise<number[]>((resolve, reject) => {
						const child = spawn(process.execPath, [workerPath, counterPath, "5"], { windowsHide: true });
						let out = "";
						child.stdout.on("data", (chunk) => {
							out += String(chunk);
						});
						child.on("error", reject);
						child.on("close", (code) => {
							const line = out.split("\n").find((l) => l.startsWith("PAO_NUMBERS:"));
							if (code !== 0 || !line) {
								reject(new Error(`worker 退出码 ${code}：${out}`));
								return;
							}
							resolve(JSON.parse(line.slice("PAO_NUMBERS:".length)) as number[]);
						});
					}),
			),
		);

		const all = results.flat();
		expect(all).toHaveLength(50);
		expect(new Set(all).size).toBe(50);
		expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
	}, 120_000);
});

describe("卡号格式与引用解析", () => {
	test("formatCardNumber 补零四位", () => {
		expect(formatCardNumber(1)).toBe("卡0001");
		expect(formatCardNumber(42)).toBe("卡0042");
		expect(formatCardNumber(12345)).toBe("卡12345");
	});

	test("parseCardRef 接受 卡0017 / 卡#17 / 17，非法引用报结构化错误", () => {
		expect(parseCardRef("卡0017")).toBe(17);
		expect(parseCardRef("卡#17")).toBe(17);
		expect(parseCardRef("17")).toBe(17);
		expect(() => parseCardRef("第17卡")).toThrow(PaoCardError);
		expect(() => parseCardRef("abc")).toThrow(/无法识别的卡引用/);
	});

	test("计数器文件可缺失后自动从 0 建", async () => {
		const dir = makeTempDir("pao-counter-missing-");
		const counterPath = join(dir, "nested", "卡号.txt");
		expect(existsSync(counterPath)).toBe(false);
		expect(await nextCardNumber(counterPath)).toBe(1);
	});
});
