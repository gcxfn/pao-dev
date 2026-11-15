// O14 独立复核探针（跑完即删）：复制 candidates.ts:331 diffsEqual 的实现，
// 对偶构造验边界相等/不等语义。
function diffsEqual(a, b) {
  const key = (diffs) =>
    diffs
      .map((d) => ({ path: d.path, kind: d.kind, newContent: d.newContent ?? "" }))
      .sort((x, y) => x.path.localeCompare(y.path) || x.kind.localeCompare(y.kind));
  const ka = key(a);
  const kb = key(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (item, index) =>
      item.path === kb[index].path && item.kind === kb[index].kind && item.newContent === kb[index].newContent,
  );
}
const cases = [
  // [名称, a, b, 期望相等?]
  ["完全相同", [{path:"f",kind:"edit",newContent:"x"}], [{path:"f",kind:"edit",newContent:"x"}], true],
  ["同path不同newContent", [{path:"f",kind:"edit",newContent:"x"}], [{path:"f",kind:"edit",newContent:"y"}], false],
  ["同内容不同kind(edit vs create)", [{path:"f",kind:"edit",newContent:"x"}], [{path:"f",kind:"create",newContent:"x"}], false],
  ["edit有diff字段 vs edit无diff字段(同newContent)", [{path:"f",kind:"edit",diff:"@@",newContent:"x"}], [{path:"f",kind:"edit",newContent:"x"}], true],
  ["delete(无newContent) vs edit newContent=''", [{path:"f",kind:"delete"}], [{path:"f",kind:"edit",newContent:""}], false],
  ["顺序不同内容同", [{path:"a",kind:"edit",newContent:"1"},{path:"b",kind:"create",newContent:"2"}], [{path:"b",kind:"create",newContent:"2"},{path:"a",kind:"edit",newContent:"1"}], true],
  ["长度不同", [{path:"f",kind:"edit",newContent:"x"}], [{path:"f",kind:"edit",newContent:"x"},{path:"g",kind:"delete"}], false],
  ["edit newContent undefined vs ''", [{path:"f",kind:"edit"}], [{path:"f",kind:"edit",newContent:""}], true],
];
let fail = 0;
for (const [name, a, b, expected] of cases) {
  const got = diffsEqual(a, b);
  const ok = got === expected;
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${got} expected=${expected}`);
}
console.log(fail === 0 ? "全部边界符合预期" : `${fail} 处不符合`);
