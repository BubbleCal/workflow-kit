import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {queueHostFingerprint} from './native-queue.mjs';

const execute=promisify(execFile);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const poll=value=>{
  if(value?.polls)return value.polls[0];
  for(const item of value?.content??[])if(item.type==='text'){try{const v=JSON.parse(item.text);if(v.polls)return v.polls[0];}catch{}}
  return null;
};
export function verifyDesktopLoader(proof,bundleId) {
  const before=poll(proof?.before),after=poll(proof?.after);
  if(proof?.source!=='codex_app.wait_threads'||proof.bundle_id!==bundleId||proof.host_fingerprint!==queueHostFingerprint()||
    !uuid.test(before?.thread?.id??'')||before.thread.id!==after?.thread?.id||before.thread.hostId!=='local'||after.thread.hostId!=='local'||
    before.thread.status?.type!=='notLoaded'||!['idle','active'].includes(after.thread.status?.type)||
    before.latestTurn?.id!==after.latestTurn?.id||!before.latestTurn?.id)
    throw new Error('Actual same-host native unloaded-to-loaded App evidence is required');
  return {verified:true,bundle_id:bundleId};
}
export class DesktopLoader {
  constructor({bundle_id,run=execute,now=()=>Date.now()}) {
    if(!/^com\.openai\.[a-z0-9.-]+$/i.test(bundle_id??''))throw new Error('Verified OpenAI desktop bundle ID required');
    this.bundle=bundle_id;this.run=run;this.now=now;
  }
  async open(threadId,{user_requested_navigation=false}={}) {
    if(user_requested_navigation!==true)throw new Error('Automatic UI navigation is disabled; an explicit user navigation request is required');
    if(!uuid.test(threadId??''))throw new Error('Use an exact existing native thread UUID');
    await this.run('/usr/bin/open',['-g','-b',this.bundle,`codex://threads/${threadId}`],{timeout:10000,maxBuffer:65536});
    return {open_requested:true,thread_id:threadId,bundle_id:this.bundle,requested_at:this.now(),execution_verified:false};
  }
}
