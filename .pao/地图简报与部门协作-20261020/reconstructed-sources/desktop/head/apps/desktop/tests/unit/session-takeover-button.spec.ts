import { beforeAll, expect, test } from "@playwright/test";

/**
 * W-bug9 接管按钮点击策略（timeline-item.tsx handleSessionTakeoverClick）：
 * 确认弹窗取消 → 不提交任何接管命令；确认 → 恰好提交一条 /pao runtime takeover。
 * 组件模块含 JSX，按 canvas-node-detail.spec 同款 jsx-runtime shim 导入。
 */

let handleSessionTakeoverClick: (typeof import("../../src/features/conversation/timeline-item"))["handleSessionTakeoverClick"];

beforeAll(() => {
  const real = require("react/jsx-runtime");
  require.cache[require.resolve("playwright/jsx-runtime")] = {
    id: "react/jsx-runtime",
    filename: require.resolve("react/jsx-runtime"),
    loaded: true,
    exports: real,
  } as never;
  ({ handleSessionTakeoverClick } =
    require("../../src/features/conversation/timeline-item") as typeof import("../../src/features/conversation/timeline-item"));
});

const TOKEN = "39c64f0e-1c1b-4a8f-9d0a-6fb4c2a6f001";

function run(confirmed: boolean, alreadySubmitted = false) {
  const commands: string[] = [];
  const submitted = handleSessionTakeoverClick({
    confirmed,
    token: TOKEN,
    alreadySubmitted,
    submit: (command) => commands.push(command),
  });
  return { commands, submitted };
}

test("确认弹窗取消：不提交任何接管命令", () => {
  const { commands, submitted } = run(false);
  expect(commands).toEqual([]);
  expect(submitted).toBe(false);
});

test("确认接受：恰好提交一条 /pao runtime takeover <token>", () => {
  const { commands, submitted } = run(true);
  expect(commands).toEqual([`/pao runtime takeover ${TOKEN}`]);
  expect(submitted).toBe(true);
});

test("连点防护：已提交过再点击不重复提交（F8 钉防双发）", () => {
  const { commands, submitted } = run(true, true);
  expect(commands).toEqual([]);
  expect(submitted).toBe(false);
});
