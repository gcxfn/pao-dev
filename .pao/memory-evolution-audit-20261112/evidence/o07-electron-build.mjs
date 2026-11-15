import { build } from "../../../PAO/node_modules/esbuild/lib/main.js";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("./o07-electron-probe.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./o07-electron-probe.mjs", import.meta.url)),
  bundle: true, platform: "node", format: "esm", target: "node22", external: ["electron"],
  banner: { js: 'import { createRequire as makeRequire } from "node:module"; const require = makeRequire(import.meta.url);' },
  logLevel: "error",
});
