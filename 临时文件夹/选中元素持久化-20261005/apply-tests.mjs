import { readFileSync, writeFileSync } from "node:fs";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function applyPair(file, text, oldText, newText, label) {
  const pattern = new RegExp(oldText.split("\n").map(escapeRegExp).join("(\\r?\\n)"), "g");
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${label} (${file}): expected 1, found ${matches.length}`);
  const ending = matches[0][1] || "\n";
  return text.replace(pattern, () => newText.split("\n").join(ending));
}

const root = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/unit";

// 1. ipc-request-validation.spec.ts
{
  const file = `${root}/ipc-request-validation.spec.ts`;
  let text = readFileSync(file, "utf8");
  text = applyPair(file, text,
    `      { id: "tab-1", workspaceId: "ws-a", title: "安装", mode: "edit", recipeName: "安装" },`,
    `      {\n        id: "tab-1",\n        workspaceId: "ws-a",\n        title: "安装",\n        mode: "edit",\n        recipeName: "安装",\n        selectedElementId: \`edge:\${JSON.stringify(["开发", "审查", true])}\`,\n      },`,
    "ipc tab-1");
  writeFileSync(file, text, "utf8");
  console.log("OK", file);
}

// 2. persisted-data.spec.ts
{
  const file = `${root}/persisted-data.spec.ts`;
  let text = readFileSync(file, "utf8");
  text = applyPair(file, text,
    `    { id: "tab-edit", workspaceId: "ws-a", title: "安装配方", mode: "edit", recipeName: "安装" },`,
    `    {\n      id: "tab-edit",\n      workspaceId: "ws-a",\n      title: "安装配方",\n      mode: "edit",\n      recipeName: "安装",\n      selectedElementId: "开发",\n    },`,
    "persisted edit tab");
  writeFileSync(file, text, "utf8");
  console.log("OK", file);
}

// 3. recipe-canvas-editor.spec.ts
{
  const file = `${root}/recipe-canvas-editor.spec.ts`;
  let text = readFileSync(file, "utf8");
  text = applyPair(file, text,
    `import {\n  dependencyAncestors,\n  isReviewNode,\n  planConnection,\n  readReviewEdges,\n} from "../../src/features/canvas/recipe-canvas-editor";`,
    `import {\n  decodeSelectedElement,\n  dependencyAncestors,\n  encodeSelectedElement,\n  isReviewNode,\n  planConnection,\n  readReviewEdges,\n  selectedElementExists,\n} from "../../src/features/canvas/recipe-canvas-editor";`,
    "spec import");

  // append a new describe block at end of file
  const ending = /\r\n/.test(text) ? "\r\n" : "\n";
  const block = [
    "",
    `describe("画布选中元素编码与恢复校验", () => {`,
    `  test("节点用名字原文编码，未选中返回 undefined", () => {`,
    `    expect(encodeSelectedElement({ kind: "node", name: "开发" })).toBe("开发");`,
    `    expect(encodeSelectedElement(null)).toBeUndefined();`,
    `    expect(encodeSelectedElement(undefined)).toBeUndefined();`,
    `  });`,
    "",
    `  test("连线用 edge: 前缀加 JSON 编码，含 review 布尔", () => {`,
    `    expect(encodeSelectedElement({ kind: "edge", from: "审查", to: "开发", review: true })).toBe(`,
    `      \`edge:\${JSON.stringify(["审查", "开发", true])}\`,`,
    `    );`,
    `    expect(encodeSelectedElement({ kind: "edge", from: "开发", to: "测试", review: false })).toBe(`,
    `      \`edge:\${JSON.stringify(["开发", "测试", false])}\`,`,
    `    );`,
    `  });`,
    "",
    `  test("decode 与 encode 往返一致；空串与坏格式当作未选中", () => {`,
    `    const node = { kind: "node", name: "开发" } as const;`,
    `    const edge = { kind: "edge", from: "审查", to: "开发", review: true } as const;`,
    `    expect(decodeSelectedElement(encodeSelectedElement(node))).toEqual(node);`,
    `    expect(decodeSelectedElement(encodeSelectedElement(edge))).toEqual(edge);`,
    `    expect(decodeSelectedElement(undefined)).toBeUndefined();`,
    `    expect(decodeSelectedElement("")).toBeUndefined();`,
    `    expect(decodeSelectedElement("edge:不是 JSON")).toBeUndefined();`,
    `    expect(decodeSelectedElement(\`edge:\${JSON.stringify(["甲", "乙"])}\`)).toBeUndefined();`,
    `    expect(decodeSelectedElement(\`edge:\${JSON.stringify(["甲", "乙", "是"])}\`)).toBeUndefined();`,
    `  });`,
    "",
    `  test("节点选中在校验：存在为 true，被删/改名后为 false", () => {`,
    `    expect(selectedElementExists({ kind: "node", name: "开发" }, chain)).toBe(true);`,
    `    expect(selectedElementExists({ kind: "node", name: "已删" }, chain)).toBe(false);`,
    `  });`,
    "",
    `  test("连线选中校验：依赖边与审核回边各自核对，删除后为 false", () => {`,
    `    expect(selectedElementExists({ kind: "edge", from: "开发", to: "测试", review: false }, chain)).toBe(`,
    `      true,`,
    `    );`,
    `    expect(selectedElementExists({ kind: "edge", from: "测试", to: "开发", review: false }, chain)).toBe(`,
    `      false,`,
    `    );`,
    `    const withReview = chain.map((row) =>`,
    `      row.名字 === "审查"`,
    `        ? { ...row, 回边: [{ 目标: "开发", 上限: 3, 超限动作: "停滞" }] }`,
    `        : row,`,
    `    );`,
    `    expect(`,
    `      selectedElementExists({ kind: "edge", from: "审查", to: "开发", review: true }, withReview),`,
    `    ).toBe(true);`,
    `    expect(`,
    `      selectedElementExists({ kind: "edge", from: "审查", to: "开发", review: true }, chain),`,
    `    ).toBe(false);`,
    `    expect(`,
    `      selectedElementExists({ kind: "edge", from: "测试", to: "开发", review: true }, chain),`,
    `    ).toBe(false);`,
    `  });`,
    `});`,
    "",
  ].join(ending);
  text = text.replace(/\s*$/, "") + ending + block;
  writeFileSync(file, text, "utf8");
  console.log("OK", file);
}
console.log("ALL DONE");
