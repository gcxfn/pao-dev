const fs = require('node:fs');
const path = require('node:path');
const ts = require('../../../desktop/node_modules/typescript');
const root = path.resolve(__dirname, '../../..');
const evidence = path.resolve(__dirname, '../checks/stage4');
fs.mkdirSync(evidence, { recursive: true });
const relative = p => path.relative(root, p).replaceAll('\\', '/');
const names = n => n.name ? [n.name.text] : n.declarationList ? n.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name.text] : []) : [];
function load(file) {
  const source = fs.readFileSync(file, 'utf8');
  const program = ts.createProgram([file], { noResolve: true, target: ts.ScriptTarget.Latest, allowImportingTsExtensions: true });
  return { source, sf: program.getSourceFile(file), checker: program.getTypeChecker() };
}
function snapshot(file) {
  const dest = path.join(evidence, 'before', relative(file));
  if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(file, dest); }
}
function analyze(file) {
  const { source, sf, checker } = load(file);
  const declarations = new Map();
  const symbols = new Map();
  for (const n of sf.statements) {
    for (const name of names(n)) {
      declarations.set(name, n);
      const id = n.name ?? n.declarationList.declarations.find(d => d.name.text === name)?.name;
      if (id) symbols.set(checker.getSymbolAtLocation(id), name);
    }
  }
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const importBindings = new Map();
  for (const n of imports) {
    const c = n.importClause;
    const bindings = [c?.name, ...(c?.namedBindings ? ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.map(x => x.name) : [c.namedBindings.name] : [])].filter(Boolean);
    for (const id of bindings) importBindings.set(checker.getSymbolAtLocation(id), { name: id.text, node: n });
  }
  function refs(nodes) {
    const local = new Set(), external = new Set();
    function visit(n) {
      if (ts.isIdentifier(n)) {
        const symbol = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name===n ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
        if (symbols.has(symbol)) local.add(symbols.get(symbol));
        if (importBindings.has(symbol)) external.add(importBindings.get(symbol).name);
      }
      ts.forEachChild(n, visit);
    }
    nodes.forEach(visit);
    return { local, external };
  }
  return { source, sf, declarations, imports, refs };
}
function importText(n, used, targetFile, sourceFile) {
  const c = n.importClause;
  if (!c) return n.getText();
  let typeOnly=c.isTypeOnly;
  const pieces = [];
  if (c.name && used.has(c.name.text)) pieces.push(c.name.text);
  if (c.namedBindings) {
    if (ts.isNamespaceImport(c.namedBindings)) { if (used.has(c.namedBindings.name.text)) pieces.push(c.namedBindings.getText()); }
    else {
      const selected=c.namedBindings.elements.filter(x => used.has(x.name.text));
      if(!pieces.length && selected.length && selected.every(x=>x.isTypeOnly))typeOnly=true;
      const items = selected.map(x => typeOnly && x.isTypeOnly ? x.getText().replace(/^type\s+/,'') : x.getText());
      if (items.length) pieces.push(`{ ${items.join(', ')} }`);
    }
  }
  if (!pieces.length) return '';
  let module = n.moduleSpecifier.text;
  if (module.startsWith('.') && path.dirname(targetFile) !== path.dirname(sourceFile)) {
    module = path.relative(path.dirname(targetFile), path.resolve(path.dirname(sourceFile), module)).replaceAll('\\', '/');
    if (!module.startsWith('.')) module = './' + module;
  }
  return `import ${typeOnly ? 'type ' : ''}${pieces.join(', ')} from ${JSON.stringify(module)};`;
}
function isType(n) { return ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n); }
function isExport(n) { return n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword); }
function move(fileRel, newRel, requested, allowedBack = []) {
  const file = path.resolve(root, fileRel), dest = path.resolve(path.dirname(file), newRel);
  const a = analyze(file);
  const extension = fileRel.startsWith('PAO/') ? '.ts' : a.imports.some(n=>n.moduleSpecifier.text.startsWith('.') && n.moduleSpecifier.text.endsWith('.js')) ? '.js' : '';
  const missing = requested.filter(n => !a.declarations.has(n));
  if (missing.length) throw new Error(`Missing declarations: ${missing.join(', ')}`);
  const moving = [...new Set(requested.map(n => a.declarations.get(n)))].sort((a,b)=>a.pos-b.pos);
  const moved = new Set(moving.flatMap(names));
  const rest = a.sf.statements.filter(n => !moving.includes(n) && !ts.isImportDeclaration(n));
  const moveRefs = a.refs(moving), restRefs = a.refs(rest);
  const append = fs.existsSync(dest) && newRel === 'app-store-utils.ts';
  if (append) {
    const existing=analyze(dest);
    for(const imp of existing.imports){
      const c=imp.importClause;
      const ids=[c?.name,...(c?.namedBindings ? ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.map(x=>x.name) : [c.namedBindings.name] : [])].filter(Boolean);
      for(const id of ids)moveRefs.external.delete(id.text);
    }
  }
  const backs = [...moveRefs.local].filter(n => !moved.has(n));
  const forbidden = backs.filter(n => !isExport(a.declarations.get(n)) && !allowedBack.includes(n));
  if (forbidden.length) throw new Error(`Private back dependencies for ${newRel}: ${forbidden.join(', ')}`);
  const importsFor = (nodes, used, dest) => nodes.map(n=>importText(n, used, dest, file)).filter(Boolean).join('\n');
  const modulePath = './' + path.relative(path.dirname(dest), file).replaceAll('\\', '/').replace(/\.tsx?$/, extension);
  const newImports = [importsFor(a.imports, moveRefs.external, dest)];
  for (const type of [true, false]) {
    const ns = backs.filter(n=>isType(a.declarations.get(n)) === type);
    if (ns.length) newImports.push(`import ${type ? 'type ' : ''}{ ${ns.join(', ')} } from ${JSON.stringify(modulePath)};`);
  }
  const exportedMoved = moving.filter(isExport).flatMap(names);
  const importMoved = [...moved].filter(n=>restRefs.local.has(n));
  const movedPath = './' + path.relative(path.dirname(file), dest).replaceAll('\\', '/').replace(/\.tsx?$/, extension);
  const keptImports = [importsFor(a.imports, restRefs.external, file)];
  for (const type of [true,false]) {
    const ns = importMoved.filter(n=>isType(a.declarations.get(n))===type);
    if(ns.length) keptImports.push(`import ${type?'type ':''}{ ${ns.join(', ')} } from ${JSON.stringify(movedPath)};`);
    const es = exportedMoved.filter(n=>isType(a.declarations.get(n))===type);
    if(es.length) keptImports.push(`export ${type?'type ':''}{ ${es.join(', ')} } from ${JSON.stringify(movedPath)};`);
  }
  const newBody = moving.map(n => { const text = a.source.slice(n.pos, n.end); return isExport(n) ? text : text.slice(0, n.getStart()-n.pos) + 'export ' + text.slice(n.getStart()-n.pos); }).join('\n');
  const keptBody = rest.map(n => {
    const text = a.source.slice(n.pos,n.end);
    return names(n).some(name=>backs.includes(name)) && !isExport(n) ? text.slice(0,n.getStart()-n.pos)+'export '+text.slice(n.getStart()-n.pos) : text;
  }).join('\n');
  snapshot(file);
  if (fs.existsSync(dest) && !append) throw new Error(`Destination exists: ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive:true });
  const existing=append ? fs.readFileSync(dest,'utf8') : '';
  if(append)snapshot(dest);
  fs.writeFileSync(dest, newImports.filter(Boolean).join('\n')+'\n'+existing+newBody+'\n');
  const prefix = a.source.slice(0, a.sf.statements[0]?.getStart() ?? 0);
  const suffix = a.source.slice(a.sf.statements.at(-1)?.end ?? a.source.length);
  fs.writeFileSync(file, prefix+keptImports.filter(Boolean).join('\n')+'\n'+keptBody+suffix);
  console.log(JSON.stringify({ source:fileRel, destination:relative(dest), names:[...moved], backDependencies:backs, exports:exportedMoved }));
}
const [mode,file,...args] = process.argv.slice(2);
if (mode === 'list') {
  const a=analyze(path.resolve(root,file));
  for(const [name,n] of a.declarations) console.log(`${a.sf.getLineAndCharacterOfPosition(n.getStart()).line+1}\t${name}\t${[...a.refs([n]).local].filter(x=>!names(n).includes(x)).join(',')}`);
} else if(mode === 'move') move(file,args[0],args[1].split(','),args[2]?.split(',')??[]);
else if(mode === 'prune') {
 const target=path.resolve(root,file),a=analyze(target);
 const rest=a.sf.statements.filter(n=>!ts.isImportDeclaration(n));
 const used=a.refs(rest).external;
 const prefix=a.source.slice(0,a.sf.statements[0]?.getStart()??0);
 const imports=a.imports.map(n=>importText(n,used,target,target)).filter(Boolean).join('\n');
 fs.writeFileSync(target,prefix+imports+'\n'+rest.map(n=>a.source.slice(n.pos,n.end)).join('\n')+a.source.slice(a.sf.statements.at(-1).end));
 console.log('Imports pruned: '+file);
}
else if(mode === 'read') {
 const a=analyze(path.resolve(root,file)); for(const name of args[0].split(',')) { const n=a.declarations.get(name); if(!n)throw new Error(name); console.log(a.source.slice(n.pos,n.end)); }
}

