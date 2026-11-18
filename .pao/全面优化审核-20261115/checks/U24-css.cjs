const fs = require("node:fs");
const directory = "desktop/apps/desktop/src/styles/";
function blocks(text) {
  const result = [];
  let start = 0;
  while (start < text.length) {
    const open = text.indexOf("{", start);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === "{") depth++;
      if (text[end] === "}") depth--;
    }
    result.push({ header: text.slice(start, open).trim(), body: text.slice(open + 1, end - 1) });
    start = end;
  }
  return result;
}
function group(selector) {
  if (/\.memory-(?:management|editor|delete|merge|conflict|technical-details)/.test(selector)) return "management";
  if (/\.memory-(?:project-|task-continuation)/.test(selector)) return "context";
  if (/\.memory-(?:usage|activity|task-usage|context-usage)/.test(selector)) return "usage";
  return "base";
}
function split(text) {
  const output = { base: "", management: "", context: "", usage: "" };
  for (const { header, body } of blocks(text)) {
    if (header.startsWith("@media")) {
      const inner = split(body);
      for (const key in output) if (inner[key]) output[key] += header + " {\n" + inner[key] + "}\n\n";
    } else {
      const selectors = {};
      for (const selector of header.split(",").map((s) => s.trim())) (selectors[group(selector)] ??= []).push(selector);
      for (const key in selectors) output[key] += selectors[key].join(",\n") + " {" + body + "}\n\n";
    }
  }
  return output;
}
function declarations(text, context = "", output = {}) {
  for (const { header, body } of blocks(text)) {
    if (header.startsWith("@media")) declarations(body, context + header, output);
    else for (const selector of header.split(",").map((s) => s.trim())) {
      (output[context + " " + selector] ??= []).push(body.trim().replace(/\s+/g, " "));
    }
  }
  return output;
}
const before = fs.readFileSync(directory + "memory.css", "utf8");
if (process.argv[2] === "split") {
  const output = split(before);
  fs.writeFileSync(directory + "memory.css", output.base);
  for (const group of ["management", "context", "usage"]) fs.writeFileSync(directory + "memory-" + group + ".css", output[group]);
  const entry = "desktop/apps/desktop/src/styles.css";
  const text = fs.readFileSync(entry, "utf8");
  fs.writeFileSync(entry, text.replace('@import "./styles/memory.css";', '@import "./styles/memory.css";\n@import "./styles/memory-management.css";\n@import "./styles/memory-context.css";\n@import "./styles/memory-usage.css";'));
} else {
  const original = fs.readFileSync(".pao/全面优化审核-20261115/checks/U23-memory.css.txt", "utf8");
  const current = ["memory.css", "memory-management.css", "memory-context.css", "memory-usage.css"].map((name) => fs.readFileSync(directory + name, "utf8")).join("\n");
  const a = declarations(original), b = declarations(current);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const changed = keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
  if (changed.length) throw Error("样式声明顺序不一致：" + changed.join(", "));
  console.log("样式搬移核对通过：" + keys.length + " 组选择器及媒体条件，声明和顺序一致。");
}
