import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_DEPARTMENT_SUPERVISION_MINUTES,
	DEFAULT_WORKER_SUPERVISION_MINUTES,
	readDepartmentSupervisionMinutes,
	readWorkerSupervisionMinutes,
	WARM_CONFIG_RELATIVE_PATH,
} from "../../src/pao/host/config.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function home(config?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-host-config-supervision-"));
	dirs.push(dir);
	if (config !== undefined) {
		const path = join(dir, WARM_CONFIG_RELATIVE_PATH);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, config, "utf8");
	}
	return dir;
}

describe("分层监督分钟配置", () => {
	it("缺文件/缺键时仍用 15/30,不受旧保温存在开关影响", () => {
		const dir = home();
		expect(readWorkerSupervisionMinutes(dir)).toBe(DEFAULT_WORKER_SUPERVISION_MINUTES);
		expect(readDepartmentSupervisionMinutes(dir)).toBe(DEFAULT_DEPARTMENT_SUPERVISION_MINUTES);
		const existing = home("{}");
		expect(readWorkerSupervisionMinutes(existing)).toBe(15);
		expect(readDepartmentSupervisionMinutes(existing)).toBe(30);
	});

	it("显式 0 关闭;坏值回落默认", () => {
		const off = home(JSON.stringify({ 工人监督分钟: 0, 部门监督分钟: 0 }));
		expect(readWorkerSupervisionMinutes(off)).toBe(0);
		expect(readDepartmentSupervisionMinutes(off)).toBe(0);
		const bad = home(JSON.stringify({ 工人监督分钟: -1, 部门监督分钟: "坏值" }));
		expect(readWorkerSupervisionMinutes(bad)).toBe(15);
		expect(readDepartmentSupervisionMinutes(bad)).toBe(30);
	});

	it("正小数按分钟向下取整且最小 1", () => {
		const dir = home(JSON.stringify({ 工人监督分钟: 0.5, 部门监督分钟: 12.8 }));
		expect(readWorkerSupervisionMinutes(dir)).toBe(1);
		expect(readDepartmentSupervisionMinutes(dir)).toBe(12);
	});
});
