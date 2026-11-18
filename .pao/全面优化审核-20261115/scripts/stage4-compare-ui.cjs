const fs=require('node:fs'),path=require('node:path');
const {PNG}=require('../../../desktop/node_modules/playwright-core/lib/utilsBundle.js');
const dir=path.resolve(__dirname,'../checks'),images=path.resolve(__dirname,'../ui-screenshots/stage4');
const read=n=>fs.readFileSync(path.join(dir,n),'utf8');
function cases(file){const found=new Map();for(const line of read(file).split(/\r?\n/)){const m=/^\s+(ok|x|-)\s+\d+\s+(.+?\.spec\.ts:\d+:\d+\s+›\s+.+)$/.exec(line);if(m)found.set(m[2].replace(/\s+\([^()]+\)$/,'').replaceAll('\\','/'),m[1]);}return found;}
const before=cases('S-ui-before-tests.log'),after=cases('S-final-ui-tests.log');
const failures=[...after].filter(([,status])=>status==='x').map(([name])=>name);
const introducedFailures=failures.filter(name=>before.get(name)!=='x');
const result={beforeCases:before.size,afterCases:after.size,beforeFailures:[...before].filter(([,s])=>s==='x').map(([n])=>n),afterFailures:failures,introducedFailures};
fs.writeFileSync(path.join(dir,'S-ui-test-comparison.json'),JSON.stringify(result,null,2)+'\n');
const base=JSON.parse(read('S07-ui-before-metrics.json')),final=JSON.parse(read('S07-ui-final-metrics.json'));
function visibleLayout(rows){return rows.filter(r=>r.width&&r.height).map(({border,...r})=>({...r,borderSize:border.split(' ').slice(0,2).join(' ')}));}
const layout=Object.keys(base).map(frame=>({frame,visibleLayoutIdentical:JSON.stringify(visibleLayout(base[frame]))===JSON.stringify(visibleLayout(final[frame]))}));
fs.writeFileSync(path.join(dir,'S-final-layout-comparison.json'),JSON.stringify(layout,null,2)+'\n');
const pixels=[];
for(const frame of Object.keys(base)){
 const a=PNG.sync.read(fs.readFileSync(path.join(images,'before',frame+'.png'))),b=PNG.sync.read(fs.readFileSync(path.join(images,'s07',frame+'.png')));
 let differentPixels=0,minX=a.width,minY=a.height,maxX=0,maxY=0;
 for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){const i=(y*a.width+x)*4;if(!a.data.subarray(i,i+4).equals(b.data.subarray(i,i+4))){differentPixels++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
 pixels.push({frame,width:a.width,height:a.height,differentPixels,bounds:differentPixels?{minX,minY,maxX,maxY}:null});
}
fs.writeFileSync(path.join(dir,'S07-pixel-comparison.json'),JSON.stringify(pixels,null,2)+'\n');
console.log(JSON.stringify({beforeCases:before.size,afterCases:after.size,introducedFailures,layout}));
if(introducedFailures.length||layout.some(r=>!r.visibleLayoutIdentical))process.exitCode=1;
