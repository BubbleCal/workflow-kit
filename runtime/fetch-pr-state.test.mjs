import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const head='a'.repeat(40),collector=fileURLToPath(new URL('./fetch-pr-state.mjs',import.meta.url));
for(const mode of ['partial','closed','moved']){
  test('the collector handles '+mode+' source state without inventing CI success',()=>{
    const dir=mkdtempSync(join(tmpdir(),'pr-state-collector-'));
    try{
      const pr={head:{sha:head},state:mode==='closed'?'closed':'open',draft:true,merged:false,updated_at:'2026-11-03T06:00:00Z'};
      writeFileSync(join(dir,'pr.json'),JSON.stringify(pr));
      writeFileSync(join(dir,'gh'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),dir=__dirname,endpoint=process.argv[3];
const calls=path.join(dir,'calls.json'),seen=fs.existsSync(calls)?JSON.parse(fs.readFileSync(calls)):[];seen.push(endpoint);fs.writeFileSync(calls,JSON.stringify(seen));
const pr=JSON.parse(fs.readFileSync(path.join(dir,'pr.json')));
if(endpoint.includes('/pulls/')){if(process.env.FIXTURE_MODE==='moved'&&seen.filter(x=>x.includes('/pulls/')).length>1)pr.head.sha='b'.repeat(40);console.log(JSON.stringify(pr));}
else if(process.env.FIXTURE_MODE==='closed'){process.exit(9);}
else if(endpoint.includes('/check-runs'))console.log(JSON.stringify([{total_count:2,check_runs:[{id:1,name:'deny',head_sha:pr.head.sha,status:'completed',conclusion:'failure',html_url:'https://example.test/check/1'},{id:2,name:'build',head_sha:pr.head.sha,status:'in_progress',conclusion:null}]}]));
else console.log(JSON.stringify([{sha:pr.head.sha,total_count:0,statuses:[]}]));
`,{mode:0o700});
      const output=join(dir,'snapshot.json'),r=spawnSync(process.execPath,[collector,'--repo','example/project','--pr','42','--output',output],{encoding:'utf8',env:{...process.env,PATH:dir+delimiter+process.env.PATH,FIXTURE_MODE:mode}});
      if(mode==='moved'){assert.notEqual(r.status,0);assert.equal(existsSync(output),false);return;}
      assert.equal(r.status,0,r.stderr);const snapshot=JSON.parse(readFileSync(output));
      if(mode==='closed'){assert.equal(snapshot.state,'closed');assert.equal(snapshot.ci,undefined);assert.equal(JSON.parse(readFileSync(join(dir,'calls.json'))).every(x=>x.includes('/pulls/')),true);}
      else{assert.equal(snapshot.ci.checks[0].conclusion,'failure');assert.equal(snapshot.ci.checks[1].status,'in_progress');assert.equal(snapshot.checks_state,'unknown');assert.equal(snapshot.ci.required_policy,'not_evaluated');}
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
}
