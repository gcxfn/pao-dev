import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPaoCardOps } from "../dist/pao-card-ops.js";

function cardText(status, owner) {
  return [
    "---",
    "goal: public card bridge test",
    "dept: engineering",
    "acceptance: test",
    "attempt: 1",
    'created: "2026-10-22 12:00"',
    `status: ${status}`,
    ...(owner === undefined ? [] : [`owner: ${owner}`]),
    "---",
    "",
  ].join("\n");
}

test("card operations use the public PAO entry and preserve disk-backed state rules", async () => {
  const root = mkdtempSync(join(tmpdir(), "pao-card-ops-public-"));
  const cardsDir = join(root, ".pao", "cards");
  const cardPath = join(cardsDir, "卡0002-owner.md");
  mkdirSync(cardsDir, { recursive: true });
  writeFileSync(cardPath, cardText("in_progress", "owner-a"), "utf8");
  try {
    const cards = await loadPaoCardOps();
    const card = cards.readCard(cardPath);
    assert.equal(card.card_no, 2);
    assert.equal(card.frontmatter.status, "in_progress");
    assert.equal(card.frontmatter.owner, "owner-a");
    assert.equal(readFileSync(cardPath, "utf8"), cardText("in_progress", "owner-a"));

    assert.throws(
      () =>
        cards.changeCardStatus(card, {
          操作者: "different-owner",
          to: "canceled",
          依据: "owner check",
          时间: "2026-10-22 12:01",
        }),
      (error) => error?.code === "FORBIDDEN_WRITER",
    );
    assert.equal(card.frontmatter.status, "in_progress");
    assert.equal(readFileSync(cardPath, "utf8"), cardText("in_progress", "owner-a"));

    const updated = cards.changeCardStatus(card, {
      操作者: "owner-a",
      to: "canceled",
      依据: "owner check",
      时间: "2026-10-22 12:02",
    });
    assert.equal(updated.frontmatter.status, "canceled");
    const disk = cards.readCard(cardPath);
    assert.equal(disk.frontmatter.status, "canceled");
    assert.equal(disk.frontmatter.owner, "owner-a");
    assert.match(disk.body, /2026-10-22 12:02/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
