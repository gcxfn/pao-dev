import { expect, test } from "@playwright/test";
import { formatLocalMinute, formatRelativeTime } from "../../src/lib/string-utils";

test("formatLocalMinute 把机器时刻转成本地分钟精度，坏值原样返回", () => {
  // 同一时刻无论时区偏移，展示的都必须是本地墙钟（与内核 utcToLocalDisplay 同口径）。
  const iso = "2026-10-05T10:05:00.000Z";
  const local = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const expected = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`;
  expect(formatLocalMinute(iso)).toBe(expected);
  // 秒被截掉（分钟精度），不显示毫秒与 Z。
  expect(formatLocalMinute(iso)).not.toContain("Z");
  expect(formatLocalMinute(iso)).not.toContain(".");
  // 坏值不抛，原样返回，展示面不编造。
  expect(formatLocalMinute("坏时间")).toBe("坏时间");
  expect(formatLocalMinute("")).toBe("");
});

test("formatRelativeTime 仍按既有口径输出相对时长", () => {
  expect(formatRelativeTime("坏时间")).toBe("坏时间");
  expect(formatRelativeTime("")).toBe("");
  expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m");
});
