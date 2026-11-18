const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const rel='desktop/apps/desktop/electron/main.ts',file=path.join(root,rel);
const source=fs.readFileSync(file,'utf8');
const saved=path.resolve(__dirname,'../checks/stage4/after',rel);
fs.mkdirSync(path.dirname(saved),{recursive:true});fs.writeFileSync(saved,source);
const home=path.resolve(root,'../临时文件夹',`pao-stage4-ui-baseline-${Date.now()}`);fs.mkdirSync(home,{recursive:true});
const env={...process.env,PAO_HOME:home,PI_APP_TEST_LANE:'core',PI_APP_REAL_AUTH:'0',PI_APP_TEST_MODE:'background'};
function run(args,cwd,name,extras={}){
 const log=path.resolve(__dirname,'../checks',name+'.log'),fd=fs.openSync(log,'w');
 const r=spawnSync(process.execPath,args,{cwd:path.join(root,cwd),env:{...env,...extras},stdio:['ignore',fd,fd]});
 fs.closeSync(fd);console.log(name+': '+r.status);return r.status;
}
const cli=path.join(root,'desktop/node_modules/playwright/cli.js');
try{
 fs.copyFileSync(path.resolve(__dirname,'../checks/stage4/before',rel),file);
 const build=run([path.join(root,'desktop/apps/desktop/node_modules/electron-vite/bin/electron-vite.js'),'build'],'desktop/apps/desktop','S-ui-before-build');
 if(build!==0)process.exitCode=1;
 else{
  const specs=['changed-files','attach-image','settings-general','composer-controls','settings-appearance','integrated-terminal','d5-workflow-layout','f-desktop-t22-a11y','skills-settings','memory'].map(n=>'apps/desktop/tests/core/'+n+'.spec.ts');
  run([cli,'test','-c','apps/desktop/playwright.config.ts',...specs],'desktop','S-ui-before-tests');
  run([cli,'test','-c',path.join(__dirname,'stage4-ui.config.cjs')],'desktop','S07-ui-before',{STAGE4_UI_PHASE:'before'});
 }
}finally{fs.writeFileSync(file,source);}
