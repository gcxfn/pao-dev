// 用途：只调用信任资源探测，比较隔离HOME与真实祖先技能的关系；不加载技能、不调用模型。
import {existsSync,writeFileSync} from 'node:fs';
import {hasTrustRequiringProjectResources} from '../../PAO/packages/coding-agent/src/core/trust-manager.ts';
const cwd='C:/Users/ASUS/AppData/Local/Temp/pao-baseline-RPqYwI/tmp';
const original=process.env.HOME;
const samples=[];
try {for(const home of ['C:/Users/ASUS/AppData/Local/Temp/pao-baseline-RPqYwI/home','C:/Users/ASUS']) {process.env.HOME=home;samples.push({cwd,home,localPi:existsSync(cwd+'/.pi'),actualAncestorSkills:existsSync('C:/Users/ASUS/.agents/skills'),trustRequiring:hasTrustRequiringProjectResources(cwd)});}} finally {if(original===undefined)delete process.env.HOME;else process.env.HOME=original;}
console.log(JSON.stringify(samples,null,2));
