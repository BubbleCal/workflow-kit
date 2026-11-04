import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTANCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(INSTANCE_ROOT, 'instance.json');
const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
export const bindings = {
  ...raw,
  threads: { coordinator:null, inbox:null, maintenance:null, dispatcher:null, ...raw.threads },
  scope: { project_id:null, project_root:null, repositories:[], ...raw.scope },
  identity: { github_login:null, ...raw.identity },
  delivery: { slack_enabled:false, slack_channel_id:null, ready_enabled:false,
    merge_enabled:false, approver_login:null, notion_enabled:false, notion_page_id:null, ...raw.delivery },
};

export function requireBindings() {
  if (!bindings.instance_id || !bindings.scope.project_id || !bindings.scope.project_root)
    throw new Error('Initialize this instance and bind its verified native project before running the workflow.');
  const ids = Object.values(bindings.threads);
  if (ids.length !== 4 || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== 4)
    throw new Error('Bind four distinct native chats for this instance; run node workflow.mjs doctor.');
}

export function instancePolicyReasons(kind, payload, evidence) {
  const reasons = [];
  const projectAction = ['task_wake','dispatch','create_thread','assign_project','archive','unarchive'].includes(kind) ||
    kind === 'human_input' && payload?.thread_id !== bindings.threads.coordinator;
  if (projectAction && bindings.scope.project_id) {
    if (evidence.operation_project_verified !== true || evidence.operation_project_id !== bindings.scope.project_id)
      reasons.push('operation_outside_verified_instance_project');
    if (kind === 'create_thread' && payload?.placement?.project_id !== bindings.scope.project_id ||
        kind === 'assign_project' && payload?.project_id !== bindings.scope.project_id)
      reasons.push('native_target_outside_instance_project');
  }
  if (['slack_pr','pr_ready','merge'].includes(kind)) {
    const enabled = {slack_pr:'slack_enabled',pr_ready:'ready_enabled',merge:'merge_enabled'}[kind];
    if (bindings.delivery[enabled] !== true) reasons.push('delivery_not_enabled_for_this_instance');
    const url = kind === 'slack_pr' ? payload?.message : payload?.pr_url;
    const repo = typeof url === 'string' ? url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9]\d*$/)?.[1] : null;
    if (!repo || !bindings.scope.repositories.includes(repo)) reasons.push('repository_outside_instance_scope');
    if (!bindings.identity.github_login) reasons.push('instance_github_identity_missing');
    if (kind === 'slack_pr' && !bindings.delivery.slack_channel_id) reasons.push('instance_slack_binding_missing');
    if (kind === 'merge' && !bindings.delivery.approver_login) reasons.push('instance_approver_missing');
  }
  if (kind === 'notion_sync' && (bindings.delivery.notion_enabled !== true || !bindings.delivery.notion_page_id))
    reasons.push('notion_not_enabled_for_this_instance');
  return reasons;
}

export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
