import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "esbuild";
import { expect, it } from "vitest";

it("separate module copies share stdout takeover and drain queue", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pao-output-channel-"));
	try {
		const source = readFileSync(new URL("../src/core/output-guard.ts", import.meta.url), "utf8");
		const { code } = await transform(source, { loader: "ts", format: "esm" });
		writeFileSync(join(dir, "bundle.mjs"), code);
		writeFileSync(join(dir, "extension.mjs"), code);
		writeFileSync(
			join(dir, "run.mjs"),
			`
import * as bundle from './bundle.mjs';
import * as extension from './extension.mjs';
bundle.takeOverStdout();
if (!extension.isStdoutTakenOver()) throw new Error('not shared');
extension.takeOverStdout();
console.log('ordinary log');
for(let i=0;i<128;i++) extension.writeRawStdout(JSON.stringify({type:'pao_usage_entry',entryId:String(i)})+'\\n');
extension.writeRawStdout(JSON.stringify({type:'pao_usage_complete'})+'\\n');
await bundle.flushRawStdout();
extension.restoreStdout();
if(bundle.isStdoutTakenOver()) throw new Error('restore not shared');
console.log('restored');
`,
		);
		const result = spawnSync(process.execPath, [join(dir, "run.mjs")], { encoding: "utf8", timeout: 10000 });
		expect(result.status).toBe(0);
		expect(result.stderr.trim()).toBe("ordinary log");
		const lines = result.stdout.trim().split("\n");
		expect(lines.pop()).toBe("restored");
		const events = lines.map((line) => JSON.parse(line));
		expect(events).toHaveLength(129);
		expect(events.at(-1).type).toBe("pao_usage_complete");
		expect(events.slice(0, 128).map((e) => e.entryId)).toEqual(Array.from({ length: 128 }, (_, i) => String(i)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
