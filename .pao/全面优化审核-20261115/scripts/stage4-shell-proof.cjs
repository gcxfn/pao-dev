const fs=require('node:fs'),path=require('node:path'),ts=require('../../../desktop/node_modules/typescript');
const root=path.resolve(__dirname,'../../..'),dir=path.resolve(__dirname,'../checks');
const appRel='desktop/apps/desktop/src/app/App.tsx';
const parse=p=>ts.createSourceFile(p,fs.readFileSync(p,'utf8'),99,true,ts.ScriptKind.TSX);
const before=parse(path.join(dir,'stage4/before',appRel)),after=parse(path.join(root,appRel));
const nav=parse(path.join(root,'desktop/apps/desktop/src/app/hooks/use-navigation-actions.ts'));
const effects=parse(path.join(root,'desktop/apps/desktop/src/app/hooks/use-shell-effects.ts'));
function find(sf,predicate){let found;function visit(n){if(predicate(n))found=n;ts.forEachChild(n,visit);}visit(sf);if(!found)throw new Error('Node not found');return found;}
const variable=(sf,name)=>find(sf,n=>ts.isVariableDeclaration(n)&&n.name.getText(sf)===name);
const body=(sf,name)=>variable(sf,name).initializer.body.getText(sf);
const result={};
for(const name of ['openSettings','openSkills','openExtensions'])result[name]=body(before,name)===body(nav,name);
for(const marker of ['const sessionExtensionUiBySession = snapshot?.sessionExtensionUiBySession;','if (rootWorkspaceOptions.length === 0)']){
 const extract=sf=>find(sf,n=>ts.isCallExpression(n)&&n.expression.getText(sf)==='useEffect'&&n.arguments[0]?.getText(sf).includes(marker)).arguments[0].body.getText(sf);
 result[marker]=extract(before)===extract(effects);
}
result.sessionConversation=variable(before,'sessionConversation').initializer.getText(before)===variable(after,'sessionConversation').initializer.getText(after);
const hookSequence=sf=>{
 const shell=find(sf,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='AppShell');const ids=[];
 function visit(n){
  if(ts.isFunctionLike(n)&&n!==shell)return;
  if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&/^use[A-Z]/.test(n.expression.text)){
   if(n.expression.text==='useShellEffects')ids.push('useEffect','useEffect');else if(n.expression.text!=='useNavigationActions')ids.push(n.expression.text);
  }
  ts.forEachChild(n,visit);
 }
 visit(shell);return ids;
};
const beforeHooks=hookSequence(before),afterHooks=hookSequence(after);result.hookOrder=JSON.stringify(beforeHooks)===JSON.stringify(afterHooks);
fs.writeFileSync(path.join(dir,'S08-body-comparison.json'),JSON.stringify({comparisons:result,beforeHooks,afterHooks},null,2)+'\n');
console.log(result);if(Object.values(result).some(v=>!v))process.exitCode=1;
