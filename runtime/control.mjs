import { bindings, INSTANCE_ROOT, requireBindings, instancePolicyReasons } from './instance.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mailbox, COORDINATOR } from './mailbox.mjs';
import { withEngineeringPrinciples } from './engineering-principles.mjs';
import { ReviewFeedback, pullRequestIdentity } from './review-feedback.mjs';
import { readOutcomeBindings, outcomeSyncAllowed } from './outcomes.mjs';
import { readModelSelection, withCreationModel } from './model-selection.mjs';
import { LifecycleLedger } from './lifecycle.mjs';
import { readDependencyPolicy, dependencyReasons } from './dependency-provenance.mjs';
import { retainedApprovalReasons } from './merge-approval.mjs';
import { isReviewDelivery, readReviewWindow, reviewWindowAt, withReviewWindowGuidance, REVIEW_WINDOW } from './review-window.mjs';

export const INBOX = bindings.threads.inbox;
export const PAGE = bindings.delivery.notion_page_id;
export const CHANNEL = bindings.delivery.slack_channel_id;
export const CAPACITY_LIMITS = Object.freeze({ automatic_limit: null, max_new_heavy_concurrency: null, max_dispatches_per_run: null });
export function resolveCapacity(value = {}) {
  if (value.automatic_limit === undefined) return value;
  return { ...value, max_new_heavy_concurrency: value.automatic_limit,
    max_dispatches_per_run: value.automatic_limit };
}
const KINDS = new Set(['dispatch', 'create_thread', 'assign_project', 'human_input', 'notify', 'slack_pr', 'pr_ready', 'merge', 'archive', 'unarchive', 'auth', 'notion_sync', 'automation_update']);
const PROTECTED_THREADS = new Set(Object.values(bindings.threads));
const prUrl = value => typeof value === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(value);
function scopeKey(kind, payload) {
  if (kind === 'create_thread') return `new-thread:${required(payload?.canonical_task_key, 'payload.canonical_task_key')}`;
  if (kind === 'assign_project') return `project-membership:${required(payload?.host_id, 'host_id')}:${required(payload?.thread_id, 'thread_id')}`;
  if (['dispatch', 'human_input', 'archive', 'unarchive'].includes(kind)) return `thread:${required(payload?.thread_id, 'payload.thread_id')}`;
  if (kind === 'notify') return `inbox:${INBOX}`;
  if (kind === 'notion_sync') return `notion:${payload?.data_source_id ?? required(payload?.page_id, 'payload.page_id')}`;
  if (kind === 'auth') return `browser:${required(payload?.host_id, 'payload.host_id')}`;
  if (kind === 'automation_update') return `automation:${required(payload?.automation_id, 'payload.automation_id')}`;
  return `pr:${required(kind === 'slack_pr' ? payload?.message : payload?.pr_url, 'PR URL')}`;
}
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
function freshness(evidence, now) {
  const at = Date.parse(evidence?.verified_at);
  return Number.isFinite(at) && at <= now + 5000 && now - at <= 60000;
}

function creationIdentity(result) {
  if (!result || result.isError) return null;
  if (result.structuredContent) { const identity = creationIdentity(result.structuredContent); if (identity) return identity; }
  if (result.threadId || result.clientThreadId) return result;
  for (const item of result.content ?? []) {
    if (item.type !== 'text') continue;
    try { const value = creationIdentity(JSON.parse(item.text)); if (value) return value; } catch {}
  }
  return null;
}

export function resolvePlacement({ projects, project_id, project_label, host_id, projectless = false, staging = false, reason, source_ref }) {
  required(host_id, 'placement host_id'); required(source_ref, 'project resolution source_ref');
  if (projectless) {
    if (host_id !== 'local') throw new Error('Remote Codex threads cannot be projectless');
    if (project_id != null || project_label || staging) throw new Error('Intentional projectless placement cannot name a project or staging move');
    required(reason, 'projectless reason');
    return { placement: { project_id: null, host_id, method: 'projectless', reason }, native_target: { type: 'projectless' } };
  }
  if (!project_id && !project_label) throw new Error('Resolve the intended project; absence is not projectless intent');
  const matches = (projects ?? []).filter(p => p.hostId === host_id &&
    (!project_id || p.projectId === project_id) && (!project_label || p.label === project_label));
  if (matches.length !== 1) throw new Error('Intended project is missing or ambiguous in the native catalog');
  if (staging && host_id !== 'local') throw new Error('Only local scratch creation can use a follow-up project move');
  return { placement: { project_id: matches[0].projectId, host_id, method: staging ? 'move' : 'create', reason: reason ?? 'Native project catalog and task context' },
    native_target: staging ? { type: 'projectless' } : { type: 'project', projectId: matches[0].projectId, environment: { type: 'local' } } };
}

// These checks validate supplied evidence. The coordinator must obtain that
// evidence from the owning tools; this is not a replacement for tool permissions.
export function assess(kind, payload, e = {}, now = Date.now(), capacity = CAPACITY_LIMITS, reviewRule = REVIEW_WINDOW, outcomeBindings = kind === 'notion_sync' && payload?.page_id !== PAGE ? readOutcomeBindings() : null, dependencyPolicy = ['pr_ready','slack_pr','merge'].includes(kind) ? readDependencyPolicy() : null) {
  const reasons = instancePolicyReasons(kind, payload, e);
  reasons.push(...dependencyReasons(kind,payload,e,dependencyPolicy,now));
  const need = (condition, reason) => { if (!condition) reasons.push(reason); };
  // A current human instruction can start engineering directly. This only
  // removes our workflow's probe phase; native app/tool permissions still apply.
  const directStart = payload?.dispatch_origin === 'manual_direct' && payload?.start_engineering_directly === true;
  need(KINDS.has(kind), 'unknown_action_kind');
  if (isReviewDelivery(kind)) need(!reviewWindowAt(now, reviewRule).blocked, 'review_delivery_blackout');
  need(freshness(e, now), 'fresh_preflight_required');
  need(e.scope_authorized === true && typeof e.authorization_ref === 'string' && !!e.authorization_ref, 'authorization_evidence_required');
  need(typeof e.policy_version === 'string' && !!e.policy_version && e.policy_version === e.current_policy_version, 'policy_changed_or_unknown');
  if (kind !== 'human_input') need(e.stopped === false, 'human_hold_or_unknown_stop_state');
  const idle = (allowUnloaded = false) => {
    const snapshot = e.native_thread_snapshot;
    const flags = snapshot?.thread?.status?.activeFlags ?? [];
    // App restarts unload terminal owners. Residency alone must not force a new
    // human resume, but an unloaded badge alone proves neither quiescence nor safety.
    const unloaded = allowUnloaded && e.thread_status === 'notLoaded' && e.thread_archived === false &&
      snapshot?.thread?.id === payload?.thread_id && snapshot?.thread?.status?.type === 'notLoaded' &&
      Array.isArray(flags) && flags.length === 0 && snapshot?.latestTurn?.id === e.actual_turn_id &&
      ['completed', 'failed', 'interrupted'].includes(snapshot?.latestTurn?.status) &&
      freshness({ verified_at: snapshot?.checked_at }, now) &&
      e.native_approval_pending === false && e.native_permissions_unchanged === true &&
      (snapshot.latestTurn.status !== 'interrupted' || e.interruption_reconciled === true &&
        typeof e.interruption_evidence_ref === 'string' && !!e.interruption_evidence_ref.trim());
    need(e.thread_status === 'idle' || unloaded, 'thread_not_idle');
    need(e.queued_input === false, 'queued_input_or_unknown');
    need(e.pending_dispatch === false, 'unconsumed_dispatch_or_unknown');
    need(e.underlying_job_running === false, 'background_job_or_unknown');
    need(typeof e.expected_turn_id === 'string' && !!e.expected_turn_id && e.expected_turn_id === e.actual_turn_id, 'turn_changed_or_unknown');
  };
  if (kind === 'dispatch') {
    idle(true);
    const readOnly = payload?.execution_mode === 'read_only_analysis';
    if (readOnly) {
      const capabilities = payload.required_capabilities;
      need(payload.starts_heavy_work === false && Array.isArray(capabilities) && capabilities.length > 0 &&
        capabilities.every(c => ['source_read','connector_read'].includes(c) && e.available_capabilities?.[c] === true), 'read_only_scope_or_capability_not_verified');
      need(e.read_only_capabilities_verified === true && e.runtime_permission_turn_id === e.actual_turn_id && e.native_permissions_unchanged === true && e.native_approval_pending === false &&
        typeof e.approval_policy === 'string' && typeof e.sandbox_mode === 'string', 'native_read_only_permissions_not_ready');
    } else need(directStart || (e.runtime_permissions_verified === true && e.runtime_permission_turn_id === e.actual_turn_id && e.approval_policy === 'never' && e.sandbox_mode === 'danger-full-access' && e.worktree_access_verified === true && e.registry_access_verified === true && e.network_access_verified === true), 'effective_runtime_permissions_not_ready');
    need(e.owner_matches === true && e.overlapping_owner === false, 'owner_conflict_or_unknown');
    need(e.work_incomplete === true, 'no_incomplete_authorized_work');
    need(e.existing_driver_owns_step === false, 'existing_driver_owns_step_or_unknown');
    need(typeof payload?.thread_id === 'string' && payload.thread_id === e.owner_thread_id, 'dispatch_target_mismatch');
  }
  if (kind === 'create_thread') {
    const placement = payload?.placement;
    const project = placement?.project_id;
    const target = payload?.native?.target;
    need(placement && (project === null || typeof project === 'string' && !!project) && typeof placement.host_id === 'string' && !!placement.host_id,
      'explicit_project_placement_required');
    need(e.project_resolution_verified === true && typeof e.project_resolution_ref === 'string' && !!e.project_resolution_ref &&
      Object.hasOwn(e, 'intended_project_id') && e.intended_project_id === project && e.project_host_id === placement?.host_id,
      'resolved_project_intent_required');
    if (project === null) {
      need(placement?.method === 'projectless' && placement.host_id === 'local' && e.intentional_projectless_verified === true && typeof placement.reason === 'string' && !!placement.reason && target?.type === 'projectless',
        'intentional_projectless_scope_required');
    } else {
      need(e.project_exists === true, 'intended_project_not_verified');
      need(placement?.method === 'create' && target?.type === 'project' && target.projectId === project ||
        placement?.method === 'move' && target?.type === 'projectless' && placement.host_id === 'local',
        'native_project_binding_or_followup_move_required');
    }
    need(directStart || (payload?.permission_probe_only === true && payload?.starts_heavy_work === false), 'new_owner_permission_probe_required');
    need(e.actual_human_message_verified === true && e.source_actor_verified === true && e.explicit_new_thread_request_verified === true, 'explicit_human_new_thread_request_required');
    need(typeof payload?.source_message_id === 'string' && !!payload.source_message_id && payload.source_message_id === e.source_message_id, 'human_message_identity_mismatch');
    need(typeof payload?.verbatim_text === 'string' && !!payload.verbatim_text && payload.verbatim_text === e.source_text, 'human_instruction_must_be_verbatim');
    need(typeof payload?.canonical_task_key === 'string' && !!payload.canonical_task_key && payload.canonical_task_key === e.canonical_task_key, 'new_thread_work_identity_mismatch');
    if (payload?.replacement) {
      const r = payload.replacement;
      need(e.replacement_request_verified === true && e.old_thread_archived === true && e.old_writer_quiescent === true, 'replacement_owner_not_released');
      need(typeof r.old_thread_id === 'string' && r.old_thread_id === e.old_thread_id && !PROTECTED_THREADS.has(r.old_thread_id), 'replacement_old_owner_mismatch');
      need(typeof r.checkpoint_sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.checkpoint_sha256) && r.checkpoint_sha256 === e.checkpoint_sha256 && e.checkpoint_saved === true && e.resources_preserved === true, 'replacement_checkpoint_not_verified');
      need(typeof r.archive_key === 'string' && typeof r.prior_creation_key === 'string', 'replacement_receipt_binding_required');
    }
    need(e.ownership_handoff_verified === true && e.overlapping_owner === false && e.duplicate_task_exists === false, 'new_thread_owner_conflict_or_unknown');
    need((e.underlying_job_for_scope_running === false || (payload?.replacement && e.preserved_jobs_handoff_verified === true && (payload.permission_probe_only === true || directStart))) && e.existing_driver_owns_step === false && e.pending_dispatch === false, 'new_thread_work_already_running_or_queued');
    need(e.worktree_isolated === true && e.branch_owner_conflict === false && e.preparation_reused_or_absent === true, 'new_thread_workspace_not_ready');
    need(e.work_incomplete === true, 'no_incomplete_authorized_work');
    need(capacity?.max_new_heavy_concurrency === null && e.reserved_heavy_count === undefined ||
      Number.isSafeInteger(e.reserved_heavy_count) && e.reserved_heavy_count >= 0, 'heavy_reservations_unknown');
  }
  if (kind === 'assign_project') {
    need(typeof payload?.creation_key === 'string' && !!payload.creation_key, 'creation_receipt_required');
    need(payload?.thread_id === e.owner_thread_id && payload?.host_id === e.actual_host_id, 'project_assignment_identity_mismatch');
    need(e.membership_observed === true && Object.hasOwn(e, 'actual_project_id'), 'native_membership_observation_required');
    need(e.project_resolution_verified === true && Object.hasOwn(e, 'intended_project_id') && payload?.project_id === e.intended_project_id && payload?.host_id === e.project_host_id,
      'project_assignment_intent_mismatch');
    need(payload?.project_id === null ? e.intentional_projectless_verified === true && payload.host_id === 'local' : e.project_exists === true, 'project_assignment_destination_unverified');
    need(e.actual_project_id !== payload?.project_id, 'project_assignment_already_satisfied');
  }
  if (kind === 'dispatch' || kind === 'create_thread') {
    need(e.capacity_available === true, 'capacity_not_available');
    const count = value => Number.isSafeInteger(value) && value >= 0;
    const validLimit = value => value === null || Number.isSafeInteger(value) && value > 0;
    const limitsValid = validLimit(capacity?.max_new_heavy_concurrency) && validLimit(capacity?.max_dispatches_per_run);
    need(limitsValid, 'capacity_configuration_missing_or_invalid');
    need(capacity?.max_new_heavy_concurrency === capacity?.max_dispatches_per_run, 'automatic_limits_must_match');
    if (capacity?.automatic_limit !== undefined) need(capacity.automatic_limit === capacity.max_new_heavy_concurrency, 'canonical_automatic_limit_mismatch');
    need(typeof payload?.run_id === 'string' && !!payload.run_id.trim(), 'dispatch_run_identity_required');
    need(typeof payload?.starts_heavy_work === 'boolean', 'dispatch_weight_unknown');
    need(capacity?.max_new_heavy_concurrency === null && e.active_heavy_count === undefined || count(e.active_heavy_count), 'active_heavy_count_unknown');
    const reserved = e.reserved_heavy_count ?? 0;
    need(count(reserved), 'heavy_reservations_unknown');
    need(capacity?.max_dispatches_per_run === null && e.dispatches_this_run === undefined || count(e.dispatches_this_run), 'dispatch_count_unknown');
    const manual = payload?.dispatch_origin === 'manual_direct';
    if (manual) need(e.manual_assignment_verified === true && e.manual_event_verified === true && e.actual_human_message_verified === true && e.source_actor_verified === true && payload.source_message_id === e.source_message_id && payload.verbatim_text === e.source_text && payload.canonical_task_key === e.canonical_task_key, 'verified_current_manual_assignment_required');
    if (directStart) need(e.manual_start_authorized === true && e.manual_start_event_verified === true, 'manual_direct_start_authorization_required');
    if (limitsValid && !manual) {
      if (capacity.max_dispatches_per_run !== null)
        need(count(e.dispatches_this_run) && e.dispatches_this_run < capacity.max_dispatches_per_run, 'dispatch_run_limit_reached');
      if (payload?.starts_heavy_work === true && capacity.max_new_heavy_concurrency !== null)
        need(count(e.active_heavy_count) && count(reserved) && e.active_heavy_count + reserved < capacity.max_new_heavy_concurrency, 'heavy_concurrency_limit_reached');
    }
  }
  if (kind === 'human_input') {
    // Direct human steering is distinct from automatic continuation. A stop or
    // correction may reach a busy owner, but a generated poll cannot impersonate it.
    need(e.actual_human_message_verified === true && e.source_actor_verified === true, 'actual_human_input_required');
    need(typeof payload?.source_message_id === 'string' && !!payload.source_message_id && payload.source_message_id === e.source_message_id, 'human_message_identity_mismatch');
    need(typeof payload?.verbatim_text === 'string' && !!payload.verbatim_text && payload.verbatim_text === e.source_text, 'human_instruction_must_be_verbatim');
    need(e.input_already_delivered === false, 'human_input_already_delivered_or_unknown');
    need(e.owner_matches === true && payload?.thread_id === e.owner_thread_id, 'human_input_target_mismatch');
    const restoredQuiescentOwner = e.thread_status === 'notLoaded' &&
      e.explicit_resume_request_verified === true && e.thread_archived === false &&
      e.latest_turn_quiescent === true && e.pending_dispatch === false && e.overlapping_owner === false;
    need(['idle', 'active', 'awaiting_input'].includes(e.thread_status) || restoredQuiescentOwner, 'human_input_target_state_unknown');
    if (payload?.intent === 'question' && payload.thread_id !== COORDINATOR) {
      need(e.thread_status === 'idle' || restoredQuiescentOwner, 'technical_question_waits_for_idle_owner');
      need(e.queued_input === false && e.pending_dispatch === false && e.underlying_job_running === false,
        'technical_question_waits_for_unoccupied_owner');
      need(typeof e.expected_turn_id === 'string' && !!e.expected_turn_id && e.expected_turn_id === e.actual_turn_id,
        'turn_changed_or_unknown');
    }
  }
  if (kind === 'notify') {
    need(payload?.thread_id === INBOX, 'notification_destination_not_inbox');
    need(['decision', 'action_required', 'important_completion', 'answer'].includes(payload?.category), 'routine_notification_forbidden');
    need(e.material_change === true && e.already_notified === false, 'no_new_material_event');
    if (payload?.category === 'answer') {
      need(e.source_question_verified === true && e.owner_answer_verified === true, 'verified_question_and_owner_answer_required');
      need(typeof payload.question_message_id === 'string' && !!payload.question_message_id && payload.question_message_id === e.question_message_id, 'answer_question_identity_mismatch');
    } else if (payload?.category !== 'important_completion') need(e.human_action_required === true, 'no_human_action_required');
    else need(e.completion_verified === true, 'completion_not_verified');
  }
  if (isReviewDelivery(kind) || kind === 'merge') {
    need(e.pr_owner === bindings.identity.github_login, 'pr_not_owned_by_configured_user');
    need(e.pr_open === true && e.pr_draft === (kind === 'pr_ready'), 'pr_not_ready');
    need(e.ordinary_change === true && e.material_findings_open === false, 'important_or_unresolved_change');
    need(e.validation_current === true && e.technical_review_current === true, 'current_head_validation_or_review_missing');
    need(typeof payload?.expected_head_sha === 'string' && /^[a-f0-9]{40,64}$/.test(payload.expected_head_sha) && payload.expected_head_sha === e.current_head_sha, 'head_changed_or_unknown');
  }
  if (kind === 'pr_ready') need(payload?.operation === 'mark_ready' && prUrl(payload.pr_url) && payload.pr_url === e.pr_url, 'verified_draft_transition_required');
  if (kind === 'slack_pr') {
    need(payload?.channel_id === CHANNEL, 'slack_destination_forbidden');
    need(prUrl(payload?.message) && payload.message === e.pr_url, 'slack_message_must_match_verified_PR_URL');
    need(e.already_announced === false, 'already_announced_or_unknown');
  }
  if (kind === 'merge') {
    need(prUrl(payload?.pr_url) && payload.pr_url === e.pr_url, 'merge_PR_identity_mismatch');
    need(e.approver === bindings.delivery.approver_login && e.approver_identity_verified === true && e.approval_state === 'APPROVED', 'designated_approval_missing');
    if (e.approved_head_sha !== e.current_head_sha || e.approval_verification)
      reasons.push(...retainedApprovalReasons(payload, e, now));
    need(e.required_checks_pass === true && e.repository_rules_satisfied === true && e.mergeable === true, 'repository_merge_requirements_unsatisfied');
    need(e.admin_override === false, 'admin_override_forbidden');
  }
  if (kind === 'unarchive') {
    need(e.actual_human_message_verified === true && e.source_actor_verified === true && e.resume_request_verified === true, 'explicit_resume_request_required');
    need(typeof payload?.source_message_id === 'string' && payload.source_message_id === e.source_message_id && typeof payload?.verbatim_text === 'string' && payload.verbatim_text === e.source_text, 'resume_human_source_mismatch');
    need(typeof payload?.thread_id === 'string' && payload.thread_id === e.owner_thread_id && !PROTECTED_THREADS.has(payload.thread_id) && e.control_or_service_chat === false, 'resume_target_invalid_or_protected');
    need(e.thread_archived === true && e.old_writer_quiescent === true && e.overlapping_owner === false && e.pending_dispatch === false, 'resume_owner_conflict_or_unknown');
    need(e.work_incomplete === true && e.checkpoint_saved === true && e.resources_preserved === true, 'resume_checkpoint_or_scope_missing');
    need(payload?.archived === false, 'unarchive_flag_required');
  }
  if (kind === 'archive') {
    need(typeof payload?.thread_id === 'string' && payload.thread_id === e.owner_thread_id && !PROTECTED_THREADS.has(payload.thread_id), 'archive_target_invalid_or_protected');
    need(e.control_or_service_chat === false, 'control_or_service_chat_protected');
    if (payload?.purpose === 'explicit_owner_replacement') {
      need(e.actual_human_message_verified === true && e.source_actor_verified === true && e.replacement_request_verified === true, 'explicit_replacement_request_required');
      need(payload.source_message_id === e.source_message_id && typeof payload.verbatim_text === 'string' && payload.verbatim_text === e.source_text, 'replacement_human_source_mismatch');
      need(e.thread_status === 'idle' && e.queued_input === false && e.pending_dispatch === false && e.old_writer_quiescent === true, 'old_writer_not_quiescent');
      need(typeof e.expected_turn_id === 'string' && !!e.expected_turn_id && e.expected_turn_id === e.actual_turn_id, 'turn_changed_or_unknown');
      need(e.checkpoint_saved === true && /^[a-f0-9]{64}$/.test(payload.checkpoint_sha256 ?? '') && payload.checkpoint_sha256 === e.checkpoint_sha256, 'replacement_checkpoint_not_verified');
      need(e.resources_preserved === true && e.preserved_jobs_handoff_verified === true && e.task_remains_incomplete === true, 'replacement_obligations_not_preserved');
    } else {
      idle(true);
      need(e.task_complete === true && e.completion_evidence_saved === true, 'task_not_fully_complete');
      need(e.pending_decision === false && e.pending_cleanup === false && e.pending_delivery === false, 'unfinished_task_obligation');
      need(e.important_result_delivered === true, 'result_delivery_not_verified');
    }
  }
  if (kind === 'auth') {
    need(e.current_auth_failure === true, 'no_current_auth_failure');
    need(e.profile_and_account_verified === true, 'credential_chain_not_verified');
    need(e.human_only_factor_required === false, 'human_only_factor_required');
    need(e.external_browser === true, 'external_browser_required');
    need(e.other_login_owner === false, 'another_login_owner_or_unknown');
  }
  if (kind === 'notion_sync') {
    const legacy = payload?.page_id === PAGE && !payload?.data_source_id &&
      (!payload?.operation || payload.operation === 'update_page');
    need(legacy || outcomeSyncAllowed(payload, e, outcomeBindings), 'notion_destination_forbidden');
    need(e.content_changed === true && e.manual_content_preserved === true, 'no_safe_substantive_page_change');
  }
  if (kind === 'automation_update') {
    need(['automation-3', 'automation-4', 'daily-pr-standup-draft'].includes(payload?.automation_id), 'automation_outside_coordinator_scope');
    need(e.actual_human_message_verified === true && e.source_actor_verified === true, 'actual_human_input_required');
    need(typeof payload?.source_message_id === 'string' && !!payload.source_message_id && payload.source_message_id === e.source_message_id, 'human_message_identity_mismatch');
    need(typeof payload?.expected_config_hash === 'string' && payload.expected_config_hash === e.current_config_hash, 'automation_config_changed_or_unknown');
    need(e.non_prompt_fields_preserved === true, 'automation_non_prompt_fields_changed');
    if (payload?.automation_id === 'daily-pr-standup-draft') need(e.standup_refinement_authorized === true && e.draft_only_preserved === true && e.exact_interval_preserved === true, 'standup_scope_not_preserved');
  }
  return { allowed: reasons.length === 0, reasons };
}

export class ControlStore {
  constructor(path, { now = () => Date.now(), capacity = CAPACITY_LIMITS, progress = null, reviewRule = readReviewWindow, outcomeBindings = readOutcomeBindings, modelSelection = readModelSelection, dependencyPolicy = readDependencyPolicy } = {}) {
    this.now = now;
    this.capacity = capacity;
    this.progress = progress;
    this.reviewRule = reviewRule;
    this.outcomeBindings = outcomeBindings;
    this.modelSelection = modelSelection;
    this.dependencyPolicy = dependencyPolicy;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (
        event_key TEXT PRIMARY KEY, source TEXT NOT NULL, task_id TEXT NOT NULL,
        source_time TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL,
        recorded_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (
        action_key TEXT PRIMARY KEY, kind TEXT NOT NULL, task_id TEXT NOT NULL,
        scope_key TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, attempt_id TEXT, owner TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        receipt TEXT, last_error TEXT, imported INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS actions_scope ON actions(scope_key, state);
      CREATE TABLE IF NOT EXISTS review_send_permits (
        attempt_id TEXT PRIMARY KEY, action_key TEXT NOT NULL, authorized_at INTEGER NOT NULL, valid_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_setups (
        creation_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, placement TEXT NOT NULL,
        thread_id TEXT, client_thread_id TEXT, host_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'awaiting_creation', evidence_ref TEXT,
        updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES ('processing', 'on');`);
    this.feedback = new ReviewFeedback(this.db,this.now);
    this.lifecycle = new LifecycleLedger(this.db, { now: this.now, dependencyPolicy:this.dependencyPolicy, deliveryMode:bindings.delivery.slack_enabled?'slack':'local', unacknowledged:()=>{
      const file=path === ':memory:' ? null : resolve(dirname(path),'mailbox.sqlite');
      if (!file || !existsSync(file)) return new Set();
      const m=new DatabaseSync(file,{readOnly:true});
      try { return new Set(m.prepare("SELECT item_key FROM mail WHERE state IN ('pending','in_batch') AND json_extract(payload,'$.event')='pr_lifecycle_action'").all().map(x=>x.item_key)); }
      finally { m.close(); }
    } });
  }
  close() { this.db.close(); }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  observe(input) {
    const source = required(input.source, 'source');
    const key = `${source}:${required(input.id, 'event id')}`;
    required(input.task_id, 'task_id');
    if (!Number.isFinite(Date.parse(input.source_time))) throw new Error('source_time must be an ISO timestamp');
    const digest = hash({ task_id: input.task_id, source_time: input.source_time, data: input.data });
    return this.atomic(() => {
      const old = this.db.prepare('SELECT digest FROM events WHERE event_key=?').get(key);
      if (old) {
        if (old.digest !== digest) throw new Error(`Immutable event changed: ${key}`);
        return { recorded: false, key, reason: 'duplicate_event' };
      }
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)').run(key, source, input.task_id, input.source_time, digest, canonical(input.data), this.now());
      return { recorded: true, key };
    });
  }
  importLegacy(rows) {
    return this.atomic(() => {
      let imported = 0;
      for (const row of rows) {
        required(row.key, 'legacy action key');
        const state = row.status === 'sent' ? 'sent' : ['cancelled', 'canceled', 'withdrawn'].includes(row.status) ? 'cancelled' : 'uncertain';
        const payload = { legacy: true, purpose: row.purpose ?? null };
        const result = this.db.prepare(`INSERT OR IGNORE INTO actions
          (action_key,kind,task_id,scope_key,digest,payload,state,due,created_at,updated_at,receipt,imported)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`).run(row.key, 'legacy', row.task_id ?? row.thread_id ?? 'unknown', `legacy:${row.key}`,
          hash(payload), canonical(payload), state, this.now(), this.now(), this.now(), canonical({ registry_status: row.status, evidence_ref: row.evidence_file ?? null }));
        imported += Number(result.changes);
      }
      return { imported };
    });
  }
  prepare(input) {
    const key = required(input.key, 'action key');
    const prior = this.db.prepare('SELECT payload FROM actions WHERE action_key=?').get(key);
    if (['dispatch','create_thread'].includes(input.kind) && (!prior || JSON.parse(prior.payload).result_contract_version === 2))
      input = { ...input, payload: { ...input.payload, result_contract_version:2 } };
    if (['dispatch','create_thread'].includes(input.kind) && (!prior || JSON.parse(prior.payload).dependency_guidance_version === 1))
      input = { ...input, payload: { ...input.payload, dependency_guidance_version:1 } };
    if (input.kind === 'create_thread') {
      const selection = prior ? JSON.parse(prior.payload).model_selection : this.modelSelection();
      input = { ...input, payload: withCreationModel(input.kind, input.payload, selection) };
    }
    if (!prior || JSON.parse(prior.payload).engineering_guidance_version === 1)
      input = { ...input, payload: withEngineeringPrinciples(input.kind, input.payload) };
    if (!prior || JSON.parse(prior.payload).review_window_guidance_version === 1)
      input = { ...input, payload: withReviewWindowGuidance(input.kind, input.payload) };
    const kind = required(input.kind, 'kind');
    const task = required(input.task_id, 'task_id');
    if (!KINDS.has(kind)) throw new Error(`Unsupported action kind: ${kind}`);
    const scope = scopeKey(kind, input.payload);
    if (input.scope_key !== undefined && input.scope_key !== scope) throw new Error(`scope_key must be ${scope}`);
    const digest = hash({ kind, task, scope, payload: input.payload });
    return this.atomic(() => {
      const old = this.db.prepare('SELECT state,digest,imported FROM actions WHERE action_key=?').get(key);
      if (old) {
        if (!old.imported && old.digest !== digest) throw new Error(`Action key reused with different content: ${key}`);
        return { prepared: false, key, state: old.state, reason: 'already_recorded' };
      }
      const rule = isReviewDelivery(kind) ? this.reviewRule() : REVIEW_WINDOW;
      const result = assess(kind, input.payload, input.evidence, this.now(), this.capacity, rule, kind === 'notion_sync' && input.payload?.page_id !== PAGE ? this.outcomeBindings() : null, ['pr_ready','slack_pr','merge'].includes(kind)?this.dependencyPolicy():null);
      const deferred = result.reasons.length === 1 && result.reasons[0] === 'review_delivery_blackout';
      if (!result.allowed && !deferred) return { prepared: false, key, ...result };
      const feedback = this.feedbackGate(kind,input.payload);
      if (!feedback.allowed) return { prepared:false,key,...feedback };
      this.db.prepare(`INSERT INTO actions
        (action_key,kind,task_id,scope_key,digest,payload,state,due,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(key, kind, task, scope, digest, canonical(input.payload), deferred ? 'deferred' : 'prepared',
          deferred ? reviewWindowAt(this.now(),rule).next_eligible_at : this.now(), this.now(), this.now());
      if (kind === 'create_thread') this.db.prepare('INSERT INTO thread_setups(creation_key,task_id,placement,host_id,updated_at) VALUES (?,?,?,?,?)')
        .run(key, task, canonical(input.payload.placement), input.payload.placement.host_id, this.now());
      return deferred ? { prepared: false, key, ...this.deferReview(key, rule) } : { prepared: true, key, state: 'prepared' };
    });
  }
  deferReview(key, rule) {
    const due = reviewWindowAt(this.now(), rule).next_eligible_at;
    this.db.prepare("UPDATE actions SET state='deferred',due=?,attempt_id=NULL,owner=NULL,last_error='review_delivery_blackout',updated_at=? WHERE action_key=?")
      .run(due, this.now(), key);
    return { deferred: true, state: 'deferred', reason: 'review_delivery_blackout', due, send_tool_forbidden: true };
  }
  feedbackGate(kind,payload) {
    if (!['slack_pr','pr_ready','merge'].includes(kind)) return {allowed:true};
    const pr=pullRequestIdentity(payload);
    return pr?this.feedback.gate(pr.repository,pr.pr_number,payload.expected_head_sha):{allowed:false,reasons:['valid_PR_feedback_identity_required']};
  }
  claim({ key, owner, evidence }) {
    required(owner, 'owner');
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM actions WHERE action_key=?').get(key);
      if (!row) throw new Error(`Unknown action: ${key}`);
      if (row.kind === 'notify' || row.kind === 'human_input' && JSON.parse(row.payload).thread_id === COORDINATOR)
        return { claimed: false, reason: 'control_plane_delivery_requires_mailbox', send_tool_forbidden: true };
      if (this.db.prepare("SELECT value FROM settings WHERE key='processing'").get().value !== 'on') return { claimed: false, reason: 'processing_paused' };
      if (!['prepared','deferred'].includes(row.state)) return { claimed: false, reason: row.state };
      if (isReviewDelivery(row.kind) && reviewWindowAt(this.now(),this.reviewRule()).blocked)
        return { claimed: false, ...this.deferReview(key,this.reviewRule()) };
      if (row.due > this.now()) return { claimed: false, reason: 'backoff', due: row.due };
      const blocked = this.db.prepare("SELECT action_key FROM actions WHERE scope_key=? AND state IN ('claimed','uncertain') AND action_key<>? LIMIT 1").get(row.scope_key, key);
      if (blocked) return { claimed: false, reason: 'scope_in_use', blocking_key: blocked.action_key };
      const payload = JSON.parse(row.payload);
      if (row.kind === 'archive' && payload.purpose !== 'explicit_owner_replacement' && this.progress?.unfinishedForOwner(payload.thread_id))
        return { claimed: false, reason: 'owner_has_unfinished_goal_stages' };
      if (row.kind === 'assign_project') {
        const setup = this.db.prepare('SELECT * FROM thread_setups WHERE creation_key=?').get(payload.creation_key);
        const created = this.db.prepare('SELECT state FROM actions WHERE action_key=?').get(payload.creation_key);
        if (!setup || created?.state !== 'sent' || setup.state === 'complete' || setup.task_id !== row.task_id ||
          setup.thread_id !== payload.thread_id || setup.host_id !== payload.host_id || JSON.parse(setup.placement).project_id !== payload.project_id)
          return { claimed: false, reason: 'project_assignment_not_bound_to_created_owner' };
      }
      if (row.kind === 'dispatch') {
        const pending = this.db.prepare("SELECT creation_key FROM thread_setups WHERE thread_id=? AND state NOT IN ('complete','cancelled') LIMIT 1").get(payload.thread_id);
        if (pending) return { claimed: false, reason: 'created_owner_project_setup_incomplete', creation_key: pending.creation_key };
      }
      if (row.kind === 'create_thread') {
        const created = this.db.prepare("SELECT action_key,task_id FROM actions WHERE scope_key=? AND kind='create_thread' AND state='sent' AND action_key<>? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(row.scope_key, key);
        if (created && !payload.replacement) return { claimed: false, reason: 'work_thread_already_created', blocking_key: created.action_key };
        if (payload.replacement) {
          const r = payload.replacement;
          const archived = this.db.prepare("SELECT * FROM actions WHERE action_key=? AND kind='archive' AND state='sent'").get(r.archive_key);
          const ap = archived ? JSON.parse(archived.payload) : {};
          if (!created || created.action_key !== r.prior_creation_key || created.task_id !== row.task_id || !archived || archived.task_id !== row.task_id || ap.purpose !== 'explicit_owner_replacement' || ap.thread_id !== r.old_thread_id || ap.checkpoint_sha256 !== r.checkpoint_sha256 || ap.source_message_id !== (r.archive_source_message_id ?? payload.source_message_id))
            return { claimed: false, reason: 'replacement_receipt_chain_invalid' };
        }
      }
      let checkedEvidence = evidence;
      if (row.kind === 'dispatch' || row.kind === 'create_thread') {
        if (payload.dispatch_origin === 'manual_direct') {
          const event = this.db.prepare('SELECT * FROM events WHERE event_key=?').get(payload.manual_event_key ?? '');
          const data = event ? JSON.parse(event.data) : {};
          checkedEvidence = { ...checkedEvidence, manual_event_verified: !!event && event.task_id === row.task_id && data.actor === 'human' && data.kind === 'manual_task_assignment' && data.message_id === payload.source_message_id && data.text === payload.verbatim_text && data.canonical_task_key === payload.canonical_task_key,
            manual_start_event_verified: data.start_engineering_directly === true };
        }
        const claimedInRun = this.db.prepare(`SELECT COUNT(*) AS count FROM actions
          WHERE kind IN ('dispatch','create_thread') AND json_extract(payload, '$.run_id')=?
          AND coalesce(json_extract(payload, '$.dispatch_origin'), 'automatic') != 'manual_direct'
          AND state IN ('claimed','sent','uncertain')`).get(payload.run_id ?? null).count;
        checkedEvidence = { ...checkedEvidence, dispatches_this_run: Number.isSafeInteger(evidence?.dispatches_this_run) && evidence.dispatches_this_run >= 0
          ? Math.max(evidence.dispatches_this_run, claimedInRun) : evidence?.dispatches_this_run };
      }
      const result = assess(row.kind, payload, checkedEvidence, this.now(), this.capacity, isReviewDelivery(row.kind) ? this.reviewRule() : REVIEW_WINDOW, row.kind === 'notion_sync' && payload.page_id !== PAGE ? this.outcomeBindings() : null, ['pr_ready','slack_pr','merge'].includes(row.kind)?this.dependencyPolicy():null);
      if (!result.allowed) return { claimed: false, ...result };
      const feedback = this.feedbackGate(row.kind,payload);
      if (!feedback.allowed) return {claimed:false,...feedback};
      const attempt = randomUUID();
      this.db.prepare("UPDATE actions SET state='claimed',attempt_id=?,owner=?,attempts=attempts+1,last_error=NULL,updated_at=? WHERE action_key=?").run(attempt, owner, this.now(), key);
      return { claimed: true, key, attempt_id: attempt, payload: JSON.parse(row.payload),
        ...(isReviewDelivery(row.kind) ? { send_tool_forbidden: true, requires_review_send_authorization: true } : {}) };
    });
  }
  authorizeReviewSend({ key, attempt_id, owner, evidence, operation_not_started }) {
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM actions WHERE action_key=?').get(key);
      if (!row || !isReviewDelivery(row.kind) || row.state !== 'claimed' || row.attempt_id !== attempt_id || row.owner !== owner)
        return { send: false, reason: 'stale_or_unowned_review_attempt' };
      if (this.db.prepare('SELECT 1 FROM review_send_permits WHERE attempt_id=?').get(attempt_id))
        return { send: false, reason: 'send_already_authorized_reconcile_outcome' };
      if (operation_not_started !== true) return { send: false, reason: 'unstarted_operation_evidence_required' };
      const rule = this.reviewRule(), window = reviewWindowAt(this.now(),rule);
      if (window.blocked) return { send: false, ...this.deferReview(key,rule) };
      if (this.db.prepare("SELECT value FROM settings WHERE key='processing'").get().value !== 'on') return { send: false, reason: 'processing_paused' };
      const result = assess(row.kind,JSON.parse(row.payload),evidence,this.now(),this.capacity,rule,null,this.dependencyPolicy());
      if (!result.allowed) return { send: false, ...result };
      const feedback = this.feedbackGate(row.kind,JSON.parse(row.payload));
      if (!feedback.allowed) return {send:false,...feedback};
      const validUntil = Math.min(this.now()+60000,window.next_block_at);
      this.db.prepare('INSERT INTO review_send_permits VALUES (?,?,?,?)').run(attempt_id,key,this.now(),validUntil);
      return { send: true, key, attempt_id, payload: JSON.parse(row.payload), valid_until: validUntil,
        next: 'Invoke the authorized external operation immediately and strictly before valid_until; otherwise reconcile proven non-delivery. Never reuse this permit.' };
    });
  }
  settle({ key, attempt_id, outcome, evidence_ref, error_class = null, native_result = null }) {
    required(evidence_ref, 'outcome evidence_ref');
    if (!['sent', 'uncertain', 'not_sent'].includes(outcome)) throw new Error(`Invalid outcome: ${outcome}`);
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM actions WHERE action_key=?').get(key);
      if (!row || row.state !== 'claimed' || row.attempt_id !== attempt_id) throw new Error(`Stale or unowned attempt: ${key}`);
      const retryable = outcome === 'not_sent' && ['rejected_before_send', 'transient_before_send'].includes(error_class) && row.attempts < 2;
      const state = outcome === 'not_sent' ? retryable ? 'prepared' : 'failed' : outcome;
      const due = retryable ? this.now() + Math.min(300000, 5000 * 2 ** (row.attempts - 1)) : this.now();
      this.db.prepare('UPDATE actions SET state=?,due=?,receipt=?,last_error=?,updated_at=? WHERE action_key=?')
        .run(state, due, canonical({ outcome, evidence_ref, ...(native_result ? { native_result } : {}) }), error_class, this.now(), key);
      if (row.kind === 'create_thread' && state === 'sent') {
        const identity = creationIdentity(native_result);
        let identity_error;
        if (identity) { try { this.bindCreationIdentity(key, identity, evidence_ref); } catch (error) { identity_error = error.message; } }
        if (!identity || identity_error) this.db.prepare("UPDATE thread_setups SET state='identity_pending',evidence_ref=?,updated_at=? WHERE creation_key=?")
          .run(evidence_ref, this.now(), key);
        return { key, state, due, setup_complete: false, ...(identity_error ? { identity_error } : {}), next: 'Record native identity, then confirm_creation from fresh list_threads; do not create a duplicate chat.' };
      }
      return { key, state, due };
    });
  }
  bindCreationIdentity(key, identity, evidence_ref) {
    const setup = this.db.prepare('SELECT * FROM thread_setups WHERE creation_key=?').get(key);
    if (!setup) throw new Error('Legacy creation needs an explicitly resolved placement before setup can complete');
    const host = identity.hostId ?? setup.host_id;
    if (host !== setup.host_id || setup.thread_id && setup.thread_id !== identity.threadId ||
      setup.client_thread_id && identity.clientThreadId && setup.client_thread_id !== identity.clientThreadId)
      throw new Error('Creation identity changed');
    if (!(typeof identity.threadId === 'string' && !!identity.threadId) && !(typeof identity.clientThreadId === 'string' && !!identity.clientThreadId)) throw new Error('Native creation identity is missing');
    this.db.prepare('UPDATE thread_setups SET thread_id=COALESCE(?,thread_id),client_thread_id=COALESCE(?,client_thread_id),state=?,evidence_ref=?,updated_at=? WHERE creation_key=?')
      .run(identity.threadId || null, identity.clientThreadId || null, setup.state === 'complete' ? 'complete' : identity.threadId ? 'project_pending' : 'identity_pending', evidence_ref, this.now(), key);
  }
  recordCreation({ key, native_result, evidence }) {
    if (!freshness(evidence, this.now()) || evidence.identity_verified !== true) throw new Error('Fresh native creation identity evidence required');
    required(evidence.evidence_ref, 'identity evidence_ref');
    return this.atomic(() => {
      const row = this.db.prepare("SELECT state FROM actions WHERE action_key=? AND kind='create_thread'").get(key);
      const setup = this.db.prepare('SELECT * FROM thread_setups WHERE creation_key=?').get(key);
      if (row?.state !== 'sent' || !setup) throw new Error('Reconcile creation delivery before recording identity');
      if (setup.client_thread_id && setup.client_thread_id !== evidence.client_thread_id) throw new Error('Queued client identity mismatch');
      const identity = creationIdentity(native_result); if (!identity) throw new Error('Native creation identity is missing');
      this.bindCreationIdentity(key, identity, evidence.evidence_ref);
      return { key, setup_complete: setup.state === 'complete', next: setup.state === 'complete' ? 'already_complete' : 'confirm_creation' };
    });
  }
  confirmCreation({ key, snapshot, verified_at, source, evidence_ref }) {
    if (!freshness({ verified_at }, this.now()) || source !== 'list_threads') throw new Error('Fresh native list_threads observation required');
    required(evidence_ref, 'project verification evidence_ref');
    return this.atomic(() => {
      const setup = this.db.prepare('SELECT * FROM thread_setups WHERE creation_key=?').get(key);
      const action = this.db.prepare('SELECT state FROM actions WHERE action_key=?').get(key);
      if (!setup?.thread_id || action?.state !== 'sent' || snapshot?.id !== setup.thread_id || snapshot?.hostId !== setup.host_id || !Object.hasOwn(snapshot, 'projectId'))
        throw new Error('Created thread identity and native membership must be known');
      const project = JSON.parse(setup.placement).project_id;
      const complete = snapshot.projectId === project;
      if (setup.state === 'complete' && !complete) return { key, setup_complete: true, project_changed_since_setup: true,
        next: 'Reconcile newer human project intent; a completed creation does not authorize moving it back.' };
      this.db.prepare('UPDATE thread_setups SET state=?,evidence_ref=?,updated_at=? WHERE creation_key=?')
        .run(complete ? 'complete' : 'project_pending', evidence_ref, this.now(), key);
      return { key, setup_complete: complete, thread_id: setup.thread_id, host_id: setup.host_id,
        intended_project_id: project, observed_project_id: snapshot.projectId,
        ...(complete ? {} : { next: 'prepare assign_project for this existing thread, settle the move, then repeat confirm_creation',
          native_move: { threadId: setup.thread_id, hostId: setup.host_id, source: 'codex', projectId: project } }) };
    });
  }
  reconcile({ key, confirmed_outcome, evidence_ref, owner_quiescent, verified_at }) {
    required(evidence_ref, 'reconciliation evidence_ref');
    if (!['sent', 'not_sent'].includes(confirmed_outcome)) throw new Error('Reconciliation needs a verified sent/not_sent outcome');
    if (owner_quiescent !== true || !freshness({ verified_at }, this.now())) throw new Error('Fresh quiescent-owner evidence required before reconciliation');
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM actions WHERE action_key=?').get(key);
      if (!row || !['claimed', 'uncertain'].includes(row.state)) throw new Error(`Action does not require reconciliation: ${key}`);
      // Imported uncertain actions require a newly prepared action after explicit
      // reconciliation, because their original executable payload was not imported.
      const state = confirmed_outcome === 'sent' ? 'sent' : row.imported ? 'cancelled' : 'prepared';
      this.db.prepare('UPDATE actions SET state=?,attempt_id=NULL,owner=NULL,due=?,receipt=?,updated_at=? WHERE action_key=?')
        .run(state, this.now(), canonical({ reconciled: true, confirmed_outcome, evidence_ref }), this.now(), key);
      if (row.kind === 'create_thread' && state === 'sent') this.db.prepare("UPDATE thread_setups SET state='identity_pending',evidence_ref=?,updated_at=? WHERE creation_key=? AND state='awaiting_creation'").run(evidence_ref, this.now(), key);
      return { key, state, ...(row.kind === 'create_thread' && state === 'sent' ? { setup_complete: false, next: 'record_creation then confirm_creation' } : {}) };
    });
  }
  cancel({ key, reason }) {
    required(reason, 'cancellation reason');
    const r = this.db.prepare("UPDATE actions SET state='cancelled',receipt=?,updated_at=? WHERE action_key=? AND state IN ('prepared','deferred')").run(canonical({ reason }), this.now(), key);
    if (r.changes) this.db.prepare("UPDATE thread_setups SET state='cancelled',updated_at=? WHERE creation_key=?").run(this.now(), key);
    return { cancelled: r.changes === 1, key };
  }
  processing(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    this.db.prepare("UPDATE settings SET value=? WHERE key='processing'").run(enabled ? 'on' : 'off');
    return { processing: enabled, running_work_interrupted: false };
  }
  status() {
    return {
      processing: this.db.prepare("SELECT value FROM settings WHERE key='processing'").get().value === 'on',
      capacity_limits: this.capacity,
      review_window: reviewWindowAt(this.now(),this.reviewRule()),
      deferred_reviews: this.db.prepare("SELECT action_key,kind,task_id,payload,due,last_error FROM actions WHERE state='deferred' ORDER BY due,created_at").all()
        .map(row => ({ ...row, payload: JSON.parse(row.payload), due_now: row.due <= this.now() })),
      prepared_reviews: this.db.prepare("SELECT action_key,kind,task_id,due FROM actions WHERE kind IN ('slack_pr','pr_ready') AND state='prepared' ORDER BY due,created_at").all(),
      events: this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
      review_feedback_snapshots: this.db.prepare('SELECT * FROM feedback_snapshots ORDER BY checked_at DESC LIMIT 20').all(),
      actions: this.db.prepare('SELECT state,COUNT(*) AS count FROM actions GROUP BY state').all(),
      unsettled: this.db.prepare("SELECT action_key,kind,task_id,scope_key,state,attempts,last_error FROM actions WHERE state IN ('claimed','uncertain','failed') ORDER BY created_at").all(),
      pending_thread_setups: this.db.prepare("SELECT creation_key,task_id,thread_id,client_thread_id,host_id,state,placement,evidence_ref FROM thread_setups WHERE state NOT IN ('complete','cancelled') ORDER BY updated_at").all()
        .map(row => ({ ...row, placement: JSON.parse(row.placement) })),
    };
  }
}

export function routeControlPreparation(input, control, mailbox, now = Date.now()) {
  const routed = input.kind === 'notify' || input.kind === 'human_input' && input.payload?.thread_id === COORDINATOR;
  if (!routed) return null;
  const gate = assess(input.kind, input.payload, input.evidence, now, control.capacity);
  if (!gate.allowed) return { prepared: false, ...gate };
  const previous = control.db.prepare('SELECT state FROM actions WHERE action_key=?').get(input.key);
  if (previous && ['sent','cancelled','claimed','uncertain'].includes(previous.state)) return { prepared: false, key: input.key, state: previous.state, reason: 'existing_delivery_must_not_be_replayed' };
  const preparation = control.prepare(input);
  if (preparation.allowed === false) return preparation;
  const notification = input.kind === 'notify';
  const text = notification ? input.payload.text ?? input.payload.prompt ?? input.payload.message : input.payload.verbatim_text;
  required(text, 'queued message text');
  const queued = mailbox.enqueue({ key: input.key, lane: notification ? 'inbox' : 'coordinator',
    kind: notification ? input.payload.category : 'human_command', payload: {
      text, task_id: input.task_id, control_action_key: input.key,
      source_message_id: input.payload.source_message_id ?? null,
      source_thread_id: input.payload.source_thread_id ?? null,
      authorization_ref: input.evidence.authorization_ref,
      intent: input.payload.intent ?? null,
      question_message_id: input.payload.question_message_id ?? null,
      result_reference: input.payload.result_reference ?? null,
    } });
  control.db.prepare("UPDATE actions SET state='queued',receipt=?,updated_at=? WHERE action_key=? AND state IN ('prepared','queued')")
    .run(JSON.stringify({ mailbox_key: input.key, sequence: queued.seq }), now, input.key);
  return { prepared: false, queued: true, key: input.key, mailbox_state: queued.state, send_tool_forbidden: true, next: 'End this turn; the dispatcher delivers only after the destination is idle.' };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  requireBindings();
  const base = INSTANCE_ROOT;
  const input = process.argv[2] === 'status' ? { op: 'status' } : JSON.parse(readFileSync(0, 'utf8'));
  const path = resolve(base, 'control.sqlite');
  const registryPath = resolve(base, 'registry.json');
  const registryState = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : {};
  const control = new ControlStore(path, { capacity: resolveCapacity(registryState.capacity ?? {}) });
  let mailbox;
  try {
    // Read the current mirror on every action preparation, so pre-migration
    // receipts and any delivery already recorded by the coordinator are not replayed.
    if (['prepare', 'import_legacy'].includes(input.op)) {
      const registry = resolve(base, 'registry.json');
      if (existsSync(registry)) control.importLegacy(JSON.parse(readFileSync(registry, 'utf8')).outbox ?? []);
    }
    const operations = {
      observe: () => control.observe(input), prepare: () => {
        if (input.kind === 'notify' || input.kind === 'human_input' && input.payload?.thread_id === COORDINATOR) {
          mailbox ??= new Mailbox(resolve(base, 'mailbox.sqlite'));
          return routeControlPreparation(input, control, mailbox);
        }
        return control.prepare(input);
      },
      claim: () => {
        const row = control.db.prepare('SELECT kind,payload FROM actions WHERE action_key=?').get(input.key);
        if (row?.kind === 'archive') { mailbox ??= new Mailbox(resolve(base, 'mailbox.sqlite')); control.progress = mailbox.progress; }
        if (row && (row.kind === 'notify' || row.kind === 'human_input' && JSON.parse(row.payload).thread_id === COORDINATOR))
          return { claimed: false, reason: 'control_plane_delivery_requires_mailbox', send_tool_forbidden: true };
        return control.claim(input);
      }, authorize_review_send: () => control.authorizeReviewSend(input), settle: () => control.settle(input),
      record_creation: () => control.recordCreation(input), confirm_creation: () => control.confirmCreation(input),
      resolve_project: () => resolvePlacement(input),
      reconcile: () => control.reconcile(input), cancel: () => control.cancel(input),
      processing: () => control.processing(input.enabled), status: () => control.status(),
      review_window: () => reviewWindowAt(control.now(),control.reviewRule()),
      feedback_ingest: () => control.atomic(()=>{
        const snapshot = input.snapshot_file ? JSON.parse(readFileSync(input.snapshot_file,'utf8')) : input.snapshot;
        const result = control.feedback.ingest(snapshot);
        if (snapshot.pr) control.lifecycle.observe(snapshot.pr, { feedbackCollected: true });
        return { ...result, lifecycle_outbox: control.lifecycle.reconcile() };
      }),
      feedback_assess: () => control.atomic(()=>({ ...control.feedback.assess(input), lifecycle_outbox: control.lifecycle.reconcile() })),
      lifecycle_track: () => control.atomic(()=>control.lifecycle.track(input)),
      lifecycle_observe: () => control.atomic(()=>{
        const result = control.lifecycle.observe(input.snapshot_file ? JSON.parse(readFileSync(input.snapshot_file,'utf8')) : input.snapshot);
        return { ...result, outbox: control.lifecycle.reconcile() };
      }),
      lifecycle_plan: () => control.atomic(()=>({ outbox: control.lifecycle.reconcile() })),
      lifecycle_status: () => control.lifecycle.status(),
      lifecycle_resolve: () => {
        let progress_resolution;
        if (input.disposition === 'progress') {
          mailbox ??= new Mailbox(resolve(base,'mailbox.sqlite'));
          if (input.progress_event_key !== `${input.key}:${input.generation}`) throw new Error('Progress must consume this exact lifecycle event');
          const event = mailbox.db.prepare('SELECT * FROM progress_events WHERE event_key=?').get(input.progress_event_key ?? '');
          if (!event) throw new Error('Record actual progress before resolving the lifecycle obligation');
          const intent = control.db.prepare('SELECT payload FROM lifecycle_intents WHERE intent_key=?').get(input.key);
          const task = intent && JSON.parse(intent.payload).task_id;
          if (!mailbox.db.prepare('SELECT 1 FROM progress_event_tasks WHERE event_key=? AND task_id=?').get(input.progress_event_key,task))
            throw new Error('Progress does not cover the PR task');
          const taskStages = mailbox.progress.goals().flatMap(g=>g.stages).filter(s=>s.task_id===task);
          progress_resolution = { verified:true, event_key:input.progress_event_key, task_ids:[task],
            goals:mailbox.progress.goals().filter(g=>g.stages.some(s=>s.task_id===task)),
            task_complete:taskStages.length>0 && taskStages.every(s=>s.state==='complete'), evidence_ref:event.evidence_ref };
        }
        return control.atomic(()=>control.lifecycle.resolve({ ...input, progress_resolution }));
      },
      feedback_status: () => control.feedback.status(input.repository,input.pr_number),
      feedback_plan: () => control.feedback.plan(input),
      feedback_record_route: () => control.atomic(()=>control.feedback.recordRoute(input)),
      import_legacy: () => control.status(),
    };
    if (!operations[input.op]) throw new Error(`Unknown operation: ${input.op}`);
    const result = operations[input.op]();
    const outbox = result?.lifecycle_outbox ?? (['lifecycle_observe','lifecycle_plan'].includes(input.op) ? result?.outbox : null);
    if (outbox?.length) {
      mailbox ??= new Mailbox(resolve(base,'mailbox.sqlite'));
      if (mailbox.transitionVersion() >= 2) for (const item of outbox) mailbox.enqueue(item);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  } finally { mailbox?.close(); control.close(); }
}
