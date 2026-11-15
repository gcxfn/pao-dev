// B2 pass 2: catch forms the token regex missed —
//   1) regex literals: /^@earendil-works\/pi-ai\/compat$/
//   2) split path segments: "@earendil-works", "pi-coding-agent" / "@pi-gui", "extension-ui"
//   3) bare "@earendil-works" scope-dir strings (join("node_modules","@earendil-works",...))
//   4) "@earendil-works/" bare scope prefix in startsWith/concat contexts
// Usage: node b2-rename-pass2.js [--apply]
const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const ROOTS = ["PAO", "desktop"].map((d) => path.join(process.cwd(), d));
const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".git", "archive", "docs", "f1", "test-results", "vendor", "e2e", ".vite", ".turbo", "coverage", "release", "build", "playwright-report", ".pi", "plans", ".next"]);
const SKIP_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "npm-shrinkwrap.json", "CHANGELOG.md"]);
const FILE_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|yml|yaml)$/;

const EXTERNAL = new Set(["gondolin", "gondolin-krun-runner-darwin-arm64", "gondolin-krun-runner-linux-x64"]);

function mapName(rest) {
	// rest = full "pi-ai/compat" or "chord/bundler" etc.
	const base = rest.split("/")[0];
	if (EXTERNAL.has(base)) return null;
	if (rest === "chord" || rest.startsWith("chord/")) return "chord" + rest.slice(5);
	if (rest.startsWith("pi-")) return rest.slice(3);
	return rest;
}
const PI_GUI_MAP = { "pi-sdk-driver": "sdk-driver" };
function mapPiGui(rest) {
	const [base, ...sub] = rest.split("/");
	return [PI_GUI_MAP[base] ?? base, ...sub].join("/");
}

// Patterns, applied in order:
const PASS2 = [
	// 1) escaped regex literals: @earendil-works\/<rest>
	{
		re: /@earendil-works\\\/([A-Za-z0-9._~*-]+(?:\\\/[A-Za-z0-9._~*-]+)*)/g,
		fn: (m, rest) => {
			const unesc = rest.replace(/\\\//g, "/");
			const mapped = mapName(unesc);
			return mapped === null ? m : "@pao\\/" + rest.replace(/^pi-/, "");
		},
	},
	{
		re: /@pi-gui\\\/([A-Za-z0-9._~*-]+(?:\\\/[A-Za-z0-9._~*-]+)*)/g,
		fn: (m, rest) => "@pao\\/" + rest.replace(/^pi-sdk-driver/, "sdk-driver"),
	},
	// 2) split array elements: "@earendil-works", "pi-foo"
	{ re: /"@earendil-works"(\s*,\s*)"pi-ai"/g, fn: (m, s) => `"@pao"${s}"ai"` },
	{ re: /"@earendil-works"(\s*,\s*)"pi-tui"/g, fn: (m, s) => `"@pao"${s}"tui"` },
	{ re: /"@earendil-works"(\s*,\s*)"pi-coding-agent"/g, fn: (m, s) => `"@pao"${s}"coding-agent"` },
	{ re: /"@earendil-works"(\s*,\s*)"pi-agent-core"/g, fn: (m, s) => `"@pao"${s}"agent-core"` },
	{ re: /"@earendil-works"(\s*,\s*)"pi-telemetry"/g, fn: (m, s) => `"@pao"${s}"telemetry"` },
	{ re: /"@earendil-works"(\s*,\s*)"chord"/g, fn: (m, s) => `"@pao"${s}"chord"` },
	{ re: /"@pi-gui"(\s*,\s*)"extension-ui"/g, fn: (m, s) => `"@pao"${s}"extension-ui"` },
	{ re: /"@pi-gui"(\s*,\s*)"session-driver"/g, fn: (m, s) => `"@pao"${s}"session-driver"` },
	{ re: /"@pi-gui"(\s*,\s*)"pi-sdk-driver"/g, fn: (m, s) => `"@pao"${s}"sdk-driver"` },
	{ re: /"@pi-gui"(\s*,\s*)"catalogs"/g, fn: (m, s) => `"@pao"${s}"catalogs"` },
	// 3) bare scope strings as path segments: "node_modules","@earendil-works" / join(root,"@earendil-works")
	//    only when followed/preceded by node_modules path context — apply when string is exactly the scope
	{ re: /"@earendil-works"/g, fn: () => `"@pao"` },
	{ re: /"@pi-gui"/g, fn: () => `"@pao"` },
	// 4) startsWith("@earendil-works/") / template `@earendil-works/${name}` etc.
	{ re: /"@earendil-works\//g, fn: () => `"@pao/` },
	{ re: /'@earendil-works\//g, fn: () => `'@pao/` },
	{ re: /`@earendil-works\//g, fn: () => "`@pao/" },
	{ re: /"@pi-gui\//g, fn: () => `"@pao/` },
	{ re: /'@pi-gui\//g, fn: () => `'@pao/` },
	{ re: /`@pi-gui\//g, fn: () => "`@pao/" },
];

let fileCount = 0;
let hitCount = 0;
const misses = [];

function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) walk(p);
			continue;
		}
		if (SKIP_FILES.has(e.name) || e.name.endsWith(".md")) continue;
		if (!FILE_RE.test(e.name)) continue;
		processFile(p);
	}
}

function processFile(file) {
	let txt = fs.readFileSync(file, "utf8");
	const orig = txt;
	for (const { re, fn } of PASS2) {
		txt = txt.replace(re, (...args) => {
			hitCount++;
			return fn(...args);
		});
	}
	if (txt !== orig) {
		fileCount++;
		if (APPLY) fs.writeFileSync(file, txt);
	}
	// collect leftovers for review
	const leftover = txt.match(/@(earendil-works|pi-gui)[^"'`\s]*/g);
	if (leftover) misses.push({ file: path.relative(process.cwd(), file), leftover });
}

for (const r of ROOTS) walk(r);
console.log(`mode: ${APPLY ? "APPLY" : "DRY-RUN"}, files: ${fileCount}, hits: ${hitCount}`);
console.log("=== leftovers (incl. legit external gondolin) ===");
for (const m of misses) console.log(m.file, "->", [...new Set(m.leftover)].join(", "));
