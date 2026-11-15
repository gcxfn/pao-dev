// PAO 桌面视图：使用现有 esbuild，仅构建浏览器资源，不复制内核。
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
for (const entry of ["desktop", "flow-desktop"])
  await build({
    absWorkingDir: fileURLToPath(new URL("../../../../", import.meta.url)),
    entryPoints: [fileURLToPath(new URL(`./${entry}.ts`, import.meta.url))],
    outfile: fileURLToPath(new URL(`./dist/${entry}.js`, import.meta.url)),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    legalComments: "none",
  });
