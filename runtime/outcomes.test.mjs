import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore, PAGE } from './control.mjs';

const NOW = Date.parse('2026-11-03T08:00:00Z');
const bindings = { enabled: true, page_id: 'outcomes-page', data_source_id: 'outcomes-data',
  source_message_id: 'human-created-outcomes', records: [
    { outcome_key: 'T-010:s3-count', task_id: 'T-010', page_id: 'outcome-record' } ] };
const evidence = () => ({ verified_at: new Date(NOW).toISOString(), scope_authorized: true,
  authorization_ref: 'human-created-outcomes', policy_version: 'current', current_policy_version: 'current',
  stopped: false, content_changed: true, manual_content_preserved: true,
  outcome_evidence_verified: true, existing_records_checked: true, existing_record_found: false });
const create = () => ({ key: 'new-result', kind: 'notion_sync', task_id: 'T-025',
  payload: { operation: 'create_outcome', page_id: bindings.page_id,
    data_source_id: bindings.data_source_id, task_id: 'T-025', outcome_key: 'T-025:arm-lld' }, evidence: evidence() });

test('optional outcome configuration cannot block the original decision page or unrelated work', () => {
  const store = new ControlStore(':memory:', { now: () => NOW,
    outcomeBindings: () => { throw new Error('Invalid optional outcome configuration'); } });
  const a = { ...create(), key: 'original-page', payload: { page_id: PAGE } };
  assert.equal(store.prepare(a).prepared, true);
  assert.equal(store.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, true);
  assert.equal(store.prepare({ ...create(), key: 'unrelated', kind: 'archive', payload: { thread_id: 'worker' } }).prepared, false);
  store.close();
});

test('outcome creation is scoped, duplicate-aware and rechecked when claimed', () => {
  let current = structuredClone(bindings);
  const store = new ControlStore(':memory:', { now: () => NOW, outcomeBindings: () => current });
  const a = create();
  assert.equal(store.prepare(a).prepared, true);
  current.records.push({ outcome_key: a.payload.outcome_key, task_id: 'T-025', page_id: 'already-created' });
  assert.equal(store.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, false);
  current = structuredClone(bindings);
  const claim = store.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence });
  assert.equal(claim.claimed, true);
  store.settle({ key: a.key, attempt_id: claim.attempt_id, outcome: 'sent', evidence_ref: 'native-create-receipt' });
  assert.equal(store.claim({ key: a.key, owner: 'coordinator', evidence: a.evidence }).claimed, false);
  store.close();
});

test('outcome projection preserves legacy page access and refuses unrelated writes', () => {
  const store = new ControlStore(':memory:', { now: () => NOW, outcomeBindings: () => bindings });
  const update = { ...create(), key: 'update-record', payload: { operation: 'update_outcome',
    page_id: 'outcome-record', data_source_id: bindings.data_source_id, task_id: 'T-010', outcome_key: 'T-010:s3-count' } };
  assert.equal(store.prepare(update).prepared, true);
  for (const patch of [{ page_id: 'other-record' }, { data_source_id: 'other-data' },
    { outcome_key: 'T-010:other' }, { task_id: 'T-999' }, { operation: 'delete_page' }]) {
    assert.equal(store.prepare({ ...update, key: JSON.stringify(patch), payload: { ...update.payload, ...patch } }).prepared, false);
  }
  assert.equal(store.prepare({ ...update, key: 'manual-note', evidence: { ...evidence(), manual_content_preserved: false } }).prepared, false);
  assert.equal(store.prepare({ ...create(), key: 'unchecked', evidence: { ...evidence(), existing_records_checked: false } }).prepared, false);
  assert.equal(store.prepare({ ...create(), key: 'existing', evidence: { ...evidence(), existing_record_found: true } }).prepared, false);
  assert.equal(store.prepare({ ...create(), key: 'legacy', payload: { page_id: PAGE } }).prepared, true);
  assert.equal(store.prepare({ ...create(), key: 'legacy-create', payload: { ...create().payload, page_id: PAGE } }).prepared, false);
  store.close();
  const disabled = new ControlStore(':memory:', { now: () => NOW, outcomeBindings: () => ({ ...bindings, enabled: false }) });
  assert.equal(disabled.prepare(create()).prepared, false);
  disabled.close();
});
