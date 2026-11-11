import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {queueHostFingerprint,verifyMigratedHostBinding} from './host-identity.mjs';
import {readMacActivity,idleNavigationAllowed} from './mac-activity.mjs';

const execute=promisify(execFile);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const poll=value=>{
  if(value?.polls)return value.polls[0];
  for(const item of value?.content??[])if(item.type==='text'){try{const v=JSON.parse(item.text);if(v.polls)return v.polls[0];}catch{}}
  return null;
};
export function verifyDesktopLoader(proof,bundleId,{host_fingerprint=queueHostFingerprint()}={}) {
  verifyMigratedHostBinding(proof);
  const before=poll(proof?.before),after=poll(proof?.after);
  if(proof?.source!=='codex_app.wait_threads'||proof.bundle_id!==bundleId||proof.host_fingerprint!==host_fingerprint||
    !uuid.test(before?.thread?.id??'')||before.thread.id!==after?.thread?.id||before.thread.hostId!=='local'||after.thread.hostId!=='local'||
    before.thread.status?.type!=='notLoaded'||!['idle','active'].includes(after.thread.status?.type)||
    before.latestTurn?.id!==after.latestTurn?.id||!before.latestTurn?.id)
    throw new Error('Actual same-host native unloaded-to-loaded App evidence is required');
  return {verified:true,bundle_id:bundleId};
}
export class DesktopLoader {
  constructor({bundle_id,run=execute,now=()=>Date.now(),read_activity}) {
    if(!/^com\.openai\.[a-z0-9.-]+$/i.test(bundle_id??''))throw new Error('Verified OpenAI desktop bundle ID required');
    this.bundle=bundle_id;this.run=run;this.now=now;
    this.readActivity=read_activity??(()=>readMacActivity({now:this.now}));
  }
  async open(threadId,{user_requested_navigation=false,idle_policy,can_open=()=>true}={}) {
    if(user_requested_navigation!==true&&!(idle_policy?.mode==='idle_only'&&idle_policy.authorization_ref))
      throw new Error('Automatic UI navigation is disabled without the authorized idle-only policy');
    if(!uuid.test(threadId??''))throw new Error('Use an exact existing native thread UUID');
    let activity;
    if(!user_requested_navigation){
      try{activity=await this.readActivity();}catch(error){return {open_requested:false,reason:'activity_unavailable',error:error.message};}
      if(!idleNavigationAllowed(activity,idle_policy,this.now()))return {open_requested:false,reason:'user_active_or_idle_unconfirmed',activity};
    }
    if(can_open()!==true)return {open_requested:false,reason:'queued_owner_changed'};
    await this.run('/usr/bin/open',['-g','-b',this.bundle,`codex://threads/${threadId}`],{timeout:10000,maxBuffer:65536});
    return {open_requested:true,thread_id:threadId,bundle_id:this.bundle,requested_at:this.now(),activity,execution_verified:false};
  }
}
