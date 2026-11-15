import { readFileSync, writeFileSync } from "node:fs";

const file = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/app/App.tsx";
const outDir = "D:/AI/workspace/pao-dev/临时文件夹/embedded-chat-20261005";
const original = readFileSync(file, "utf8");
if (original.includes("\r")) throw new Error("expected LF line endings");
const lines = original.split("\n");
const trimIs = (s) => (l) => l.trim() === s;
const countOf = (pred) => lines.filter(pred).length;
const indentOf = (l) => l.length - l.trimStart().length;
const shift = (block, delta) => block.map((l) => (l.trim() === "" ? l : l.slice(delta)));

// --- normal-session branch ---
const start = lines.findIndex(trimIs(") : selectedWorkspace && selectedSession ? ("));
const end = lines.findIndex(trimIs(") : selectedWorkspace ? ("));
if (start < 0 || end <= start) throw new Error("branch markers not found");
if (countOf(trimIs(") : selectedWorkspace && selectedSession ? (")) !== 1)
  throw new Error("conversation branch marker is not unique");
if (countOf(trimIs(") : selectedWorkspace ? (")) !== 1) throw new Error("tail marker is not unique");
if (lines[start + 1].trim() !== "<>") throw new Error("branch does not open with a fragment");
if (lines[end - 1].trim() !== "</>") throw new Error("branch does not close its fragment");

const inner = lines.slice(start + 2, end - 1);
const modalAt = inner.findIndex(trimIs("{treeModalState.open ? ("));
if (modalAt < 0) throw new Error("tree modal marker missing");
const conversation = inner.slice(0, modalAt);
const modals = inner.slice(modalAt);
if (countOf(trimIs("{forkModalState.open ? (")) !== 1) throw new Error("fork modal marker is not unique");
if (conversation.length < 120) throw new Error("conversation block looks too small");
const conversationShift = indentOf(conversation[0]) - 8;
const modalShift = indentOf(modals[0]) - 8;
if (conversationShift <= 0 || modalShift <= 0) throw new Error("unexpected indentation");

const sessionNode = [
  "  const sessionConversation =",
  "    selectedWorkspace && selectedSession ? (",
  "      <>",
  ...shift(conversation, conversationShift),
  "      </>",
  "    ) : null;",
];

// --- insertion points ---
const shellAt = lines.findIndex((l) => l.includes("const shellClassName ="));
const returnAt = lines.findIndex((l, i) => i > shellAt && l === "  return (");
if (shellAt < 0 || returnAt < 0) throw new Error("return statement not found");
const extAt = lines.findIndex(trimIs("{activeExtensionDialog ? ("));
if (extAt < 0) throw new Error("extension dialog marker missing");
if (lines[extAt + 5].trim() !== ") : null}") throw new Error("extension dialog block unexpected");
const sideAt = lines.findIndex((l, i) => i > extAt && l.includes("{sidePanelVisible && selectedWorkspace"));
if (sideAt < 0) throw new Error("side panel marker missing");
const canvasAt = lines.findIndex(trimIs("<CanvasSurface"));
if (canvasAt < 0) throw new Error("CanvasSurface marker missing");
const selectSessionAt = lines.findIndex(
  (l, i) => i > canvasAt && l.trim() === "onSelectSession={handleSelectSession}"
);
if (selectSessionAt < 0 || lines[selectSessionAt + 1].trim() !== "/>")
  throw new Error("CanvasSurface props not as expected");

const edits = [
  { name: "canvas props", from: selectSessionAt + 1, to: selectSessionAt, insert: [
      "              embeddedChat={sessionConversation}",
      "              chatTarget={workbenchTarget}",
    ] },
  { name: "session node", from: returnAt, to: returnAt - 1, insert: [...sessionNode, ""] },
  { name: "branch uses the node", from: start, to: end - 1, insert: [lines[start], "            sessionConversation"] },
  { name: "modals at app level", from: sideAt, to: sideAt - 1, insert: shift(modals, modalShift) },
];

const next = [];
let cursor = 0;
for (const edit of edits.slice().sort((a, b) => a.from - b.from)) {
  if (edit.from < cursor) throw new Error(`overlapping edit: ${edit.name}`);
  next.push(...lines.slice(cursor, edit.from), ...edit.insert);
  cursor = edit.to + 1;
}
next.push(...lines.slice(cursor));
const updated = next.join("\n");

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
const deltas = new Map([
  ["const sessionConversation =", 1],
  ["embeddedChat={sessionConversation}", 1],
  ["chatTarget={workbenchTarget}", 1],
  ["onSelectSession={handleSelectSession}", 0],
  ["<ConversationTimeline", 0],
  ["<ComposerPanel", 0],
  ["{treeModalState.open ? (", 0],
  ["{forkModalState.open ? (", 0],
  ["schema-skew-notice", 0],
  ["scheduledBinding ? (", 0],
  ["<CanvasSurface", 0],
  ["<Workbench", 0],
  ["<ScheduledTasksView", 0],
]);
const checks = [...deltas].map(([needle, delta]) => {
  const expected = occurrences(original, needle) + delta;
  const actual = occurrences(updated, needle);
  return [actual === expected && (delta > 0 || expected > 0), `${needle} count ${actual} (expected ${expected})`];
});for (const [ok, label] of checks) if (!ok) throw new Error(`check failed: ${label}`);

const context = 3;
const hunks = [];
let replaced = 0;
for (const edit of edits.slice().sort((a, b) => a.from - b.from)) {
  const before = lines.slice(Math.max(0, edit.from - context), edit.from);
  const removed = edit.to >= edit.from ? lines.slice(edit.from, edit.to + 1) : [];
  const after = lines.slice(edit.to + 1, edit.to + 1 + context);
  replaced += removed.length;
  const body = [
    ...before.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...edit.insert.map((l) => `+${l}`),
    ...after.map((l) => ` ${l}`),
  ].join("\n");
  hunks.push(`@@\n${body}\n`);
}
if (replaced === 0) throw new Error("no source lines replaced");

writeFileSync(`${outDir}/app.patch`, `*** Begin Patch\n*** Update File: ${file}\n${hunks.join("")}*** End Patch\n`, "utf8");
writeFileSync(`${outDir}/expected-App.tsx`, updated, "utf8");
console.log(JSON.stringify({ originalLines: lines.length, updatedLines: next.length - 1, hunks: hunks.length, replaced, conversation: conversation.length, modals: modals.length, conversationShift, modalShift }, null, 2));
