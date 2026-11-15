// 诊断探针：复刻 build-coding-agent-bundle.mjs 的主构建（entry=cli/index/rpc-entry），
// 只为导出 metafile.inputs 中含 pi-ai / bedrock 的真实解析路径。不产出 bundle。
import { relative } from "node:path";
import { createRequire } from "node:module";
const { build } = createRequire(import.meta.url)("D:/AI/workspace/pao-dev/PAO/node_modules/esbuild/lib/main.js");

const repoRoot = "D:/AI/workspace/pao-dev/PAO";
const codingAgentDistDir = `${repoRoot}/packages/coding-agent/dist`;
const result = await build({
	absWorkingDir: repoRoot,
	bundle: true,
	entryPoints: {
		"cli-runtime": `${codingAgentDistDir}/cli.js`,
		index: `${codingAgentDistDir}/index.js`,
		"rpc-entry": `${codingAgentDistDir}/rpc-entry.js`,
	},
	outdir: `${repoRoot}/packages/coding-agent/dist/bundle-probe-tmp`,
	splitting: true,
	format: "esm",
	platform: "node",
	target: "node22.19",
	metafile: true,
	logLevel: "silent",
	write: false,
	tsconfigRaw: { compilerOptions: {} },
});
const hits = Object.keys(result.metafile.inputs).filter((p) => /pi-ai|bedrock|@anthropic-ai|@earendil-works/.test(p));
console.log("== inputs 命中 @earendil-works|bedrock|anthropic 共", hits.length, "条 ==");
for (const p of hits.slice(0, 25)) console.log(relative(repoRoot, p).replaceAll("\\", "/"));
const bedrockLazy = Object.keys(result.metafile.inputs).filter((p) => p.replaceAll("\\", "/").endsWith("packages/ai/dist/api/bedrock-converse-stream.lazy.js"));
console.log("== endsWith packages/ai/dist/api/bedrock-converse-stream.lazy.js 命中:", bedrockLazy.length);
const pnpmBedrock = Object.keys(result.metafile.inputs).filter((p) => p.includes(".pnpm") && p.includes("bedrock-converse-stream.lazy"));
for (const p of pnpmBedrock.slice(0, 5)) console.log(".pnpm 版:", relative(repoRoot, p).replaceAll("\\", "/"));
