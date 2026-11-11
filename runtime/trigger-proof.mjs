import {nativeReadback} from './native-queue.mjs';

export function triggerMessage(db,id){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='rt_trigger_messages'").get())return null;
 const r=db.prepare('SELECT * FROM rt_trigger_messages WHERE id=?').get(id);
 return r?{...r,data:JSON.parse(r.data),receipt:r.receipt?JSON.parse(r.receipt):null}:null;
}
const xml=text=>text.replace(/&(lt|gt|amp|quot|apos);/g,(_,k)=>({lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"})[k]);
export function verifyTriggerExecution(db,id,proof,{thread_id,workspace,now=Date.now(),terminal=false}={}){
 const r=triggerMessage(db,id);if(!r)return null;
 if(!['claimed','sent','uncertain','started','finished'].includes(r.state)||r.owner_id!==thread_id)throw Error('Original claimed trigger delivery required');
 const read=nativeReadback(proof?.readback),at=Date.parse(proof?.checked_at),t=read.turns?.[0];
 if(proof?.source!=='codex_app.read_thread'||!proof.evidence_ref||!Number.isFinite(at)||at>now+5000||now-at>60000||
  read.thread?.id!==thread_id||read.thread.kind!=='codex'||read.thread.hostId!=='local'||read.thread.cwd!==workspace||
  !t?.id||t.id===r.preflight_turn||!Number.isFinite(t.startedAt)||t.startedAt*1000<r.claimed_at-1000||
  (!terminal&&(read.thread.status?.type!=='active'||t.status!=='inProgress'||t.error))||terminal&&!['completed','failed','interrupted'].includes(t.status))
  throw Error('Fresh distinct actual trigger-started native turn required');
 const matches=t.items?.filter(i=>{
  if(i.type!=='functionCallOutput'||i.namespace!=='codex_app'||i.name!=='send_message_to_thread'||i.output?.truncated!==false)return false;
  const text=i.output.text??'',m=text.match(/^<codex_delegation>\s*<source_thread_id>([^<]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/);
  return m&&m[1]===r.sender_id&&(m[2]===r.prompt||xml(m[2])===r.prompt);
 })??[];
 if(matches.length!==1)throw Error('Exact original trigger sender and immutable registered message required');
 return {turn_id:t.id,status:t.status,evidence_ref:proof.evidence_ref,transport:'native_trigger',trigger_message_id:id};
}

export function settleTriggerDiscovery(db,mailbox,batch,owner,now){
 const id=`discovery:${batch.id}:${batch.generation}`,r=triggerMessage(db,id);if(!r)return null;
 const current=db.prepare('SELECT state,generation FROM discovery_batches WHERE id=?').get(batch.id);
 const run=db.prepare('SELECT thread_id,turn_id FROM work_creation_runs WHERE batch_id=? AND generation=?').get(batch.id,batch.generation);
 const mail=mailbox.db.prepare('SELECT state,batch_id FROM mail WHERE item_key=?').get(id);
 if(!current||!['finished','checkpointed'].includes(current.state)||current.generation!==batch.generation||!r.execution_turn||r.execution_turn!==run?.turn_id||run.thread_id!==owner||r.owner_id!==owner||!['started','finished'].includes(r.state)||mail?.batch_id)
  throw Error('Original actual trigger discovery execution and unsent mailbox receipt required');
 if(mail&&!['pending','trigger_pending','acknowledged'].includes(mail.state))throw Error('Preserve competing discovery delivery');
 if(mail)mailbox.db.prepare("UPDATE mail SET state='acknowledged',completed_at=? WHERE item_key=? AND state IN ('pending','trigger_pending') AND batch_id IS NULL").run(now,id);
 db.prepare("UPDATE rt_trigger_messages SET state='finished',updated_at=? WHERE id=?").run(now,id);
 return{settled:true,transport:'native_trigger',batch_id:batch.id,generation:batch.generation,turn_id:run.turn_id,queue_consumed:false};
}
