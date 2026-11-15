// B2 rename: replace @earendil-works/X -> @pao/Y and @pi-gui/X -> @pao/Y.
// Rules:
//  - @earendil-works/pi-foo -> @pao/foo ; @earendil-works/chord -> @pao/chord
//  - unmapped @earendil-works/<base> (e.g. gondolin, pi-example-plugin,
//    pi-coding-agent-install, test-plugin, pi-agent-old) -> @pao/<base> with pi- kept
//  - @pi-gui/X -> @pao/Y per map (pi-sdk-driver -> sdk-driver dedup)
//  - skips: node_modules, dist, out, archive, docs, .git, f1, test-results,
//    vendor (generated), CHANGELOG.md, .md files (docs not in batch)
// Usage: node b2-rename.js [--apply]   (default dry-run prints summary)
const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const ROOTS = ["PAO", "desktop"].map((d) => path.join(process.cwd(), d));
const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".git", "archive", "docs", "f1", "test-results", "vendor", "e2e", ".vite", ".turbo", "coverage", "release", "build", "playwright-report", ".pi", "plans"]);
const SKIP_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "npm-shrinkwrap.json", "CHANGELOG.md", "yarn.lock"]);
const FILE_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|yml|yaml)$/;

const PI_GUI_MAP = {
	"pi-sdk-driver": "sdk-driver",
};
// identity for all other @pi-gui/* names (desktop, website, catalogs,
// extension-ui, session-driver, example-*, pao-desktop)

// External npm-published deps under the same scope must NOT be renamed —
// @pao/gondolin does not exist on the registry.
const EXTERNAL_EARENDIL = new Set(["gondolin", "gondolin-krun-runner-darwin-arm64", "gondolin-krun-runner-linux-x64"]);

function mapEarendil(rest) {
	const base = rest.split("/")[0];
	if (EXTERNAL_EARENDIL.has(base)) return null; // keep old token
	if (rest === "chord" || rest.startsWith("chord/")) return "chord" + rest.slice(5);
	if (rest.startsWith("pi-")) return rest.slice(3); // pi-coding-agent -> coding-agent, keeps subpath
	return rest; // unmapped non-pi names: test-plugin, second-test-plugin, ...
}

function mapToken(token) {
	// token like "@earendil-works/pi-ai/providers/all" or "@pi-gui/desktop"
	const m = /^@(earendil-works|pi-gui)\/(.+)$/.exec(token);
	if (!m) return token;
	const [, scope, rest] = m;
	if (scope === "earendil-works") {
		const mapped = mapEarendil(rest);
		return mapped === null ? token : "@pao/" + mapped;
	}
	// @pi-gui
	const [base, ...sub] = rest.split("/");
	const newBase = PI_GUI_MAP[base] ?? base;
	return "@pao/" + [newBase, ...sub].join("/");
}

const TOKEN_RE = /@(?:earendil-works|pi-gui)\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~*-]+)*/g;

// tokens that must NOT be rewritten (external packages): none — even gondolin
// maps to @pao/gondolin per "all @earendil-works" rule. Registry-published
// deps resolved from npm keep old name in lockfiles, but those are rebuilt.

const changes = [];
let fileCount = 0;
let tokenCount = 0;
const tokenStats = {};

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
	const txt = fs.readFileSync(file, "utf8");
	const out = txt.replace(TOKEN_RE, (tok) => {
		const mapped = mapToken(tok);
		if (mapped !== tok) {
			tokenCount++;
			const key = `${tok} -> ${mapped}`;
			tokenStats[key] = (tokenStats[key] || 0) + 1;
			changes.push({ file: path.relative(process.cwd(), file), tok, mapped });
		}
		return mapped;
	});
	if (out !== txt) {
		fileCount++;
		if (APPLY) fs.writeFileSync(file, out);
	}
}

for (const r of ROOTS) walk(r);
console.log(`mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`files changed: ${fileCount}, tokens replaced: ${tokenCount}`);
console.log("=== token stats ===");
Object.entries(tokenStats).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(v, k));
