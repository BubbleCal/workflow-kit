import {nativeReadback} from './native-queue.mjs';
import {verifyFollowupAuthority} from './human-followup.mjs';


export function createdOwnerSetupPrompt(taskId,creationKey){return `[workflow-created-owner-setup:${creationKey}]\nThis is the single authorized setup-only continuation for ${taskId}, using the original created owner. Read WORK_TASKS.md in the existing workflow instance and confirm this existing chat can receive a native message. Do not implement, test, build, change product files, create branches/chats/resources, send external messages, change permissions/models, move projects, bind or start the task. Project membership is still unverified; preserve that uncertainty. End with exactly CREATED_OWNER_SETUP_OK and await normal guarded engineering execution.`;}

const sourceFields=['source_thread_id','source_turn_id','source_message_id','verbatim_text'];
function exportValue(value){
 if(value?.content)for(const c of value.content)if(c.type==='text'){try{return JSON.parse(c.text);}catch{}}
 return value;
}
const fresh=(proof,source,now)=>proof?.source===source&&proof.evidence_ref&&Number.isFinite(Date.parse(proof.checked_at))&&Date.parse(proof.checked_at)<=now+5000&&now-Date.parse(proof.checked_at)<=60000;

// Enrich attribution only; an issue URL or an agent relay never becomes a grant.
export function reconcileAcceptedSource(control,input){return control.atomic(()=>{
 if(input.actual_human_verified!==true||!input.evidence_ref)throw Error('Actual original human source proof required');
 verifyFollowupAuthority(input.human_authorization,input);
 const t=control.work.get(input.task_id);
 if(!t||t.state!=='accepted'||t.owner_thread_id||control.work.execution(t.id)||t.data.source?.kind!=='user'||t.authorization?.actual_human_verified!==true||t.authorization.source_message_id!==input.source_message_id)
  throw Error('Accepted unbound original user task and matching acceptance authority required');
 if(sourceFields.some(k=>t.data.source[k]!==undefined&&t.data.source[k]!==input[k]))throw Error('Preserve conflicting original source attribution');
 if(sourceFields.every(k=>t.data.source[k]===input[k]))return {reconciled:false,already_reconciled:true,task_id:t.id,revision:t.revision};
 if(t.revision!==input.expected_revision||control.db.prepare('SELECT 1 FROM work_manual_creation_runs WHERE task_id=?').get(t.id))throw Error('Exact registration revision without a competing manual actor required');
 const source={...t.data.source,...Object.fromEntries(sourceFields.map(k=>[k,input[k]]))},data={...t.data,source};
 control.db.prepare('UPDATE work_items SET data=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(data),control.now(),t.id);
 control.reactive.diagnostic(`accepted-source-repair:${t.id}`,{source_message_id:input.source_message_id,evidence_ref:input.evidence_ref,old_revision:t.revision,new_revision:t.revision+1,original_source:t.data.source,scope_unchanged:true,authorization_unchanged:true});
 return {reconciled:true,task_id:t.id,revision:t.revision+1,scope_unchanged:true,authorization_unchanged:true};
});}

// This operation reasserts the original project for one genuinely created but
// unstarted owner missing from a complete native listing. It asserts no observed
// membership; only a later real list_threads readback can complete setup.
export function createdProjectRepairReasons(control,kind,taskId,payload,evidence,key){
 if(!['repair_created_project','setup_created_owner'].includes(kind))return [];
 const setupOnly=kind==='setup_created_owner';
 try{
  if(!control.work.creation.enabled())throw Error('Existing discovery-owned creation policy required');
  control.work.creation.actor(taskId,evidence.creation_actor);
  const t=control.work.get(taskId),now=control.now(),db=control.db;
  if(!t||t.state!=='accepted'||t.owner_thread_id||control.work.execution(taskId)||t.data.source?.kind!=='user'||t.authorization?.actual_human_verified!==true||t.data.source.source_message_id!==t.authorization.source_message_id)
   throw Error('Unbound unstarted accepted user task required');
  verifyFollowupAuthority(evidence.human_authorization,t.data.source);
  const creation=db.prepare("SELECT * FROM actions WHERE action_key=? AND kind='create_thread' AND state='sent'").get(payload.creation_key);
  const setup=db.prepare('SELECT * FROM thread_setups WHERE creation_key=?').get(payload.creation_key);
  const request=db.prepare('SELECT action_key FROM work_owner_requests WHERE task_id=?').get(taskId);
  const p=JSON.parse(creation?.payload??'{}'),receipt=JSON.parse(creation?.receipt??'{}'),native=exportValue(receipt.native_result?.structuredContent??receipt.native_result);
  const project=control.work.config.scope.project_id,placement=JSON.parse(setup?.placement??'{}');
  if(key!==`${setupOnly?'setup-created-owner':'project-repair'}:${payload.creation_key}`||payload.creation_key!==`owner-create:${t.canonical_key}`||creation?.task_id!==taskId||request?.action_key!==payload.creation_key||receipt.outcome!=='sent'||receipt.native_result?.isError===true||native?.threadId!==payload.thread_id||setup?.task_id!==taskId||setup.thread_id!==payload.thread_id||setup.host_id!=='local'||setup.state!=='project_pending'||payload.host_id!=='local'||payload.project_id!==project||placement.project_id!==project||p.native?.target?.type!=='project'||p.native.target.projectId!==project||p.canonical_task_key!==t.canonical_key)
   throw Error('Exact sent creation and original pending project identity required');
  if(setupOnly){
   const moved=db.prepare("SELECT kind,state,receipt FROM actions WHERE action_key=? AND task_id=?").get(`project-repair:${payload.creation_key}`,taskId),moveReceipt=JSON.parse(moved?.receipt??'{}');
   if(moved?.kind!=='repair_created_project'||moved.state!=='sent'||moveReceipt.outcome!=='sent'||moveReceipt.native_result?.isError===true||payload.prompt!==createdOwnerSetupPrompt(taskId,payload.creation_key))throw Error('A successful original project repair and exact setup-only prompt required');
  }
  const proof=evidence.created_owner_proof,read=nativeReadback(proof?.readback),turn=read.turns?.[0];
  if(!fresh(proof,'codex_app.read_thread',now)||read.thread?.id!==payload.thread_id||read.thread.kind!=='codex'||read.thread.hostId!=='local'||read.thread.cwd!==t.data.workspace||read.thread.status?.type!=='idle'||read.thread.status.activeFlags?.length||turn?.status!=='completed'||turn.error)
   throw Error('Fresh quiescent original created owner proof required');
  const expected=`<codex_delegation>\n  <source_thread_id>${creation.owner}</source_thread_id>\n  <input>${p.native.prompt}</input>\n</codex_delegation>`;
  if(read.turns.filter(turn=>turn.status==='completed'&&!turn.error&&turn.startedAt*1000>=creation.created_at-1000&&(turn.items??[]).some(i=>i.type==='userMessage'&&(i.content??[]).map(c=>c.text??'').join('\n')===p.native.prompt||i.type==='functionCallOutput'&&i.namespace==='codex_app'&&i.name==='create_thread'&&i.output?.truncated===false&&i.output.text===expected)).length!==1)
   throw Error('Exact completed original creation setup required');
  const listing=evidence.complete_thread_listing,l=exportValue(listing?.readback),projects=evidence.project_listing,catalog=exportValue(projects?.readback);
  if(!fresh(listing,'codex_app.list_threads',now)||listing.request?.mode!=='history'||listing.request.archived!==false||listing.request.cursor||l?.nextCursor||!Array.isArray(l?.threads)||l.threads.some(x=>x.id===payload.thread_id))
   throw Error('Complete fresh native listing must genuinely omit this owner; never invent actual_project_id');
  if(!fresh(projects,'codex_app.list_projects',now)||!catalog?.projects?.some(x=>x.projectId===project&&x.hostId==='local'&&x.path===t.data.workspace))throw Error('Fresh original destination project catalog required');
  if(db.prepare("SELECT 1 FROM actions WHERE task_id=? AND action_key<>? AND state IN ('claimed','uncertain')").get(taskId,key))throw Error('Preserve in-flight or uncertain effects');
  return [];
 }catch(error){return [error.message];}
}
