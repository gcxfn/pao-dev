import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "../../../desktop/node_modules/@playwright/test";
import {
  launchDesktop, makeUserDataDir, makeWorkspace, seedAgentDir,
  writeProjectExtension, selectSession, getSelectedTranscript,
} from "../../../desktop/apps/desktop/tests/helpers/electron-app";

const desktopDir = resolve(__dirname, "../../../desktop/apps/desktop");
const requireDesktop = createRequire(join(desktopDir, "package.json"));
const checks = resolve(__dirname, "../checks");
const provider = String.raw`
import { createAssistantMessageEventStream } from "@pao/ai";
export default function perfProvider(pi) {
  pi.registerProvider("pao-perf", {
    baseUrl: "http://127.0.0.1:9/never-contact", apiKey: "LOCAL_TEST_CANARY", api: "pao-perf",
    models: [{ id: "scripted", name: "本地性能夹具", reasoning: false, input: ["text"],
      cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:128000, maxTokens:32768 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = { role:"assistant", content:[{type:"text",text:""}], api:model.api,
        provider:model.provider, model:model.id, usage:{input:1,output:1,cacheRead:0,cacheWrite:0,
        totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        stopReason:"stop", timestamp:Date.now() };
      stream.push({type:"start",partial:message});
      stream.push({type:"text_start",contentIndex:0,partial:message});
      const started = Date.now(); let index=0;
      const tick = () => {
        const done = Date.now()-started >= 60000;
        const delta = done ? "\nPERF_DONE" : "片段" + (++index) + "：持续输出与界面切换测量。\n";
        message.content[0].text += delta;
        stream.push({type:"text_delta",contentIndex:0,delta,partial:message});
        if(done) {
          stream.push({type:"text_end",contentIndex:0,content:message.content[0].text,partial:message});
          stream.push({type:"done",reason:"stop",message});
        } else setTimeout(tick,50);
      };
      setTimeout(tick,50); return stream;
    }
  });
}
`;

async function devServer() {
  const { createServer } = await import(pathToFileURL(requireDesktop.resolve("vite")).href);
  const config = await import(pathToFileURL(join(desktopDir,"electron.vite.config.mjs")).href);
  const { renderer } = config.default({ command:"serve", mode:"development" });
  const server = await createServer({ ...renderer, configFile:false,
    cacheDir:resolve(__dirname,"vite-cache"),
    server:{...renderer.server,host:"127.0.0.1",port:5186,strictPort:true} });
  await server.listen();
  return server;
}

test("D05 默认关闭计数", async () => {
  const server = await devServer();
  const traces: string[] = [];
  const harness = await launchDesktop(await makeUserDataDir(), { envOverrides: {
    PAO_PERF_TRACE: undefined, ELECTRON_RENDERER_URL: "http://127.0.0.1:5186",
    PI_APP_OPEN_DEVTOOLS:"0",
  } });
  harness.electronApp.process().stdout?.on("data", (chunk) => traces.push(chunk.toString()));
  try { await harness.firstWindow(); await new Promise(r=>setTimeout(r,11000)); }
  finally { await harness.close(); await server.close(); }
  expect(traces.join("")).not.toContain("[perf-trace]");
  await writeFile(join(checks,"D05-disabled.json"),JSON.stringify({perfTraceLines:0})+"\n");
});

test("D05 两百条历史消息与一分钟真实 SDK 流式输出", async () => {
  await mkdir(checks,{recursive:true});
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir,"agent");
  const workspacePath = await makeWorkspace("pao-d05-perf");
  await seedAgentDir(agentDir,{withOpenAiAuth:false,withDefaultModel:false});
  await writeFile(join(agentDir,"settings.json"),JSON.stringify({
    defaultProvider:"pao-perf",defaultModel:"scripted",enabledModels:["pao-perf/scripted"],
    packages:[],cacheWarming:"off",compaction:{enabled:false},
  }));
  await writeProjectExtension(workspacePath,"perf-provider.ts",provider);
  process.env.PI_CODING_AGENT_DIR=agentDir;
  process.env.PAO_CODING_AGENT_DIR=agentDir;
  const { SessionManager } = await import(pathToFileURL(join(desktopDir,"node_modules/@pao/coding-agent/dist/index.js")).href);
  for(const [title,count] of [["性能长会话",200],["切换对照会话",2]] as const) {
    const manager = SessionManager.create(workspacePath);
    for(let i=0;i<count;i++) manager.appendMessage({role:"user",content:`历史消息 ${i}：`+"正文内容。".repeat(80),timestamp:Date.now()+i});
    manager.appendSessionInfo(title);
  }
  const server = await devServer();
  const harness = await launchDesktop(userDataDir,{agentDir,initialWorkspaces:[workspacePath],
    envOverrides:{ PAO_PERF_TRACE:"1",ELECTRON_RENDERER_URL:"http://127.0.0.1:5186",PI_APP_OPEN_DEVTOOLS:"0" }});
  const raw: string[]=[];
  harness.electronApp.process().stdout?.on("data",(chunk)=>raw.push(chunk.toString()));
  let startedAt=0, endedAt=0;
  try {
    const window=await harness.firstWindow();
    await selectSession(window,"性能长会话");
    expect((await getSelectedTranscript(window))?.transcript.length).toBeGreaterThanOrEqual(200);
    startedAt=Date.now();
    await window.getByTestId("composer").fill("请连续输出一分钟，用于性能测量。");
    await window.getByTestId("composer").press("Enter");
    await expect.poll(async()=>(await getSelectedTranscript(window))?.transcript.some(
      item=>item.kind==="message" && item.role==="assistant" && item.text.includes("片段")),{timeout:15000})
      .toBe(true);
    await new Promise(r=>setTimeout(r,20000));
    await selectSession(window,"切换对照会话");
    await new Promise(r=>setTimeout(r,20000));
    await selectSession(window,"性能长会话");
    await expect.poll(async()=>(await getSelectedTranscript(window))?.transcript.some(
      item=>item.kind==="message" && item.role==="assistant" && item.text.includes("PERF_DONE")),{timeout:40000})
      .toBe(true);
    endedAt=Date.now();
    await window.screenshot({path:join(checks,"D05-electron.png")});
    await new Promise(r=>setTimeout(r,11000));
  } finally {
    await harness.close(); await server.close();
    await writeFile(join(checks,"D05-perf-raw.log"),raw.join(""));
    const samples=raw.join("").split(/\r?\n/).filter(l=>l.includes("[perf-trace]")).map(l=>JSON.parse(l.slice(l.indexOf("[perf-trace]")+12).trim()));
    await writeFile(join(checks,"D05-measurement.json"),JSON.stringify({startedAt,endedAt,userDataDir,workspacePath,seededMessages:200,model:"本地模拟模型，真实 SDK 与磁盘流程",samples},null,2)+"\n");
  }
});
