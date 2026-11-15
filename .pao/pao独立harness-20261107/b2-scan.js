// B2 scan: classify all @earendil-works / @pi-gui occurrences in both repos.
// Usage: node b2-scan.js  (cwd: pao-dev)
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MAPPED = new Set([
	"pi-coding-agent", "pi-agent-core", "pi-ai", "pi-client", "pi-codemode",
	"pi-durable", "pi-evals", "pi-mcp", "pi-protocol", "pi-server",
	"pi-telemetry", "pi-tui", "chord",
]);
const PI_GUI = new Set([
	"desktop", "website", "catalogs", "extension-ui", "pi-sdk-driver",
	"session-driver", "example-github", "example-pr-review",
	"example-test-runs", "example-trace", "example-usage", "pao-desktop",
]);

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (["node_modules", "dist", "out", ".git", "archive", "docs", "f1", "test-results", "vendor"].includes(e.name)) continue;
			walk(p, out);
		} else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|json|yml|yaml)$/.test(e.name)) {
			out.push(p);
		}
	}
	return out;
}

const roots = ["PAO", "desktop"].map(d => path.join(process.cwd(), d));
const re = /@(earendil-works|pi-gui)\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~*-]+)*/g;
const hits = [];
for (const root of roots) {
	for (const f of walk(root)) {
		const txt = fs.readFileSync(f, "utf8");
		const lines = txt.split("\n");
		lines.forEach((line, i) => {
			let m;
			while ((m = re.exec(line))) {
				const scope = m[1];
				const rest = m[0].slice(scope.length + 2);
				const base = rest.split("/")[0];
				let cls;
				if (scope === "earendil-works") cls = MAPPED.has(base) ? "mapped" : "UNMAPPED";
				else cls = PI_GUI.has(base) ? "mapped" : "UNMAPPED";
				hits.push({ file: path.relative(process.cwd(), f), line: i + 1, tok: m[0], cls });
			}
		});
	}
}
const unmapped = hits.filter(h => h.cls === "UNMAPPED");
const counts = {};
for (const h of hits) counts[h.tok.split("/").slice(0, 2).join("/")] = (counts[h.tok.split("/").slice(0, 2).join("/")] || 0) + 1;
console.log("=== token counts ===");
Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(v, k));
console.log("\n=== UNMAPPED occurrences ===");
unmapped.forEach(h => console.log(`${h.file}:${h.line}: ${h.tok}`));
console.log("\ntotal hits:", hits.length, "unmapped:", unmapped.length);
