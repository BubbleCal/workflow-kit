import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {NativeQueue,validateQueueCompatibility,verifyNativeBinding,nativeReadback} from './native-queue.mjs';
import {verifyDesktopLoader} from './desktop-loader.mjs';
import {legacyHostFingerprint,queueHostFingerprint} from './host-identity.mjs';
import {verifyFollowupAuthority} from './human-followup.mjs';
import {validateIdleNavigationPolicy} from './mac-activity.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Explicit bootstrap: ordinary runtime operations retain their normal checks.
export async function migrateRuntimeHostBinding(control,input,{root=control.work.config.instance_root,identity=()=>({legacy:legacyHostFingerprint(),stable:queueHostFingerprint()}),probeQueue=async config=>new NativeQueue(config.queue).probe()}={}){
 if(input.actual_human_verified!==true||!input.evidence_ref)throw Error('Actual maintenance authority required');
 verifyFollowupAuthority(input.human_authorization,input);
 const path=join(root,'runtime.json'),before=readFileSync(path),config=JSON.parse(before),task=input.task_id?control.reactive.task(input.task_id):null,wake=task&&control.reactive.openWake(task.task_id);
 const support=control.work.config.support,interactive=input.interactive_maintenance===true;
 let actor;
 if(interactive){
  if(input.task_id||config.service_tasks?.maintenance||support?.mode!=='manual_only'||support.automatic_control_lane!==false||
   !support.source_message_id||!support.evidence_ref||!support.maintenance_thread_id||input.owner_thread_id!==support.maintenance_thread_id||!input.expected_turn_id||
   control.reactive.tasks().some(t=>t.owner_id===support.maintenance_thread_id&&t.mode==='active'&&t.status!=='complete')||
   control.db.prepare("SELECT 1 FROM actions WHERE owner=? AND state IN ('claimed','uncertain')").get(support.maintenance_thread_id))
   throw Error('Use the configured manual-only maintenance owner without creating or borrowing an execution task');
  actor={owner_id:support.maintenance_thread_id,workspace:control.work.config.thread_workspaces?.maintenance??control.work.config.scope.project_root,turn_id:input.expected_turn_id};
 }else{
  if(config.service_tasks?.maintenance!==task?.task_id||task?.mode!=='active'||task.contract.service_lane!=='maintenance'||wake?.state!=='running')throw Error('Acknowledged original maintenance wake required');
  actor={owner_id:task.owner_id,workspace:task.contract.workspace,turn_id:wake.turn_id};
 }
 verifyNativeBinding(input.native_proof,{thread_id:actor.owner_id,workspace:actor.workspace,now:control.now()});
 const native=nativeReadback(input.native_proof.readback);if(native.thread.status?.type!=='active'||native.turns[0]?.status!=='inProgress'||native.turns[0].id!==actor.turn_id||interactive&&(native.thread.status.activeFlags??[]).length)throw Error('Actual executing maintenance owner required');
 if(hash(before)!==input.expected_runtime_digest)throw Error('Runtime configuration changed; preserve concurrent settings');
 const host=identity(),probe=await probeQueue(config);
 if(host.stable!==probe.host_fingerprint||host.stable===host.legacy)throw Error('Verified stable macOS host identity required');
 const queueBytes=readFileSync(input.queue_evidence_file),desktopBytes=readFileSync(input.desktop_evidence_file),queueProof=JSON.parse(queueBytes),desktopProof=JSON.parse(desktopBytes);
 if(queueProof.host_binding||desktopProof.host_binding)throw Error('Migrate original legacy evidence only');
 validateQueueCompatibility(queueProof,{...probe,host_fingerprint:host.legacy});
 verifyDesktopLoader(desktopProof,config.desktop_loader?.bundle_id,{host_fingerprint:host.legacy});
 validateIdleNavigationPolicy(config.desktop_loader);
 if(config.desktop_loader.mode!=='idle_only'||!config.desktop_loader.authorization_ref)throw Error('Preserve authorized idle-only desktop policy');
 const dir=join(root,'observations',`host-binding-${host.stable.slice(0,12)}`);mkdirSync(dir,{recursive:true});
 const bind=(name,bytes,proof)=>{
  const original=join(dir,`${name}-original-${hash(bytes)}.json`),file=join(dir,`${name}-stable.json`);
  try{writeFileSync(original,bytes,{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST'||hash(readFileSync(original))!==hash(bytes))throw error;}
  const value={...proof,host_fingerprint:host.stable,host_binding:{schema_version:2,scheme:'macos-platform-uuid-and-user-home-v2',original_host_fingerprint:host.legacy,original_evidence_ref:original,original_evidence_digest:hash(bytes),verified_at:new Date(control.now()).toISOString(),source_message_id:input.source_message_id,authorization_ref:input.evidence_ref}};
  const result=Buffer.from(JSON.stringify(value,null,2)+'\n');return {file,bytes:result,value,digest:hash(result)};
 };
 const queue=bind('queue',queueBytes,queueProof),desktop=bind('desktop',desktopBytes,desktopProof);
 validateQueueCompatibility(queue.value,probe);verifyDesktopLoader(desktop.value,config.desktop_loader.bundle_id,{host_fingerprint:host.stable});
 if(hash(readFileSync(path))!==input.expected_runtime_digest)throw Error('Runtime configuration changed during verification');
 writeFileSync(queue.file,queue.bytes,{mode:0o600});writeFileSync(desktop.file,desktop.bytes,{mode:0o600});
 const next={...config,queue_validation:{file:queue.file,digest:queue.digest},desktop_loader:{...config.desktop_loader,evidence_file:desktop.file,evidence_digest:desktop.digest,...(input.restore_desktop===true?{enabled:true}:{})}};
 delete next.desktop_loader.validation_pending;
 if(!interactive)writeFileSync(join(dir,'runtime-before.json'),before,{mode:0o600});
 const nextBytes=JSON.stringify(next,null,2)+'\n';
 writeFileSync(path+'.host-binding.tmp',nextBytes,{mode:0o600});renameSync(path+'.host-binding.tmp',path);
 const result={migrated:true,scheme:'macos-platform-uuid-and-user-home-v2',host_fingerprint:host.stable,legacy_verified:true,original_native_evidence_preserved:true,cli_version:probe.cli_version,desktop_enabled:next.desktop_loader.enabled,min_idle_ms:next.desktop_loader.min_idle_ms,queue_validation:next.queue_validation,desktop_evidence_file:desktop.file,authorization_ref:input.evidence_ref,source_message_id:input.source_message_id,actor_mode:interactive?'manual_maintenance':'scheduled_maintenance',owner_thread_id:actor.owner_id,native_turn_id:actor.turn_id,verified_at:new Date(control.now()).toISOString(),raw_hardware_identifier_exported:false};
 Object.assign(result,{runtime_before_digest:hash(before),runtime_after_digest:hash(nextBytes)});
 writeFileSync(join(dir,'migration.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
}
