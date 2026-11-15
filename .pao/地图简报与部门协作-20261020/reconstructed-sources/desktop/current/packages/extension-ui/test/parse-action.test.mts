import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopHostAction } from "../dist/browser.js";

await test("openView accepts the canvas and workboard views only", () => {
  assert.deepEqual(parseDesktopHostAction({ type: "openView", view: "canvas" }), {
    type: "openView",
    view: "canvas",
  });
  assert.deepEqual(parseDesktopHostAction({ type: "openView", view: "workboard" }), {
    type: "openView",
    view: "workboard",
  });
});

await test("openView rejects unknown views, missing fields, and extra keys", () => {
  assert.throws(() => parseDesktopHostAction({ type: "openView", view: "settings" }));
  assert.throws(() => parseDesktopHostAction({ type: "openView", view: "threads" }));
  assert.throws(() => parseDesktopHostAction({ type: "openView" }));
  assert.throws(() => parseDesktopHostAction({ type: "openView", view: "" }));
  assert.throws(() => parseDesktopHostAction({ type: "openView", view: "canvas", extra: 1 }));
});
