import test from 'node:test';
import assert from 'node:assert/strict';
import { withCreationModel } from './model-selection.mjs';

const selection = { source_message_id: 'actual-human', model: 'selected-model',
  thinking: 'xhigh', fast: false, service_tier_control_supported: false };

test('creation uses the requested native model and effort without inventing tier support', () => {
  const payload = { native: { prompt: 'Original task', target: { type: 'projectless' } } };
  const prepared = withCreationModel('create_thread', payload, selection);
  assert.equal(prepared.native.model, 'selected-model');
  assert.equal(prepared.native.thinking, 'xhigh');
  assert.equal(prepared.native.prompt, 'Original task');
  assert.equal(Object.hasOwn(prepared.native, 'serviceTier'), false);
  assert.equal(prepared.model_selection.service_tier_control_supported, false);
  assert.equal(payload.native.model, undefined);
  assert.deepEqual(withCreationModel('create_thread', prepared, selection), prepared);
});

test('explicit task choices and existing-thread dispatch settings remain intact', () => {
  const payload = { native: { model: 'task-choice', thinking: 'high' } };
  assert.deepEqual(withCreationModel('create_thread', payload, selection).native, payload.native);
  assert.equal(withCreationModel('dispatch', payload, selection), payload);
  assert.equal(withCreationModel('create_thread', payload, null), payload);
  assert.equal(withCreationModel('create_thread', { tool_args: { prompt: 'Existing adapter' } }, selection).tool_args.model, selection.model);
});
