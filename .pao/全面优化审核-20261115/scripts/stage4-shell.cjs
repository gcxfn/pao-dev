const fs=require('node:fs');
const path=require('node:path');
const ts=require('../../../desktop/node_modules/typescript');
const root=path.resolve(__dirname,'../../..');
const rel='desktop/apps/desktop/src/app/App.tsx';
const file=path.join(root,rel);
let source=fs.readFileSync(file,'utf8');
const sf=ts.createSourceFile(file,source,99,true,ts.ScriptKind.TSX);
const shell=sf.statements.find(n=>n.name?.text==='AppShell');
const declarations=new Map();
for(const n of shell.body.statements)for(const d of n.declarationList?.declarations??[])if(ts.isIdentifier(d.name))declarations.set(d.name.text,n);
function replace(edits){for(const [start,end,text] of edits.sort((a,b)=>b[0]-a[0]))source=source.slice(0,start)+text+source.slice(end);fs.writeFileSync(file,source);}
function write(name,text){const f=path.join(path.dirname(file),name);if(fs.existsSync(f))throw new Error(f);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);}
function snapshot(){const p=path.resolve(__dirname,'../checks/stage4/before',rel);if(!fs.existsSync(p)){fs.mkdirSync(path.dirname(p),{recursive:true});fs.copyFileSync(file,p);}}
snapshot();
const mode=process.argv[2];
if(mode==='effects'){
 const effects=shell.body.statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(sf)==='useEffect');
 const first=effects.find(n=>n.getText(sf).includes('const sessionExtensionUiBySession = snapshot?.sessionExtensionUiBySession;'));
 const second=effects.find(n=>n.getText(sf).includes('if (rootWorkspaceOptions.length === 0)'));
 if(!first||!second)throw new Error('Shell effects not found');
 const params=['snapshot','rootWorkspaceOptions','setDockExpandedBySession','setSettingsWorkspaceId','setSkillsWorkspaceId','setExtensionsWorkspaceId'];
 write('hooks/use-shell-effects.ts',`import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { DesktopAppState, WorkspaceRecord } from "../../../contracts/desktop-state";
import { hasExtensionDockContent } from "../../features/extensions/extension-session-ui";
interface ShellEffectsOptions {
 readonly snapshot: DesktopAppState | null;
 readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
 readonly setDockExpandedBySession: Dispatch<SetStateAction<Record<string,string>>>;
 readonly setSettingsWorkspaceId: Dispatch<SetStateAction<string>>;
 readonly setSkillsWorkspaceId: Dispatch<SetStateAction<string>>;
 readonly setExtensionsWorkspaceId: Dispatch<SetStateAction<string>>;
}
export function useShellEffects({${params.join(',')}}:ShellEffectsOptions){
${first.getText(sf)}
${second.getText(sf)}
}
`);
 replace([[first.getStart(sf),first.end,`useShellEffects({${params.join(',')}});`],[second.getStart(sf),second.end,''],[0,0,'import { useShellEffects } from "./hooks/use-shell-effects";\n']]);
}else if(mode==='navigation'){
 const moving=['openSettings','setActiveView','openSkills','openExtensions','handleTrySkill'].map(n=>{if(!declarations.has(n))throw new Error(n);return declarations.get(n);});
 const params=['api','setSnapshot','rootWorkspaceOptions','settingsWorkspaceId','setSettingsWorkspaceId','setSettingsSection','skillsWorkspaceId','setSkillsWorkspaceId','extensionsWorkspaceId','setExtensionsWorkspaceId','sidebar','fillComposerFromSlash'];
 write('hooks/use-navigation-actions.ts',`import type { Dispatch, SetStateAction } from "react";
import type { AppView, DesktopAppState, WorkspaceRecord } from "../../../contracts/desktop-state";
import type { SettingsSection } from "../../features/settings/settings-view";
import { updateSnapshot } from "../desktop-app-state";
import type { useNarrowSidebar } from "../use-narrow-sidebar";
interface NavigationActionsOptions {
 readonly api: NonNullable<typeof window.piApp>;
 readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState|null>>;
 readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
 readonly settingsWorkspaceId: string;
 readonly setSettingsWorkspaceId: Dispatch<SetStateAction<string>>;
 readonly setSettingsSection: Dispatch<SetStateAction<SettingsSection>>;
 readonly skillsWorkspaceId: string;
 readonly setSkillsWorkspaceId: Dispatch<SetStateAction<string>>;
 readonly extensionsWorkspaceId: string;
 readonly setExtensionsWorkspaceId: Dispatch<SetStateAction<string>>;
 readonly sidebar: ReturnType<typeof useNarrowSidebar>;
 readonly fillComposerFromSlash: (command:string)=>void;
}
export function useNavigationActions({${params.join(',')}}:NavigationActionsOptions){
${moving.map(n=>n.getText(sf).replace('slashMenu.fillComposerFromSlash(command)','fillComposerFromSlash(command)')).join('\n')}
return {openSettings,setActiveView,openSkills,openExtensions,handleTrySkill};
}
`);
 const call=`const {openSettings,setActiveView,openSkills,openExtensions,handleTrySkill}=useNavigationActions({${params.map(p=>p==='api'?'api:api!':p==='fillComposerFromSlash'?'fillComposerFromSlash:(command)=>slashMenu.fillComposerFromSlash(command)':p).join(',')}});`;
 replace(moving.map((n,i)=>[n.getStart(sf),n.end,i===0?call:'']).concat([[0,0,'import { useNavigationActions } from "./hooks/use-navigation-actions";\n']]));
}else if(mode==='surface'){
 const branch=shell.body.statements.find(n=>ts.isIfStatement(n)&&n.expression.getText(sf)==='secondarySurfaceView');
 if(!branch)throw new Error('Secondary branch not found');
 const ret=branch.thenStatement.statements[0];
 const fields=['api','snapshot','setSnapshot','secondarySurfaceView','rootWorkspaceOptions','settingsSection','setSettingsSection','settingsWorkspaceId','setSettingsWorkspaceId','skillsWorkspaceId','setSkillsWorkspaceId','extensionsWorkspaceId','setExtensionsWorkspaceId','setActiveView','handleTrySkill','commandPalette'];
 const mapping={secondarySurfaceView:'activeView',setSettingsSection:'onSelectSettingsSection',setSettingsWorkspaceId:'onSelectSettingsWorkspace',setSkillsWorkspaceId:'onSelectSkillsWorkspace',setExtensionsWorkspaceId:'onSelectExtensionsWorkspace',setActiveView:'onSelectView',handleTrySkill:'onTrySkill'};
 write('secondary-surface-view.tsx',`import type {ComponentProps,ReactNode} from "react";
import type {AppView} from "../../contracts/desktop-state";
import {SecondarySurfaces} from "./secondary-surfaces";
type SurfaceProps=ComponentProps<typeof SecondarySurfaces>;
interface SecondarySurfaceViewProps {
${fields.map(f=>`readonly ${f}: ${f==='commandPalette'?'ReactNode':f==='setActiveView'?'(view:AppView)=>void':`SurfaceProps["${mapping[f]??f}"]`};`).join('\n')}
}
export function SecondarySurfaceView({${fields.join(',')}}:SecondarySurfaceViewProps){
${ret.getText(sf)}
}
`);
 replace([[ret.getStart(sf),ret.end,`return <SecondarySurfaceView ${fields.map(f=>`${f}={${f}}`).join(' ')} />;`],[0,0,'import { SecondarySurfaceView } from "./secondary-surface-view";\n']]);
}else throw new Error(mode);
