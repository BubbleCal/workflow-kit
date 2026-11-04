import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareQuestion, pendingQuestions, taskDisplayText, resolveReply } from './task-decisions.mjs';

const state = () => ({ next_id: 12, items: [
  { id: 'D-009', task_id: 'T-177', status: 'resolved', question: 'Model setting', dedup_key: 'model' },
  { id: 'D-010', task_id: 'T-179', status: 'resolved', question: 'Delete snapshot', dedup_key: 'snapshot', resolution: 'actual human approval' },
  { id: 'D-011', task_id: 'T-010', status: 'unresolved', subject: 'Java build approach', question: 'Which Java build approach?', dedup_key: 'java', options: ['A', 'B'], question_message_id: 'java-question' },
] });
test('existing questions display under T while legacy identities and resolved evidence remain untouched', () => {
  const s=state(),before=structuredClone(s),views=pendingQuestions(s);
  assert.deepEqual(views.map(x=>x.title),['T-010 · 待你决定：Java build approach']);
  assert.equal(JSON.stringify(views).includes('D-011'),false);assert.deepEqual(s,before);
  assert.equal(taskDisplayText('D-011 / D010; https://example.test/D-011 and D011:T010:key',s),
    'T-010 / T-179; https://example.test/D-011 and D011:T010:key');
});
test('new question identities are private and deduplicate without advancing a second counter', () => {
  const s=state(),input={task_id:'T010',dedup_key:'another-question',subject:'Test budget',question:'Which budget?',evidence_ref:'actual-scope'};
  const a=prepareQuestion(input,s),b=prepareQuestion(input,s);assert.equal(a.record.id,b.record.id);
  assert.match(a.record.id,/^question:[a-f0-9]{32}$/);assert.equal(s.next_id,12);
  assert.equal(prepareQuestion({...input,dedup_key:'java'},s).record.id,'D-011');
  assert.throws(()=>prepareQuestion({...input,id:'D-012'},s),/private/);
  assert.throws(()=>prepareQuestion({...input,task_id:'D-012'},s),/parent T/);
});
test('T replies and legacy D aliases bind the same pending question without resolving or granting authority', () => {
  const s=state(),before=structuredClone(s);
  for(const ref of ['T010','T-010','D011','D-011']) {
    const r=resolveReply({reference:ref,option:'A'},s);assert.equal(r.status,'matched');assert.equal(r.question_key,'D-011');assert.equal(r.authorization_granted,false);
  }
  assert.equal(resolveReply({reference:'D010'},s).status,'already_resolved');assert.deepEqual(s,before);
});
test('multiple questions need discriminating subject, source context or a unique answer', () => {
  const s=state();s.items.push({id:'question:budget',task_id:'T-010',status:'unresolved',subject:'Test budget',question:'Which budget?',options:['A','C'],question_message_id:'budget-question'});
  assert.equal(resolveReply({reference:'T010',option:'A'},s).status,'ambiguous');
  assert.equal(resolveReply({reference:'T010',subject:'Java'},s).question_key,'D-011');
  assert.equal(resolveReply({reference:'T010',context_message_id:'budget-question'},s).question_key,'question:budget');
  assert.equal(resolveReply({reference:'T010',option:'C'},s).question_key,'question:budget');
  assert.equal(resolveReply({reference:'T010',subject:'missing'},s).status,'no_pending_match');
  assert.equal(resolveReply({reference:'D011',context_message_id:'budget-question'},s).status,'no_pending_match');
});
test('unknown aliases are not silently relabeled as another task', () => {
  assert.throws(()=>taskDisplayText('D-012 needs an answer',state(),{rejectUnknown:true}),/Unknown D/);
  assert.equal(resolveReply({reference:'D012'},state()).status,'no_pending_match');
});
