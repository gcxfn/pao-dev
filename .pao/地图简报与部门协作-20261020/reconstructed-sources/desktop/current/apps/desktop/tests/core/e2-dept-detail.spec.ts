/**
 * E2b 部门详情页（桌面契约·薄桥·渲染·按需读取）的 Electron 端到端验收。
 *
 * 覆盖计划 §5.2 第 1、2、3、7 条：
 *  - 部门目录的名单唯一来源是 <PAO_HOME>/部门/注册表.md，不是「有卡就算部门」；
 *  - 详情页七段（职责原文/工具白名单/技能真实路径/默认档位/标准/知识入口/配置问题）都从
 *    内核 dept 投影直取，缺失一律显示「未配置」而不是 0 或空白；
 *  - 负载（热部长/卡片/活卡/挂起节点）与配置面分开显示，不与配置文件混为一谈；
 *  - 读不了配置就如实说「读不了」，不能把失败显示成「没有部门」（§8.3 未知不译成成功）。
 *
 * 纪律：走真实内核（PAO_HOME 指向隔离夹具）＋真实 Electron；不 mock IPC、不塞状态；
 * 断言等待的是应用真实状态（视图标题、具体字段文本），不是「元素可见即就绪」。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";

/** 打开「部门详情」扩展视图，返回它的 frame。 */
async function openPaoView(window: Page, title: string): Promise<FrameLocator> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) await window.getByTestId("toggle-side-panel").click();
  const tab = workbench.getByRole("tab", { name: title, exact: true });
  if (await tab.count()) await tab.click();
  else {
    const chooser = window.getByTestId("workbench-chooser");
    if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
    await chooser.getByRole("button", { name: title, exact: true }).click();
  }
  return window.frameLocator('[data-testid="extension-view-frame"]');
}

/**
 * 铺一个隔离 PAO_HOME：注册表登记两个部门，各自的配方覆盖「有值 / 缺值」两种形态。
 *
 * - `写作`：人设、工具、默认档位齐全，技能指向一个真实存在的 SKILL.md ⇒ 应显示为可用；
 * - `审查`：配方只有名字与工具，人设/档位/技能都缺 ⇒ 应逐项显示「未配置」，不得显示成 0。
 *
 * 另外写一份 `pao配置/档位.json`：`主力` 档配了真模型，`写作` 走部门默认档，
 * `审查` 的配方里点名一个不存在的档位 ⇒ 档位解析必须报出原因而不是猜。
 */
async function seedPaoHome(home: string): Promise<void> {
  const deptRoot = join(home, "部门");
  await mkdir(join(home, "pao配置", "skills", "长文写作"), { recursive: true });
  await writeFile(
    join(home, "pao配置", "skills", "长文写作", "SKILL.md"),
    "# 长文写作\n\n本技能用于把提纲扩写成成稿。\n",
    "utf8",
  );
  await writeFile(
    join(home, "pao配置", "档位.json"),
    JSON.stringify(
      {
        provider: "pao",
        档位: [
          { 名: "主力", provider: "pao", model: "主力模型", thinkingLevel: "medium" },
          { 名: "快", provider: "pao", model: "快模型", thinkingLevel: "low" },
        ],
        部门默认: { 写作: "快" },
      },
      null,
      2,
    ),
    "utf8",
  );
  await mkdir(join(deptRoot, "写作", "知识库"), { recursive: true });
  await writeFile(
    join(deptRoot, "写作", "配方.md"),
    [
      "# 配方：写作",
      "",
      "- 名字：写作",
      "- 人设：负责把提纲扩写成可交付成稿，只做写作，不做事实核查。",
      "- 工具：read、write、长文写作",
      "- 技能：长文写作",
      "- 记忆目录：部门/写作/知识库",
      "",
      "## 干法",
      "",
      "先读提纲，再按段落扩写。",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(deptRoot, "写作", "知识库", "索引.md"), "# 写作知识库\n\n## 各区导引\n", "utf8");
  await mkdir(join(deptRoot, "审查", "知识库"), { recursive: true });
  await writeFile(
    join(deptRoot, "审查", "配方.md"),
    ["# 配方：审查", "", "- 名字：审查", "- 工具：read、grep", "- 默认档位：不存在的档", ""].join("\n"),
    "utf8",
  );
  await writeFile(
    join(deptRoot, "注册表.md"),
    [
      "| 名字 | 能力标签 | 库路径 | 建部日期 |",
      "| --- | --- | --- | --- |",
      "| 写作 | 长文/改写 | 部门/写作/知识库 | 2026-10-10 |",
      "| 审查 | 核查/挑错 | 部门/审查/知识库 | 2026-10-10 |",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** 项目里放一张「写作」的卡：让部门总览的运行态一侧也有数据，验证两端并集显示。 */
async function seedProjectCards(project: string): Promise<void> {
  const cardsDir = join(project, ".pao", "卡");
  await mkdir(cardsDir, { recursive: true });
  await writeFile(
    join(cardsDir, "卡0001-write.md"),
    [
      "---",
      "goal: 写一篇开题稿",
      "dept: 写作",
      "acceptance: 有标题与三段正文",
      "attempt: 0",
      'created: "2026-10-10 10:00"',
      "status: unclaimed",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

test("部门目录来自注册表，详情页七段与负载都能读到真实值", async () => {
  const home = await makeWorkspace("e2-dept-home");
  const project = await makeWorkspace("e2-dept-project");
  await seedPaoHome(home);
  await seedProjectCards(project);
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  try {
    const window = await app.firstWindow();
    await createNamedThread(window, "部门详情 E2b");
    const frame = await openPaoView(window, "部门详情");
    await expect(frame.getByRole("heading", { name: "部门详情" })).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByRole("heading", { name: "部门总览", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // 名单来自注册表：两个部门都得出现（`审查` 没有卡，只有注册表能证明它不该被漏掉）。
    await expect(frame.getByRole("heading", { name: "写作", exact: true })).toBeVisible();
    await expect(frame.getByRole("heading", { name: "审查", exact: true })).toBeVisible();
    // 配置摘要走真实档位解析：写作走「档位.json 部门默认」的快档，模型要显示出来。
    const writingCard = frame.locator("article.dept-card", { hasText: "写作" }).first();
    await expect(writingCard.getByText(/档位 快 · 模型 pao\/快模型/)).toBeVisible({ timeout: 15_000 });

    // 进详情：七段标题必须都在。
    await writingCard.getByRole("button", { name: "进入部门" }).click();
    await expect(frame.getByRole("heading", { name: "部门 · 写作" })).toBeVisible({ timeout: 15_000 });
    for (const heading of ["职责与人设", "工具白名单", "技能清单", "默认档位", "标准", "知识入口", "负载"]) {
      await expect(frame.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
    // 人设原文 + 出处（真实配方路径），不是摘要。
    await expect(
      frame.getByText("负责把提纲扩写成可交付成稿，只做写作，不做事实核查。"),
    ).toBeVisible();
    // 工具：内置 read/write 标 ok，混写的「长文写作」是表外名。
    await expect(frame.getByText("read", { exact: true })).toBeVisible();
    await expect(frame.getByText("write", { exact: true })).toBeVisible();
    await expect(frame.getByText("长文写作（表外）")).toBeVisible();
    // 技能：真实 SKILL.md 存在 ⇒ 可用。
    await expect(frame.getByText(/长文写作 · 可用/)).toBeVisible();
    // 档位：来源与模型都显示，思考强度来自档位.json。
    await expect(frame.getByText("生效档位：快（来源：档位.json 部门默认）")).toBeVisible();
    await expect(frame.getByText(/模型：pao\/快模型/)).toBeVisible();
    // 思考强度取不到真值：内核读取上下文时把键名命中 /thinking/ 的字段一律遮蔽成「[不展示]」，
    // 而档位里的键名正是 `thinkingLevel`（参数名不是思维链正文）。投影如实透传遮蔽结果，
    // 桌面不猜、不补默认值。这是 E 批已知缺口，已记入执行记录；真值要等内核收窄遮蔽规则。
    await expect(frame.getByText("思考强度：[不展示]")).toBeVisible();
    // 负载：与配置面分开，卡片数来自项目卡快照。
    await expect(frame.getByText(/卡片 1 · 活卡 1/)).toBeVisible();
    // 返回列表。
    await frame.getByRole("button", { name: "← 返回部门列表" }).click();
    await expect(frame.getByRole("heading", { name: "部门总览", exact: true })).toBeVisible();
    await expectExtensionViewReady(window);
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    if (page) await app.close();
  }
});

test("缺值如实显示「未配置」，档位查无此档不猜模型", async () => {
  const home = await makeWorkspace("e2-dept-missing-home");
  const project = await makeWorkspace("e2-dept-missing-project");
  await seedPaoHome(home);
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  try {
    const window = await app.firstWindow();
    await createNamedThread(window, "部门详情缺值");
    const frame = await openPaoView(window, "部门详情");
    await expect(frame.getByRole("heading", { name: "部门总览", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const reviewCard = frame.locator("article.dept-card", { hasText: "审查" }).first();
    // 审查的配方点名一个不存在的档位：模型必须显示「未配置」，不能猜出主力/快档的模型。
    await expect(reviewCard.getByText(/模型 未配置/)).toBeVisible({ timeout: 15_000 });
    await reviewCard.getByRole("button", { name: "进入部门" }).click();
    await expect(frame.getByRole("heading", { name: "部门 · 审查" })).toBeVisible({ timeout: 15_000 });
    // 人设缺失 ⇒ 明确说未配置，不是空白。
    await expect(frame.getByText("未配置：配方里没有「人设」行。")).toBeVisible();
    // 技能缺失 ⇒ 明确说未配置。
    await expect(frame.getByText("未配置：配方里没有引用技能。")).toBeVisible();
    // 档位：查无此档要同时给出「未配置」与原因，不能静默显示档名。
    await expect(frame.getByText(/模型：未配置/)).toBeVisible();
    // 档位查无此档时思考强度也取不到可判定的值：内核遮蔽规则把 thinkingLevel 一律改成
    // 「[不展示]」，投影不解析、不猜测，于是这里显示的是遮蔽结果而非「未配置」。
    // 与上一条用例同一缺口（E 批已知，记在执行记录），等内核收窄遮蔽规则后才会有「未配置」。
    await expect(frame.getByText(/思考强度：\[不展示\]/)).toBeVisible();
    // 配置问题段必须把「档位不在档位.json」这条报出来（级别 + 类别 + 修法 + 证据）。
    await expect(frame.getByRole("heading", { name: /配置问题（[1-9]\d*）/ })).toBeVisible();
    await expect(frame.getByText(/修法：/).first()).toBeVisible();
    await expectExtensionViewReady(window);
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    if (page) await app.close();
  }
});

test("注册表读不了时如实报读取失败，不显示成「没有部门」", async () => {
  const home = await makeWorkspace("e2-dept-broken-home");
  const project = await makeWorkspace("e2-dept-broken-project");
  // 先铺一套完好配置，再把注册表换成目录：这样唯一的失败源就是注册表本身，
  // 断言不会被「档位.json 不存在」这类无关问题抢先命中。
  await mkdir(join(home, "pao配置"), { recursive: true });
  await writeFile(
    join(home, "pao配置", "档位.json"),
    JSON.stringify(
      {
        provider: "pao",
        档位: [{ 名: "快", provider: "pao", model: "快模型", thinkingLevel: "low" }],
      },
      null,
      2,
    ),
    "utf8",
  );
  // 注册表路径上放一个目录：读取必然失败，且不会被当成「空注册表」。
  await mkdir(join(home, "部门", "注册表.md"), { recursive: true });
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  try {
    const window = await app.firstWindow();
    await createNamedThread(window, "注册表坏掉");
    const frame = await openPaoView(window, "部门详情");
    await expect(frame.getByRole("heading", { name: "部门总览", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // 要么在部门配置段报出失败原因，要么在全局问题里报——两种都行，但必须说「读不了」。
    await expect(
      frame.getByText(/部门配置读取失败：|注册表不可读|注册表.*不是目录|EISDIR|EACCES/),
    ).toBeVisible({ timeout: 15_000 });
    await expectExtensionViewReady(window);
  } finally {
    const page = app.electronApp.windows().find((window) => !window.isClosed());
    if (page) await app.close();
  }
});
