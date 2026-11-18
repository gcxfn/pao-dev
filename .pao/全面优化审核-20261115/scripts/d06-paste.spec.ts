import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { expect, test } from "../../../desktop/node_modules/@playwright/test";
import {
  launchDesktop, makeUserDataDir, makeWorkspace, createNamedThread,
  openNewThread, pasteTinyPngViaClipboard, TINY_PNG_BASE64,
} from "../../../desktop/apps/desktop/tests/helpers/electron-app";

test("D06 Windows 开发模式原生粘贴路径计数", async () => {
  const desktopDir = resolve(__dirname,"../../../desktop/apps/desktop");
  const requireDesktop = createRequire(join(desktopDir,"package.json"));
  const {createServer} = await import(pathToFileURL(requireDesktop.resolve("vite")).href);
  const config = await import(pathToFileURL(join(desktopDir,"electron.vite.config.mjs")).href);
  const {renderer} = config.default({command:"serve",mode:"development"});
  const server = await createServer({...renderer,configFile:false,cacheDir:resolve(__dirname,"vite-cache"),
    server:{...renderer.server,host:"127.0.0.1",port:5187,strictPort:true}});
  await server.listen();
  const harness = await launchDesktop(await makeUserDataDir(),{
    initialWorkspaces:[await makeWorkspace("pao-paste-trace")],testMode:"foreground",
    envOverrides:{ELECTRON_RENDERER_URL:"http://127.0.0.1:5187",PI_APP_OPEN_DEVTOOLS:"0",PAO_PERF_TRACE:undefined},
  });
  const records: unknown[]=[];
  try {
    const window=await harness.firstWindow();
    await createNamedThread(window,"粘贴查证");
    await harness.focusWindow();
    await harness.electronApp.evaluate(({BrowserWindow,ipcMain})=>{
      const stats={native:0,prevented:0,sync:0,pushed:0};
      (globalThis as unknown as {pasteTrace:typeof stats}).pasteTrace=stats;
      ipcMain.on("pi-gui:read-clipboard-image",()=>{stats.sync+=1;});
      for(const win of BrowserWindow.getAllWindows()){
        win.webContents.on("before-input-event",(event,input)=>{
          if(input.type==="keyDown" && input.control && !input.shift && input.key.toLowerCase()==="v"){
            stats.native+=1;if(event.defaultPrevented)stats.prevented+=1;
          }
        });
        const send=win.webContents.send.bind(win.webContents);
        win.webContents.send=(channel,...args)=>{
          if(channel==="pi-gui:clipboard-image-pasted")stats.pushed+=1;
          return send(channel,...args);
        };
      }
    });
    await window.evaluate(()=>{
      const g=globalThis as unknown as {pasteDomKeys:number}; g.pasteDomKeys=0;
      window.addEventListener("keydown",e=>{
        if(e.ctrlKey&&!e.shiftKey&&e.key.toLowerCase()==="v")g.pasteDomKeys+=1;
      },true);
    });
    async function sample(name:string){
      const main=await harness.electronApp.evaluate(()=>{
        const g=globalThis as unknown as {pasteTrace:{native:number;prevented:number;sync:number;pushed:number}};
        const result={...g.pasteTrace};
        Object.assign(g.pasteTrace,{native:0,prevented:0,sync:0,pushed:0});
        return result;
      });
      const domKeys=await window.evaluate(()=>{
        const g=globalThis as unknown as {pasteDomKeys:number};const count=g.pasteDomKeys;g.pasteDomKeys=0;return count;
      });
      const record={name,...main,domKeys}; records.push(record);
      console.info("[paste-trace]",JSON.stringify(record));return record;
    }
    let nativeStep=0;
    async function nativePaste(testId:string,image:boolean){
      await window.getByTestId(testId).click();
      await harness.focusWindow();
      await harness.electronApp.evaluate(({clipboard,nativeImage},png)=>{
        if(png)clipboard.writeImage(nativeImage.createFromDataURL(`data:image/png;base64,${png}`));
        else clipboard.writeText("粘贴文本查证");
      },image?TINY_PNG_BASE64:"");
      const gate=resolve(__dirname,`../checks/D06-key-${Date.now()}-${++nativeStep}.json`);
      await writeFile(resolve(__dirname,"../checks/D06-ready.json"),JSON.stringify({
        step:nativeStep,testId,image,gate,
        pid:await harness.electronApp.evaluate(()=>process.pid),
        title:await window.title(),
      }));
      const deadline=Date.now()+120000;
      while(true){
        try { await readFile(gate);break; }
        catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        if(Date.now()>deadline)throw new Error("等待原生键盘实测超时");
        await new Promise(r=>setTimeout(r,200));
      }
      if(image)await expect(window.locator(".composer-attachment")).toHaveCount(1);
      else await expect(window.getByTestId(testId)).toHaveValue("粘贴文本查证");
    }
    await nativePaste("composer",true);
    expect(await sample("会话输入框粘贴图片")).toMatchObject({native:1,prevented:1,sync:0,pushed:1,domKeys:0});
    await expect(window.locator(".composer-attachment")).toHaveCount(1);
    await openNewThread(window);
    await nativePaste("new-thread-composer",true);
    expect(await sample("新会话输入框粘贴图片")).toMatchObject({native:1,prevented:1,sync:0,pushed:1,domKeys:0});
    await expect(window.locator(".composer-attachment")).toHaveCount(1);
    const composer=window.getByTestId("new-thread-composer");
    await composer.fill("");await nativePaste("new-thread-composer",false);
    await expect(composer).toHaveValue("粘贴文本查证");
    expect(await sample("新会话输入框粘贴文本")).toMatchObject({native:1,prevented:0,sync:1,pushed:0,domKeys:1});
    await pasteTinyPngViaClipboard(harness,window,"new-thread-composer");
    const testPath=await sample("原有 native 测试的 Playwright 键盘路径");
    expect(testPath.sync+testPath.pushed).toBe(1);
    await expect(window.locator(".composer-attachment")).toHaveCount(2);
    await window.screenshot({path:resolve(__dirname,"../checks/D06-electron.png")});
  } finally {
    await harness.close();await server.close();
    await writeFile(resolve(__dirname,"../checks/D06-measurement.json"),JSON.stringify(records,null,2)+"\n");
  }
});
