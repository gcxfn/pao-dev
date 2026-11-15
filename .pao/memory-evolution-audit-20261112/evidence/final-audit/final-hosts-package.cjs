const asar=require('D:/AI/workspace/pao-dev/desktop/node_modules/@electron/asar');
const fs=require('node:fs');
const path=require('node:path');
const archive='D:/AI/workspace/pao-dev/desktop/apps/desktop/release/win-unpacked/resources/app.asar';
const files=asar.listPackage(archive);
const results=[];
for(const suffix of ['pao/memory/backup.js','pao/memory/maintenance.js','pao/memory/tools.js','pao/worker/dispatch-core.js','pao/desktop/host-mount.js','pao/evolution/host-mount.js','pao/memory/artifact-registration.js','main.js']) {
 const entry=files.find(p=>p.replaceAll('\\','/').endsWith('/node_modules/@pao/coding-agent/dist/'+suffix));
 const out={suffix,entry:entry??null,markers:{}};
 if(entry) {
  const body=asar.extractFile(archive,entry.replace(/^[/\\]/,'')).toString('utf8');
  for(const marker of ['serialize(','VACUUM INTO','snapshotDb','sourceStillLinked','enqueueEvolveJob','enqueueMaintenanceJob','finishMaintenanceBatch','makeRegisterReceiptArtifacts','ensureTaskBindings','recordUsed','handleRegression','recoverEvolutionState']) {
   out.markers[marker]=body.split(/\r?\n/).flatMap((line,i)=>line.includes(marker)?[i+1]:[]);
  }
 }
 results.push(out);
}
const report={archive,modified:fs.statSync(archive).mtime.toISOString(),results};
fs.writeFileSync(path.join(__dirname,'final-hosts-package-result.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
