// 用途：为 E2E 终报提供两条可复现的判据（只读，不触碰产品代码）。
// 输入：无。输出：stdout 文本。
// 判据一：#20 的附件 id 为什么被 attachment-store.ts:241 的正则拒掉。
// 判据二：#21 的 CSS 属性选择器在 Windows 路径上为什么匹配不到（反斜杠被当转义吞掉）。
// 判据三：#25 与 #21 同病根（文件名保留「两条」，实际已含三条判据）。
const id = "queued-message-1:image:0:1e7ef36d-b000-4f3b-95d9-3068deaa7bf";
const re = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
console.log("=== #20 attachment id validation ===");
console.log("id        = " + id);
console.log("length    = " + id.length);
console.log("regexPass = " + re.test(id));
const bad = [...id].map((c, i) => [c, i]).filter(([c]) => !/[A-Za-z0-9._-]/.test(c));
console.log("badChars  = " + JSON.stringify(bad));

// CSS 字符串解析：反斜杠 + 非十六进制字符 = 该字符本身；反斜杠 + 十六进制 = 码点。
const cssUnescape = (s) =>
  s.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_m, g) => {
    if (/^[0-9a-fA-F]/.test(g)) return String.fromCodePoint(parseInt(g.trim(), 16));
    return g;
  });
const path =
  "C:\\Users\\ASUS\\AppData\\Local\\Temp\\pi-gui-user-data-abpAru\\worktrees\\review-checkout-root\\wt-c3793e";
const selectorValue = `[data-option-id="${path}"]`;
const bare = selectorValue.slice('[data-option-id="'.length, -2);
console.log("");
console.log("=== #21 CSS attribute selector ===");
console.log("attrValueInDom = " + path);
console.log("selectorValue  = " + selectorValue);
console.log("cssParsedValue = " + cssUnescape(bare));
console.log("matchesDomAttr = " + (cssUnescape(bare) === path));

// 判据三：#25 sidebar-folder-collapse.spec.ts:33 把工作区绝对路径拼进 CSS 属性选择器。
const workspaceId =
  "C:\\Users\\ASUS\\AppData\\Local\\Temp\\pi-gui-workspace-seRWHJ\\collapse-alpha";
const groupSelector = `.workspace-group[data-workspace-id="${workspaceId}"]`;
const groupBare = groupSelector.slice(
  '.workspace-group[data-workspace-id="'.length,
  -2,
);
console.log("");
console.log("=== #25 CSS attribute selector ===");
console.log("attrValueInDom  = " + workspaceId);
console.log("selectorValue   = " + groupSelector);
console.log("cssParsedValue  = " + cssUnescape(groupBare));
console.log("matchesDomAttr  = " + (cssUnescape(groupBare) === workspaceId));
