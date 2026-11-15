import { expect, test } from "@playwright/test";
import { formatRunningLabel } from "../../src/features/conversation/hooks/use-running-label";

/** 右上角「已运行」标签格式化回归（真机 P0 期发现：7m345s——秒数未对 60 取模）。 */

function startedSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

test("未开始运行时显示占位文案", () => {
  expect(formatRunningLabel(undefined, "en")).toBe("Working…");
  expect(formatRunningLabel(undefined, "zh")).toBe("处理中…");
});

test("不足一分钟只显示秒", () => {
  expect(formatRunningLabel(startedSecondsAgo(30), "en")).toBe("Working for 30s");
  expect(formatRunningLabel(startedSecondsAgo(30), "zh")).toBe("已运行 30 秒");
});

test("超过一分钟后秒数对 60 取模进位（回归钉：修复前把总秒数传进模板显示 6m 405s）", () => {
  expect(formatRunningLabel(startedSecondsAgo(405), "en")).toBe("Working for 6m 45s");
  expect(formatRunningLabel(startedSecondsAgo(405), "zh")).toBe("已运行 6 分 45 秒");
});

test("整分钟不显示余秒", () => {
  expect(formatRunningLabel(startedSecondsAgo(420), "en")).toBe("Working for 7m");
  expect(formatRunningLabel(startedSecondsAgo(420), "zh")).toBe("已运行 7 分钟");
});
