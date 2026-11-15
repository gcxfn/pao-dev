import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  reloadDesktopRenderer,
} from "../helpers/electron-app";

/**
 * D5：「工作流主页 + 右栏阅读区」的布局与可访问性取证。
 *
 * 与 `workflow-cards.spec.ts` 的分工：那边验的是数据正确性（状态、人工门、产物流转），
 * 这里只验**兑现与操作**——三档宽度能不能用、触控目标够不够大、Tab/Enter/Space/Escape
 * 的落点对不对、切走再回来焦点有没有被抢、焦点环在中文名控件上是否可见。
 *
 * 为什么自带一份夹具而不是复用那边的：那边的 launch 函数是 spec 内私有的，
 * 而这里需要的是**同一个真实现场**（已交付的人工门 + 进行中的步骤 + 真实产物），
 * 抽公共 helper 要动别人正在改的文件；复制夹具脚本是这两条约束下的最小代价。
 * 数据来源与那边完全一致：真实内核构建产物 + 真实状态机，不手写状态。
 */
const execFileAsync = promisify(execFile);

const ARTIFACT_PATH = "创作成果/初稿.md";
const ARTIFACT_MARKER = "D5-LAYOUT-PROOF";

const FIXTURE_SCRIPT = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, project] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);

const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");
const feedback = await load("workflow/plan-feedback.js");

const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "小说首章",
  来源会话: "sess-d5-1",
  请求ID: "req-d5-1",
  已注册部门: ["策划部", "写作部", "审稿部", "资料部"],
  步骤: [
    // s1 是人工门审核节点：内核只允许「审核: true」的步骤做 decideNode，而标了审核就必须带部门标准；
    // 且内核要求回边必须指向依赖链上游，所以审核节点只能打回它的上游——这里没有更上游，
    // 所以 s1 不带回边，只在 s6 上做回边打回 s2（s6 依赖 s1，s2 依赖 s1，见下）。
    {
      标题: "讨论计划",
      部门: "策划部",
      要求: "把方向与章节计划讨论清楚",
      人工门: true,
      审核: true,
      部门标准: "方向可执行、与章节计划一致",
    },
    { 标题: "写初稿", 部门: "写作部", 要求: "按计划写初稿" },
    { 标题: "润色", 部门: "写作部", 要求: "把初稿的语言打磨一遍", 依赖: ["s2"] },
    { 标题: "审稿", 部门: "审稿部", 要求: "核对人物与情节一致性", 依赖: ["s3"] },
    { 标题: "定稿", 部门: "策划部", 要求: "定稿并归档", 依赖: ["s4"] },
    // s6 是并行组共同前置。它同时是审核节点并声明一条回边打回 s2：
    // 内核「回边必须指向依赖链上游」——s6 依赖 s1、s2 也依赖 s1，但要成为上游必须真正在链上，
    // 所以让 s6 依赖 s2，s2 就成了 s6 的上游。
    {
      标题: "拟定方向",
      部门: "策划部",
      要求: "定下资料检索方向",
      审核: true,
      部门标准: "方向可执行、与章节计划一致",
      依赖: ["s2"],
      回边: [{ 目标: "s2", 上限: 3, 超限动作: "停滞" }],
    },
    // 并行组：同前置 s6、部门互不相同、都只读、都没有人工门——四条同时成立内核才算真并行，
    // 界面才该画分组抬头（__group-head）。少一条就不成组，所以下面各加一条不满足的对照。
    { 标题: "查资料", 部门: "资料部", 要求: "查背景资料", 依赖: ["s6"], 只读: true },
    { 标题: "查竞品", 部门: "审稿部", 要求: "查同类作品", 依赖: ["s6"], 只读: true },
    // 对照组：同部门且同前置，内核按部门串行，界面不许把它算进并行组。
    { 标题: "写作子项甲", 部门: "写作部", 要求: "甲", 依赖: ["s6"], 只读: true },
    { 标题: "写作子项乙", 部门: "写作部", 要求: "乙", 依赖: ["s6"], 只读: true },
  ],
  当刻: "2026-10-17 10:00",
});

const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-d5-1",
  定义版本: 1,
  来源会话: "sess-d5-1",
});
await driver.startWorkflow(execution.配方, {}, {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-d5-1",
});
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
if (!identity) throw new Error("实例身份读不出来");
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID,
  定义版本: 1,
  启动请求ID: "start-d5-1",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: "sess-d5-1",
  受理时刻: "2026-10-17 10:01",
});

const options = {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId: "sess-d5-1",
};
const identityOf = (节点) => ({ 实例: identity.实例, 节点, 轮次: 1, 部长会话: "sess-d5-1" });
const status = (卡号, to, 时间) =>
  cards.changeCardStatus(cards.loadCard(execution.卡目录, cards.parseCardRef(卡号)), {
    操作者: "sess-d5-1",
    to,
    时间,
  });

mkdirSync(join(project, "创作成果"), { recursive: true });
writeFileSync(join(project, "创作成果", "初稿.md"), "# 初稿\\n\\n${ARTIFACT_MARKER}\\n", "utf8");
await control.bindMinister(execution.配方, options, "s1", "sess-d5-1");
const [first] = await control.addNodeCards(execution.配方, options, identityOf("s1"), [
  { goal: "写初稿", acceptance: "初稿可读" },
]);
status(first, "in_progress", "2026-10-17 10:05");
cards.appendReceipt(cards.loadCard(execution.卡目录, cards.parseCardRef(first)), {
  尝试号: 1,
  时间: "2026-10-17 10:30",
  结果: "success",
  摘要: "初稿完成",
  产物路径: ["${ARTIFACT_PATH}"],
});
status(first, "delivered", "2026-10-17 10:31");
await control.endDecomposition(execution.配方, options, identityOf("s1"));

await control.bindMinister(execution.配方, options, "s2", "sess-d5-1");
const [second] = await control.addNodeCards(execution.配方, options, identityOf("s2"), [
  { goal: "写初稿", acceptance: "初稿可读" },
]);
status(second, "in_progress", "2026-10-17 10:40");
// s2 必须先交付并结束拆解：s6 依赖 s2（这样 s2 才在 s6 的依赖链上游，回边才合法），
// 而内核 ready() 要求全部前置 complete——complete() 要求卡状态是 delivered，所以要真走交付。
cards.appendReceipt(cards.loadCard(execution.卡目录, cards.parseCardRef(second)), {
  尝试号: 1,
  时间: "2026-10-17 10:41",
  结果: "success",
  摘要: "初稿改完",
  产物路径: ["${ARTIFACT_PATH}"],
});
status(second, "delivered", "2026-10-17 10:42");
await control.endDecomposition(execution.配方, options, identityOf("s2"));

// s6：并行组共同前置且是审核节点。它必须真的交付并收尾拆解，下游 s7/s8 才停在「等待前序」而不是「等部长」,
// 分组抬头也才会同时出现在交界处。
await control.bindMinister(execution.配方, options, "s6", "sess-d5-1");
const [sixth] = await control.addNodeCards(execution.配方, options, identityOf("s6"), [
  { goal: "定方向", acceptance: "方向可执行" },
]);
status(sixth, "in_progress", "2026-10-17 10:45");
status(sixth, "delivered", "2026-10-17 10:50");
await control.endDecomposition(execution.配方, options, identityOf("s6"));

// 真实回边：先按核内状态机把 s6 的卡走完 in_progress → delivered，再做一版 change 判定打回 s2。
// 打回时内核 control.js:517 会把本轮「判定 + 理由」推进节点的「历史」数组，
// 桌面侧 temporary-plans-query.ts:308 再把「历史」投影成进度行的 records，
// 于是右栏「这一步的运行」里的 __record-verdict / __record-reason 是**真实控制正本投影**，
// 不是往 DOM 里硬塞的假数据。
//
// 为什么要打回而不能只做一次 pass：内核只在「打回」分支写「历史」（push 完就把 node.判定 清空），
// 单次 pass 只更新当前判定，records 仍为空，那两个 span 永远渲染不出来。
await control.decideNode(execution.配方, options, identityOf("s6"), {
  结果: "change",
  理由: "方向偏了，先按章节计划重定",
  引用: ["创作成果/初稿.md:1"],
  失败轴: "card",
  目标: "s2",
});

// 一条真实「投递失败」的意见：deriveTodos 的第四类来源，只往意见.md 落一行，
// 不动任何步骤状态与栏位宽度——这是最轻的待办触达方式。
// 走内核公开 API（记录 → 回执），不手写意见.md，免得格式漂移时测试骗人。
const recorded = await feedback.recordPlanFeedback({
  项目根: project,
  计划ID: created.计划ID,
  目标: { 类型: "步骤", 步骤ID: "s6" },
  正文: "资料检索方向再收窄一点",
  投递请求ID: "deliver-d5-1",
  来源会话: "sess-d5-1",
  当刻: "2026-10-17 11:00",
});
await feedback.recordPlanFeedbackDelivery({
  项目根: project,
  计划ID: created.计划ID,
  意见ID: recorded.entry.意见ID,
  送达: false,
  结果: "部长会话已结束，未能送达",
  投递请求ID: "deliver-d5-1",
  来源会话: "sess-d5-1",
  当刻: "2026-10-17 11:01",
});

console.log(JSON.stringify({ 计划ID: created.计划ID, 项目根: project }));
`;

const REGISTRY = `# 部门注册表

<!-- 唯一真相:名字/能力标签/库路径/建部日期 -->

| 名字 | 能力标签 | 库路径 | 建部日期 |
| --- | --- | --- | --- |
| 策划部 | 策划 | 部门/策划部/知识库 | 2026-10-17 |
| 写作部 | 写作 | 部门/写作部/知识库 | 2026-10-17 |
| 审稿部 | 审稿 | 部门/审稿部/知识库 | 2026-10-17 |
`;

/** 三档宽度：700 窄窗、900 常见笔记本、1280 桌面。 */
const WIDTHS = [
  { width: 700, height: 820, label: "700" },
  { width: 900, height: 900, label: "900" },
  { width: 1280, height: 960, label: "1280" },
] as const;

const proofDir = process.env.PI_APP_D5_PROOF_DIR?.trim();

async function saveProof(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ path: join(proofDir, name), fullPage: false });
}

async function launchD5Fixture() {
  const home = await makeWorkspace("d5-home");
  const project = await makeWorkspace("d5-project");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(home, "部门", "注册表.md"), REGISTRY, "utf8");

  const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const fixtureScript = join(home, "make-d5-fixture.mjs");
  await writeFile(fixtureScript, FIXTURE_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [fixtureScript, kernelDist, project], {
    windowsHide: true,
  });
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    计划ID: string;
    项目根: string;
  };

  // 中文界面：下面断言的中文控件名就是产品要交付的文案（默认 en 会渲染英文源串）。
  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "1" },
  });
  return { app, project, home, fixture };
}

/** 焦点环可见性：对比聚焦/失焦两态的实际描边与阴影，不认 `:focus-visible` 的意图。 */
async function readFocusDecoration(page: Page, selector: string) {
  return page.locator(selector).evaluate((node) => {
    const style = globalThis.getComputedStyle(node);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
    };
  });
}

test("三档宽度下工作流主页与右栏都可用：不横向溢出、触控目标达标、焦点不被抢", async () => {
  test.setTimeout(180_000);
  const { app } = await launchD5Fixture();
  try {
    const page = await app.firstWindow();
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");
    await page.locator(".workflow-cards__filter-panel > summary").click();
    await page.getByTestId("workflow-cards-overview").locator(":scope > summary").click();

    for (const { width, height, label } of WIDTHS) {
      await page.setViewportSize({ width, height });

      // 760px 以下侧栏是绝对定位的抽屉浮层（sidebar.css 的 @media (max-width:760px)），
      // 会盖住主区左侧。验收要的是「用户实际能用」的常态：窄窗先收起抽屉再看内容，
      // 否则量到的是浮层遮挡，不是布局缺陷。收起动作走产品自己的开关。
      const collapsed =
        (await page.getByTestId("sidebar-toggle").getAttribute("aria-pressed")) === "false";
      if (width <= 760 && !collapsed) {
        await page.getByTestId("sidebar-toggle").click();
      }

      // 窄窗下右栏允许折到下方，但阅读区本身必须还在，且必须在视口内可见。
      await expect(page.getByTestId("workflow-cards-inspector")).toBeVisible();

      const overflow = await page.evaluate(() => {
        const root = globalThis.document.documentElement;
        return {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          offenders: Array.from(globalThis.document.querySelectorAll<HTMLElement>("*"))
            .filter((node) => node.getBoundingClientRect().right > root.clientWidth + 1)
            .slice(0, 5)
            .map((node) => `${node.tagName.toLowerCase()}.${node.className || "(无类名)"}`),
        };
      });
      expect(
        overflow.scrollWidth,
        `${label}px 下根元素横向溢出；越界元素：${overflow.offenders.join("、") || "无"}`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);

      // 根元素不溢出还不够：中栏若自己 overflow-x:hidden，溢出的子元素会被静默裁掉
      // （文字从左侧被切掉的典型表现），根元素量不出来。这里逐元素量 scrollWidth，
      // 把「内容比容器宽」真正揪出来——裁剪对用户就是丢内容。
      const clipped = await page.evaluate(() => {
        const scope = globalThis.document.querySelector<HTMLElement>(".workflow-cards__main");
        if (!scope) {
          return ["找不到 .workflow-cards__main"];
        }
        const offenders: string[] = [];
        const walk = (el: HTMLElement): void => {
          if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
            offenders.push(
              `${el.tagName.toLowerCase()}.${el.className || "(无类名)"} 内容 ${el.scrollWidth}px > 容器 ${el.clientWidth}px`,
            );
          }
          for (const child of Array.from(el.children)) {
            if (child instanceof HTMLElement) {
              walk(child);
            }
          }
        };
        walk(scope);
        return offenders.slice(0, 5);
      });
      expect(clipped, `${label}px 下中栏有内容被横向裁掉`).toEqual([]);

      // 先把右栏切到 s6：它是夹具里唯一带「历史轮次」的步骤（真实回边打回后留下的判定与理由），
      // 「这一步的执行记录」里的 __record-verdict / __record-reason 只在这一步的详情里渲染。
      // 然后确保右栏停「步骤详情」面板——文件预览态下 StepDetail 整块不渲染，量不到那些类。
      await page.getByTestId("workflow-cards-step-s6").click();
      await page.getByTestId("workflow-cards-panel-step").click();
      // 右栏 detail-title 里的步骤名就是选中态的最好证据（detail-state 只放状态，不放名字）。
      await expect(page.getByTestId("workflow-cards-detail-state")).toBeVisible();
      await expect(page.locator(".workflow-cards__detail-title")).toContainText("拟定方向");

      // D1 定稿视图新增的结构类必须真的有样式落地：只有类名、没有规则的节点
      // 会退回浏览器默认排版（li 圆点、details 三角形、块级各占一行），不是「刚好没样式」。
      // 这里量 computed style，把「图纸上有、样式里没有」的类名抓出来。
      //
      // 关键在于「没渲染」不能算通过：夹具没触发的分支量到的是 undefined，
      // 若把它和「有样式」一起放过，这条断言就会给出虚假绿灯。所以三态分开记账，
      // 未渲染的逐条列进未验清单并打印出来——宁可显式报未覆盖，也不静默当通过。
      const styled = await page.evaluate(() => {
        const wanted = [
          "__group-head",
          "__records",
          "__record",
          "__record-raw",
          "__record-reason",
          "__record-round",
          "__record-verdict",
          "__todos",
          "__todo-list",
        ];
        return wanted.map((name) => {
          const el = globalThis.document.querySelector<HTMLElement>(`.workflow-cards${name}`);
          if (!el) {
            return { name, state: "未渲染" };
          }
          const style = globalThis.getComputedStyle(el);
          // 综合判定，不看单一属性：这个文件里已经有 list-style:none 的祖先约定，
          // 单拿 listStyleType 当判据会把「零样式」误判成「有样式」。
          const hasRule =
            style.display !== "block" ||
            style.paddingTop !== "0px" ||
            style.gap !== "normal" ||
            style.listStyleType !== "disc";
          return { name, state: hasRule ? "有样式" : "无样式" };
        });
      });
      const unstyled = styled.filter((item) => item.state === "无样式").map((item) => item.name);
      const uncovered = styled.filter((item) => item.state === "未渲染").map((item) => item.name);
      const covered = styled.filter((item) => item.state === "有样式").map((item) => item.name);
      // 显式打印三态清单：已验（有样式）与未验（本次数据没让该分支渲染）必须分开说清楚，
      // 不能让「没渲染」悄悄混进绿灯——那会变成虚假通过。
      console.log(
        `[D5] ${label}px 结构类样式 ｜ 已验有样式(${covered.length}): ${covered.join("、") || "无"}` +
          (uncovered.length > 0
            ? ` ｜ 未验·本次未渲染(${uncovered.length}): ${uncovered.join("、")}`
            : " ｜ 未验: 无"),
      );
      // 唯一硬失败：类名在 DOM 里存在却没有样式规则落地——这是真缺陷，必须红。
      expect(unstyled, `${label}px 下这些结构类没有样式落地`).toEqual([]);
      // 未渲染的类不进 covered 清单，只在上面日志里作为「未验」留痕，不当作通过也不当作失败。
      // 它们需要能让对应分支渲染的夹具才能验，见交付说明的「未验清单」。

      // 中栏到右栏的实际可用宽度：窄窗里若两栏并排装不下，就会出现「文字被挤到看不见」。
      const columns = await page.evaluate(() => {
        const pick = (sel: string): string => {
          const el = globalThis.document.querySelector<HTMLElement>(sel);
          if (!el) {
            return `${sel}=缺失`;
          }
          const r = el.getBoundingClientRect();
          return `${sel} 宽 ${r.width.toFixed(0)} 左 ${r.left.toFixed(0)}`;
        };
        return [
          pick(".workflow-cards"),
          pick(".workflow-cards__main"),
          pick(".workflow-cards__center"),
          pick(".workflow-cards__inspector"),
          pick(".workflow-cards__body"),
        ].join(" | ");
      });
      console.log(`[D5] ${label}px 栏位实测: ${columns}`);

      // 触控目标：主操作按钮按 WCAG 2.2 AA 的 24×24 CSS px 下限核（更严的 44×44 不适合桌面鼠标）。
      for (const testId of [
        "workflow-cards-next-pending",
        "workflow-cards-filter-waiting",
        "workflow-cards-tab-output",
      ]) {
        const box = await page.getByTestId(testId).boundingBox();
        expect(box, `${label}px 下 ${testId} 量不到尺寸`).not.toBeNull();
        expect(box!.height, `${label}px 下 ${testId} 高度不足 24px`).toBeGreaterThanOrEqual(24);
        expect(box!.width, `${label}px 下 ${testId} 宽度不足 24px`).toBeGreaterThanOrEqual(24);
      }

      // 待办区单独留一张：它是本批新增结构，截图要能直接看出三档下的实际排版，
      // 而不是「截图恰好停在别的滚动位置」。滚到可见再截，并记下它的实际宽度。
      const todoSection = page.getByTestId("workflow-cards-todos");
      await todoSection.scrollIntoViewIfNeeded();
      const todoBox = await todoSection.boundingBox();
      expect(todoBox, `${label}px 下待办区量不到尺寸`).not.toBeNull();
      console.log(
        `[D5] ${label}px 待办区 宽${Math.round(todoBox!.width)} 高${Math.round(todoBox!.height)}`,
      );
      await saveProof(page, `工作流-${label}-待办.png`);

      await saveProof(page, `工作流-${label}.png`);
    }

    // 760px 以下侧栏是浮层抽屉：收起后内容必须是完整可读宽度（这是窄窗主场景）。
    await page.setViewportSize({ width: 700, height: 820 });
    const toggleAfter = page.getByTestId("sidebar-toggle");
    if ((await toggleAfter.getAttribute("aria-pressed")) === "true") {
      await toggleAfter.click();
    }
    await expect(toggleAfter).toHaveAttribute("aria-pressed", "false");
    await saveProof(page, "工作流-窄窗收起抽屉.png");

    // 抽屉还能再打开（浮层复现），且打开后不改变主区内容宽度假设。
    await toggleAfter.click();
    await expect(toggleAfter).toHaveAttribute("aria-pressed", "true");
    await saveProof(page, "工作流-窄窗抽屉复开.png");
    await toggleAfter.click();

    // 右栏折到下方也不能只剩标题：正文/意见区要有非零可读高度。
    // 高度阈值取 UX 侧 120px：比「一整条挤没了」明显更高，也不预设 D5 要采用哪种折叠方式。
    const inspector = page.getByTestId("workflow-cards-inspector");
    const inspectorBox = await inspector.boundingBox();
    expect(inspectorBox!.height, "700px 下右栏被压成不可读的一条").toBeGreaterThanOrEqual(120);
    await page.setViewportSize({ width: 1280, height: 960 });
    await expect(inspector).toBeVisible();
    await saveProof(page, "工作流-恢复宽窗.png");

    // 焦点未被抢：刷新后焦点不落在任何输入控件上（这是「刷新不抢焦点」的可见证据）。
    await page.evaluate(() => (globalThis.document.activeElement as HTMLElement | null)?.blur());
    // 主进程会拦下页面重载，首个 reload 正常以 ERR_ABORTED 结束；走仓库既有重载助手，
    // 不在这里手写重试。
    await reloadDesktopRenderer(page);
    // 刷新后侧栏折叠状态会被记住（上面收起了抽屉），窄窗下 canvas 入口就藏在抽屉里，
    // 先把抽屉打开再走入口，否则量到的是「入口不可见」而不是焦点行为。
    if ((await page.getByTestId("sidebar-toggle").getAttribute("aria-pressed")) === "false") {
      await page.getByTestId("sidebar-toggle").click();
    }
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");
    const activeAfterReload = await page.evaluate(() => {
      const active = globalThis.document.activeElement;
      if (!(active instanceof HTMLElement)) {
        return "(无)";
      }
      return `${active.tagName.toLowerCase()}#${active.id || "-"}.${active.className || "-"}`;
    });
    expect(activeAfterReload, "刷新后焦点被抢到了输入控件").not.toMatch(/input|textarea|select/);
    await saveProof(page, "工作流-刷新后焦点.png");
  } finally {
    await app.close();
  }
});

test("键盘可操作：中文名可见、Tab 落点有序、Enter/Space 生效、Escape 收起并归还焦点", async () => {
  test.setTimeout(180_000);
  const { app } = await launchD5Fixture();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("小说首章");
    await page.locator(".workflow-cards__filter-panel > summary").click();

    // 中文控件名：读屏念出来的名字必须来自产品文案，不是空名或英文源串。
    const search = page.getByTestId("workflow-cards-search");
    await expect(search).toHaveAttribute("aria-label", /[\u4e00-\u9fa5]/);
    for (const testId of ["workflow-cards-next-pending", "workflow-cards-filter-waiting"]) {
      await expect(page.getByTestId(testId)).toHaveAccessibleName(/[\u4e00-\u9fa5]/);
    }
    // 步骤列表要有列表语义，单项要能报出自身状态（读屏靠它区分「等你确认/进行中」）。
    await expect(page.getByTestId("workflow-cards-steps")).toHaveRole("list");
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveRole("listitem");

    // 焦点环：必须用真实键盘走到元素上，才符合「键盘用户能看到焦点」的实际场景。
    // 不能用 element.focus()：程序化聚焦不一定让浏览器判定 :focus-visible，
    // 而产品全局焦点环基座（base.css 的 `button:focus-visible`）正是挂在 :focus-visible 上。
    const idle = await readFocusDecoration(page, '[data-testid="workflow-cards-next-pending"]');
    await page.getByTestId("workflow-cards-next-pending").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const focused = await readFocusDecoration(page, '[data-testid="workflow-cards-next-pending"]');
    const focusedIsActive = await page.evaluate(
      () =>
        (globalThis.document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ??
        "",
    );
    expect(focusedIsActive, "键盘 Tab 没有把焦点送到 next-pending").toBe(
      "workflow-cards-next-pending",
    );
    expect(
      focused.outlineWidth > idle.outlineWidth || focused.boxShadow !== idle.boxShadow,
      `键盘聚焦后没有可见焦点环：idle=${JSON.stringify(idle)} focused=${JSON.stringify(focused)}`,
    ).toBe(true);

    // Tab 落点：从搜索框按 Tab 必须走到下一个真实控件，而不是掉进不可见区域。
    await search.focus();
    await page.keyboard.press("Tab");
    const afterTab = await page.evaluate(() => {
      const active = globalThis.document.activeElement;
      if (!(active instanceof HTMLElement)) {
        return { tag: "(无)", testId: "", hidden: true };
      }
      const style = globalThis.getComputedStyle(active);
      return {
        tag: active.tagName.toLowerCase(),
        testId: active.getAttribute("data-testid") ?? "",
        hidden: style.visibility === "hidden" || style.display === "none",
      };
    });
    expect(afterTab.hidden, "Tab 落到了不可见元素").toBe(false);
    expect(["button", "input", "a", "select", "textarea"]).toContain(afterTab.tag);

    // 筛选按钮：Space 与 Enter 都必须真的切换状态（不是只有鼠标能用）。
    const waiting = page.getByTestId("workflow-cards-filter-waiting");
    await waiting.focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("workflow-cards-step-s1")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("workflow-cards-step-s1")).toBeVisible();

    // Escape 收起并归还焦点：打开产物预览后按 Escape，焦点要回到打开它的那个入口。
    const inspector = page.getByTestId("workflow-cards-inspector");
    await page.getByTestId("workflow-cards-tab-output").click();
    // 同一产物可能被多个步骤（多轮）引用，右栏会给出多个入口；只取第一个可见入口，
    // 不因为多了一个入口就把 strict mode 撞红——多入口本身是正确行为（多卡/多轮不取首卡代表）。
    const artifact = page.getByTestId(`workflow-cards-artifact-${ARTIFACT_PATH}`).first();
    await expect(artifact).toBeVisible();
    await artifact.click();
    await expect(page.getByTestId("workflow-cards-file-preview")).toBeVisible();
    await expect(inspector.getByTestId("workflow-cards-file-preview")).toBeVisible();
    const focusedInInspector = await inspector.evaluate((node) =>
      node.contains(globalThis.document.activeElement),
    );
    expect(focusedInInspector, "打开产物预览后焦点没进右栏，Escape 的归还目标不成立").toBe(true);
    await page.keyboard.press("Escape");
    const focusReturned = await artifact.evaluate(
      (node) => globalThis.document.activeElement === node,
    );
    expect(focusReturned, "Escape 后焦点没有回到打开预览的那个入口").toBe(true);

    await saveProof(page, "键盘-Escape归还焦点.png");
  } finally {
    await app.close();
  }
});
