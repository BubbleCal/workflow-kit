import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {T3NativeLedger,runT3Ledger} from './t3-native-ledger.mjs';

function fixture(t,change={}){
  const root=mkdtempSync(join(tmpdir(),'workflow-auto-review-'));
  mkdirSync(join(root,'discovery'));
  const proof=(id,items=[],extra={})=>{
    const path=join(root,id+'.json');
    writeFileSync(path,JSON.stringify({thread:{threadId:id,projectId:'project',createdBy:'agent',creationSource:'mcp',providerInstanceId:'codex',model:'chosen',runtimeMode:'full-access',...extra},items}));
    return {source:'t3code.mcp.t3_thread_read',evidence_ref:path};
  };
  const authority={source_message_id:'grant',verbatim_text:'Automatically create independent read-only review tasks',native_proof:proof('maintenance',[{type:'user_message',messageId:'grant',text:'Automatically create independent read-only review tasks',createdBy:'user',creationSource:'web',visibility:'local'}])};
  const config={backend:'t3-native',project_id:'project',environment_id:'env',project_root:root,roles:{main:{thread_id:'main'},discovery:{thread_id:'discovery'},maintenance:{thread_id:'maintenance'}},task_admission:{independent_task_threads:true,automatic_reviews:{enabled:true,authority}},sources:{github:{enabled:true,account:{login:'Yang'},scope:{repositories:['org/repo']}},slack:{enabled:true}},...change};
  const evidence=join(root,'pr-request.json'),docEvidence=join(root,'doc-request.json');
  const metadata={html_url:'https://github.com/org/repo/pull/7',state:'open',head:{sha:'head'},requested_reviewers:[{login:'Yang'}]};
  writeFileSync(evidence,JSON.stringify({call:{tool:'github_fetch',args:{url:'https://api.github.com/repos/org/repo/pulls/7'}},response:{structuredContent:{content:JSON.stringify(metadata)}}}));
  writeFileSync(docEvidence,JSON.stringify({call:{tool:'slack_read_thread'},response:{content:[{type:'text',text:JSON.stringify({messages:'Yang please review this proposal https://app.notion.com/p/abc'})}]}}));
  const candidates={items:{
    'github:org/repo:7':{source:'github',source_url:metadata.html_url,canonical_id:'github:org/repo:7',version:'v1',disposition:'candidate',state:'open',is_pr:true,metadata_pending:false,evidence_refs:[evidence]},
    'slack:channel:123':{source:'slack',source_url:'https://work.slack.com/archives/channel/p123',canonical_id:'slack:channel:123',version:'v1',disposition:'candidate',full_thread_pending:false,evidence_refs:[docEvidence]}
  }};
  writeFileSync(join(root,'t3-workflow.json'),JSON.stringify(config));
  writeFileSync(join(root,'discovery/candidates.json'),JSON.stringify(candidates));
  const ledger=new T3NativeLedger(root);t.after(()=>{ledger.close();rmSync(root,{recursive:true,force:true});});
  const pr={candidate_id:'github:org/repo:7',review_kind:'pull_request',target_url:metadata.html_url,request_evidence_ref:evidence};
  const doc={candidate_id:'slack:channel:123',review_kind:'document',target_url:'https://app.notion.com/p/abc',request_text:'please review this proposal',request_evidence_ref:docEvidence};
  const saveCandidates=()=>writeFileSync(join(root,'discovery/candidates.json'),JSON.stringify(candidates));
  return {root,ledger,proof,config,authority,metadata,evidence,docEvidence,candidates,pr,doc,saveCandidates};
}

test('standing human authority admits independent PR and document reviews without per-candidate answers',t=>{
  const f=fixture(t),pr=f.ledger.registerReview(f.pr),doc=f.ledger.registerReview(f.doc);
  assert.equal(pr.created,true);assert.equal(doc.created,true);assert.notEqual(pr.task.task_id,doc.task.task_id);
  assert.equal(pr.task.canonical_key,'github:org/repo:7');
  assert.equal(doc.task.canonical_key,'document:https://app.notion.com/p/abc');
  for(const r of [pr,doc]){
    assert.equal(r.task.data.review.read_only,true);
    assert.equal(r.task.data.source.message_id,'grant');
    assert.ok(r.task.data.constraints.some(x=>x.includes('approve')));
    assert.equal(r.task.owner,null);
  }
  assert.deepEqual(f.ledger.pending().decisions,[]);
  assert.equal(runT3Ledger(f.root,{op:'register_review',...f.pr}).created,false);
  assert.equal(f.ledger.registerReview({...f.pr,objective:'Implement and approve it'}).task.data.objective,pr.task.data.objective);
});

test('repeated candidates and changed heads retain the first task and owner',t=>{
  const f=fixture(t),a=f.ledger.registerReview(f.pr).task;
  f.ledger.bind({task_id:a.task_id,thread_id:'pr-owner',environment_id:'env',native_proof:f.proof('pr-owner')});
  f.candidates.items[f.pr.candidate_id].version='v2';f.saveCandidates();
  const b=f.ledger.registerReview(f.pr);
  assert.equal(b.created,false);assert.equal(b.task.task_id,a.task_id);assert.equal(b.task.owner.thread_id,'pr-owner');
  const alias={...f.candidates.items['slack:channel:123'],canonical_id:'slack:other:456'};
  f.candidates.items[alias.canonical_id]=alias;f.saveCandidates();
  const d=f.ledger.registerReview(f.doc).task;
  assert.equal(f.ledger.registerReview({...f.doc,candidate_id:alias.canonical_id}).task.task_id,d.task_id);
});

test('independent tasks cannot bind to Discovery or share another tasks owner',t=>{
  const f=fixture(t),a=f.ledger.registerReview(f.pr).task,b=f.ledger.registerReview(f.doc).task;
  const bind=(task_id,id)=>f.ledger.bind({task_id,thread_id:id,environment_id:'env',native_proof:f.proof(id)});
  assert.throws(()=>bind(a.task_id,'discovery'),/service role/);
  bind(a.task_id,'owner');
  assert.throws(()=>bind(b.task_id,'owner'),/separate owner threads/);
  assert.equal(bind(b.task_id,'doc-owner').owner.thread_id,'doc-owner');
});

test('automatic review cannot borrow an installer or agent message as standing authority',t=>{
  const f=fixture(t),saved=JSON.parse(readFileSync(f.authority.native_proof.evidence_ref,'utf8'));
  saved.items[0].createdBy='agent';saved.items[0].creationSource='mcp';
  writeFileSync(f.authority.native_proof.evidence_ref,JSON.stringify(saved));
  assert.throws(()=>f.ledger.registerReview(f.pr),/Actual complete human/);
  assert.deepEqual(f.ledger.pending().tasks,[]);
});

test('unclassified, held, disabled-source, mismatched-target and missing request evidence do not admit reviews',t=>{
  const f=fixture(t),c=f.candidates.items[f.pr.candidate_id],before={...c};
  for(const change of [{disposition:'pending_classification'},{hold:'wait for Yang'},{owner_binding:[{owner_thread_id:'legacy-owner'}]}]){
    for(const key of Object.keys(c))delete c[key];Object.assign(c,before,change);f.saveCandidates();
    assert.throws(()=>f.ledger.registerReview(f.pr),/classified|hold|existing owner/);
  }
  Object.assign(c,before);delete c.hold;delete c.owner_binding;f.saveCandidates();
  assert.throws(()=>f.ledger.registerReview({...f.pr,target_url:'https://github.com/other/repo/pull/7'}),/target/);
  assert.throws(()=>f.ledger.registerReview({...f.doc,target_url:'https://app.notion.com/p/unrelated'}),/source evidence/);
  assert.throws(()=>f.ledger.registerReview({...f.doc,request_text:'Invented request'}),/source evidence/);
  assert.throws(()=>f.ledger.registerReview({...f.pr,review_kind:'implementation'}),/review kind/);
  f.config.sources.github.enabled=false;writeFileSync(join(f.root,'t3-workflow.json'),JSON.stringify(f.config));
  assert.throws(()=>runT3Ledger(f.root,{op:'register_review',...f.pr}),/enabled source/);
  assert.deepEqual(f.ledger.pending().tasks,[]);
});

test('PR admission requires a real open review request to the configured account in the configured repositories',t=>{
  const f=fixture(t);
  for(const extra of [{state:'closed'},{requested_reviewers:[]},{html_url:'https://github.com/org/repo/pull/8'}]){
    writeFileSync(f.evidence,JSON.stringify({response:{structuredContent:{content:JSON.stringify({...f.metadata,...extra})}}}));
    assert.throws(()=>f.ledger.registerReview(f.pr),/open review request/);
  }
  assert.deepEqual(f.ledger.pending().tasks,[]);
});

test('Notion share links and tracking parameters cannot create another task for the same document',t=>{
  const f=fixture(t),id='416fbb61f87281409f6dcd0360182cd2';
  const direct='https://app.notion.com/p/'+id,share='https://www.notion.so/My-pitch-'+id+'?pvs=4';
  writeFileSync(f.docEvidence,JSON.stringify({response:{structuredContent:{messages:'please review this proposal '+direct+' '+share}}}));
  const first=f.ledger.registerReview({...f.doc,target_url:direct});
  const second=f.ledger.registerReview({...f.doc,target_url:share});
  assert.equal(first.created,true);assert.equal(second.created,false);
  assert.equal(second.task.task_id,first.task.task_id);
  assert.equal(first.task.canonical_key,'document:'+direct);
});

test('automatic reviews remain disabled without the actual instance opt-in',t=>{
  const f=fixture(t,{task_admission:{automatic_reviews:{enabled:false}}});
  assert.throws(()=>f.ledger.registerReview(f.pr),/standing human authority/);
  assert.deepEqual(f.ledger.pending().tasks,[]);
});
