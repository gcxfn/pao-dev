import assert from "node:assert/strict";
import test from "node:test";

test("loader resolves to the native public PAO desktop module", async () => {
  const { loadPaoDesktopModule } = await import("../dist/pao-desktop-module.js");
  const [loaded, native] = await Promise.all([
    loadPaoDesktopModule(),
    import("@earendil-works/pi-coding-agent/pao/desktop"),
  ]);
  assert.equal(loaded, native);
  for (const name of [
    "readDesktopCanvas",
    "readDesktopNodeDetail",
    "readDesktopProject",
    "readDesktopSessionIncrement",
    "readDesktopFlows",
    "readDesktopPlans",
    "readDesktopDeptCatalog",
    "readDesktopDeptDetail",
    "runDesktopFlowCommand",
    "startDesktopWorkflow",
  ] as const) {
    assert.equal(typeof loaded[name], "function", `${name} should be exported by pao/desktop`);
  }
});
