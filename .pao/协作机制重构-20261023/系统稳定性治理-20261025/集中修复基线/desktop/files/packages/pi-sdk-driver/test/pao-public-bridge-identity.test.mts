import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadPaoCardOps } from "../dist/pao-card-ops.js";
import {
  loadPaoDesktopCanvas,
  loadPaoDesktopNodeDetail,
  loadPaoDesktopRuntimeReader,
} from "../dist/pao-canvas.js";
import { loadPaoDesktopDept } from "../dist/pao-dept.js";
import { loadPaoDesktopFlowControl } from "../dist/pao-flow-control.js";
import {
  loadPaoKanbanReader,
  loadPaoWorkboardSessionReader,
} from "../dist/pao-kanban.js";
import { loadPaoDesktopPlans } from "../dist/pao-plans.js";
import { loadPaoDesktopWorkflow } from "../dist/pao-workflow.js";
import { loadPaoWorkboardAggregates } from "../dist/pao-workboard.js";

test("migrated bridges load real functions from the native public PAO entries", async () => {
  const [
    desktop,
    root,
    cardOps,
    canvas,
    nodeDetail,
    runtime,
    dept,
    flowControl,
    kanban,
    workboardSession,
    plans,
    workflow,
    workboard,
  ] =
    await Promise.all([
      import("@earendil-works/pi-coding-agent/pao/desktop"),
      import("@earendil-works/pi-coding-agent/pao"),
      loadPaoCardOps(),
      loadPaoDesktopCanvas(),
      loadPaoDesktopNodeDetail(),
      loadPaoDesktopRuntimeReader(),
      loadPaoDesktopDept(),
      loadPaoDesktopFlowControl(),
      loadPaoKanbanReader(),
      loadPaoWorkboardSessionReader(),
      loadPaoDesktopPlans(),
      loadPaoDesktopWorkflow(),
      loadPaoWorkboardAggregates(),
    ]);

  assert.equal(typeof root.readCard, "function");
  assert.equal(typeof cardOps.readCard, "function");
  assert.equal(typeof cardOps.changeCardStatus, "function");
  assert.equal(typeof desktop.readDesktopCanvas, "function");
  assert.equal(typeof canvas, "function");
  assert.equal(typeof desktop.readDesktopNodeDetail, "function");
  assert.equal(typeof nodeDetail, "function");
  assert.equal(typeof runtime.readDesktopProject, "function");
  assert.equal(typeof runtime.readDesktopSessionIncrement, "function");
  assert.equal(typeof dept.readDesktopDeptCatalog, "function");
  assert.equal(typeof dept.readDesktopDeptDetail, "function");
  assert.equal(typeof flowControl.readDesktopFlows, "function");
  assert.equal(typeof flowControl.runDesktopFlowCommand, "function");
  assert.equal(typeof desktop.readDesktopPending, "function");
  assert.equal(typeof kanban, "function");
  assert.equal(typeof workboardSession.readDesktopExecution, "function");
  assert.equal(typeof workboardSession.readDesktopWorkflowMinister, "function");
  assert.equal(typeof plans.readDesktopPlans, "function");
  assert.equal(typeof workflow.readDesktopRecipeCatalog, "function");
  assert.equal(typeof workflow.previewDesktopWorkflow, "function");
  assert.equal(typeof workflow.installDesktopTemplate, "function");
  assert.equal(typeof workflow.saveDesktopRecipe, "function");
  assert.equal(typeof workflow.deleteDesktopRecipe, "function");
  assert.equal(typeof workflow.startDesktopWorkflow, "function");
  assert.equal(typeof workboard.workflowInstances, "function");
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const home = await fs.mkdtemp(`${tmpdir()}/pao-public-bridge-`);
  try {
    assert.deepEqual((await canvas(home)).配方, []);
    const project = await runtime.readDesktopProject(home, "missing-session");
    assert.equal(resolve(project.projectRoot), resolve(home));
    assert.deepEqual(project.cards, []);
    assert.deepEqual(project.execution, []);
    assert.deepEqual(project.issues, []);
    const catalog = workflow.readDesktopRecipeCatalog(home);
    assert.ok(Array.isArray(catalog.recipes));
    assert.ok(Array.isArray(catalog.departments));
    assert.ok(Array.isArray(catalog.tiers));
    assert.deepEqual(await flowControl.readDesktopFlows(home), { 工作流: [], 问题: [] });
    assert.deepEqual(await plans.readDesktopPlans(home), { 计划: [], 问题: [] });
    assert.throws(
      () => dept.readDesktopDeptCatalog("missing-session", home, { paoHome: home }),
      /原会话 owner 不可用或已切换/,
    );
    assert.deepEqual(await workboard.workflowInstances(home), {
      挂起: [],
      异常: [],
    });
    assert.deepEqual(await workboard.pending(home), []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
