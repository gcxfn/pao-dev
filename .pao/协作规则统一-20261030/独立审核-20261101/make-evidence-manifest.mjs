// 用途：为 S7 未入库的矩阵原始证据生成摘要清单（路径、大小、sha256）。
// 输入：../S7/矩阵-36槽位.json 与 ../S7/checks/matrix/<槽位>/ 的关键文件。
// 输出：../S7/证据清单.json；不修改任何原始证据。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const s7 = fileURLToPath(new URL("../S7", import.meta.url));
const matrixPath = join(s7, "矩阵-36槽位.json");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function entry(path) {
	const stat = statSync(path);
	return {
		path: relative(s7, path).replaceAll("\\", "/"),
		bytes: stat.size,
		sha256: sha256(path),
	};
}

function filesUnder(dir) {
	if (!existsSync(dir)) return [];
	const result = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isFile()) result.push(entry(path));
	}
	return result;
}

const slots = matrix.slots.map((slot) => {
	const dir = join(s7, "checks", "matrix", slot.slot);
	const keyFiles = ["run.json", "assert.json", "processes.json"]
		.map((name) => join(dir, name))
		.filter((path) => existsSync(path))
		.map((path) => entry(path));
	return {
		slot: slot.slot,
		status: slot.status,
		passed: slot.passed,
		failed: slot.failed,
		evidenceDir: slot.evidenceDir,
		keyFiles,
		controlFiles: filesUnder(join(dir, "control")),
	};
});

const topLevel = [
	"矩阵-36槽位.json",
	"矩阵-36槽位.md",
	"边界B01-B20.json",
	"边界B01-B20-结果.md",
	"桌面与发行.json",
	"桌面与发行-结果.md",
	"兼容与结构收敛.json",
	"兼容与结构收敛-结果.md",
	"工程门-结果.json",
	"工程门-结果.md",
	"验收记录.md",
	"交付报告.md",
]
	.map((name) => join(s7, name))
	.filter((path) => existsSync(path))
	.map((path) => entry(path));

const manifest = {
	generatedAt: new Date().toISOString(),
	note: "矩阵原始证据未入库（70MB、含嵌套 Git 仓库与运行缓存）；本清单记录关键文件的 sha256，原始文件保留在工作区。",
	sourceMatrix: basename(matrixPath),
	slotCount: slots.length,
	slots,
	topLevel,
};

writeFileSync(join(s7, "证据清单.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${join(s7, "证据清单.json")} (${slots.length} slots, ${topLevel.length} top-level files)`);
