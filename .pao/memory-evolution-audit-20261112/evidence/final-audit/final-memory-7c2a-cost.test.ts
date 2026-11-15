import {it,expect} from "vitest";
import {mkdirSync,mkdtempSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {composeModelProvider} from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/provider-composer.ts";
import {calculateCost,fauxAssistantMessage} from "D:/AI/workspace/pao-dev/PAO/packages/ai/src/index.ts";
import {requestExtraction} from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-model.ts";
import {openPersistentMemoryLedger} from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/runtime-embedding.ts";
import {readMemoryUsage} from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/usage-query.ts";
import {openMemoryStore} from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/store.ts";
import {budgetLedgerPath,readBudgetLedger} from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/usage/budget-ledger.ts";
it("FINAL-COST：未声明价格的自定义模型应保留未知费用占额",async()=>{
 const home=mkdtempSync("D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-memory-7c2a-cost-home-");const now=new Date().toISOString();mkdirSync(join(home,"pao配置"),{recursive:true});
 writeFileSync(join(home,"pao配置","记忆后台预算.json"),JSON.stringify({每日上限:1}));
 writeFileSync(budgetLedgerPath(home),JSON.stringify({version:1,reservations:[],grants:[{version:1,总预算:10,授权时间:now,余额依据:{已花:0,授权前总预算:0},授权人:"audit"}]}));
 const definition={id:"no-price-model"};
 const provider=composeModelProvider("audit-no-price",undefined,{getProvider:()=>({api:"openai-completions",baseUrl:"http://offline.invalid/v1",models:[definition]})} as never,undefined);
 const model=provider.getModels()[0];const usage={input:1161,output:39,cacheRead:0,cacheWrite:0,totalTokens:1200,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};calculateCost(model,usage);
 const ledger=openPersistentMemoryLedger(home,"no-price-job");const store=openMemoryStore(home,"readwrite");
 try {
 const result=await requestExtraction({paoHome:home,ledger,modelRegistry:{find:()=>model,streamSimple:()=>({result:async()=>({...fauxAssistantMessage("[]"),provider:model.provider,model:model.id,usage})})} as never,tierConfig:{provider:"pao",档位:[{名:"fast",provider:model.provider,model:model.id,thinkingLevel:"off"}]},outboundProjects:["audit"],outbound:{projects:{audit:{allowed:true,asOf:"2099-12-31"}}},budgetScopeKey:"session:no-price"} as never,{jobId:"no-price-job",sourceSessionId:"no-price",entries:[{sourceId:"s1",entryId:"e1",eventType:"user",content:"使用配置"}]});
 const reservations=readBudgetLedger(budgetLedgerPath(home)).reservations;const aggregate=readMemoryUsage(store,{paoHome:home});
 const evidence={declaredPrice:Object.hasOwn(definition,"cost"),runtimeRates:model.cost,usage:result.usage,reservations,aggregate};writeFileSync("D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-memory-7c2a-cost-observed.json",JSON.stringify(evidence,null,2));console.log("FINAL-COST",JSON.stringify(evidence));
 expect(reservations[0].status).toBe("unknown");expect(aggregate.total.unknownCount).toBe(1);
 }finally{store.close();}
});