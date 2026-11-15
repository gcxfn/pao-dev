import assert from "node:assert/strict";
import test from "node:test";
import { mergeEnabledModelPatterns } from "../src/runtime-types.ts";

test("merges provider model patterns after existing entries without duplicates", () => {
  assert.deepEqual(
    mergeEnabledModelPatterns(
      ["provider-a/first", "provider-b/second"],
      ["provider-a/first", "provider-c/third", "provider-c/third"],
    ),
    ["provider-a/first", "provider-b/second", "provider-c/third"],
  );
});

test("returns the existing order and length when every provider pattern is already present", () => {
  const current = ["provider-b/second", "provider-a/first"] as const;
  const merged = mergeEnabledModelPatterns(current, ["provider-a/first", "provider-b/second"]);

  assert.deepEqual(merged, current);
  assert.equal(merged.length, current.length);
});

test("handles empty inputs without manufacturing a model pattern", () => {
  assert.deepEqual(mergeEnabledModelPatterns([], []), []);
  assert.deepEqual(mergeEnabledModelPatterns([], ["provider/model"]), ["provider/model"]);
});
