// 零模型：正式界面确认错误原owner恢复，原工作流文件必须逐字节不变。
import { test, expect } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { launchDesktop, startThreadFromSurface } from '../../../../apps/desktop/tests/helpers/electron-app';
async function snapshot(root: string): Promise<Record<string,string>> {
 const result: Record<string,string>={};
 async function visit(dir:string){for(const item of await readdir(dir,{withFileTypes:true})){
  const path=join(dir,item.name);if(item.isDirectory())await visit(path);
  else result[path]=createHash('sha256').update(await readFile(path)).digest('hex');
 }}
 await visit(root);return result;
}
test('正式确认后错误原owner拒绝，原控制卡回执不变',async()=>{
 test.setTimeout(90000);
 const config=JSON.parse(await readFile(process.env.PAO_OWNER_REJECT_CONFIG!,'utf8'));
 await mkdir(config.evidence,{recursive:true});
 const before=await snapshot(config.workspace);
 await writeFile(join(config.evidence,'原文件快照.json'),JSON.stringify(before,null,2));
 const harness=await launchDesktop(config.profile,{agentDir:config.agentDir,initialWorkspaces:[config.project],scrubProviderEnv:true,envOverrides:{PI_APP_TEST_MODE:undefined,PAO_CODING_AGENT_DIR:config.agentDir,PAO_HOME:config.home,PAO_SESSION_BUDGET:'{"turns":0}',PAO_REQUEST_BUDGET:JSON.stringify({path:config.budgetPath,requests:600,concurrency:2})}});
 try{
 const page=await harness.firstWindow();await harness.focusWindow();
 await startThreadFromSurface(page,{prompt:'/pao runtime'});
 const composer=page.getByTestId('composer');
 await composer.fill('/pao flow control '+JSON.stringify({...config.command,动作:'恢复',原owner:randomUUID(),理由:'仅验证错误原owner拒绝；不授权实际接管，不增加预算。'}));
 await composer.press('Enter');
 const dialog=page.getByTestId('extension-dialog');await expect(dialog).toBeVisible();
 await expect(dialog).toContainText('工作流人工确认');
 await page.screenshot({path:join(config.evidence,'错误owner确认前.png')});
 const buttons=await dialog.getByRole('button').allTextContents();
 await writeFile(join(config.evidence,'确认按钮.json'),JSON.stringify(buttons));
 await dialog.getByRole('button',{name:/^(Yes|Confirm|确认|是)$/}).click();
 await expect(page.getByText('恢复身份不符或缺现场核查说明',{exact:false}).first()).toBeVisible();
 await page.screenshot({path:join(config.evidence,'错误owner实际拒绝.png')});
 const after=await snapshot(config.workspace);expect(after).toEqual(before);
 await writeFile(join(config.evidence,'结果.json'),JSON.stringify({before,after,originalUnchanged:true,ownerRejected:true,roundGateReached:false,boundary:'真正点击恢复确认后原owner拒绝；未到轮次验证，未恢复成功。'},null,2));
 }finally{await harness.close();}
});
