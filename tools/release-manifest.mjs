import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version;
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(file=>file&&existsSync(resolve(root,file))))].sort();
const hash=file=>createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex');
const save=(file,data)=>writeFileSync(resolve(root,file),JSON.stringify(data,null,2)+'\n');
const sourceFiles=files.filter(f=>f.endsWith('.mjs')||f==='package.json');
const baseIndex=process.argv.indexOf('--base');
const base=baseIndex>=0?execFileSync('git',['rev-parse','--verify',process.argv[baseIndex+1]],{cwd:root,encoding:'utf8'}).trim():null;
save('PROVENANCE.json',{version,source:'workflow-kit repository source',...(base?{upstream_base_commit:base}:{}),
  source_files:Object.fromEntries(sourceFiles.map(file=>[file,hash(file)])),operational_data_exported:false,credentials_exported:false});
save('MANIFEST.json',{version,files:Object.fromEntries(files.filter(f=>f!=='MANIFEST.json').map(file=>[file,hash(file)]))});
console.log(JSON.stringify({version,source_files:sourceFiles.length,manifest_files:files.length-1}));
