/** 真实 Electron 操作内核控制；隔离无模型实例，不证明 worker 启动或真实交付。 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";
const runFile = promisify(execFile);

/** 项目 .pao 下递归收集实例清单与卡文件名（启动场景的落盘断言用）。 */
async function walkNames(project: string, prefix: string): Promise<string[]> {
  try {
    const entries = await readdir(join(project, ".pao"), { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

test("主控暂停与人工恢复真实落盘，确认未交付节点显示内核拒绝", async () => {
  const home = await makeWorkspace("workflow-control-home");
  const project = await makeWorkspace("workflow-control-project");
  await mkdir(join(home, "工作流"), { recursive: true });
  const recipePath = join(home, "工作流", "控制验证.md");
  await writeFile(
    recipePath,
    `---\n${JSON.stringify({ 版本: 2, 名字: "控制验证", 参数: [], 节点: [{ 名字: "任务", 部门: "工程", 目标: "检查", 验收: "检查", 人工确认: true, depends_on: [] }] })}\n---\n`,
  );
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "控制验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    const snapshot = await page.evaluate(() => window.piApp!.getState());
    const owner = snapshot.workflowTabs.find((tab) => tab.recipeName === "控制验证")?.controller
      ?.sessionId;
    if (!owner) throw new Error("主控未绑定");
    const task = join(project, ".pao", "控制测试");
    const script = join(home, "seed-control.mjs");
    await writeFile(
      script,
      `import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const [dist,recipePath,task,owner,home,project]=process.argv.slice(2);
const {formatProjectList}=await import(pathToFileURL(join(dist,'dept/projects.js')).href);
writeFileSync(join(home,'项目清单.md'),formatProjectList([{项目名:'控制项目',项目根:project,首次服务:'2026-10-05 09:00',最近服务:'2026-10-05 09:00'}]));
const {parseRecipe}=await import(pathToFileURL(join(dist,'workflow/recipe.js')).href);
const {startControl}=await import(pathToFileURL(join(dist,'workflow/control.js')).href);
mkdirSync(join(task,'卡'),{recursive:true});
await startControl(parseRecipe(readFileSync(recipePath,'utf8'),recipePath),{}, {workspaceDir:task,cardsDir:join(task,'卡'),ownerSessionId:owner});`,
    );
    await runFile(
      process.execPath,
      [
        script,
        resolve(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao"),
        recipePath,
        task,
        owner,
        home,
        project,
      ],
      { windowsHide: true },
    );
    await page.getByTestId("canvas-refresh").click();
    await page.getByTestId("canvas-instance-row").filter({ hasText: "控制验证" }).click();
    const controls = page.getByTestId("workflow-runtime-controls");
    await controls.getByRole("button", { name: "打开原主控", exact: true }).click();
    await expect(controls.getByRole("button", { name: "确认放行", exact: true })).toBeEnabled();
    await controls.getByRole("button", { name: "确认放行", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /Confirm|确认/ })
      .click();
    await expect(controls.getByRole("status")).toContainText("确认");
    await controls.getByLabel("操作说明").fill("人工暂停验证");
    await controls.getByRole("button", { name: "暂停推进", exact: true }).click();
    await expect(controls).toContainText("暂停原因：人工暂停验证");
    const controlPath = join(task, "工作流实例-控制验证.md");
    expect(await readFile(controlPath, "utf8")).toContain("人工暂停验证");
    await controls.getByLabel("操作说明").fill("已核查无在途卡，恢复验证");
    await controls.getByRole("button", { name: "人工恢复", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /Confirm|确认/ })
      .click();
    await expect(controls.getByRole("status")).toContainText("操作已完成");
    await expect(controls).not.toContainText("暂停原因：");
    expect(await readFile(controlPath, "utf8")).toContain("已核查无在途卡，恢复验证");
  } finally {
    await app.close();
  }
});

test("向导真实启动：预检不过不落假实例，修复后启动落实例与首批卡（手动配方，无模型请求）", async () => {
  const home = await makeWorkspace("workflow-start-home");
  const project = await makeWorkspace("workflow-start-project");
  await mkdir(join(home, "工作流"), { recursive: true });
  // 档位配置先行（向导目录在打开时读取，主控档位下拉需要它）；部门注册表故意缺席＝预检红项。
  await mkdir(join(home, "pao配置"), { recursive: true });
  await writeFile(
    join(home, "pao配置", "档位.json"),
    JSON.stringify({
      provider: "openai",
      档位: [{ 名: "标准", provider: "openai", model: "gpt-5", thinkingLevel: "medium" }],
    }),
  );
  await writeFile(
    join(home, "工作流", "手动流.md"),
    `---\n${JSON.stringify({ 名字: "手动流", 参数: [], 节点: [{ 名字: "任务", 部门: "工程", 目标: "做事", 验收: "有产物", depends_on: [] }] })}\n---\n手动启动验证\n`,
  );
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "手动流" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    await page.getByTestId("canvas-start-workflow").click();
    const wizard = page.getByTestId("workflow-wizard");
    await expect(wizard).toBeVisible();
    // 无参数配方：参数步直接下一步到节点步，再下一步进预检（预检自动运行）。
    // 测试环境界面语言为英文，向导按钮走 i18n（Next），其余中文为源码硬编码文案。
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByTestId("wizard-blocked")).toBeVisible();
    await page.getByTestId("wizard-master-tier").selectOption("标准");
    await expect(page.getByTestId("wizard-thinking")).toHaveValue("medium");
    await expect(page.getByTestId("wizard-start")).toBeDisabled();
    // 启动失败不落假实例：项目里没有任何实例清单与卡。
    expect(await walkNames(project, "工作流实例-")).toEqual([]);
    expect(await walkNames(project, "卡")).toEqual([]);
    // 补上部门注册表与部门配方后重跑预检即可启动。
    await mkdir(join(home, "部门", "工程"), { recursive: true });
    await writeFile(
      join(home, "部门", "注册表.md"),
      "# 部门注册表\n\n| 名字 | 能力标签 | 库路径 | 建部日期 |\n| --- | --- | --- | --- |\n| 工程 | 测试 | 库/工程 | 2026-10-06 |\n",
    );
    await writeFile(join(home, "部门", "工程", "配方.md"), "工程测试配方正文\n");
    await page.getByRole("button", { name: "Run preflight", exact: true }).click();
    await expect(page.getByTestId("wizard-can-start")).toBeVisible();
    await page.getByTestId("wizard-start").click();
    await page.getByRole("dialog").getByRole("button", { name: /Confirm|确认/ }).click();
    // 启动成功即同步关向导（onStarted 卸载，started 面板不可见）。v1 手动配方实例按读模型契约
    // 不进画布（画布只认带冻结配方的 v2 实例），横幅须如实告知而非谎报同名冲突；启动真相以磁盘为准。
    await expect(page.getByTestId("workflow-wizard")).toBeHidden();
    await expect(page.getByTestId("canvas-load-error")).toContainText("画布暂未读到此次运行记录");
    // 真实落盘：实例清单＋首批卡（手动配方只落卡不派发——隔离本地执行，非真实供应商）。
    const instances = await walkNames(project, "工作流实例-");
    expect(instances).toEqual(["工作流实例-手动流.md"]);
    const cards = await walkNames(project, "卡");
    expect(cards.length).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("向导启动后.png") });
  } finally {
    await app.close();
  }
});

test("向导内管理档位（S9-2）：新增直写档位.json＋备份＋重名拒绝＋下拉即时可选＋编辑保留部门默认", async () => {
  const home = await makeWorkspace("tier-manage-home");
  const project = await makeWorkspace("tier-manage-project");
  await mkdir(join(home, "工作流"), { recursive: true });
  await mkdir(join(home, "pao配置"), { recursive: true });
  await writeFile(
    join(home, "pao配置", "档位.json"),
    JSON.stringify({
      provider: "openai",
      档位: [{ 名: "标准", provider: "openai", model: "gpt-5", thinkingLevel: "medium" }],
      部门默认: { 工程: "标准" },
    }),
  );
  await writeFile(
    join(home, "工作流", "档位管理验证.md"),
    `---\n${JSON.stringify({ 名字: "档位管理验证", 参数: [], 节点: [{ 名字: "任务", 部门: "工程", 目标: "做事", 验收: "有产物", depends_on: [] }] })}\n---\n管理档位验证\n`,
  );
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "档位管理验证" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    await page.getByTestId("canvas-start-workflow").click();
    const wizard = page.getByTestId("workflow-wizard");
    await expect(wizard).toBeVisible();
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    // 新增档位：表单填档名/物理模型/思考档，保存即写盘。
    await page.getByTestId("wizard-tier-name").fill("专家");
    await page.getByTestId("wizard-tier-model").fill("zai-coding-cn/glm-max");
    await page.getByTestId("wizard-tier-thinking").selectOption("high");
    await page.getByTestId("wizard-tier-save").click();
    await expect(page.getByTestId("wizard-tier-status")).toContainText("Tier saved.");
    const tierFile = join(home, "pao配置", "档位.json");
    const saved = JSON.parse(await readFile(tierFile, "utf8"));
    expect(saved.档位.map((row: { 名: string }) => row.名)).toEqual(["标准", "专家"]);
    expect(saved.部门默认).toEqual({ 工程: "标准" });
    const expert = saved.档位[1];
    expect(expert.provider).toBe("zai-coding-cn");
    expect(expert.model).toBe("glm-max");
    expect(expert.thinkingLevel).toBe("high");
    // 写前自动备份：同目录 .bak- 时间戳，内容为改前文件。
    const configDir = await readdir(join(home, "pao配置"));
    const backups = configDir.filter((name) => name.startsWith("档位.json.bak-"));
    expect(backups.length).toBe(1);
    // 目录已刷新：主控档位下拉立刻可选新档位，选中后思考档跟随推荐值。
    await page.getByTestId("wizard-master-tier").selectOption("专家");
    await expect(page.getByTestId("wizard-thinking")).toHaveValue("high");
    // 重名拒绝：内核中文错误原样透出到面板状态行。
    await page.getByTestId("wizard-tier-picker").selectOption("");
    await page.getByTestId("wizard-tier-name").fill("专家");
    await page.getByTestId("wizard-tier-model").fill("zai-coding-cn/glm-max");
    await page.getByTestId("wizard-tier-thinking").selectOption("low");
    await page.getByTestId("wizard-tier-save").click();
    await expect(page.getByTestId("wizard-tier-status")).toContainText("已存在");
    // 编辑现有档：改物理模型与思考档，写盘后仍是两档且部门默认不动。
    await page.getByTestId("wizard-tier-picker").selectOption("标准");
    await expect(page.getByTestId("wizard-tier-model")).toHaveValue("openai/gpt-5");
    await page.getByTestId("wizard-tier-model").fill("openai/gpt-5-mini");
    await page.getByTestId("wizard-tier-save").click();
    await expect(page.getByTestId("wizard-tier-status")).toContainText("Tier saved.");
    const edited = JSON.parse(await readFile(tierFile, "utf8"));
    expect(edited.档位.map((row: { 名: string }) => row.名)).toEqual(["标准", "专家"]);
    expect(edited.档位[0].model).toBe("gpt-5-mini");
    expect(edited.档位[0].thinkingLevel).toBe("medium");
    expect(edited.部门默认).toEqual({ 工程: "标准" });
    await page.screenshot({ path: test.info().outputPath("档位管理后.png") });
  } finally {
    await app.close();
  }
});

test("旧请求：另一入口推进轮次后，过期提交被请求关联拒绝且不落写", async () => {
  const home = await makeWorkspace("workflow-stale-home");
  const project = await makeWorkspace("workflow-stale-project");
  await mkdir(join(home, "工作流"), { recursive: true });
  const recipePath = join(home, "工作流", "过期请求.md");
  await writeFile(
    recipePath,
    `---\n${JSON.stringify({ 版本: 2, 名字: "过期请求", 参数: [], 节点: [{ 名字: "任务", 部门: "工程", 目标: "检查", 验收: "检查", 人工确认: true, depends_on: [] }] })}\n---\n`,
  );
  const app = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [project],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("sidebar-canvas").click();
    await page.getByTestId("canvas-recipe-row").filter({ hasText: "过期请求" }).click();
    await page.getByTestId("canvas-open-master-session").click();
    await expect(page.getByTestId("canvas-open-master-session")).toContainText("已建立");
    const snapshot = await page.evaluate(() => window.piApp!.getState());
    const owner = snapshot.workflowTabs.find((tab) => tab.recipeName === "过期请求")?.controller
      ?.sessionId;
    if (!owner) throw new Error("主控未绑定");
    const task = join(project, ".pao", "过期测试");
    const script = join(home, "seed-stale.mjs");
    await writeFile(
      script,
      `import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const [dist,recipePath,task,owner,home,project]=process.argv.slice(2);
const {formatProjectList}=await import(pathToFileURL(join(dist,'dept/projects.js')).href);
writeFileSync(join(home,'项目清单.md'),formatProjectList([{项目名:'过期项目',项目根:project,首次服务:'2026-10-06 09:00',最近服务:'2026-10-06 09:00'}]));
const {parseRecipe}=await import(pathToFileURL(join(dist,'workflow/recipe.js')).href);
const {startControl}=await import(pathToFileURL(join(dist,'workflow/control.js')).href);
mkdirSync(join(task,'卡'),{recursive:true});
await startControl(parseRecipe(readFileSync(recipePath,'utf8'),recipePath),{}, {workspaceDir:task,cardsDir:join(task,'卡'),ownerSessionId:owner});`,
    );
    await runFile(
      process.execPath,
      [
        script,
        resolve(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao"),
        recipePath,
        task,
        owner,
        home,
        project,
      ],
      { windowsHide: true },
    );
    await page.getByTestId("canvas-refresh").click();
    await page.getByTestId("canvas-instance-row").filter({ hasText: "过期请求" }).click();
    const controls = page.getByTestId("workflow-runtime-controls");
    await controls.getByRole("button", { name: "打开原主控", exact: true }).click();
    await expect(controls.getByRole("button", { name: "确认放行", exact: true })).toBeEnabled();
    // 另一入口（终端同源内核）把轮次推进到 2；页面还停留在第 1 轮的旧视图。
    const controlPath = join(task, "工作流实例-过期请求.md");
    const before = await readFile(controlPath, "utf8");
    expect(before).toContain("轮次: 1");
    const bumped = before.replace("轮次: 1", "轮次: 2");
    await writeFile(controlPath, bumped);
    await controls.getByRole("button", { name: "确认放行", exact: true }).click();
    await expect(controls.getByRole("status")).toContainText("节点或轮次已变化，请刷新后重试。");
    // 过期提交不落写：清单与我外部推进后的字节完全一致，无确认时间戳。
    expect(await readFile(controlPath, "utf8")).toBe(bumped);
  } finally {
    await app.close();
  }
});
