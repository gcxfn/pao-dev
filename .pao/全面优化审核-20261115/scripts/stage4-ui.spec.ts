import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '../../../desktop/node_modules/@playwright/test';
import { createNamedThread, desktopShortcut, launchDesktop, makeUserDataDir, makeWorkspace } from '../../../desktop/apps/desktop/tests/helpers/electron-app';

test('外壳与样式搬移保持会话、菜单、终端及设置界面',async()=>{
 const phase=process.env.STAGE4_UI_PHASE??'before';
 const fixtureFile=join(__dirname,'../checks/S07-ui-fixture.json');
 let fixture:{home:string;project:string;userData:string};
 if(phase==='before'){
  fixture={home:await mkdtemp(join(tmpdir(),'pao-stage4-ui-')),project:await makeWorkspace('stage4-ui'),userData:await makeUserDataDir('pao-stage4-ui-')};
  await writeFile(join(fixture.userData,'ui-state.json'),JSON.stringify({language:'zh'}));
  await writeFile(fixtureFile,JSON.stringify(fixture,null,2));
 }else fixture=JSON.parse(await readFile(fixtureFile,'utf8'));
 const app=await launchDesktop(fixture.userData,{initialWorkspaces:[fixture.project],testMode:'background',scrubProviderEnv:true,envOverrides:{PAO_HOME:fixture.home,PAO_DISABLE_BUILTIN_EXTENSION:'1'}});
 const metrics:Record<string,unknown>={};
 try{
  const page=await app.firstWindow();
  await page.setViewportSize({width:1280,height:800});
  if(await page.getByTestId('settings-surface').isVisible())await page.locator('.secondary-surface__back').click();
  if(phase==='before')await createNamedThread(page,'拆分验收会话');
  const composer=page.getByTestId('composer');
  await expect(composer).toBeVisible();
  await composer.fill('');
  const output=join(__dirname,'../ui-screenshots/stage4',phase);
  await mkdir(output,{recursive:true});
  async function capture(name:string){
   await page.screenshot({path:join(output,name+'.png'),animations:'disabled',caret:'hide',style:'.xterm-cursor-layer { visibility:hidden !important; } .session-row__time { visibility:hidden !important; width:80px !important; }'});
   metrics[name]=await page.locator('.main,.composer,.composer__surface,.slash-menu,.terminal-panel,.settings-row,.secondary-surface').evaluateAll(nodes=>nodes.map(n=>{
    const s=getComputedStyle(n),r=n.getBoundingClientRect();
    return {className:n.className,width:r.width,height:r.height,padding:s.padding,display:s.display,gridTemplateColumns:s.gridTemplateColumns,border:s.border,borderRadius:s.borderRadius,background:s.backgroundColor};
   }));
  }
  await capture('conversation-1280');
  await composer.fill('/');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await capture('slash-menu-1280');
  await composer.fill('');
  await page.keyboard.press(desktopShortcut('J'));
  await expect(page.getByTestId('integrated-terminal').locator('.xterm-rows')).toBeVisible();
  await expect(page.getByTestId('integrated-terminal').locator('.xterm-rows')).toContainText(basename(fixture.project));
  await page.getByTestId('integrated-terminal').locator('.xterm').click();
  await capture('terminal-1280');
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-panel__status--exited')).toBeVisible();
  await page.keyboard.press(desktopShortcut('J'));
  await expect(page.getByTestId('integrated-terminal')).toBeHidden();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.getByTestId('settings-surface')).toBeVisible();
  await capture('settings-1280');
  await page.setViewportSize({width:900,height:700});
  await capture('settings-900');
  await writeFile(join(__dirname,`../checks/S07-ui-${phase}-metrics.json`),JSON.stringify(metrics,null,2));
 }finally{await app.close();}
});
