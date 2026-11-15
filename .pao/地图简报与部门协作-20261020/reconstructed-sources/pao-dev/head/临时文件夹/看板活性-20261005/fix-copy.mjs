import { readFileSync, writeFileSync } from "node:fs";
const src = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/workboard/kanban-board.tsx";
let t = readFileSync(src, "utf8");
const old = `  const copy = async () => {
    if (command === null) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // 剪贴板不可用不报成功：指令仍留在只读文本框里，用户可手动复制。
      setCopied(false);
    }
  };`;
if (!t.includes(old)) throw new Error("copy 锚点不匹配");
const next = `  const copy = () => {
    if (command === null) return;
    navigator.clipboard
      .writeText(command)
      .then(() => setCopied(true))
      // 剪贴板不可用不报成功：指令仍留在只读文本框里，用户可手动复制。
      .catch(() => setCopied(false));
  };`;
t = t.replace(old, next);
t = t.replace("onClick={() => void copy()}", "onClick={copy}");
writeFileSync(src, t);
console.log("ok");