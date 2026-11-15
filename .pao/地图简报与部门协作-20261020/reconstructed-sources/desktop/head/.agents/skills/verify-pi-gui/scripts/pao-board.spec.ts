import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchDesktop, type DesktopHarness } from "../../../../apps/desktop/tests/helpers/electron-app";
import { expectExtensionViewReady } from "../../../../apps/desktop/tests/helpers/desktop-extension-fixture";

// 可见Windows桌面；复用此前真实对话profile，不注入假助手或建会话IPC。
// 卡片为明确标注的只读展示fixture；此脚本不声称它由真实模型派发。
test("PAO board reads files, reports corrupt card, and arms context without model calls", async()=>{
  test.setTimeout(120000);
  const evidence=process.env.PI_GUI_PROOF_DIR!;
  const privateRoot=process.env.PAO_BOARD_PRIVATE_ROOT!;
  const workspace=process.env.PAO_BOARD_WORKSPACE!;
  if(!evidence||!privateRoot||!workspace) throw new Error("缺少已验证现场路径");
  const budgetPath=JSON.parse(process.env.PAO_REQUEST_BUDGET!).path;
  const before=JSON.parse(await readFile(budgetPath,"utf8")).used;
  const cards=join(workspace,".pao","卡");
  await mkdir(cards,{recursive:true});
  await mkdir(evidence,{recursive:true});
  const good=join(cards,"卡0998-桌面展示样本.md");
  await writeFile(good,'---\n目标: 隔离展示样本，不代表真实工作流\n部门: 验收隔离\n验收: 只读显示原文\n尝试: 1\n创建: "2026-10-04 04:00"\n状态: 进行中\n---\n\n此为UI展示fixture，尚未验收通过。\n',{flag:"wx"});
  await writeFile(join(cards,"卡0999-损坏样本.md"),"明确损坏的只读显示样本\n",{flag:"wx"});
  let harness:DesktopHarness|undefined;
  let pid:number|undefined;
  const checkpoints:string[]=[];
  try {
    harness=await launchDesktop(join(privateRoot,"profile"),{agentDir:join(privateRoot,"agent"),initialWorkspaces:[workspace],scrubProviderEnv:true,envOverrides:{PI_APP_TEST_MODE:undefined,PAO_CODING_AGENT_DIR:join(privateRoot,"agent"),PAO_RUNTIME_SURFACE:"desktop"}});
    await harness.focusWindow();
    const page=await harness.firstWindow();
    const doctor=await harness.electronApp.evaluate(({app,BrowserWindow})=>({pid:process.pid,appPath:app.getAppPath(),userData:app.getPath("userData"),visible:BrowserWindow.getAllWindows()[0]?.isVisible(),focused:BrowserWindow.getAllWindows()[0]?.isFocused(),testMode:process.env.PI_APP_TEST_MODE??null,testHooks:"__PI_APP_TEST_HOOKS" in globalThis}));
    pid=doctor.pid;
    expect(doctor).toMatchObject({visible:true,testMode:null,testHooks:false});
    expect(resolve(doctor.appPath)).toBe(resolve("apps/desktop"));
    expect(resolve(doctor.userData)).toBe(resolve(privateRoot,"profile"));
    await writeFile(join(evidence,"doctor.json"),JSON.stringify(doctor,null,2));
    await harness.electronApp.context().tracing.start({screenshots:true,snapshots:true,sources:true});
    await expect(page.getByTestId("composer")).toBeVisible();
    if(!await page.getByTestId("workbench").isVisible()) await page.getByTestId("toggle-side-panel").click();
    const chooser=page.getByTestId("workbench-chooser");
    if(!await chooser.isVisible()) await page.getByTestId("workbench-add-tab").click();
    await chooser.getByRole("button",{name:"PAO 工作看板",exact:true}).click();
    await expectExtensionViewReady(page);
    const frame=page.frameLocator('[data-testid="extension-view-frame"]');
    await expect(frame.getByRole("heading",{name:"PAO 工作看板",exact:true})).toBeVisible();
    await expect(frame.locator("main")).toContainText("隔离展示样本，不代表真实工作流");
    await expect(frame.locator("main")).toContainText("frontmatter");
    checkpoints.push("真实文件与坏卡提示");
    await page.screenshot({path:join(evidence,"任务.png")});
    for(const tab of ["待处理","结果与恢复","上下文与记忆"]){
      await frame.getByRole("button",{name:tab,exact:true}).click();
      if(tab==="结果与恢复") await expect(frame.locator("main")).toContainText("尚未验收通过");
      if(tab==="上下文与记忆") {
        await frame.getByRole("button",{name:"准备捕获下一次请求",exact:true}).click();
        await expect(frame.getByRole("button",{name:"刷新正本",exact:true})).toBeEnabled();
      }
      checkpoints.push(tab);
      await page.screenshot({path:join(evidence,`${tab}.png`)});
    }
    const after=JSON.parse(await readFile(budgetPath,"utf8")).used;
    expect(after).toBe(before);
    expect(await readFile(good,"utf8")).toContain("尚未验收通过");
    await writeFile(join(evidence,"result.json"),JSON.stringify({status:"通过",checkpoints,budgetBefore:before,budgetAfter:after,boundary:"卡是标注fixture；窗口/文件读取/SDK连接为真实，未执行模型派发"},null,2));
  } finally {
    if(harness){
      await harness.electronApp.context().tracing.stop({path:join(evidence,"board.zip")}).catch(()=>{});
      await harness.close();
      await writeFile(join(evidence,"cleanup.json"),JSON.stringify({pid,closed:true},null,2));
    }
  }
});
