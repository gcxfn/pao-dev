// 用途：独立复核归档是否把说明文本当成功终态；仅本轮隔离假留档，真实worker，无模型。
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const base='D:/AI/workspace/临时文件夹/PAO-机械调度测试-20261004';
const home=mkdtempSync(join(base,'独立误删-')); const archive=join(home,'定时','留档'); const run=join(archive,'archiver');const other=join(archive,'other');mkdirSync(run,{recursive:true});mkdirSync(other);
for(let i=0;i<31;i++)writeFileSync(join(other,`${new Date(1e12+i*1000).toISOString().replace(/:/g,'-')}.md`),'# 测试\n任务：other\nprompt 仅作说明，未执行其自然语言指令：检查报告中的“状态：机械白名单操作完成；”标记\n\n状态：已领取，尚未证明完成。\n状态：失败/取消（code=1 signal=null）\n');
const child=spawn(process.execPath,['D:/AI/workspace/pao-dev/桌面端/packages/pi-sdk-driver/extensions/pao/maintenance-worker.mjs'],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,PAO_MECHANICAL_HOME:home,PAO_MECHANICAL_RUN_DIR:run,PAO_MECHANICAL_TASK:JSON.stringify({id:'archiver',工具白名单:['归档']})}}); let report='';child.on('message',m=>report=m);child.send('execute');const [exit]=await once(child,'exit');console.log(JSON.stringify({home,before:31,after:readdirSync(other).length,exit,report},null,2));
