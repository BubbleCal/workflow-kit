import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SourceRate,sourceInterval} from './source-rate.mjs';

test('source cadence scales with monitored PRs and preserves the shared read budget',()=>{
  const config={poll_min_ms:30000,github_read_budget_per_hour:1800};
  const interval=sourceInterval(config,24);
  assert.ok(24*12*3600000/interval<=1800);assert.ok(interval>=config.poll_min_ms);
  assert.equal(sourceInterval(config,1),30000);
});

test('a provider rate limit pauses all source reads until reset and survives restart',async()=>{
  const db=new DatabaseSync(':memory:');let now=100000,calls=0;
  const readQuota=async()=>{calls++;return {core:{remaining:0,reset:160},graphql:{remaining:4000,reset:170}};};
  try{
    const g=new SourceRate(db,{now:()=>now,readQuota});
    const result=await Promise.all([g.observe(new Error('API rate limit exceeded')),g.observe(new Error('API rate limit exceeded'))]);
    assert.equal(calls,1);assert.deepEqual(result,[161000,161000]);assert.equal(g.paused(),true);
    const restarted=new SourceRate(db,{now:()=>now,readQuota});await restarted.observe(new Error('API rate limit exceeded'));assert.equal(calls,1);
    now=161000;assert.equal(restarted.paused(),false);restarted.success();assert.equal(restarted.current().failures,0);
    assert.equal(await restarted.observe(new Error('Unrelated source failure')),null);
  }finally{db.close();}
});
