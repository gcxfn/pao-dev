import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../../../desktop/node_modules/@playwright/test';
import { createNamedThread, launchDesktop, makeUserDataDir, makeWorkspace, seedAgentDir } from '../../../desktop/apps/desktop/tests/helpers/electron-app';

test('开发模式打开主窗口并显示缺少模型授权的提示',async()=>{
 const appDir=resolve(__dirname,'../../../desktop/apps/desktop');
 const req=createRequire(join(appDir,'package.json'));
 const {createServer}=await import(pathToFileURL(req.resolve('vite')).href);
 const react=(await import(pathToFileURL(req.resolve('@vitejs/plugin-react')).href)).default;
 const tsconfigPaths=(await import(pathToFileURL(req.resolve('vite-tsconfig-paths')).href)).default;
 const server=await createServer({configFile:false,root:appDir,base:'./',plugins:[react(),tsconfigPaths({projects:[join(appDir,'tsconfig.paths.json')]})],server:{host:'127.0.0.1',port:0}});
 await server.listen();
 const rendererUrl=server.resolvedUrls.local[0];
 const home=await mkdtemp(join(tmpdir(),'pao-stage4-dev-'));
 const userData=await makeUserDataDir('pao-stage4-dev-');
 const project=await makeWorkspace('stage4-dev');
 const agentDir=join(userData,'agent');
 await seedAgentDir(agentDir,{withOpenAiAuth:false});
 const app=await launchDesktop(userData,{agentDir,initialWorkspaces:[project],testMode:'background',scrubProviderEnv:true,envOverrides:{PAO_HOME:home,PAO_DISABLE_BUILTIN_EXTENSION:'1',ELECTRON_RENDERER_URL:rendererUrl}});
 try{
  const page=await app.firstWindow();
  await page.setViewportSize({width:1280,height:800});
  await expect(page).toHaveURL(new RegExp(rendererUrl.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  await createNamedThread(page,'Development smoke');
  const composer=page.getByTestId('composer');
  await expect(composer).toBeVisible();
  await composer.fill('PAO development message smoke');
  const send=page.getByRole('button',{name:'Send message',exact:true});
  const submitted=await send.isEnabled();
  if(submitted)await send.click();
  const feedback=page.locator('.composer__error,.error-banner,.model-onboarding-notice').filter({hasText:/key|auth|provider|model|密钥|授权|模型|配置/i}).first();
  await expect(feedback).toBeVisible({timeout:15000});
  const out=join(__dirname,'../ui-screenshots/stage4');await mkdir(out,{recursive:true});
  await page.screenshot({path:join(out,'S06-development.png'),animations:'disabled',caret:'hide'});
  await writeFile(join(__dirname,'../checks/S06-development-proof.json'),JSON.stringify({developmentRenderer:true,windowVisible:true,submitted,feedback:await feedback.innerText()},null,2));
 }finally{try{await app.close();}finally{await server.close();}}
});
