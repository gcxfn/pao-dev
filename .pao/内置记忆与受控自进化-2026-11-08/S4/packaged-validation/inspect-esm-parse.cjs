const { readFileSync } = require("node:fs");
const { SourceTextModule } = require("node:vm");

for (const filePath of process.argv.slice(2)) {
  try {
    new SourceTextModule(readFileSync(filePath, "utf8"), { identifier: filePath });
    console.log(`${filePath}: ok`);
  } catch (error) {
    console.error(`${filePath}: ${error.name}: ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  }
}
