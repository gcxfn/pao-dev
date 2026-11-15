import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { saveDispatchContractReference } from "../../src/pao/dispatch-brief/artifacts.ts";
import { sha256Bytes } from "../../src/pao/dispatch-brief/canonical.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("V05 artifact path baseline", () => {
	test("junction outside project is rejected during contract save", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-artifact-path-"));
		roots.push(root);
		const project = join(root, "project");
		const outside = join(root, "outside");
		mkdirSync(join(project, ".pao", "卡"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "contract.md"), "outside\n");
		const { symlinkSync } = await import("node:fs");
		symlinkSync(outside, join(project, "src-link"), "junction");
		await expect(
			saveDispatchContractReference({
				cardsDir: join(project, ".pao", "卡"),
				projectRoot: project,
				id: "junction-contract",
				version: "1",
				ref: join(outside, "contract.md"),
				digest: sha256Bytes(readFileSync(join(outside, "contract.md"))),
				contentPath: "src-link/contract.md",
			}),
		).rejects.toMatchObject({ code: "unsafe_path" });
	});
});
