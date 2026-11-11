import {ControlStore} from '../control.mjs';
import {WorkCatalog} from '../work-catalog.mjs';
import {DiscoveryStore} from '../discovery.mjs';
import {nativeProof,OWNER,NOW,QUEUE_ID} from './reactive.mjs';

export const MAIN='44444444-4444-4444-8444-444444444444',DISCOVERY='55555555-5555-4555-8555-555555555555';
export function workFixture(path=':memory:'){
  let time=NOW,work;
  const config={layout:'native',instance_id:'native-fixture',scope:{project_id:'project',project_root:'/task',repositories:[]},threads:{main:MAIN,discovery:DISCOVERY},thread_workspaces:{main:'/task',discovery:'/task'}};
  const registry=()=>({scope:config.scope,task_registry:{items:Object.fromEntries((work?.list()??[]).map(t=>[t.id,{canonical_key:t.canonical_key,owner_thread_id:t.owner_thread_id,status:t.state}]))}});
  const c=new ControlStore(path,{now:()=>time,taskRegistry:registry});
  work=new WorkCatalog(c.db,{config,now:()=>time});c.work=work;c.reactive.registry=registry;c.reactive.completionReasons=id=>work.completionReasons(id);
  c.discovery=new DiscoveryStore(c.db,{config,work,reactive:c.reactive,now:()=>time});
  const accept=id=>work.accept({task_id:id,source_message_id:'user:accept',actual_human_verified:true,evidence_ref:'actual-user-task'});
  const bind=(id,owner=OWNER)=>work.bindOwner({task_id:id,owner_thread_id:owner,native_binding:nativeProof({thread:owner,status:'completed',now:time}),
    evidence_ref:'native-owner-readback',existing_owner_authorized:true,actual_human_verified:true,source_message_id:'user:owner'});
  const begin=id=>{
    work.start(c.reactive,{task_id:id,queue_compatibility_verified:true});const w=c.reactive.reserveQueuedWake(id).wake,prompt=`[workflow-event:${w.id}] explore`;
    c.db.prepare("UPDATE rt_wakes SET state='queued',queue_id=?,prompt=? WHERE id=?").run(QUEUE_ID,prompt,w.id);
    c.reactive.begin({task_id:id,wake_id:w.id,native_proof:nativeProof({message:prompt,now:time})});return c.reactive.openWake(id);
  };
  return {c,work,config,accept,bind,begin,advance:ms=>{time+=ms;},now:()=>time};
}
