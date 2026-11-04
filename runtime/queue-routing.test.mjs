import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore, routeControlPreparation, INBOX, assess } from './control.mjs';
import { Mailbox, COORDINATOR, renderPrompt } from './mailbox.mjs';

const now = Date.parse('2026-11-02T10:00:00Z');
const common = () => ({ verified_at: new Date(now).toISOString(), scope_authorized: true,
  authorization_ref: 'human-refactor-request', policy_version: 'queue-v1', current_policy_version: 'queue-v1', stopped: false });
test('valid important result is durably queued without permission to send directly', () => {
  const c = new ControlStore(':memory:', { now: () => now }); const m = new Mailbox(':memory:', { now: () => now });
  const input = { op: 'prepare', key: 'T-001:done', task_id: 'T-001', kind: 'notify', payload: { thread_id: INBOX, category: 'important_completion', text: 'T-001 is complete.' }, evidence: { ...common(), material_change: true, already_notified: false, completion_verified: true } };
  const first = routeControlPreparation(input, c, m, now);
  assert.equal(first.queued, true); assert.equal(first.send_tool_forbidden, true);
  assert.equal(routeControlPreparation(input, c, m, now).queued, true);
  assert.equal(m.status().pending[0].count, 1);
  assert.equal(c.db.prepare('SELECT state FROM actions').get().state, 'queued');
  c.close(); m.close();
});
test('human input to a busy coordinator enters its queue without waking it', () => {
  const c = new ControlStore(':memory:', { now: () => now }); const m = new Mailbox(':memory:', { now: () => now });
  const input = { key: 'human-1:T-025', task_id: 'T-025', kind: 'human_input', payload: { thread_id: COORDINATOR, source_message_id: 'human-1', verbatim_text: 'Start T-025' }, evidence: { ...common(), actual_human_message_verified: true, source_actor_verified: true, source_message_id: 'human-1', source_text: 'Start T-025', input_already_delivered: false, owner_matches: true, owner_thread_id: COORDINATOR, thread_status: 'active' } };
  assert.equal(routeControlPreparation(input, c, m, now).queued, true);
  assert.equal(m.status().active_batches.length, 0);
  assert.equal(m.status().pending[0].lane, 'coordinator'); c.close(); m.close();
});
test('already sent notifications are not re-enqueued during migration', () => {
  const c = new ControlStore(':memory:', { now: () => now }); const m = new Mailbox(':memory:', { now: () => now });
  c.importLegacy([{ key: 'old', status: 'sent' }]);
  const r = routeControlPreparation({ key: 'old', kind: 'notify', task_id: 'T-001', payload: { thread_id: INBOX, category: 'important_completion', text: 'old' }, evidence: { ...common(), material_change: true, already_notified: false, completion_verified: true } }, c, m, now);
  assert.equal(r.state, 'sent'); assert.equal(m.status().pending.length, 0); c.close(); m.close();
});

test('the action library also refuses direct control-plane sends outside the CLI wrapper', () => {
  const c = new ControlStore(':memory:', { now: () => now });
  const input = { key: 'direct-notify', task_id: 'T-001', kind: 'notify', payload: { thread_id: INBOX, category: 'important_completion', text: 'done' }, evidence: { ...common(), material_change: true, already_notified: false, completion_verified: true } };
  c.prepare(input);
  assert.equal(c.claim({ key: input.key, owner: 'coordinator', evidence: input.evidence }).send_tool_forbidden, true);
  c.close();
});

test('technical questions queue through a busy coordinator but wait for a busy engineering owner', () => {
  const e = { ...common(), actual_human_message_verified: true, source_actor_verified: true,
    source_message_id: 'q1', source_text: 'Why did T-014 change?', input_already_delivered: false,
    owner_matches: true, owner_thread_id: 'worker', thread_status: 'active',
    queued_input: false, pending_dispatch: false, underlying_job_running: false,
    expected_turn_id: 'turn-1', actual_turn_id: 'turn-1' };
  const p = { thread_id: 'worker', intent: 'question', source_message_id: 'q1', verbatim_text: e.source_text };
  assert.equal(assess('human_input', p, e, now).allowed, false);
  assert.equal(assess('human_input', p, { ...e, thread_status: 'idle' }, now).allowed, true);
  for (const blocked of [{ queued_input: true }, { pending_dispatch: true },
    { underlying_job_running: true }, { actual_turn_id: 'turn-2' }]) {
    assert.equal(assess('human_input', p, { ...e, thread_status: 'idle', ...blocked }, now).allowed, false);
  }
  assert.equal(assess('human_input', { ...p, thread_id: COORDINATOR }, { ...e, owner_thread_id: COORDINATOR }, now).allowed, true);
});

test('an owner answer is delivered as an answer, without falsely completing its task', () => {
  const c = new ControlStore(':memory:', { now: () => now }); const m = new Mailbox(':memory:', { now: () => now });
  const x = { key: 'q1:answer', kind: 'notify', task_id: 'T-014', payload: { thread_id: INBOX, category: 'answer', question_message_id: 'q1', text: 'The API prerequisite is merged; implementation continues.' }, evidence: { ...common(), material_change: true, already_notified: false, source_question_verified: true, owner_answer_verified: true, question_message_id: 'q1' } };
  assert.equal(routeControlPreparation(x, c, m, now).queued, true);
  assert.equal(m.status().pending[0].kind, 'answer');
  assert.equal(assess('notify', x.payload, { ...x.evidence, owner_answer_verified: false }, now).allowed, false);
  c.close(); m.close();
});

test('decision notices render T labels while original action and pending message identities remain immutable',()=>{
  const c=new ControlStore(':memory:',{now:()=>now}),m=new Mailbox(':memory:',{now:()=>now});
  const state={items:[{id:'D-011',task_id:'T-010',status:'unresolved',subject:'Java approach',question:'Which approach?'}]};
  const x={key:'D-011:original-notice',task_id:'T-010',kind:'notify',payload:{thread_id:INBOX,category:'decision',text:'D-011 · Java approach: A or B?'},evidence:{...common(),material_change:true,already_notified:false,human_action_required:true}};
  routeControlPreparation(x,c,m,now,state);
  const mail=m.db.prepare('SELECT * FROM mail WHERE item_key=?').get(x.key);
  assert.equal(JSON.parse(mail.payload).text,'T-010 · Java approach: A or B?');
  assert.equal(JSON.parse(c.db.prepare('SELECT payload FROM actions WHERE action_key=?').get(x.key).payload).text,x.payload.text);
  state.items[0].status='resolved';routeControlPreparation(x,c,m,now,state);
  assert.deepEqual(m.db.prepare('SELECT * FROM mail WHERE item_key=?').get(x.key),mail);
  const legacy={id:'old-batch',lane:'inbox',snapshot:{items:[{key:'old-key',payload:{text:'D-011 · Which approach?'}}]}};
  const before=structuredClone(legacy);assert.match(renderPrompt(legacy,'fixture',state),/T-010 · Which approach/);assert.deepEqual(legacy,before);
  assert.equal(m.db.prepare('SELECT count(*) n FROM mail').get().n,1);c.close();m.close();
});

test('actual decision replies keep their verbatim source and durable routing without resolving state',()=>{
  const c=new ControlStore(':memory:',{now:()=>now}),m=new Mailbox(':memory:',{now:()=>now});
  const state={items:[{id:'D-011',task_id:'T-010',status:'unresolved',subject:'Java approach',question:'Which approach?'}]},before=structuredClone(state);
  const text='T010，Java approach 选 A';const x={key:'actual-answer',task_id:'T-010',kind:'human_input',payload:{thread_id:COORDINATOR,source_message_id:'human-source',verbatim_text:text,intent:'decision_answer',decision_reply:{reference:'T010',subject:'Java approach'}},evidence:{...common(),actual_human_message_verified:true,source_actor_verified:true,source_message_id:'human-source',source_text:text,input_already_delivered:false,owner_matches:true,owner_thread_id:COORDINATOR,thread_status:'active'}};
  routeControlPreparation(x,c,m,now,state);const row=JSON.parse(m.db.prepare('SELECT payload FROM mail').get().payload);
  assert.equal(row.text,text);assert.equal(row.source_message_id,'human-source');assert.equal(row.decision_route.question_key,'D-011');assert.equal(row.decision_route.authorization_granted,false);assert.deepEqual(state,before);c.close();m.close();
});

test('an unrelated existing mailbox key cannot silently absorb a newly prepared notice',()=>{
  const c=new ControlStore(':memory:',{now:()=>now}),m=new Mailbox(':memory:',{now:()=>now});
  m.enqueue({key:'collision',lane:'inbox',kind:'decision',payload:{text:'Original question'}});
  const x={key:'collision',task_id:'T-010',kind:'notify',payload:{thread_id:INBOX,category:'decision',text:'Different question'},evidence:{...common(),material_change:true,already_notified:false,human_action_required:true}};
  assert.throws(()=>routeControlPreparation(x,c,m,now,{items:[]}),/reconcile its source/);
  assert.equal(c.db.prepare('SELECT count(*) n FROM actions').get().n,0);
  assert.equal(JSON.parse(m.db.prepare('SELECT payload FROM mail').get().payload).text,'Original question');c.close();m.close();
});
