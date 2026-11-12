import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,cpSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {T3NativeLedger,runT3Ledger} from './t3-native-ledger.mjs';
import {nativePrOperation} from './t3-pr-authorization.mjs';
import {passedReviewGates} from './test-fixtures/pr-review.mjs';
import {detachLegacyRuntime} from '../t3/policy-store.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const NOW=Date.parse('2026-11-12T06:00:00Z'),head='a'.repeat(40),url='https://github.com/example/service/pull/14';
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'t3-native-pr-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env=process.env.T3CODE_THREAD_ID;t.after(()=>{if(env===undefined)delete process.env.T3CODE_THREAD_ID;else process.env.T3CODE_THREAD_ID=env;});
  process.env.T3CODE_THREAD_ID='maintenance';
  const save=(n,v)=>{const p=join(root,n);writeFileSync(p,JSON.stringify(v));return p;};
  const proof=(n,thread,items=[],extra={})=>({source:'t3code.mcp.t3_thread_read',evidence_ref:save(n,{thread:{threadId:thread,projectId:'project',runtimeMode:'full-access',archived:false,...extra},items})});
  const human=(n,text,extra={})=>proof(n,'owner',[{type:'user_message',messageId:n,runId:n+'-run',createdBy:'user',creationSource:'server',visibility:'local',textTruncated:false,updatedAt:new Date(NOW-1000).toISOString(),text,...extra}]);
  const manifest=save('manifest.json',{target_t3_thread_id:'maintenance',old_local:{root}});
  const authority_ref=save('migration-authority.json',{thread:{id:'01a1acc4-a8af-7b72-87a7-30209ea4c70c'},turns:[{items:[{type:'userMessage',id:'human',content:[{type:'text',text:'所有任务暂停 maintenance'}]}]}]});
  const config={backend:'t3-native',project_id:'project',processing:false,roles:{main:'main',maintenance:'maintenance'},migration:{paused:true,manifest,manifest_sha256:sha(manifest),authority_ref,human_message_id:'human',exempt_thread_id:'maintenance',resumption:{target_thread_ids:['owner']}}};save('t3-workflow.json',config);
  const policy={schema_version:1,source_message_id:'route',default_channel_id:'CDEFAULT',routes:[{scope:'lancedb_functions',channel_id:'CFUNCTIONS',delivery_hold:{active:true,source_message_id:'functions-hold',evidence_ref:'old-human'}}],personal_review:{enabled:true,source_message_id:'personal-rule',thread_id:'old-main',evidence_ref:'old-human',authorizations:[]},merge_holds:[{task_id:'T-014',pr_url:url,decision:'hold_merge',head_sha:null,reason:'Investigate performance regression and establish actual product benefit before renewed delivery decision',source_message_id:'old-hold',verified_at:new Date(NOW-86400000).toISOString(),source_thread_id:'old-main',actual_human_verified:true,evidence_ref:'old-human'}]};
  save('channels.json',policy);save('instance.json',{threads:{inbox:'old-main'},scope:{repositories:['example/service']},identity:{github_login:'author'},delivery:{slack_enabled:true,ready_enabled:true,slack_channel_id:'CDEFAULT',merge_enabled:true,approver_login:'Xuanwo',slack_routing_file:'channels.json'}});
  save('pr-review-window.json',{timezone:'Asia/Shanghai',blocked_start_inclusive:'03:00:00',blocked_end_exclusive:'10:00:00'});save('dependency-policy.json',null);
  const old=new DatabaseSync(join(root,'control.sqlite'));old.exec('CREATE TABLE actions(action_key TEXT,kind TEXT,payload TEXT,state TEXT,receipt TEXT)');t.after(()=>old.close());
  const runtime=save('runtime.json',{catalog:[{id:'T-014',state:'accepted'}],tasks:[{runtime_task:{task_id:'T-014',owner_id:'old-owner',contract:{pull_requests:[{repository:'example/service',pr_number:14}]}}}]});
  const l=new T3NativeLedger(root);t.after(()=>l.close());l.db.exec('CREATE TABLE migration_records(source_key TEXT PRIMARY KEY,data TEXT); CREATE TABLE migration_resumptions(source_key TEXT PRIMARY KEY,data TEXT)');
  const r={source_task_id:'T-014',source_host:'local',source_thread_id:'old-owner',source_task_context_ref:runtime,snapshots:[{path:runtime,sha256:sha(runtime)}],destination:{threadId:'owner',projectId:'project'}};
  l.db.prepare('INSERT INTO migration_records VALUES (?,?)').run('source',JSON.stringify(r));l.db.prepare('INSERT INTO migration_resumptions VALUES (?,?)').run('source',JSON.stringify({thread_id:'owner',action:'handoff_then_resume_original_scope'}));
  const identity={task_id:'T-014',pr_url:url,head_sha:head};
  const text=`请亲自检查 ${url} 当前 head ${head} 首查询变慢，总 CPU 增加。不包含发布、部署或解除其他渠道 hold\n已亲自审阅，允许送审及条件合并（推荐）`;
  const repair='#14 授权和原 owner 的迁移映射，保留所有 CI、审批、渠道、窗口和 expected-head 门禁\n允许交给现有维护负责人修复（推荐）';
  const input={op:'pr_authorization_record',...identity,caller_proof:proof('maintenance.json','maintenance'),native_proof:human('personal.json',text),source_message_id:'personal.json',repair_proof:human('repair.json',repair),repair_message_id:'repair.json',supersedes_hold_message_ids:['old-hold']};
  const op=i=>nativePrOperation(l,i,{now:NOW});
  const record=()=>op(input);
  const checkInput=(kind='slack_pr')=>{
    const version=op({op:'pr_authorization_get',...identity}).policy_version,gates=passedReviewGates(NOW,head,url);
    const e={...gates,task_id:'T-014',executor_thread_id:'owner',verified_at:new Date(NOW).toISOString(),scope_authorized:true,authorization_ref:input.native_proof.evidence_ref,policy_version:version,current_policy_version:version,stopped:false,pr_owner:'author',pr_url:url,pr_open:true,pr_draft:false,ordinary_change:false,material_findings_open:false,validation_current:true,technical_review_current:true,current_head_sha:head,already_announced:false,review_routing:{scope:'default',verified:true,pr_url:url,head_sha:head,evidence_ref:'scope'},pr_impact:{pr_url:url,head_sha:head,checked_at:new Date(NOW).toISOString(),owner_thread_id:'owner',evidence_ref:'diff',reason:'Complete diff and limits assessed',breaking_change:false,format_change:true,broad_impact:true,high_risk:true,labels_complete:true,labels:[]},approver:'Xuanwo',approver_identity_verified:true,approval_state:'APPROVED',approved_head_sha:head,required_checks_pass:true,repository_rules_satisfied:true,mergeable:true,admin_override:false};
    const snapshot={repository:'example/service',pr_number:14,head_sha:head,head_before:head,head_after:head,checked_at:new Date(NOW).toISOString(),evidence_ref:'complete-feedback',complete:{reviews:true,review_comments:true,issue_comments:true,review_threads:true},reviews:gates.gatekeeper.reviews,review_comments:[],issue_comments:[],review_threads:[]};
    return {op:'pr_action_check',...identity,kind,payload:{pr_url:url,message:url,channel_id:'CDEFAULT',expected_head_sha:head},evidence:e,feedback_snapshot:snapshot,feedback_decisions:[{key:'example/service#14:review:1',digest:null,disposition:'informational',reason:'Approve without code findings; full body assessed',evidence_ref:'semantic-assessment',current_code_relevance_verified:true}]};
  };
  // Obtain the public feedback digest from the same complete source, as owners do.
  const ready=kind=>{const c=checkInput(kind);const status=op({...c,feedback_decisions:[]}).feedback_status;const row=status.items[0];c.feedback_decisions[0].digest=row.digest;return c;};
  return {root,l,old,save,proof,human,config,policy,input,op,record,ready,identity,text};
}
test('public native record preserves exact source and is idempotent without rewriting old Main/policy',t=>{
  const f=fixture(t),before=readFileSync(join(f.root,'channels.json'),'utf8');
  const r=runT3Ledger(f.root,f.input);assert.equal(r.recorded,true);assert.equal(f.record().already_recorded,true);
  assert.equal(r.authorization.source.thread_id,'owner');assert.equal(r.authorization.source.text,f.text);assert.equal(r.authorization.release,false);
  assert.equal(readFileSync(join(f.root,'channels.json'),'utf8'),before);
  assert.equal(f.op({...f.ready(),op:'pr_action_check'}).allowed,true);
  assert.equal(f.op(f.ready('merge')).allowed,true);
});
test('reject relays, inherited/truncated/wrong-owner sources and mismatched task/PR/head/resume scope',t=>{
  for(const change of [{createdBy:'agent',creationSource:'mcp'},{visibility:'inherited'},{textTruncated:true},{sourceThreadId:'other'}]){
    const f=fixture(t);f.input.native_proof=f.human('personal.json',f.text,change);assert.throws(f.record,/Direct complete human/);
  }
  for(const patch of [{task_id:'T-999'},{pr_url:url+'9'},{head_sha:'b'.repeat(40)}]){const f=fixture(t);assert.throws(()=>f.op({...f.input,...patch}));}
  const f=fixture(t);f.config.migration.resumption.target_thread_ids=[];f.l.config=f.config;assert.throws(f.record,/not allowlisted/);
});
test('CI, GK, complete feedback, routing, window, personal-risk assessment and designated merge approval remain gates',t=>{
  const f=fixture(t);f.record();
  for(const [kind,patch,reason] of [['slack_pr',{validation_current:false},'current_head_validation_or_review_missing'],['slack_pr',{already_announced:true},'already_announced_or_unknown'],['slack_pr',{stopped:true},'human_hold_or_unknown_stop_state'],['merge',{approval_state:'REVIEW_REQUIRED'},'designated_approval_missing'],['merge',{repository_rules_satisfied:false},'repository_merge_requirements_unsatisfied'],['merge',{admin_override:true},'admin_override_forbidden'],['slack_pr',{executor_thread_id:'maintenance'},'original_native_owner_required']]){
    const c=f.ready(kind);c.evidence={...c.evidence,...patch};assert.ok(f.op(c).reasons.includes(reason));
  }
  const ci=f.ready();ci.evidence.applicable_ci.checks[0].conclusion='skipped';assert.ok(f.op(ci).reasons.includes('current_applicable_CI_not_passed'));
  const gk=f.ready();gk.evidence.gatekeeper=structuredClone(gk.evidence.gatekeeper);gk.evidence.gatekeeper.reviews[0].commit_id='b'.repeat(40);assert.ok(f.op(gk).reasons.includes('current_head_Gatekeeper_approval_required'));
  const route=f.ready();route.evidence.review_routing.scope='lancedb_functions';route.payload.channel_id='CFUNCTIONS';assert.ok(f.op(route).reasons.includes('review_delivery_paused_by_user'));
  const wrong=f.ready();wrong.payload.channel_id='COTHER';assert.ok(f.op(wrong).reasons.includes('slack_destination_forbidden'));
  const feedback=f.ready();feedback.feedback_decisions[0].disposition='actionable';assert.ok(f.op(feedback).reasons.includes('material_review_feedback_open'));
  const missing=f.ready();delete missing.feedback_snapshot.complete.issue_comments;assert.throws(()=>f.op(missing),/Complete all-author/);
  const night=Date.parse('2026-11-12T20:00:00Z'),c=f.ready();delete c.feedback_snapshot;assert.ok(nativePrOperation(f.l,c,{now:night}).reasons.includes('review_delivery_blackout'));
});
test('new hold/policy edits and historical uncertain/sent actions cannot be waived by recorded permission',t=>{
  const f=fixture(t);f.record();let c=f.ready('merge');
  f.policy.merge_holds.push({...f.policy.merge_holds[0],source_message_id:'later-hold',reason:'Stop until new decision'});f.save('channels.json',f.policy);
  assert.ok(f.op(c).reasons.includes('policy_changed_or_unknown'));c=f.ready('merge');assert.ok(f.op(c).reasons.includes('merge_explicitly_held_by_user'));
  f.old.prepare('INSERT INTO actions VALUES (?,?,?,?,?)').run('old-unknown','slack_pr',JSON.stringify({message:url}),'uncertain','original-receipt');
  assert.ok(f.op(f.ready()).reasons.some(r=>r.includes('old-unknown:uncertain')));
  assert.ok(f.op(f.ready('merge')).reasons.some(r=>r.includes('old-unknown:uncertain')));
  f.old.prepare("UPDATE actions SET state='sent'").run();assert.ok(f.op(f.ready()).reasons.some(r=>r.includes('old-unknown:sent')));
});
test('one human message holding several tasks resolves only the exact task/PR and original hold version',t=>{
  const f=fixture(t);
  f.policy.merge_holds.push({...f.policy.merge_holds[0],task_id:'T-005',pr_url:'https://github.com/example/service/pull/5'});
  f.save('channels.json',f.policy);f.record();
  assert.equal(f.op(f.ready('merge')).allowed,true);
  const saved=JSON.parse(readFileSync(join(f.root,'channels.json')));
  assert.equal(saved.merge_holds.length,2);assert.deepEqual(saved.merge_holds[1],f.policy.merge_holds[1]);
  f.policy.merge_holds[0].reason='Updated human hold on same source';f.save('channels.json',f.policy);
  assert.ok(f.op(f.ready('merge')).reasons.includes('merge_explicitly_held_by_user'));
});
test('only actual owner claims once; unknown blocks new keys and exact receipts reconcile without replay',t=>{
  const f=fixture(t);f.record();const c={...f.ready(),op:'pr_action_claim',action_key:'send-1',caller_proof:f.proof('owner-read.json','owner')};
  assert.throws(()=>f.op(c),/Actual original native caller/);process.env.T3CODE_THREAD_ID='owner';
  const permit=f.op(c);assert.equal(permit.send,true);assert.equal(permit.valid_until,NOW+60000);
  assert.equal(f.op({...c,action_key:'different-key'}).send,false);
  const settle={op:'pr_action_settle',action_key:permit.action_key,attempt_id:permit.attempt_id,caller_proof:c.caller_proof,outcome:'uncertain',receipt_ref:f.save('unknown.json',{error:'connection lost'})};
  assert.equal(f.op(settle).state,'uncertain');assert.equal(f.op({...c,action_key:'retry'}).send,false);
  assert.throws(()=>f.op({...settle,op:'pr_action_reconcile',outcome:'not_sent'}),/unsupported non-delivery/);
  const receipt=f.save('slack-receipt.json',{ok:true,channel:'CDEFAULT',ts:'123.456',message:{text:url}});
  assert.equal(f.op({...settle,op:'pr_action_reconcile',outcome:'sent',receipt_ref:receipt}).state,'sent');
  assert.equal(f.op({...c,action_key:'new-head-retry'}).send,false);
});
test('merge settlement preserves raw tool envelopes and requires exact PR/head and successful merge result',t=>{
  const f=fixture(t);f.record();process.env.T3CODE_THREAD_ID='owner';
  const claim=f.op({...f.ready('merge'),op:'pr_action_claim',action_key:'merge-1',caller_proof:f.proof('caller.json','owner')});
  assert.equal(claim.send,true);
  const settle={op:'pr_action_settle',action_key:claim.action_key,attempt_id:claim.attempt_id,caller_proof:f.proof('settler.json','owner'),outcome:'sent'};
  for(const patch of [{pr_url:url+'9'},{expected_head_sha:'b'.repeat(40)},{response:{isError:true}},{response:{structuredContent:{merged:false,sha:'merge-commit'}}}]){
    const receipt={pr_url:url,expected_head_sha:head,response:{isError:false,structuredContent:{merged:true,sha:'merge-commit'}},...patch};
    assert.throws(()=>f.op({...settle,receipt_ref:f.save('bad.json',receipt)}),/receipt|not a sent/);
  }
  const ref=f.save('actual.json',{pr_url:url,expected_head_sha:head,response:{isError:false,structuredContent:{merged:true,sha:'merge-commit'}}});
  assert.equal(f.op({...settle,receipt_ref:ref}).state,'sent');
});

function detach(f){
  f.config.task_admission={paused:true};f.save('t3-workflow.json',f.config);
  f.old.exec("CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES ('processing','off')");
  const proof=f.proof('reform.json','maintenance',[{type:'user_message',messageId:'reform',createdBy:'user',creationSource:'web',visibility:'local',textTruncated:false,text:'开始改造吧'}]);
  const input={native_proof:proof,source_message_id:'reform',verbatim_text:'开始改造吧'};
  const receipt=detachLegacyRuntime(f.root,input);
  f.l.config=JSON.parse(readFileSync(join(f.root,'t3-workflow.json')));f.l.nativeControl=true;
  return {receipt,input};
}

function nativeGrant(f,{creationSource='server',conditional=false,answer,short=true,shortLength=8}={}){
  // The mapped native owner survives even when the archived runtime has no
  // accepted task row or PR enrollment. These are deliberately empty.
  const path=f.save('runtime.json',{catalog:[],tasks:[]});
  const row=JSON.parse(f.l.db.prepare('SELECT data FROM migration_records').get().data);
  row.snapshots=[{path,sha256:sha(path)}];f.l.db.prepare('UPDATE migration_records SET data=?').run(JSON.stringify(row));
  const chosen=answer??(conditional?'已亲自审阅，允许送审及条件合并':'已亲自看过，允许按原门禁送审');
  const text=`请亲自检查 ${url}，head ${short?head.slice(0,shortLength):head}；后续仍须满足原有门禁。\n${chosen}`;
  const native_proof=f.human('native-answer.json',text,{creationSource});
  const binding_proof={owner_native_proof:f.proof('owner-link.json','owner',[],{pullRequests:[{url,repository:'example/service',number:14}]}),pr_native_proof:{evidence_ref:f.save('pr-proof.json',{structuredContent:{url,number:14,head_sha:head,draft:true,state:'open'}})}};
  const input={op:'pr_authorization_record',...f.identity,caller_proof:f.input.caller_proof,native_proof,source_message_id:'native-answer.json',binding_proof,
    decision:conditional?'allow_external_review_and_conditional_merge':'allow_external_review'};
  for(const key of Object.keys(f.input))delete f.input[key];Object.assign(f.input,input);
  // This fixture has no historical hold for this newly bound PR.
  f.policy.merge_holds=[];f.save('channels.json',f.policy);
  return f.input;
}
test('native web/server grants bind existing owner and verified abbreviated head without runtime enrollment or separate repair Ask',t=>{
  for(const creationSource of ['web','server']){
    const f=fixture(t);nativeGrant(f,{creationSource});const r=f.record();
    assert.equal(r.authorization.conditional_merge,false);assert.equal(r.authorization.external_review,true);
    assert.equal(r.authorization.head_resolution.mentioned_head,head.slice(0,8));assert.equal(r.authorization.head_resolution.full_head,head);
    assert.ok(r.authorization.source.text.includes('head '+head.slice(0,8)+'；'));
    assert.equal(r.authorization.repair_source,undefined);assert.equal(f.record().already_recorded,true);
    assert.equal(f.op(f.ready()).allowed,true);
    for(const ordinary_change of [true,false]){const c=f.ready('merge');c.evidence.ordinary_change=ordinary_change;assert.ok(f.op(c).reasons.includes('native_authorization_external_review_only'));}
  }
});
test('native conditional merge comes only from the human answer, not a requested enum or review-implies-merge policy',t=>{
  const f=fixture(t);nativeGrant(f);assert.throws(()=>f.op({...f.input,decision:'allow_external_review_and_conditional_merge'}),/actual human answer/);
  const yes=fixture(t);nativeGrant(yes,{conditional:true,creationSource:'web'});assert.equal(yes.record().authorization.conditional_merge,true);
  assert.equal(yes.op(yes.ready('merge')).allowed,true);
  const held=yes.ready('merge');held.evidence.approval_state='REVIEW_REQUIRED';assert.ok(yes.op(held).reasons.includes('designated_approval_missing'));
});
test('T-032 first-person inspection and conditional merge answer resolves a verified seven-character head without waiving merge gates',t=>{
  const f=fixture(t);nativeGrant(f,{conditional:true,shortLength:7,answer:'我已看过，允许送审及满足条件后合并'});
  const grant=f.record().authorization;
  assert.equal(grant.conditional_merge,true);assert.equal(grant.head_resolution.mentioned_head,head.slice(0,7));
  assert.equal(f.op(f.ready()).allowed,true);assert.equal(f.op(f.ready('merge')).allowed,true);
  for(const patch of [{approval_state:'REVIEW_REQUIRED'},{repository_rules_satisfied:false},{admin_override:true}]){
    const c=f.ready('merge');Object.assign(c.evidence,patch);assert.equal(f.op(c).allowed,false);
  }
  const changed=fixture(t);nativeGrant(changed,{conditional:true,shortLength:7,answer:'我已看过，允许送审及满足条件后合并'});
  changed.save('pr-proof.json',{url,number:14,head_sha:'b'.repeat(40)});assert.throws(changed.record,/GitHub PR\/full head/);
});
test('a user/server-shaped administrative withdrawal is never a personal review or merge grant',t=>{
  const f=fixture(t);nativeGrant(f,{conditional:true,shortLength:7,answer:'Administrative reconciliation by the T-032 agent, not a new human answer or approval: withdraw this obsolete maintenance-permission question. Preserve the original product authorization.'});
  assert.throws(f.record,/Explicit personal inspection answer/);
  assert.equal(f.l.db.prepare('SELECT count(*) AS n FROM native_pr_authorizations').get().n,0);
});
function normalizedSlackCase(t){
  const f=fixture(t);nativeGrant(f);f.record();
  f.l.config.sources={slack:{account:{user_id:'UOWNER'}}};process.env.T3CODE_THREAD_ID='owner';
  const caller_proof=f.proof('normalized-caller.json','owner');
  const permit=f.op({...f.ready(),op:'pr_action_claim',action_key:'normalized-send',caller_proof});assert.equal(permit.send,true);
  f.op({op:'pr_action_settle',action_key:permit.action_key,attempt_id:permit.attempt_id,caller_proof,outcome:'uncertain',receipt_ref:f.save('normalized-unknown.json',{error:'success fields not in raw Slack shape'})});
  const ts='1794498952.621389',message_link='https://example.slack.com/archives/CDEFAULT/p1794498952621389';
  const raw={content:[{type:'text',text:JSON.stringify({message_link,message_context:{message_ts:ts,channel_id:'CDEFAULT'}})}],structuredContent:null,isError:false};
  const text=`=== THREAD PARENT MESSAGE ===\nFrom: Owner <owner@example.com> (UOWNER)\nTime: 2026-11-12 23:55:52 CST\nMessage TS: ${ts}\n<${url}|${url.slice(8)}>\n*Sent using* <@UAPP|ChatGPT>\n\nNo thread messsages\n`;
  const readback={content:[{type:'text',text:JSON.stringify({messages:text,pagination_info:'There are no more messages in this thread.\n'})}],structuredContent:null,isError:false};
  const input={op:'pr_action_reconcile',action_key:permit.action_key,attempt_id:permit.attempt_id,caller_proof,outcome:'sent',receipt_ref:f.save('normalized-send.json',raw),
    slack_readback:{source:'slack.read_thread',channel_id:'CDEFAULT',message_ts:ts,evidence_ref:f.save('normalized-readback.json',readback)}};
  return {...f,input,raw,text,readback};
}
test('normalized Slack location receipt plus exact independent readback reconciles unknown without fabricating raw success fields',t=>{
  const f=normalizedSlackCase(t),r=f.op(f.input);assert.equal(r.state,'sent');assert.equal(r.retry_allowed,false);
  assert.equal(r.verification.authored_message,url);assert.equal(r.verification.connector_attribution,true);
  const receipt=JSON.parse(f.l.db.prepare('SELECT receipt FROM native_pr_actions').get().receipt);
  assert.deepEqual(receipt.native_result,f.raw);assert.equal(receipt.native_result.ok,undefined);
  const g=f.op({op:'pr_authorization_get',...f.identity}).authorization;assert.equal(g.conditional_merge,false);
  assert.equal(f.op({...f.ready(),op:'pr_action_claim',action_key:'do-not-resend',caller_proof:f.input.caller_proof}).send,false);
});
test('normalized Slack reconciliation rejects absent/mismatched readback, author/content edits, errors and wrong permalink, preserving unknown',t=>{
  const f=normalizedSlackCase(t);
  const bad=[{slack_readback:undefined},{slack_readback:{...f.input.slack_readback,channel_id:'COTHER'}},{slack_readback:{...f.input.slack_readback,message_ts:'1794498952.999999'}},{attempt_id:'other-attempt'}];
  for(const patch of bad)assert.throws(()=>f.op({...f.input,...patch}));
  for(const text of [f.text.replace('1794498952.621389','1794498952.999999'),f.text.replace('(UOWNER)','(UOTHER)'),f.text.replace(url,url+'9'),f.text.replace('*Sent using*','Authored extra commentary\n*Sent using*')]){
    f.save('normalized-readback.json',{...f.readback,content:[{type:'text',text:JSON.stringify({messages:text,pagination_info:'There are no more messages in this thread.\n'})}]});assert.throws(()=>f.op(f.input));
  }
  f.save('normalized-readback.json',{...f.readback,isError:true});assert.throws(()=>f.op(f.input),/readback returned an error/);
  f.save('normalized-readback.json',f.readback);
  f.save('normalized-send.json',{message_link:'https://example.slack.com/archives/COTHER/p1794498952621389',message_context:{message_ts:'1794498952.621389',channel_id:'CDEFAULT'}});
  assert.throws(()=>f.op(f.input),/permalink/);
  assert.equal(f.l.db.prepare('SELECT state FROM native_pr_actions').get().state,'uncertain');
});
function previewSlackCase(t){
  const f=normalizedSlackCase(t);
  const detailed=f.text.replace('\n\nNo thread',`\nApp notification from App (${url}): Generated PR summary\nGenerated preview continuation...\n\nNo thread`);
  f.save('normalized-readback.json',{...f.readback,content:[{type:'text',text:JSON.stringify({messages:detailed,pagination_info:'There are no more messages in this thread.\n'})}]});
  const concise=`THREAD: <${url}|${url.slice(8)}>\n*Sent using* <@UAPP|ChatGPT> [Owner <owner@example.com>]\n\nNo thread messsages\n`;
  const conciseResponse={content:[{type:'text',text:JSON.stringify({messages:concise,pagination_info:'There are no more messages in this thread.\n'})}],structuredContent:null,isError:false};
  f.input.slack_readback.concise_readback={source:'slack.read_thread',response_format:'concise',channel_id:'CDEFAULT',message_ts:'1794498952.621389',evidence_ref:f.save('concise-readback.json',conciseResponse)};
  return {...f,detailed,concise,conciseResponse};
}
test('generated PR unfurl reconciles only with paired exact authored-content readback; original detailed preview remains intact',t=>{
  const f=previewSlackCase(t),before=readFileSync(f.input.slack_readback.evidence_ref,'utf8'),r=f.op(f.input);
  assert.equal(r.state,'sent');assert.equal(r.retry_allowed,false);assert.equal(r.verification.authored_message,url);
  assert.equal(r.verification.generated_preview.url,url);
  assert.equal(readFileSync(f.input.slack_readback.evidence_ref,'utf8'),before);
  assert.ok(JSON.stringify(r.verification.readback.native_result).includes('Generated preview continuation'));
});
test('preview labels alone do not bypass authored-text or location/sender checks; mismatched paired reads leave action uncertain',t=>{
  const f=previewSlackCase(t),paired=f.input.slack_readback.concise_readback;
  delete f.input.slack_readback.concise_readback;assert.throws(()=>f.op(f.input),/independent same-location/);f.input.slack_readback.concise_readback=paired;
  for(const patch of [{channel_id:'COTHER'},{message_ts:'1794498952.999999'}]){
    f.input.slack_readback.concise_readback={...paired,...patch};assert.throws(()=>f.op(f.input),/same-location/);
  }
  f.input.slack_readback.concise_readback=paired;
  for(const message of [f.concise.replace(url,url+'9'),f.concise.replace('Owner <owner@example.com>','Other <other@example.com>'),f.concise.replace(' [Owner','\nExtra authored commentary [Owner')]){
    f.save('concise-readback.json',{...f.conciseResponse,content:[{type:'text',text:JSON.stringify({messages:message,pagination_info:'There are no more messages in this thread.'})}]});
    assert.throws(()=>f.op(f.input),/exact authored URL/);
  }
  f.save('concise-readback.json',f.conciseResponse);
  for(const detailed of [f.detailed.replace(`App notification from App (${url})`,`App notification from App (${url}9)`),f.detailed.replace('App notification','Extra authored commentary\nApp notification')]){
    f.save('normalized-readback.json',{...f.readback,content:[{type:'text',text:JSON.stringify({messages:detailed,pagination_info:'There are no more messages in this thread.'})}]});
    assert.throws(()=>f.op(f.input),/canonical PR URL/);
  }
  assert.equal(f.l.db.prepare('SELECT state FROM native_pr_actions').get().state,'uncertain');
});
function reactionSlackCase(t){
  const f=previewSlackCase(t),reactions='Reactions: eyes (1), white_check_mark (1)';
  const detailed=f.text.replace('\n\nNo thread',`\n${reactions}\n\nNo thread`);
  const saveDetailed=text=>f.save('normalized-readback.json',{...f.readback,content:[{type:'text',text:JSON.stringify({messages:text,pagination_info:'There are no more messages in this thread.\n'})}]});
  saveDetailed(detailed);return {...f,detailed,reactions,saveDetailed};
}
test('reaction metadata requires paired authored-content proof and preserves original receipts and no-retry',t=>{
  const f=reactionSlackCase(t),before=readFileSync(f.input.slack_readback.evidence_ref,'utf8'),r=f.op(f.input);
  assert.equal(r.state,'sent');assert.equal(r.retry_allowed,false);
  assert.equal(r.verification.reaction_metadata.rendered,f.reactions);
  assert.equal(r.verification.authored_message,url);assert.equal(r.verification.connector_attribution,true);
  assert.equal(readFileSync(f.input.slack_readback.evidence_ref,'utf8'),before);
  assert.ok(JSON.stringify(r.verification.readback.native_result).includes(f.reactions));
  assert.equal(f.op({...f.ready(),op:'pr_action_claim',action_key:'reaction-no-resend',caller_proof:f.input.caller_proof}).send,false);
});
test('reaction label cannot hide authored commentary, malformed counts, mismatched identity or unpaired evidence',t=>{
  const f=reactionSlackCase(t),paired=f.input.slack_readback.concise_readback;
  delete f.input.slack_readback.concise_readback;assert.throws(()=>f.op(f.input));f.input.slack_readback.concise_readback=paired;
  for(const text of [
    f.detailed.replace(f.reactions,f.reactions+'\nExtra authored commentary'),
    f.detailed.replace(f.reactions,'Extra authored commentary\n'+f.reactions),
    f.detailed.replace('*Sent using* <@UAPP|ChatGPT>\n'+f.reactions,f.reactions+'\n*Sent using* <@UAPP|ChatGPT>'),
    f.detailed.replace(f.reactions,'Reactions: eyes (0)'),f.detailed.replace(f.reactions,'Reactions: eyes (-1)'),
    f.detailed.replace(f.reactions,'Reactions: eyes (1), approved by Yang'),
    f.detailed.replace(f.reactions,f.reactions+'\n'+f.reactions),
    f.detailed.replace('(UOWNER)','(UOTHER)'),f.detailed.replace('1794498952.621389','1794498952.999999')
  ]){f.saveDetailed(text);assert.throws(()=>f.op(f.input));}
  f.saveDetailed(f.detailed);
  for(const message of [
    f.concise.replace(' [Owner','\n'+f.reactions+' [Owner'),
    f.concise.replace(' [Owner','\nExtra authored commentary [Owner'),
    f.concise.replace(url,url+'9'),f.concise.replace('Owner <owner@example.com>','Other <other@example.com>')
  ]){f.save('concise-readback.json',{...f.conciseResponse,content:[{type:'text',text:JSON.stringify({messages:message,pagination_info:'There are no more messages in this thread.\n'})}]});assert.throws(()=>f.op(f.input));}
  f.save('concise-readback.json',f.conciseResponse);
  for(const patch of [{channel_id:'COTHER'},{message_ts:'1794498952.999999'},{evidence_ref:f.input.slack_readback.evidence_ref}]){
    f.input.slack_readback.concise_readback={...paired,...patch};assert.throws(()=>f.op(f.input));
  }
  assert.equal(f.l.db.prepare('SELECT state FROM native_pr_actions').get().state,'uncertain');
});
test('reaction metadata composes with generated preview only under the same paired exact proof',t=>{
  const f=reactionSlackCase(t);f.saveDetailed(f.detailed.replace(f.reactions,`App notification from App (${url}): Generated summary\nPreview continuation\n${f.reactions}`));
  const r=f.op(f.input);assert.equal(r.state,'sent');assert.equal(r.retry_allowed,false);
  assert.equal(r.verification.generated_preview.url,url);assert.equal(r.verification.reaction_metadata.rendered,f.reactions);
});
test('native binding rejects relay, wrong project/owner/PR/head and unsupported abbreviated-head expansion',t=>{
  for(const change of [{createdBy:'agent',creationSource:'mcp'},{creationSource:'provider'},{visibility:'inherited'},{textTruncated:true},{sourceThreadId:'other'}]){
    const f=fixture(t);nativeGrant(f);const saved=JSON.parse(readFileSync(f.input.native_proof.evidence_ref));Object.assign(saved.items[0],change);f.save('native-answer.json',saved);
    assert.throws(f.record,/Direct complete human/);
  }
  for(const patch of [{threadId:'another-owner'},{projectId:'other'},{pullRequests:[]}]){
    const f=fixture(t);nativeGrant(f);const p=f.input.binding_proof.owner_native_proof.evidence_ref,s=JSON.parse(readFileSync(p));Object.assign(s.thread,patch);f.save('owner-link.json',s);assert.throws(f.record,/association/);
  }
  const f=fixture(t);nativeGrant(f);f.save('pr-proof.json',{url,number:14,head_sha:'b'.repeat(40)});assert.throws(f.record,/GitHub PR\/full head/);
  for(const answer of ['已亲自看过，允许按原门禁送审？','已亲自看过，暂不允许送审','已亲自看过，允许送审但等我再次确认']){
    const no=fixture(t);nativeGrant(no,{answer});assert.throws(no.record,/permission|affirmative/);
  }
});
test('review-only Ready uses ordinary pre-ready CI and full feedback; subsequent Slack still requires current-head GK; exact Ready receipt required',t=>{
  const f=fixture(t);nativeGrant(f);f.record();
  const ready=()=>{const c=f.ready();c.kind='pr_ready';c.payload.operation='mark_ready';c.evidence.pr_draft=true;c.evidence.applicable_ci.phase='pre_ready';delete c.evidence.gatekeeper;return c;};
  const evaluated=f.op(ready());assert.equal(evaluated.allowed,true,JSON.stringify(evaluated.reasons));
  const ci=ready();ci.evidence.applicable_ci.checks[0].conclusion='failure';assert.ok(f.op(ci).reasons.includes('current_applicable_CI_not_passed'));
  const noGk=f.ready();delete noGk.evidence.gatekeeper;assert.ok(f.op(noGk).reasons.includes('fresh_verified_Gatekeeper_surface_required'));
  process.env.T3CODE_THREAD_ID='owner';const caller_proof=f.proof('ready-caller.json','owner');
  const permit=f.op({...ready(),op:'pr_action_claim',action_key:'ready-1',caller_proof});assert.equal(permit.send,true);
  assert.equal(f.op({...ready(),op:'pr_action_claim',action_key:'ready-duplicate',caller_proof}).send,false);
  assert.equal(f.op({op:'pr_action_settle',action_key:permit.action_key,attempt_id:permit.attempt_id,caller_proof,outcome:'uncertain',receipt_ref:f.save('ready-unknown.json',{error:'transport lost'})}).state,'uncertain');
  assert.ok(f.op(f.ready()).reasons.some(r=>r.includes('ready-1:uncertain')));
  assert.equal(f.op({...ready(),op:'pr_action_claim',action_key:'ready-retry',caller_proof}).send,false);
  const settle={op:'pr_action_reconcile',action_key:permit.action_key,attempt_id:permit.attempt_id,caller_proof,outcome:'sent'};
  for(const patch of [{draft:true},{head_sha:'b'.repeat(40)},{url:url+'9'}])assert.throws(()=>f.op({...settle,receipt_ref:f.save('bad-ready.json',{url,head_sha:head,draft:false,state:'open',...patch})}),/non-draft PR readback/);
  assert.equal(f.op({...settle,receipt_ref:f.save('ready-done.json',{structuredContent:{url,head_sha:head,draft:false,state:'open'}})}).state,'sent');
});
test('finite native conversion keeps exact grants/holds/policy version and original unknown receipts without old files',t=>{
  const f=fixture(t);f.record();const before=f.op({op:'pr_authorization_get',...f.identity});
  f.old.prepare('INSERT INTO actions VALUES (?,?,?,?,?)').run('old-uncertain','slack_pr',JSON.stringify({message:url}),'uncertain','exact-old-receipt');
  const {receipt,input}=detach(f);assert.equal(receipt.converted,true);
  assert.equal(receipt.preserved_policy_version,before.policy_version);
  assert.equal(receipt.original_action_receipts,1);assert.equal(receipt.unresolved_original_actions[0].state,'uncertain');
  assert.equal(detachLegacyRuntime(f.root,input).already_native,true);
  for(const file of ['instance.json','channels.json','pr-review-window.json','dependency-policy.json','control.sqlite','manifest.json','migration-authority.json'])rmSync(join(f.root,file),{force:true});
  const after=f.op({op:'pr_authorization_get',...f.identity});assert.deepEqual(after.authorization,before.authorization);assert.equal(after.policy_version,before.policy_version);
  const check=f.op(f.ready());assert.ok(check.reasons.some(r=>r.includes('old-uncertain:uncertain')));
  assert.equal(check.human_authorization_recognized,true);
  assert.equal(f.l.config.processing,false);assert.equal(f.l.config.task_admission.paused,true);
});
test('native CLI is usable with no runtime directory and refuses fallback if an installed policy artifact is missing',t=>{
  const f=fixture(t);f.record();detach(f);
  const packaged=join(f.root,'standalone');mkdirSync(packaged);
  const source=fileURLToPath(new URL('..',import.meta.url));
  for(const name of ['t3','guards'])cpSync(join(source,name),join(packaged,name),{recursive:true});
  cpSync(join(source,'workflow.mjs'),join(packaged,'workflow.mjs'));
  const operation=f.save('read-standalone.json',{op:'pr_authorization_get',...f.identity});
  const child=spawnSync(process.execPath,[join(packaged,'workflow.mjs'),'t3','ledger','--instance',f.root,'--file',operation],{encoding:'utf8',cwd:f.root});
  assert.equal(child.status,0,child.stderr+child.stdout);assert.equal(JSON.parse(child.stdout).authorization.source.thread_id,'owner');
  const wrong=spawnSync(process.execPath,[join(packaged,'workflow.mjs'),'runtime','init','--instance',f.root],{encoding:'utf8',cwd:f.root});
  assert.notEqual(wrong.status,0);assert.match(wrong.stdout,/legacy runtime\/queue\/scheduler commands are disabled/);
  rmSync(join(f.root,f.l.config.policy_store.pr_policy.path));
  assert.throws(()=>f.op({op:'pr_authorization_get',...f.identity}),/ENOENT/);
  // Still-present original policy files must not become a silent fallback.
  assert.equal(JSON.parse(readFileSync(join(f.root,'channels.json'))).personal_review.authorizations.length,0);
});
test('native conversion rejects an agent relay, wrong project/caller, active old processing and unapproved source',t=>{
  const f=fixture(t);f.config.task_admission={paused:true};f.save('t3-workflow.json',f.config);
  f.old.exec("CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES ('processing','on')");
  const items=[{type:'user_message',messageId:'reform',createdBy:'agent',creationSource:'mcp',visibility:'local',textTruncated:false,text:'开始改造吧'}];
  const input={native_proof:f.proof('refuse.json','maintenance',items),source_message_id:'reform',verbatim_text:'开始改造吧'};
  assert.throws(()=>detachLegacyRuntime(f.root,input),/Direct complete human/);
  items[0].createdBy='user';items[0].creationSource='web';input.native_proof=f.proof('refuse.json','maintenance',items);
  assert.throws(()=>detachLegacyRuntime(f.root,input),/Legacy processing must stay off/);
  process.env.T3CODE_THREAD_ID='other';assert.throws(()=>detachLegacyRuntime(f.root,input),/designated native Maintenance/);
});
