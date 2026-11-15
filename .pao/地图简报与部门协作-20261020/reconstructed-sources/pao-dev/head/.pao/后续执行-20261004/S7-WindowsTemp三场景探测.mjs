// 用途：按完整基线的空环境独立复跑指定两项，不改变原测试/基线。
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const base='D:/AI/workspace/pao-dev/.pao/后续执行-20261004',root=mkdtempSync('C:/Windows/Temp/pao-baseline-probe-');
const probe=join(root,'permission-probe.txt');writeFileSync(probe,'only-this-run',{flag:'wx'});if(readFileSync(probe,'utf8')!=='only-this-run')throw Error('probe mismatch');rmSync(probe);console.log(JSON.stringify({permissionProbe:'create/read/remove passed',root}));
const home=join(root,'home'),temp=join(root,'tmp');mkdirSync(home);mkdirSync(temp);
const allowed=new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PROGRAMFILES','PROGRAMFILES(X86)','CI','GITHUB_ACTIONS','LANG','LC_ALL','TZ']);
const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>allowed.has(name.toUpperCase())));
for(const name of ['npm-userconfig','npm-globalconfig'])writeFileSync(join(root,name),'');
Object.assign(env,{HOME:home,USERPROFILE:home,TMPDIR:temp,TMP:temp,TEMP:temp,XDG_CONFIG_HOME:join(home,'.config'),XDG_CACHE_HOME:join(root,'cache'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_TERMINAL_PROMPT:'0',PI_OFFLINE:'1',PI_NO_LOCAL_LLM:'1',AWS_EC2_METADATA_DISABLED:'true',NPM_CONFIG_USERCONFIG:join(root,'npm-userconfig'),NPM_CONFIG_GLOBALCONFIG:join(root,'npm-globalconfig'),NPM_CONFIG_CACHE:join(root,'cache/npm')});
for(const [file,title] of [['package-command-paths','allows local package install to initialize fresh project settings'],['resource-loader','should prefer AGENTS.override.md within each directory while preserving ancestor layering'],['pao/worker-run','currentScript 不可用时回落 PATH 垫片:worker 经垫片真实拉起并出回执']]){
 const result=spawnSync(process.execPath,['D:/AI/workspace/pao-dev/PAO/node_modules/vitest/vitest.mjs','run',`test/${file}.test.ts`,'-t',title,'--maxWorkers','1','--reporter=verbose'],{cwd:'D:/AI/workspace/pao-dev/PAO/packages/coding-agent',env,windowsHide:true,encoding:'utf8',timeout:90000});
 writeFileSync(join(base,`S7-WindowsTemp-${file.replaceAll("/","-")}-隔离精确复跑.log`),`${result.stdout??''}${result.stderr??''}\nexit=${result.status} error=${result.error??''}`);console.log(JSON.stringify({file,status:result.status,error:String(result.error??''),root}));
}

