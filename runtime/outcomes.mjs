import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function readOutcomeBindings() {
  const path = fileURLToPath(new URL('../outcomes/notion-bindings.json', import.meta.url));
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

// The coordinator supplies owning-source evidence; a page title or parent label
// never grants access to another database or an unregistered existing record.
export function outcomeSyncAllowed(payload, evidence, bindings) {
  if (bindings?.enabled !== true || !bindings.page_id || !bindings.data_source_id ||
      !bindings.source_message_id) return false;
  if (payload?.operation === 'update_page')
    return payload.page_id === bindings.page_id && !payload.data_source_id;
  if (!['create_outcome', 'update_outcome'].includes(payload?.operation) ||
      payload.data_source_id !== bindings.data_source_id ||
      !/^T-\d{3,}$/.test(payload.task_id ?? '') ||
      typeof payload.outcome_key !== 'string' ||
      !payload.outcome_key.startsWith(`${payload.task_id}:`) ||
      payload.outcome_key.length <= payload.task_id.length + 1 ||
      evidence.outcome_evidence_verified !== true) return false;
  const records = bindings.records ?? [];
  const existing = records.find(r => r.outcome_key === payload.outcome_key);
  if (payload.operation === 'create_outcome')
    return payload.page_id === bindings.page_id && !existing &&
      evidence.existing_records_checked === true && evidence.existing_record_found === false;
  return existing?.page_id === payload.page_id && existing?.task_id === payload.task_id;
}
