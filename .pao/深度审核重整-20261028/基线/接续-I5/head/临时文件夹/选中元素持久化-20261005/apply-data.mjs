import { readFileSync, writeFileSync } from "node:fs";

const root = "D:/AI/workspace/pao-dev/桌面端/apps/desktop";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyPair(text, oldText, newText, label) {
  const pattern = new RegExp(
    oldText.split("\n").map(escapeRegExp).join("(\\r?\\n)"),
    "g",
  );
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected 1 match, found ${matches.length}`);
  }
  const ending = matches[0][1] || "\n";
  const replacement = newText.split("\n").join(ending);
  return text.replace(pattern, () => replacement);
}

const edits = [
  {
    file: `${root}/contracts/desktop-state.ts`,
    pairs: [
      [
        `  readonly controller?: WorkspaceSessionTarget;\n  readonly mode: WorkflowTabMode;\n}`,
        `  readonly controller?: WorkspaceSessionTarget;\n  /**\n   * 画布上当前选中的元素，供切标签/重启后恢复：节点用名字原文；连线用 \`edge:\` 前缀加\n   * JSON \`[from,to,review]\` 编码（review 为布尔）。仅渲染层解释，不属于草稿内容。\n   */\n  readonly selectedElementId?: string;\n  readonly mode: WorkflowTabMode;\n}`,
      ],
    ],
  },
  {
    file: `${root}/electron/ipc/request-validation.ts`,
    pairs: [
      [
        `    instanceName: expectOptionalString(record.instanceName, \`\${name}.instanceName\`),\n    controller:`,
        `    instanceName: expectOptionalString(record.instanceName, \`\${name}.instanceName\`),\n    selectedElementId: expectOptionalString(\n      record.selectedElementId,\n      \`\${name}.selectedElementId\`,\n    ),\n    controller:`,
      ],
    ],
  },
  {
    file: `${root}/electron/persistence/app-store-persistence.ts`,
    pairs: [
      [
        `        ["id", "workspaceId", "title", "recipeName", "instanceName", "controller", "mode"],`,
        `        [\n          "id",\n          "workspaceId",\n          "title",\n          "recipeName",\n          "instanceName",\n          "selectedElementId",\n          "controller",\n          "mode",\n        ],`,
      ],
      [
        `      for (const key of ["title", "recipeName", "instanceName"])\n        optional(record, key, string, \`\${path}.\${key}\`);`,
        `      for (const key of ["title", "recipeName", "instanceName", "selectedElementId"])\n        optional(record, key, string, \`\${path}.\${key}\`);`,
      ],
      [
        `    const instanceName = stringValue(record.instanceName);\n    const controller = toPersistedSessionTarget(record.controller);`,
        `    const instanceName = stringValue(record.instanceName);\n    const selectedElementId = stringValue(record.selectedElementId);\n    const controller = toPersistedSessionTarget(record.controller);`,
      ],
      [
        `        ...(instanceName !== undefined ? { instanceName } : {}),\n        ...(controller !== undefined ? { controller } : {}),`,
        `        ...(instanceName !== undefined ? { instanceName } : {}),\n        ...(selectedElementId !== undefined ? { selectedElementId } : {}),\n        ...(controller !== undefined ? { controller } : {}),`,
      ],
    ],
  },
  {
    file: `${root}/electron/application/workflow-tabs.ts`,
    pairs: [
      [
        `  const { recipeName, instanceName } = tab;\n  return {\n    id: tab.id,\n    workspaceId: tab.workspaceId,\n    title: tab.title,\n    mode: tab.mode,\n    ...(recipeName !== undefined ? { recipeName } : {}),\n    ...(instanceName !== undefined ? { instanceName } : {}),\n  };`,
        `  const { recipeName, instanceName, selectedElementId } = tab;\n  return {\n    id: tab.id,\n    workspaceId: tab.workspaceId,\n    title: tab.title,\n    mode: tab.mode,\n    ...(recipeName !== undefined ? { recipeName } : {}),\n    ...(instanceName !== undefined ? { instanceName } : {}),\n    ...(selectedElementId !== undefined ? { selectedElementId } : {}),\n  };`,
      ],
    ],
  },
];

for (const { file, pairs } of edits) {
  let text = readFileSync(file, "utf8");
  for (const [oldText, newText] of pairs) {
    text = applyPair(text, oldText, newText, file);
  }
  writeFileSync(file, text, "utf8");
  console.log(`OK ${file}`);
}
console.log("ALL DONE");
