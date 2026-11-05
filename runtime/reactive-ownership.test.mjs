import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeControlRuntime} from './reactive-ownership.mjs';
test('a paused native layout cannot fall back to a legacy dispatcher',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-control-ownership-'));
 try{writeFileSync(join(root,'instance.json'),JSON.stringify({layout:'native'}));
 assert.equal(nativeControlRuntime(join(root,'mailbox.sqlite')),true);
 writeFileSync(join(root,'instance.json'),JSON.stringify({layout:'legacy'}));assert.equal(nativeControlRuntime(join(root,'mailbox.sqlite')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
